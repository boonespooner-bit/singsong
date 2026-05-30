package com.singsong.app.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.sin

enum class MetronomeNote(val displayName: String, val frequency: Float) {
    C("C", 261.63f),
    C_SHARP("C#", 277.18f),
    D("D", 293.66f),
    E_FLAT("Eb", 311.13f),
    E("E", 329.63f),
    F("F", 349.23f),
    F_SHARP("F#", 369.99f),
    G("G", 392.00f),
    A_FLAT("Ab", 415.30f),
    A("A", 440.00f),
    B_FLAT("Bb", 466.16f),
    B("B", 493.88f);
}

class Metronome {

    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.Default)

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

    private val _bpm = MutableStateFlow(120)
    val bpm: StateFlow<Int> = _bpm.asStateFlow()

    private val _note = MutableStateFlow<MetronomeNote?>(null)
    val note: StateFlow<MetronomeNote?> = _note.asStateFlow()

    private val _beat = MutableStateFlow(0)
    val beat: StateFlow<Int> = _beat.asStateFlow()

    fun setBpm(value: Int) {
        _bpm.value = value.coerceIn(40, 300)
    }

    fun setNote(value: MetronomeNote?) {
        _note.value = value
    }

    fun start() {
        if (_isRunning.value) return
        _isRunning.value = true
        _beat.value = 0

        job = scope.launch {
            val sampleRate = 44100
            val bufferSize = AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            val audioTrack = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            audioTrack.play()

            var beatCount = 0

            while (isActive && _isRunning.value) {
                val currentBpm = _bpm.value
                val intervalMs = (60_000L / currentBpm)

                _beat.value = beatCount % 4

                val clickSamples = generateClick(sampleRate, beatCount % 4 == 0)
                val buffer = ShortArray(clickSamples.size) { i ->
                    (clickSamples[i] * Short.MAX_VALUE).toInt()
                        .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
                }
                audioTrack.write(buffer, 0, buffer.size)

                beatCount++
                val clickDurationMs = (clickSamples.size * 1000L) / sampleRate
                val remainingMs = intervalMs - clickDurationMs
                if (remainingMs > 0) {
                    delay(remainingMs)
                }
            }

            audioTrack.stop()
            audioTrack.release()
        }
    }

    fun stop() {
        _isRunning.value = false
        job?.cancel()
        job = null
        _beat.value = 0
    }

    private fun generateClick(sampleRate: Int, isDownbeat: Boolean): FloatArray {
        val currentNote = _note.value

        return if (currentNote != null) {
            // Pitched note mode: triangle wave at note frequency
            val durationSamples = (sampleRate * 0.12f).toInt() // 120ms
            val frequency = if (isDownbeat) currentNote.frequency else currentNote.frequency * 0.5f
            FloatArray(durationSamples) { i ->
                val t = i.toFloat() / sampleRate
                val phase = (t * frequency) % 1.0f
                val triangle = 4f * kotlin.math.abs(phase - 0.5f) - 1f
                val envelope = if (i < 200) i / 200f else (1f - (i - 200f) / (durationSamples - 200f)).coerceAtLeast(0f)
                triangle * envelope * 0.6f
            }
        } else {
            // Click mode
            val durationSamples = (sampleRate * 0.03f).toInt() // 30ms
            val frequency = if (isDownbeat) 1500f else 1000f
            FloatArray(durationSamples) { i ->
                val t = i.toFloat() / sampleRate
                val envelope = 1f - (i.toFloat() / durationSamples)
                (sin(2.0 * PI * frequency * t).toFloat() * envelope * 0.7f)
            }
        }
    }

    fun release() {
        stop()
    }
}
