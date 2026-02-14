package com.singsong.app.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

class AudioRecorder(private val context: Context) {

    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null

    private val _isRecording = MutableStateFlow(false)
    val isRecording: StateFlow<Boolean> = _isRecording.asStateFlow()

    private val _audioLevel = MutableStateFlow(0f)
    val audioLevel: StateFlow<Float> = _audioLevel.asStateFlow()

    private val _waveformData = MutableStateFlow<List<Float>>(emptyList())
    val waveformData: StateFlow<List<Float>> = _waveformData.asStateFlow()

    private var outputFile: File? = null

    companion object {
        private const val SAMPLE_RATE = 44100
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }

    fun hasPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    suspend fun startRecording(outputPath: String): Boolean = withContext(Dispatchers.IO) {
        if (!hasPermission()) return@withContext false

        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        if (bufferSize == AudioRecord.ERROR_BAD_VALUE || bufferSize == AudioRecord.ERROR) {
            return@withContext false
        }

        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize * 2
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                audioRecord?.release()
                audioRecord = null
                return@withContext false
            }

            outputFile = File(outputPath)
            outputFile?.parentFile?.mkdirs()

            audioRecord?.startRecording()
            _isRecording.value = true
            _waveformData.value = emptyList()

            recordingThread = Thread {
                writeAudioDataToFile(bufferSize)
            }
            recordingThread?.start()

            true
        } catch (e: SecurityException) {
            false
        }
    }

    private fun writeAudioDataToFile(bufferSize: Int) {
        val buffer = ShortArray(bufferSize)
        val outputStream = FileOutputStream(outputFile)
        val waveformSamples = mutableListOf<Float>()

        // Write WAV header placeholder (will be updated when recording stops)
        val headerBytes = ByteArray(44)
        outputStream.write(headerBytes)

        var totalBytesWritten = 0L

        try {
            while (_isRecording.value) {
                val readCount = audioRecord?.read(buffer, 0, bufferSize) ?: 0
                if (readCount > 0) {
                    // Calculate audio level (RMS)
                    var sum = 0.0
                    for (i in 0 until readCount) {
                        sum += buffer[i].toDouble() * buffer[i].toDouble()
                    }
                    val rms = sqrt(sum / readCount)
                    val db = if (rms > 0) 20 * log10(rms / Short.MAX_VALUE) else -100.0
                    val normalizedLevel = ((db + 100) / 100).toFloat().coerceIn(0f, 1f)
                    _audioLevel.value = normalizedLevel

                    // Add waveform sample (downsample for display)
                    val maxAmplitude = buffer.take(readCount).maxOfOrNull { abs(it.toInt()) } ?: 0
                    val normalizedAmplitude = maxAmplitude.toFloat() / Short.MAX_VALUE
                    waveformSamples.add(normalizedAmplitude)
                    _waveformData.value = waveformSamples.toList()

                    // Write PCM data
                    val byteBuffer = ByteArray(readCount * 2)
                    for (i in 0 until readCount) {
                        byteBuffer[i * 2] = (buffer[i].toInt() and 0xFF).toByte()
                        byteBuffer[i * 2 + 1] = (buffer[i].toInt() shr 8 and 0xFF).toByte()
                    }
                    outputStream.write(byteBuffer)
                    totalBytesWritten += byteBuffer.size
                }
            }
        } finally {
            outputStream.close()
        }

        // Update WAV header with correct sizes
        writeWavHeader(totalBytesWritten)
    }

    private fun writeWavHeader(totalAudioBytes: Long) {
        val file = outputFile ?: return
        val raf = RandomAccessFile(file, "rw")

        val totalDataLen = totalAudioBytes + 36
        val channels = 1
        val byteRate = SAMPLE_RATE * channels * 2L
        val blockAlign = channels * 2

        raf.seek(0)
        raf.writeBytes("RIFF")
        raf.writeIntLE(totalDataLen.toInt())
        raf.writeBytes("WAVE")
        raf.writeBytes("fmt ")
        raf.writeIntLE(16) // Sub-chunk size
        raf.writeShortLE(1) // PCM format
        raf.writeShortLE(channels) // Mono
        raf.writeIntLE(SAMPLE_RATE)
        raf.writeIntLE(byteRate.toInt())
        raf.writeShortLE(blockAlign)
        raf.writeShortLE(16) // Bits per sample
        raf.writeBytes("data")
        raf.writeIntLE(totalAudioBytes.toInt())

        raf.close()
    }

    fun stopRecording(): String? {
        _isRecording.value = false
        _audioLevel.value = 0f

        try {
            recordingThread?.join(2000)
        } catch (_: InterruptedException) {}

        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        recordingThread = null

        return outputFile?.absolutePath
    }

    fun release() {
        stopRecording()
    }
}

// Extension functions for writing little-endian values
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
