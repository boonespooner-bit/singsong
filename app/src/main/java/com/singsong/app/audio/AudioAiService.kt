package com.singsong.app.audio

import android.util.Log
import com.singsong.app.data.TrackRole
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * Service that transforms recorded audio to match the selected instrument/role
 * using the Kits.AI Voice Conversion API.
 *
 * API flow:
 * 1. Fetch available instrument voice models via GET /voice-models
 * 2. POST audio to /voice-conversions with the matched voice model ID
 * 3. Poll GET /voice-conversions/{id} until status is "completed"
 * 4. Download the output file from the outputFileUrl
 */
class AudioAiService {

    companion object {
        private const val TAG = "AudioAiService"
        private const val API_BASE_URL = "https://arpeggi.io/api/kits/v1"
        private const val API_KEY = "Q-Vgzw2B.mCWit1ka3N8IGb6S5q0dKYRj"
        private const val MAX_POLL_ATTEMPTS = 60
        private const val POLL_INTERVAL_MS = 3000L
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    // Cache of instrument voice model IDs keyed by role
    private var instrumentModels: Map<TrackRole, Long>? = null

    sealed class TransformResult {
        data class Success(val outputPath: String) : TransformResult()
        data class Error(val message: String) : TransformResult()
    }

    /**
     * Transforms the audio file at [inputPath] to sound like the given [role]
     * using the Kits.AI voice conversion API.
     */
    suspend fun transformAudio(
        inputPath: String,
        role: TrackRole,
        outputPath: String
    ): TransformResult = withContext(Dispatchers.IO) {
        try {
            val inputFile = File(inputPath)
            if (!inputFile.exists()) {
                return@withContext TransformResult.Error("Input file not found")
            }

            // Skip API call for vocals and other - just copy the file
            if (role == TrackRole.VOCALS || role == TrackRole.OTHER) {
                inputFile.copyTo(File(outputPath), overwrite = true)
                return@withContext TransformResult.Success(outputPath)
            }

            // Step 1: Get the voice model ID for this instrument role
            val voiceModelId = getVoiceModelId(role)
            if (voiceModelId == null) {
                Log.w(TAG, "No voice model found for role $role, copying raw audio")
                inputFile.copyTo(File(outputPath), overwrite = true)
                return@withContext TransformResult.Success(outputPath)
            }

            Log.d(TAG, "Using voice model ID $voiceModelId for role ${role.displayName}")

            // Step 2: Create a voice conversion job
            val jobId = createVoiceConversionJob(inputFile, voiceModelId)
                ?: return@withContext TransformResult.Error("Failed to create voice conversion job")

            Log.d(TAG, "Voice conversion job created with ID: $jobId")

            // Step 3: Poll for completion
            val outputFileUrl = pollForCompletion(jobId)
                ?: return@withContext TransformResult.Error("Voice conversion timed out or failed")

            Log.d(TAG, "Voice conversion completed, downloading from: $outputFileUrl")

            // Step 4: Download the converted audio file
            val downloaded = downloadFile(outputFileUrl, outputPath)
            if (!downloaded) {
                return@withContext TransformResult.Error("Failed to download converted audio")
            }

            TransformResult.Success(outputPath)
        } catch (e: Exception) {
            Log.e(TAG, "Transform failed", e)
            TransformResult.Error("Transform failed: ${e.message}")
        }
    }

    /**
     * Fetches available instrument voice models from the Kits.AI API
     * and maps them to TrackRole values.
     */
    private fun fetchInstrumentModels(): Map<TrackRole, Long> {
        val models = mutableMapOf<TrackRole, Long>()

        try {
            // Fetch voice models, filtering for instruments
            var page = 1
            var hasMore = true

            while (hasMore && page <= 5) {
                val request = Request.Builder()
                    .url("$API_BASE_URL/voice-models?page=$page&perPage=50&instruments=true")
                    .addHeader("Authorization", "Bearer $API_KEY")
                    .get()
                    .build()

                val response = client.newCall(request).execute()
                val body = response.body?.string() ?: break

                if (!response.isSuccessful) {
                    Log.e(TAG, "Failed to fetch voice models: ${response.code} - $body")
                    break
                }

                val jsonArray = JSONArray(body)

                if (jsonArray.length() == 0) {
                    hasMore = false
                    continue
                }

                for (i in 0 until jsonArray.length()) {
                    val model = jsonArray.getJSONObject(i)
                    val id = model.getLong("id")
                    val title = model.optString("title", "").lowercase()
                    val tags = mutableListOf<String>()

                    // Collect tags if available
                    if (model.has("tags")) {
                        val tagsArray = model.optJSONArray("tags")
                        if (tagsArray != null) {
                            for (t in 0 until tagsArray.length()) {
                                tags.add(tagsArray.optString(t, "").lowercase())
                            }
                        }
                    }

                    val searchText = "$title ${tags.joinToString(" ")}"

                    // Map model to track role based on title/tags
                    when {
                        !models.containsKey(TrackRole.GUITAR) &&
                                searchText.contains("guitar") -> models[TrackRole.GUITAR] = id

                        !models.containsKey(TrackRole.BASS) &&
                                (searchText.contains("bass") && !searchText.contains("bassoon")) ->
                            models[TrackRole.BASS] = id

                        !models.containsKey(TrackRole.DRUMS) &&
                                (searchText.contains("drum") || searchText.contains("percussion")) ->
                            models[TrackRole.DRUMS] = id

                        !models.containsKey(TrackRole.PIANO) &&
                                (searchText.contains("piano") || searchText.contains("keys")) ->
                            models[TrackRole.PIANO] = id

                        !models.containsKey(TrackRole.SYNTH) &&
                                (searchText.contains("synth") || searchText.contains("synthesizer")) ->
                            models[TrackRole.SYNTH] = id

                        !models.containsKey(TrackRole.STRINGS) &&
                                (searchText.contains("string") || searchText.contains("violin") ||
                                        searchText.contains("cello")) ->
                            models[TrackRole.STRINGS] = id
                    }
                }

                // Stop if we found all instrument types
                if (models.size >= 6) break

                page++
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch instrument models", e)
        }

        Log.d(TAG, "Found ${models.size} instrument models: $models")
        return models
    }

    /**
     * Gets the voice model ID for a given track role, fetching models if needed.
     */
    private fun getVoiceModelId(role: TrackRole): Long? {
        if (instrumentModels == null) {
            instrumentModels = fetchInstrumentModels()
        }
        return instrumentModels?.get(role)
    }

    /**
     * Creates a new voice conversion job on the Kits.AI API.
     * Returns the job ID on success.
     */
    private fun createVoiceConversionJob(audioFile: File, voiceModelId: Long): Long? {
        try {
            val mediaType = "audio/wav".toMediaType()

            val requestBody = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("voiceModelId", voiceModelId.toString())
                .addFormDataPart(
                    "soundFile",
                    audioFile.name,
                    audioFile.asRequestBody(mediaType)
                )
                .addFormDataPart("conversionStrength", "0.5")
                .addFormDataPart("modelVolumeMix", "0.5")
                .build()

            val request = Request.Builder()
                .url("$API_BASE_URL/voice-conversions")
                .addHeader("Authorization", "Bearer $API_KEY")
                .post(requestBody)
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string()

            if (!response.isSuccessful) {
                Log.e(TAG, "Failed to create conversion job: ${response.code} - $body")
                return null
            }

            val json = JSONObject(body ?: return null)
            return json.optLong("id", -1).takeIf { it > 0 }
        } catch (e: Exception) {
            Log.e(TAG, "Error creating voice conversion job", e)
            return null
        }
    }

    /**
     * Polls the Kits.AI API for the voice conversion job status.
     * Returns the output file URL when the job completes.
     */
    private suspend fun pollForCompletion(jobId: Long): String? {
        for (attempt in 1..MAX_POLL_ATTEMPTS) {
            delay(POLL_INTERVAL_MS)

            try {
                val request = Request.Builder()
                    .url("$API_BASE_URL/voice-conversions/$jobId")
                    .addHeader("Authorization", "Bearer $API_KEY")
                    .get()
                    .build()

                val response = client.newCall(request).execute()
                val body = response.body?.string()

                if (!response.isSuccessful) {
                    Log.w(TAG, "Poll attempt $attempt failed: ${response.code}")
                    continue
                }

                val json = JSONObject(body ?: continue)
                val status = json.optString("status", "")

                Log.d(TAG, "Poll attempt $attempt: status=$status")

                when (status) {
                    "completed", "success" -> {
                        val outputUrl = json.optString("outputFileUrl", "")
                        if (outputUrl.isNotEmpty()) {
                            return outputUrl
                        }
                        // Try alternate field names
                        val outputUrl2 = json.optString("outputUrl", "")
                        if (outputUrl2.isNotEmpty()) {
                            return outputUrl2
                        }
                        Log.w(TAG, "Job completed but no output URL found in: $body")
                        return null
                    }
                    "failed", "error" -> {
                        val error = json.optString("error", "Unknown error")
                        Log.e(TAG, "Voice conversion job failed: $error")
                        return null
                    }
                    // "running", "queued", etc. - keep polling
                }
            } catch (e: Exception) {
                Log.w(TAG, "Poll attempt $attempt error", e)
            }
        }

        Log.e(TAG, "Voice conversion timed out after $MAX_POLL_ATTEMPTS attempts")
        return null
    }

    /**
     * Downloads a file from the given URL and saves it to the output path.
     */
    private fun downloadFile(url: String, outputPath: String): Boolean {
        return try {
            val request = Request.Builder()
                .url(url)
                .build()

            val response = client.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.e(TAG, "Download failed: ${response.code}")
                return false
            }

            val outputFile = File(outputPath)
            outputFile.parentFile?.mkdirs()

            response.body?.byteStream()?.use { input ->
                FileOutputStream(outputFile).use { output ->
                    input.copyTo(output)
                }
            }

            Log.d(TAG, "Downloaded converted audio to $outputPath (${outputFile.length()} bytes)")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to download file", e)
            false
        }
    }
}
