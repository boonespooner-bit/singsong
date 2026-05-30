package com.singsong.app.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.singsong.app.SingSongApplication
import com.singsong.app.audio.MultitrackPlayer
import com.singsong.app.audio.TrackPlaybackConfig
import com.singsong.app.data.Song
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class HomeViewModel(application: Application) : AndroidViewModel(application) {

    private val database = (application as SingSongApplication).database
    private val songDao = database.songDao()
    private val trackDao = database.trackDao()
    private val player = MultitrackPlayer()

    val songs: StateFlow<List<Song>> = songDao.getAllSongs()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _playingSongId = MutableStateFlow<Long?>(null)
    val playingSongId: StateFlow<Long?> = _playingSongId.asStateFlow()

    val isPlaying: StateFlow<Boolean> = player.isPlaying

    fun createNewSong(
        name: String,
        aiMode: Boolean = false,
        aiKey: String = "C",
        aiScale: String = "major",
        onCreated: (Long) -> Unit
    ) {
        viewModelScope.launch {
            val songId = songDao.insertSong(
                Song(
                    name = name,
                    aiMode = aiMode,
                    aiKey = aiKey,
                    aiScale = aiScale
                )
            )
            onCreated(songId)
        }
    }

    fun deleteSong(song: Song) {
        viewModelScope.launch {
            songDao.deleteSong(song)
        }
    }

    fun playSong(song: Song) {
        viewModelScope.launch {
            if (_playingSongId.value == song.id) {
                player.stop()
                _playingSongId.value = null
                return@launch
            }

            player.stop()
            _playingSongId.value = song.id

            val tracks = trackDao.getTracksForSong(song.id)
            val configs = mutableListOf<TrackPlaybackConfig>()

            tracks.collect { trackList ->
                configs.clear()
                for (track in trackList) {
                    if (track.filePath.isNotEmpty()) {
                        configs.add(
                            TrackPlaybackConfig(
                                trackId = track.id,
                                filePath = track.filePath,
                                volume = track.volume,
                                pan = track.pan,
                                eqBass = track.eqBass,
                                eqMids = track.eqMids,
                                eqTreble = track.eqTreble,
                                compressorEnabled = track.compressorEnabled,
                                muted = track.muted,
                                reverbMix = track.reverbMix,
                                delayMix = track.delayMix,
                                delayTime = track.delayTime,
                                chorusMix = track.chorusMix,
                                harmonizerMix = track.harmonizerMix,
                                harmonizerInterval = track.harmonizerInterval,
                                harmonizerDirection = track.harmonizerDirection
                            )
                        )
                    }
                }
                if (configs.isNotEmpty()) {
                    player.play(configs.toList())
                }
                return@collect
            }
        }
    }

    fun stopPlayback() {
        player.stop()
        _playingSongId.value = null
    }

    override fun onCleared() {
        super.onCleared()
        player.release()
    }
}
