package com.singsong.app.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.io.RandomAccessFile
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.PI

data class TrackPlaybackConfig(
    val trackId: Long,
    val filePath: String,
    val volume: Float = 0.8f,
    val eqBass: Float = 0.5f,
    val eqMids: Float = 0.5f,
    val eqTreble: Float = 0.5f,
    val compressorEnabled: Boolean = false
)

class MultitrackPlayer {

    private var audioTrack: AudioTrack? = null
    private var playbackJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

    private val _playbackProgress = MutableStateFlow(0f)
    val playbackProgress: StateFlow<Float> = _playbackProgress.asStateFlow()

    companion object {
        private const val SAMPLE_RATE = 44100
        private const val BUFFER_SIZE = 4096
    }

    fun play(tracks: List<TrackPlaybackConfig>) {
        if (tracks.isEmpty()) return
        stop()

        _isPlaying.value = true

        playbackJob = scope.launch {
            try {
                playMixed(tracks)
            } finally {
                _isPlaying.value = false
                _playbackProgress.value = 0f
            }
        }
    }

    private fun playMixed(tracks: List<TrackPlaybackConfig>) {
        // Read all WAV files into PCM sample arrays
        val trackSamples = tracks.mapNotNull { config ->
            val file = File(config.filePath)
            if (!file.exists()) return@mapNotNull null
            val samples = readWavSamples(file) ?: return@mapNotNull null
            config to samples
        }

        if (trackSamples.isEmpty()) return

        // Find the longest track
        val maxLength = trackSamples.maxOf { it.second.size }

        // Mix all tracks together
        val mixedSamples = FloatArray(maxLength)
        for ((config, samples) in trackSamples) {
            val processed = applyEffects(samples, config)
            for (i in processed.indices) {
                mixedSamples[i] += processed[i]
            }
        }

        // Normalize to prevent clipping
        val maxVal = mixedSamples.maxOfOrNull { kotlin.math.abs(it) } ?: 1f
        if (maxVal > 1f) {
            for (i in mixedSamples.indices) {
                mixedSamples[i] /= maxVal
            }
        }

        // Convert to 16-bit PCM
        val pcmBuffer = ShortArray(maxLength)
        for (i in mixedSamples.indices) {
            pcmBuffer[i] = (mixedSamples[i] * Short.MAX_VALUE).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }

        // Play through AudioTrack
        val bufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize * 2)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        audioTrack?.play()

        var offset = 0
        while (offset < pcmBuffer.size && _isPlaying.value) {
            val remaining = pcmBuffer.size - offset
            val writeSize = min(BUFFER_SIZE, remaining)
            audioTrack?.write(pcmBuffer, offset, writeSize)
            offset += writeSize
            _playbackProgress.value = offset.toFloat() / pcmBuffer.size
        }

        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
    }

    private fun readWavSamples(file: File): FloatArray? {
        return try {
            val raf = RandomAccessFile(file, "r")

            // Skip WAV header (44 bytes)
            raf.seek(44)

            val dataSize = (file.length() - 44).toInt()
            val numSamples = dataSize / 2
            val samples = FloatArray(numSamples)

            val bytes = ByteArray(dataSize)
            raf.readFully(bytes)
            raf.close()

            for (i in 0 until numSamples) {
                val low = bytes[i * 2].toInt() and 0xFF
                val high = bytes[i * 2 + 1].toInt()
                val sample = (high shl 8 or low).toShort()
                samples[i] = sample.toFloat() / Short.MAX_VALUE
            }

            samples
        } catch (e: Exception) {
            null
        }
    }

    private fun applyEffects(samples: FloatArray, config: TrackPlaybackConfig): FloatArray {
        var result = samples.clone()

        // Apply volume
        for (i in result.indices) {
            result[i] *= config.volume
        }

        // Apply simple 3-band EQ
        result = applyEq(result, config.eqBass, config.eqMids, config.eqTreble)

        // Apply compressor if enabled
        if (config.compressorEnabled) {
            result = applyCompressor(result)
        }

        return result
    }

    private fun applyEq(samples: FloatArray, bass: Float, mids: Float, treble: Float): FloatArray {
        if (samples.isEmpty()) return samples
        val output = FloatArray(samples.size)

        // Simple biquad-style EQ using weighted running averages
        // Bass: low-pass influence, Mids: band-pass, Treble: high-pass
        val bassGain = bass * 2f   // 0..1 maps to 0..2x gain
        val midsGain = mids * 2f
        val trebleGain = treble * 2f

        var lowPass = 0f
        var bandPass = 0f
        val cutoff = 0.05f // Low-pass cutoff factor

        for (i in samples.indices) {
            val input = samples[i]

            // Simple one-pole low-pass filter for bass
            lowPass += cutoff * (input - lowPass)
            val highPass = input - lowPass
            bandPass += cutoff * (highPass - bandPass)
            val mid = bandPass
            val high = highPass - bandPass

            output[i] = lowPass * bassGain + mid * midsGain + high * trebleGain
        }

        return output
    }

    private fun applyCompressor(samples: FloatArray): FloatArray {
        val output = samples.clone()
        val threshold = 0.5f
        val ratio = 4f
        var envelope = 0f
        val attack = 0.001f
        val release = 0.01f

        for (i in output.indices) {
            val abs = kotlin.math.abs(output[i])
            envelope = if (abs > envelope) {
                envelope + attack * (abs - envelope)
            } else {
                envelope + release * (abs - envelope)
            }

            if (envelope > threshold) {
                val gain = threshold + (envelope - threshold) / ratio
                output[i] *= gain / max(envelope, 0.0001f)
            }
        }

        return output
    }

    fun stop() {
        _isPlaying.value = false
        playbackJob?.cancel()
        playbackJob = null
        try {
            audioTrack?.stop()
            audioTrack?.release()
        } catch (_: Exception) {}
        audioTrack = null
    }

    fun release() {
        stop()
    }
}
