package com.singsong.app.audio

import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

class AiTrackGenerator {

    companion object {
        private const val TAG = "AiTrackGenerator"
        private const val SERVER_BASE_URL = "http://10.0.2.2:3000"
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    data class GenerateOptions(
        val instrument: String,
        val bpm: Int = 120,
        val key: String = "C",
        val scale: String = "major",
        val durationSeconds: Int = 30,
        val description: String = "",
        val temperature: Float = 1.0f,
        val density: Float = 0.5f,
        val brightness: Float = 0.5f,
        val existingTracksBase64: List<String> = emptyList()
    )

    sealed class GenerateResult {
        data class Success(val outputPath: String) : GenerateResult()
        data class Error(val message: String) : GenerateResult()
    }

    suspend fun generateTrack(
        options: GenerateOptions,
        outputPath: String,
        onStatus: (String) -> Unit
    ): GenerateResult = withContext(Dispatchers.IO) {
        try {
            onStatus("Preparing AI track generation...")

            val json = JSONObject().apply {
                put("instrument", options.instrument)
                put("bpm", options.bpm)
                put("key", options.key)
                put("scale", options.scale)
                put("durationSeconds", options.durationSeconds)
                put("description", options.description)
                put("temperature", options.temperature.toDouble())
                put("density", options.density.toDouble())
                put("brightness", options.brightness.toDouble())
                if (options.existingTracksBase64.isNotEmpty()) {
                    put("existingTracksBase64", JSONArray(options.existingTracksBase64))
                }
            }

            onStatus("Generating ${options.instrument} track with AI...")

            val request = Request.Builder()
                .url("$SERVER_BASE_URL/api/ai/generate-track")
                .post(json.toString().toRequestBody("application/json".toMediaType()))
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string()

            if (!response.isSuccessful) {
                Log.e(TAG, "Generate failed: ${response.code} - $body")
                return@withContext GenerateResult.Error("AI generation failed: ${response.code}")
            }

            val result = JSONObject(body ?: return@withContext GenerateResult.Error("Empty response"))
            val audioBase64 = result.optString("audioBase64", "")

            if (audioBase64.isEmpty()) {
                return@withContext GenerateResult.Error("No audio returned from AI")
            }

            onStatus("Saving generated track...")

            val audioBytes = Base64.decode(audioBase64, Base64.DEFAULT)
            val outputFile = File(outputPath)
            outputFile.parentFile?.mkdirs()
            FileOutputStream(outputFile).use { it.write(audioBytes) }

            Log.d(TAG, "AI track saved: $outputPath (${audioBytes.size} bytes)")
            GenerateResult.Success(outputPath)

        } catch (e: Exception) {
            Log.e(TAG, "AI track generation failed", e)
            GenerateResult.Error("Generation failed: ${e.message}")
        }
    }

    fun fileToBase64(file: File): String? {
        return try {
            val bytes = file.readBytes()
            Base64.encodeToString(bytes, Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to encode file to base64", e)
            null
        }
    }
}
