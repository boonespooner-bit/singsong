package com.singsong.app.ui.editor

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.singsong.app.SingSongApplication
import com.singsong.app.audio.AiTrackGenerator
import com.singsong.app.audio.AudioAiService
import com.singsong.app.audio.AudioRecorder
import com.singsong.app.audio.Metronome
import com.singsong.app.audio.MetronomeNote
import com.singsong.app.audio.MultitrackPlayer
import com.singsong.app.audio.TrackPlaybackConfig
import com.singsong.app.data.Collaborator
import com.singsong.app.data.Song
import com.singsong.app.data.Track
import com.singsong.app.data.TrackRole
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

class SongEditorViewModel(application: Application) : AndroidViewModel(application) {

    private val database = (application as SingSongApplication).database
    private val songDao = database.songDao()
    private val trackDao = database.trackDao()
    private val collaboratorDao = database.collaboratorDao()
    val recorder = AudioRecorder(application)
    private val player = MultitrackPlayer()
    private val aiService = AudioAiService()
    private val aiGenerator = AiTrackGenerator()
    val metronome = Metronome()

    private val _songId = MutableStateFlow(0L)

    private val _song = MutableStateFlow<Song?>(null)
    val song: StateFlow<Song?> = _song.asStateFlow()

    private val _tracks = MutableStateFlow<List<Track>>(emptyList())
    val tracks: StateFlow<List<Track>> = _tracks.asStateFlow()

    private val _collaborators = MutableStateFlow<List<Collaborator>>(emptyList())
    val collaborators: StateFlow<List<Collaborator>> = _collaborators.asStateFlow()

    val isRecording: StateFlow<Boolean> = recorder.isRecording
    val audioLevel: StateFlow<Float> = recorder.audioLevel
    val waveformData: StateFlow<List<Float>> = recorder.waveformData
    val isPlaying: StateFlow<Boolean> = player.isPlaying
    val playbackProgress: StateFlow<Float> = player.playbackProgress

    private val _currentRecordingTrackId = MutableStateFlow<Long?>(null)
    val currentRecordingTrackId: StateFlow<Long?> = _currentRecordingTrackId.asStateFlow()

    private val _aiProcessingTrackId = MutableStateFlow<Long?>(null)
    val aiProcessingTrackId: StateFlow<Long?> = _aiProcessingTrackId.asStateFlow()

    private val _aiStatus = MutableStateFlow("")
    val aiStatus: StateFlow<String> = _aiStatus.asStateFlow()

    private var aiJob: Job? = null

    private val _showNewTrackDialog = MutableStateFlow(false)
    val showNewTrackDialog: StateFlow<Boolean> = _showNewTrackDialog.asStateFlow()

    private val _showInviteDialog = MutableStateFlow(false)
    val showInviteDialog: StateFlow<Boolean> = _showInviteDialog.asStateFlow()

    private val _showEqDialog = MutableStateFlow<Long?>(null)
    val showEqDialog: StateFlow<Long?> = _showEqDialog.asStateFlow()

    private val _showFxDialog = MutableStateFlow<Long?>(null)
    val showFxDialog: StateFlow<Long?> = _showFxDialog.asStateFlow()

    private val _showAiTrackDialog = MutableStateFlow(false)
    val showAiTrackDialog: StateFlow<Boolean> = _showAiTrackDialog.asStateFlow()

    // Mute/Solo state tracked in Track entity directly

    fun loadSong(songId: Long) {
        _songId.value = songId
        viewModelScope.launch {
            _song.value = songDao.getSongById(songId)
        }
        viewModelScope.launch {
            trackDao.getTracksForSong(songId).collect { trackList ->
                _tracks.value = trackList
            }
        }
        viewModelScope.launch {
            collaboratorDao.getCollaboratorsForSong(songId).collect { collabList ->
                _collaborators.value = collabList
            }
        }
    }

    fun showNewTrackDialog() { _showNewTrackDialog.value = true }
    fun hideNewTrackDialog() { _showNewTrackDialog.value = false }
    fun showInviteDialog() { _showInviteDialog.value = true }
    fun hideInviteDialog() { _showInviteDialog.value = false }
    fun showEqDialog(trackId: Long) { _showEqDialog.value = trackId }
    fun hideEqDialog() { _showEqDialog.value = null }
    fun showFxDialog(trackId: Long) { _showFxDialog.value = trackId }
    fun hideFxDialog() { _showFxDialog.value = null }
    fun showAiTrackDialog() { _showAiTrackDialog.value = true }
    fun hideAiTrackDialog() { _showAiTrackDialog.value = false }

    fun createTrack(name: String, role: TrackRole) {
        viewModelScope.launch {
            val trackId = trackDao.insertTrack(
                Track(songId = _songId.value, name = name, role = role)
            )
            _showNewTrackDialog.value = false
            startRecording(trackId)
        }
    }

    fun startRecording(trackId: Long) {
        viewModelScope.launch {
            trackDao.getTrackById(trackId) ?: return@launch
            val audioDir = File(getApplication<SingSongApplication>().filesDir, "audio")
            val filePath = File(audioDir, "track_${trackId}_raw.wav").absolutePath

            _currentRecordingTrackId.value = trackId
            recorder.startRecording(filePath)
        }
    }

    fun stopRecording() {
        viewModelScope.launch {
            val filePath = recorder.stopRecording() ?: return@launch
            val trackId = _currentRecordingTrackId.value ?: return@launch
            _currentRecordingTrackId.value = null

            val track = trackDao.getTrackById(trackId) ?: return@launch
            val song = _song.value

            if (track.role != TrackRole.VOCALS && track.role != TrackRole.OTHER) {
                _aiProcessingTrackId.value = trackId
                _aiStatus.value = "Transforming audio..."

                val outputPath = File(
                    getApplication<SingSongApplication>().filesDir,
                    "audio/track_${trackId}.wav"
                ).absolutePath

                when (val result = aiService.transformAudio(filePath, track.role, outputPath)) {
                    is AudioAiService.TransformResult.Success -> {
                        trackDao.updateTrack(track.copy(filePath = result.outputPath, aiProcessed = true))
                    }
                    is AudioAiService.TransformResult.Error -> {
                        trackDao.updateTrack(track.copy(filePath = filePath))
                    }
                }
                _aiProcessingTrackId.value = null
                _aiStatus.value = ""
            } else {
                trackDao.updateTrack(track.copy(filePath = filePath))
            }

            _song.value?.let { songDao.updateSong(it.copy(updatedAt = System.currentTimeMillis())) }
        }
    }

    fun cancelAiProcessing() {
        aiJob?.cancel()
        aiJob = null
        _aiProcessingTrackId.value = null
        _aiStatus.value = ""
    }

    fun updateTrackVolume(trackId: Long, volume: Float) {
        viewModelScope.launch {
            val track = trackDao.getTrackById(trackId) ?: return@launch
            trackDao.updateTrack(track.copy(volume = volume))
        }
    }

    fun updateTrackPan(trackId: Long, pan: Float) {
        viewModelScope.launch {
            val track = trackDao.getTrackById(trackId) ?: return@launch
            trackDao.updateTrack(track.copy(pan = pan))
        }
    }

    fun updateTrackEq(trackId: Long, bass: Float, mids: Float, treble: Float) {
        viewModelScope.launch {
            val track = trackDao.getTrackById(trackId) ?: return@launch
            trackDao.updateTrack(track.copy(eqBass = bass, eqMids = mids, eqTreble = treble))
        }
    }

    fun toggleCompressor(trackId: Long) {
        viewModelScope.launch {
            val track = trackDao.getTrackById(trackId) ?: return@launch
            trackDao.updateTrack(track.copy(compressorEnabled = !track.compressorEnabled))
        }
    }

    fun updateTrackFx(
        trackId: Long,
        reverbMix: Float,
        delayMix: Float,
        delayTime: Float,
        chorusMix: Float,
        harmonizerMix: Float,
        harmonizerInterval: Int,
        harmonizerDirection: String
    ) {
        viewModelScope.launch {
            val track = trackDao.getTrackById(trackId) ?: return@launch
            trackDao.updateTrack(
                track.copy(
                    reverbMix = reverbMix,
                    delayMix = delayMix,
                    delayTime = delayTime,
                    chorusMix = chorusMix,
                    harmonizerMix = harmonizerMix,
                    harmonizerInterval = harmonizerInterval,
                    harmonizerDirection = harmonizerDirection
                )
            )
        }
    }

    fun toggleMute(trackId: Long) {
        viewModelScope.launch {
            val track = trackDao.getTrackById(trackId) ?: return@launch
            trackDao.updateTrack(track.copy(muted = !track.muted))
        }
    }

    fun toggleSolo(trackId: Long) {
        viewModelScope.launch {
            val track = trackDao.getTrackById(trackId) ?: return@launch
            val newSoloed = !track.soloed
            trackDao.updateTrack(track.copy(soloed = newSoloed))
        }
    }

    fun deleteTrack(track: Track) {
        viewModelScope.launch {
            if (track.filePath.isNotEmpty()) {
                File(track.filePath).delete()
            }
            trackDao.deleteTrack(track)
        }
    }

    fun playAllTracks() {
        val trackList = _tracks.value
        if (trackList.isEmpty()) return

        if (player.isPlaying.value) {
            player.stop()
            return
        }

        val hasSoloed = trackList.any { it.soloed }

        val configs = trackList.filter { it.filePath.isNotEmpty() }.map { track ->
            val effectiveMuted = if (hasSoloed) !track.soloed else track.muted

            TrackPlaybackConfig(
                trackId = track.id,
                filePath = track.filePath,
                volume = track.volume,
                pan = track.pan,
                eqBass = track.eqBass,
                eqMids = track.eqMids,
                eqTreble = track.eqTreble,
                compressorEnabled = track.compressorEnabled,
                muted = effectiveMuted,
                reverbMix = track.reverbMix,
                delayMix = track.delayMix,
                delayTime = track.delayTime,
                chorusMix = track.chorusMix,
                harmonizerMix = track.harmonizerMix,
                harmonizerInterval = track.harmonizerInterval,
                harmonizerDirection = track.harmonizerDirection
            )
        }

        if (configs.isNotEmpty()) {
            player.play(configs)
        }
    }

    fun generateAiTrack(
        instrument: String,
        role: TrackRole,
        description: String,
        bpm: Int,
        temperature: Float,
        density: Float,
        brightness: Float
    ) {
        val song = _song.value ?: return
        _showAiTrackDialog.value = false

        aiJob = viewModelScope.launch {
            val trackId = trackDao.insertTrack(
                Track(
                    songId = _songId.value,
                    name = "$instrument (AI)",
                    role = role,
                    aiGenerated = true,
                    aiProcessed = true
                )
            )

            _aiProcessingTrackId.value = trackId
            _aiStatus.value = "Preparing..."

            val existingBase64 = _tracks.value
                .filter { it.filePath.isNotEmpty() && it.id != trackId }
                .mapNotNull { track ->
                    val file = File(track.filePath)
                    if (file.exists()) aiGenerator.fileToBase64(file) else null
                }

            val outputPath = File(
                getApplication<SingSongApplication>().filesDir,
                "audio/track_${trackId}.wav"
            ).absolutePath

            val options = AiTrackGenerator.GenerateOptions(
                instrument = instrument,
                bpm = bpm,
                key = song.aiKey,
                scale = song.aiScale,
                durationSeconds = 30,
                description = description,
                temperature = temperature,
                density = density,
                brightness = brightness,
                existingTracksBase64 = existingBase64
            )

            when (val result = aiGenerator.generateTrack(options, outputPath) { status ->
                _aiStatus.value = status
            }) {
                is AiTrackGenerator.GenerateResult.Success -> {
                    val track = trackDao.getTrackById(trackId)
                    if (track != null) {
                        trackDao.updateTrack(track.copy(filePath = result.outputPath))
                    }
                }
                is AiTrackGenerator.GenerateResult.Error -> {
                    _aiStatus.value = "Error: ${result.message}"
                }
            }

            _aiProcessingTrackId.value = null
            _aiStatus.value = ""
            _song.value?.let { songDao.updateSong(it.copy(updatedAt = System.currentTimeMillis())) }
        }
    }

    fun inviteCollaborator(name: String, email: String) {
        viewModelScope.launch {
            collaboratorDao.insertCollaborator(
                Collaborator(songId = _songId.value, name = name, email = email)
            )
            _showInviteDialog.value = false
        }
    }

    fun removeCollaborator(collaborator: Collaborator) {
        viewModelScope.launch {
            collaboratorDao.deleteCollaborator(collaborator)
        }
    }

    override fun onCleared() {
        super.onCleared()
        recorder.release()
        player.release()
        metronome.release()
    }
}
