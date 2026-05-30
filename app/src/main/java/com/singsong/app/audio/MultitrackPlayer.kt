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
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.PI

data class TrackPlaybackConfig(
    val trackId: Long,
    val filePath: String,
    val volume: Float = 0.8f,
    val pan: Float = 0f,
    val eqBass: Float = 0.5f,
    val eqMids: Float = 0.5f,
    val eqTreble: Float = 0.5f,
    val compressorEnabled: Boolean = false,
    val muted: Boolean = false,
    val reverbMix: Float = 0f,
    val delayMix: Float = 0f,
    val delayTime: Float = 0.3f,
    val chorusMix: Float = 0f,
    val harmonizerMix: Float = 0f,
    val harmonizerInterval: Int = 3,
    val harmonizerDirection: String = "above"
)

class MultitrackPlayer {

    private var audioTrack: AudioTrack? = null
    private var playbackJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

    private val _playbackProgress = MutableStateFlow(0f)
    val playbackProgress: StateFlow<Float> = _playbackProgress.asStateFlow()

    private val _currentPositionMs = MutableStateFlow(0L)
    val currentPositionMs: StateFlow<Long> = _currentPositionMs.asStateFlow()

    companion object {
        const val SAMPLE_RATE = 44100
        private const val BUFFER_SIZE = 4096
    }

    fun play(tracks: List<TrackPlaybackConfig>, startPositionMs: Long = 0) {
        if (tracks.isEmpty()) return
        stop()

        _isPlaying.value = true

        playbackJob = scope.launch {
            try {
                playMixed(tracks, startPositionMs)
            } finally {
                _isPlaying.value = false
                _playbackProgress.value = 0f
            }
        }
    }

    private fun playMixed(tracks: List<TrackPlaybackConfig>, startPositionMs: Long) {
        val trackSamples = tracks.mapNotNull { config ->
            if (config.muted) return@mapNotNull null
            val file = File(config.filePath)
            if (!file.exists()) return@mapNotNull null
            val samples = readWavSamples(file) ?: return@mapNotNull null
            config to samples
        }

        if (trackSamples.isEmpty()) return

        val maxLength = trackSamples.maxOf { it.second.size }

        // Mix to stereo
        val mixedLeft = FloatArray(maxLength)
        val mixedRight = FloatArray(maxLength)

        for ((config, samples) in trackSamples) {
            val processed = applyEffects(samples, config)

            // Pan law: equal power panning
            val panAngle = (config.pan + 1f) / 2f * (PI / 2f)
            val leftGain = cos(panAngle).toFloat()
            val rightGain = sin(panAngle).toFloat()

            for (i in processed.indices) {
                mixedLeft[i] += processed[i] * leftGain
                mixedRight[i] += processed[i] * rightGain
            }
        }

        // Normalize stereo
        var maxVal = 0f
        for (i in 0 until maxLength) {
            maxVal = max(maxVal, abs(mixedLeft[i]))
            maxVal = max(maxVal, abs(mixedRight[i]))
        }
        if (maxVal > 1f) {
            for (i in 0 until maxLength) {
                mixedLeft[i] /= maxVal
                mixedRight[i] /= maxVal
            }
        }

        // Interleave L/R into stereo 16-bit PCM
        val stereoLength = maxLength * 2
        val pcmBuffer = ShortArray(stereoLength)
        for (i in 0 until maxLength) {
            pcmBuffer[i * 2] = (mixedLeft[i] * Short.MAX_VALUE).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            pcmBuffer[i * 2 + 1] = (mixedRight[i] * Short.MAX_VALUE).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }

        val bufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_STEREO,
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
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize * 2)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        audioTrack?.play()

        val startSample = ((startPositionMs * SAMPLE_RATE) / 1000).toInt().coerceIn(0, maxLength)
        var offset = startSample * 2 // stereo offset

        while (offset < pcmBuffer.size && _isPlaying.value) {
            val remaining = pcmBuffer.size - offset
            val writeSize = min(BUFFER_SIZE, remaining)
            audioTrack?.write(pcmBuffer, offset, writeSize)
            offset += writeSize
            _playbackProgress.value = (offset / 2f) / maxLength
            _currentPositionMs.value = ((offset / 2L) * 1000L) / SAMPLE_RATE
        }

        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
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

    private fun applyEffects(samples: FloatArray, config: TrackPlaybackConfig): FloatArray {
        var result = samples.clone()

        // Volume
        for (i in result.indices) {
            result[i] *= config.volume
        }

        // EQ
        result = applyEq(result, config.eqBass, config.eqMids, config.eqTreble)

        // Compressor
        if (config.compressorEnabled) {
            result = applyCompressor(result)
        }

        // Reverb
        if (config.reverbMix > 0f) {
            result = applyReverb(result, config.reverbMix)
        }

        // Delay
        if (config.delayMix > 0f) {
            result = applyDelay(result, config.delayMix, config.delayTime)
        }

        // Chorus
        if (config.chorusMix > 0f) {
            result = applyChorus(result, config.chorusMix)
        }

        // Harmonizer
        if (config.harmonizerMix > 0f) {
            result = applyHarmonizer(result, config.harmonizerMix, config.harmonizerInterval, config.harmonizerDirection)
        }

        return result
    }

    private fun applyEq(samples: FloatArray, bass: Float, mids: Float, treble: Float): FloatArray {
        if (samples.isEmpty()) return samples
        val output = FloatArray(samples.size)

        val bassGain = bass * 2f
        val midsGain = mids * 2f
        val trebleGain = treble * 2f

        var lowPass = 0f
        var bandPass = 0f
        val cutoff = 0.05f

        for (i in samples.indices) {
            val input = samples[i]
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
            val absVal = abs(output[i])
            envelope = if (absVal > envelope) {
                envelope + attack * (absVal - envelope)
            } else {
                envelope + release * (absVal - envelope)
            }
            if (envelope > threshold) {
                val gain = threshold + (envelope - threshold) / ratio
                output[i] *= gain / max(envelope, 0.0001f)
            }
        }
        return output
    }

    private fun applyReverb(samples: FloatArray, mix: Float): FloatArray {
        val output = samples.clone()
        val delays = intArrayOf(1557, 1617, 1491, 1422, 1277, 1356)
        val gains = floatArrayOf(0.7f, 0.68f, 0.72f, 0.66f, 0.74f, 0.69f)

        val reverbBuffer = FloatArray(samples.size)

        for (d in delays.indices) {
            val delaySamples = delays[d]
            val feedback = gains[d]
            val buffer = FloatArray(delaySamples)
            var bufIdx = 0
            for (i in samples.indices) {
                val delayed = buffer[bufIdx]
                val input = samples[i] + delayed * feedback
                buffer[bufIdx] = input
                reverbBuffer[i] += delayed / delays.size
                bufIdx = (bufIdx + 1) % delaySamples
            }
        }

        for (i in output.indices) {
            output[i] = output[i] * (1f - mix) + reverbBuffer[i] * mix
        }
        return output
    }

    private fun applyDelay(samples: FloatArray, mix: Float, delayTime: Float): FloatArray {
        val output = samples.clone()
        val delaySamples = (delayTime * SAMPLE_RATE).toInt().coerceAtLeast(1)
        val feedback = 0.4f

        val buffer = FloatArray(delaySamples)
        var bufIdx = 0

        for (i in output.indices) {
            val delayed = buffer[bufIdx]
            buffer[bufIdx] = output[i] + delayed * feedback
            output[i] = output[i] * (1f - mix) + delayed * mix
            bufIdx = (bufIdx + 1) % delaySamples
        }
        return output
    }

    private fun applyChorus(samples: FloatArray, mix: Float): FloatArray {
        val output = FloatArray(samples.size)
        val maxDelay = (0.03f * SAMPLE_RATE).toInt() // 30ms max delay
        val lfoRate = 0.5f // Hz
        val buffer = FloatArray(maxDelay + 1)
        var writeIdx = 0

        for (i in samples.indices) {
            buffer[writeIdx] = samples[i]

            val lfo = sin(2.0 * PI * lfoRate * i / SAMPLE_RATE).toFloat()
            val delaySamples = ((lfo + 1f) / 2f * maxDelay).toInt()
            var readIdx = writeIdx - delaySamples
            if (readIdx < 0) readIdx += buffer.size

            val delayed = buffer[readIdx]
            output[i] = samples[i] * (1f - mix) + delayed * mix

            writeIdx = (writeIdx + 1) % buffer.size
        }
        return output
    }

    private fun applyHarmonizer(
        samples: FloatArray,
        mix: Float,
        interval: Int,
        direction: String
    ): FloatArray {
        // interval: 3 = major 3rd (4 semitones), 5 = perfect 5th (7 semitones)
        val semitones = if (interval == 5) 7 else 4
        val shift = if (direction == "below") -semitones else semitones
        val rate = 2.0.pow(shift / 12.0)

        val output = FloatArray(samples.size)
        for (i in samples.indices) {
            val srcIdx = i * rate
            val idx0 = srcIdx.toInt()
            val frac = (srcIdx - idx0).toFloat()
            val harmSample = if (idx0 + 1 < samples.size) {
                samples[idx0] * (1f - frac) + samples[idx0 + 1] * frac
            } else if (idx0 < samples.size) {
                samples[idx0]
            } else {
                0f
            }
            output[i] = samples[i] * (1f - mix) + harmSample * mix
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
