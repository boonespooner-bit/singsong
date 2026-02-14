package com.singsong.app.audio

import com.singsong.app.data.TrackRole
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import java.io.RandomAccessFile
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * Service that transforms recorded audio to match the selected instrument/role.
 *
 * In production, this would connect to an Audio AI API (e.g., a model like
 * Meta's MusicGen, Google's MusicLM, or a custom voice-to-instrument model).
 * For now, this applies DSP transformations to simulate the effect.
 */
class AudioAiService {

    sealed class TransformResult {
        data class Success(val outputPath: String) : TransformResult()
        data class Error(val message: String) : TransformResult()
    }

    /**
     * Transforms the audio file at [inputPath] to sound like the given [role].
     * Returns the path to the transformed file.
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

            val samples = readWavSamples(inputFile)
                ?: return@withContext TransformResult.Error("Failed to read audio file")

            // Apply role-specific transformation
            val transformed = when (role) {
                TrackRole.VOCALS -> samples // Keep vocals as-is
                TrackRole.GUITAR -> transformToGuitar(samples)
                TrackRole.BASS -> transformToBass(samples)
                TrackRole.DRUMS -> transformToDrums(samples)
                TrackRole.PIANO -> transformToPiano(samples)
                TrackRole.SYNTH -> transformToSynth(samples)
                TrackRole.STRINGS -> transformToStrings(samples)
                TrackRole.OTHER -> samples
            }

            // Simulate AI processing time
            delay(1500)

            // Write transformed audio
            writeWavFile(transformed, File(outputPath))

            TransformResult.Success(outputPath)
        } catch (e: Exception) {
            TransformResult.Error("Transform failed: ${e.message}")
        }
    }

    private fun transformToGuitar(samples: FloatArray): FloatArray {
        val output = FloatArray(samples.size)
        // Simulate guitar: add mild distortion + harmonic content
        for (i in samples.indices) {
            var s = samples[i]
            // Soft clipping distortion
            s *= 1.5f
            s = if (s > 0) 1f - kotlin.math.exp(-s.toDouble()).toFloat()
            else -(1f - kotlin.math.exp(s.toDouble()).toFloat())
            // Add subtle harmonics
            if (i > 0) {
                s += samples[i] * 0.3f * sin(2.0 * PI * i / 100).toFloat()
            }
            output[i] = s * 0.7f
        }
        return output
    }

    private fun transformToBass(samples: FloatArray): FloatArray {
        val output = FloatArray(samples.size)
        // Low-pass filter to simulate bass frequencies
        var prev = 0f
        val alpha = 0.15f // Strong low-pass
        for (i in samples.indices) {
            prev = prev + alpha * (samples[i] - prev)
            // Pitch shift down by doubling samples (simple octave-down)
            val idx = i / 2
            val bassSample = if (idx < samples.size) samples[idx] else 0f
            output[i] = (prev * 0.4f + bassSample * 0.6f) * 1.2f
        }
        return output
    }

    private fun transformToDrums(samples: FloatArray): FloatArray {
        val output = FloatArray(samples.size)
        // Emphasize transients and add punch
        for (i in samples.indices) {
            val current = abs(samples[i])
            val prev = if (i > 0) abs(samples[i - 1]) else 0f
            val transient = (current - prev).coerceAtLeast(0f)
            // Boost transients, compress sustain
            output[i] = samples[i] * 0.5f + transient * 3f * samples[i].let { if (it >= 0) 1f else -1f }
            // Add sub-bass thump
            output[i] += transient * sin(2.0 * PI * 60 * i / 44100.0).toFloat() * 0.3f
        }
        return output
    }

    private fun transformToPiano(samples: FloatArray): FloatArray {
        val output = FloatArray(samples.size)
        // Simulate piano: clean tone with natural decay
        for (i in samples.indices) {
            val decay = kotlin.math.exp(-i.toDouble() / (samples.size * 0.8)).toFloat()
            output[i] = samples[i] * decay
            // Add harmonic shimmer
            if (i > 1) {
                output[i] += samples[i] * 0.15f * cos(2.0 * PI * i / 50).toFloat()
            }
        }
        return output
    }

    private fun transformToSynth(samples: FloatArray): FloatArray {
        val output = FloatArray(samples.size)
        // Synth: quantize amplitude + add oscillation
        for (i in samples.indices) {
            // Bit-crush style quantization
            val quantized = (samples[i] * 8).toInt() / 8f
            // LFO modulation
            val lfo = sin(2.0 * PI * 5 * i / 44100.0).toFloat() * 0.2f
            output[i] = (quantized + lfo * quantized) * 0.8f
        }
        return output
    }

    private fun transformToStrings(samples: FloatArray): FloatArray {
        val output = FloatArray(samples.size)
        // Strings: smooth with vibrato
        for (i in samples.indices) {
            val vibrato = sin(2.0 * PI * 6 * i / 44100.0).toFloat() * 0.01f
            val idx = (i + (vibrato * 100).toInt()).coerceIn(0, samples.size - 1)
            // Smoothing filter
            val smooth = if (i > 2) {
                (samples[idx] + output[i - 1] + output[i - 2]) / 3f
            } else {
                samples[idx]
            }
            output[i] = smooth * 0.9f
        }
        return output
    }

    private fun readWavSamples(file: File): FloatArray? {
        return try {
            val raf = RandomAccessFile(file, "r")
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

    private fun writeWavFile(samples: FloatArray, file: File) {
        file.parentFile?.mkdirs()
        val raf = RandomAccessFile(file, "rw")
        val dataSize = samples.size * 2
        val totalSize = dataSize + 36

        // WAV header
        raf.writeBytes("RIFF")
        raf.writeIntLE(totalSize)
        raf.writeBytes("WAVE")
        raf.writeBytes("fmt ")
        raf.writeIntLE(16)
        raf.writeShortLE(1)
        raf.writeShortLE(1) // Mono
        raf.writeIntLE(44100)
        raf.writeIntLE(44100 * 2)
        raf.writeShortLE(2)
        raf.writeShortLE(16)
        raf.writeBytes("data")
        raf.writeIntLE(dataSize)

        // Write samples
        for (sample in samples) {
            val s = (sample * Short.MAX_VALUE).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            raf.write(s.toInt() and 0xFF)
            raf.write(s.toInt() shr 8 and 0xFF)
        }

        raf.close()
    }
}

private fun RandomAccessFile.writeIntLE(value: Int) {
    write(value and 0xFF)
    write(value shr 8 and 0xFF)
    write(value shr 16 and 0xFF)
    write(value shr 24 and 0xFF)
}

private fun RandomAccessFile.writeShortLE(value: Int) {
    write(value and 0xFF)
    write(value shr 8 and 0xFF)
}
