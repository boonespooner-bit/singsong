package com.singsong.app.ui.editor

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Equalizer
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.singsong.app.audio.MetronomeNote
import com.singsong.app.data.Track
import com.singsong.app.data.TrackRole
import com.singsong.app.ui.components.AudioLevelIndicator
import com.singsong.app.ui.components.WaveformView

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SongEditorScreen(
    songId: Long,
    viewModel: SongEditorViewModel,
    onNavigateBack: () -> Unit
) {
    LaunchedEffect(songId) {
        viewModel.loadSong(songId)
    }

    val song by viewModel.song.collectAsState()
    val tracks by viewModel.tracks.collectAsState()
    val isRecording by viewModel.isRecording.collectAsState()
    val audioLevel by viewModel.audioLevel.collectAsState()
    val waveformData by viewModel.waveformData.collectAsState()
    val isPlaying by viewModel.isPlaying.collectAsState()
    val currentRecordingTrackId by viewModel.currentRecordingTrackId.collectAsState()
    val aiProcessingTrackId by viewModel.aiProcessingTrackId.collectAsState()
    val aiStatus by viewModel.aiStatus.collectAsState()
    val showNewTrackDialog by viewModel.showNewTrackDialog.collectAsState()
    val showInviteDialog by viewModel.showInviteDialog.collectAsState()
    val showEqDialogTrackId by viewModel.showEqDialog.collectAsState()
    val showFxDialogTrackId by viewModel.showFxDialog.collectAsState()
    val showAiTrackDialog by viewModel.showAiTrackDialog.collectAsState()
    val collaborators by viewModel.collaborators.collectAsState()
    val metronomeRunning by viewModel.metronome.isRunning.collectAsState()
    val metronomeBpm by viewModel.metronome.bpm.collectAsState()
    val metronomeNote by viewModel.metronome.note.collectAsState()
    val metronomeBeat by viewModel.metronome.beat.collectAsState()

    val hasSoloed = tracks.any { it.soloed }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            song?.name ?: "Song Editor",
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        if (song?.aiMode == true) {
                            Spacer(modifier = Modifier.width(8.dp))
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(MaterialTheme.colorScheme.tertiary.copy(alpha = 0.2f))
                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                            ) {
                                Text(
                                    "AI",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.tertiary,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.showInviteDialog() }) {
                        Icon(Icons.Default.PersonAdd, contentDescription = "Invite collaborator")
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        },
        bottomBar = {
            BottomControls(
                isRecording = isRecording,
                isPlaying = isPlaying,
                hasTracks = tracks.any { it.filePath.isNotEmpty() },
                metronomeRunning = metronomeRunning,
                metronomeBpm = metronomeBpm,
                metronomeBeat = metronomeBeat,
                onNewTrack = { viewModel.showNewTrackDialog() },
                onStopRecording = { viewModel.stopRecording() },
                onPlayAll = { viewModel.playAllTracks() },
                onToggleMetronome = {
                    if (metronomeRunning) viewModel.metronome.stop()
                    else viewModel.metronome.start()
                },
                onBpmChange = { viewModel.metronome.setBpm(it) },
                onAiTrack = { viewModel.showAiTrackDialog() }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            // Recording visualization
            AnimatedVisibility(visible = isRecording) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                ) {
                    val recordingTrack = tracks.find { it.id == currentRecordingTrackId }
                    Text(
                        "Recording: ${recordingTrack?.name ?: "Track"}",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.secondary,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    AudioLevelIndicator(
                        level = audioLevel,
                        activeColor = MaterialTheme.colorScheme.secondary
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    WaveformView(
                        waveformData = waveformData,
                        color = MaterialTheme.colorScheme.secondary
                    )
                }
            }

            // AI Processing indicator
            AnimatedVisibility(visible = aiProcessingTrackId != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer
                    )
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Text(
                            aiStatus.ifEmpty { "AI is processing..." },
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f)
                        )
                        IconButton(
                            onClick = { viewModel.cancelAiProcessing() },
                            modifier = Modifier.size(32.dp)
                        ) {
                            Icon(
                                Icons.Default.Close,
                                contentDescription = "Cancel",
                                modifier = Modifier.size(18.dp)
                            )
                        }
                    }
                }
            }

            if (tracks.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .weight(1f),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(
                            Icons.Default.Mic,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            "No tracks yet",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            "Tap the mic button to record or AI to generate",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                        )
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(tracks, key = { it.id }) { track ->
                        TrackCard(
                            track = track,
                            isAiProcessing = aiProcessingTrackId == track.id,
                            isRecording = currentRecordingTrackId == track.id,
                            isEffectivelyMuted = if (hasSoloed) !track.soloed else track.muted,
                            onVolumeChange = { viewModel.updateTrackVolume(track.id, it) },
                            onPanChange = { viewModel.updateTrackPan(track.id, it) },
                            onShowEq = { viewModel.showEqDialog(track.id) },
                            onShowFx = { viewModel.showFxDialog(track.id) },
                            onToggleCompressor = { viewModel.toggleCompressor(track.id) },
                            onToggleMute = { viewModel.toggleMute(track.id) },
                            onToggleSolo = { viewModel.toggleSolo(track.id) },
                            onDelete = { viewModel.deleteTrack(track) }
                        )
                    }

                    if (collaborators.isNotEmpty()) {
                        item {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                "Collaborators",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        items(collaborators) { collaborator ->
                            Card(
                                modifier = Modifier.fillMaxWidth(),
                                shape = RoundedCornerShape(12.dp)
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            collaborator.name,
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.Medium
                                        )
                                        Text(
                                            collaborator.email,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                    Text(
                                        if (collaborator.accepted) "Joined" else "Invited",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (collaborator.accepted)
                                            MaterialTheme.colorScheme.tertiary
                                        else MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    IconButton(
                                        onClick = { viewModel.removeCollaborator(collaborator) },
                                        modifier = Modifier.size(32.dp)
                                    ) {
                                        Icon(
                                            Icons.Default.Close,
                                            contentDescription = "Remove",
                                            modifier = Modifier.size(16.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Dialogs
    if (showNewTrackDialog) {
        NewTrackDialog(
            onDismiss = { viewModel.hideNewTrackDialog() },
            onCreate = { name, role -> viewModel.createTrack(name, role) }
        )
    }

    if (showInviteDialog) {
        InviteCollaboratorDialog(
            onDismiss = { viewModel.hideInviteDialog() },
            onInvite = { name, email -> viewModel.inviteCollaborator(name, email) }
        )
    }

    showEqDialogTrackId?.let { trackId ->
        val track = tracks.find { it.id == trackId }
        if (track != null) {
            EqDialog(
                track = track,
                onDismiss = { viewModel.hideEqDialog() },
                onApply = { bass, mids, treble ->
                    viewModel.updateTrackEq(trackId, bass, mids, treble)
                    viewModel.hideEqDialog()
                }
            )
        }
    }

    showFxDialogTrackId?.let { trackId ->
        val track = tracks.find { it.id == trackId }
        if (track != null) {
            FxDialog(
                track = track,
                onDismiss = { viewModel.hideFxDialog() },
                onApply = { reverb, delay, delayTime, chorus, harmMix, harmInterval, harmDir ->
                    viewModel.updateTrackFx(trackId, reverb, delay, delayTime, chorus, harmMix, harmInterval, harmDir)
                    viewModel.hideFxDialog()
                }
            )
        }
    }

    if (showAiTrackDialog) {
        AiTrackDialog(
            song = song,
            onDismiss = { viewModel.hideAiTrackDialog() },
            onGenerate = { instrument, role, description, bpm, temp, density, brightness ->
                viewModel.generateAiTrack(instrument, role, description, bpm, temp, density, brightness)
            }
        )
    }
}

@Composable
private fun TrackCard(
    track: Track,
    isAiProcessing: Boolean,
    isRecording: Boolean,
    isEffectivelyMuted: Boolean,
    onVolumeChange: (Float) -> Unit,
    onPanChange: (Float) -> Unit,
    onShowEq: () -> Unit,
    onShowFx: () -> Unit,
    onToggleCompressor: () -> Unit,
    onToggleMute: () -> Unit,
    onToggleSolo: () -> Unit,
    onDelete: () -> Unit
) {
    var volume by remember(track.volume) { mutableFloatStateOf(track.volume) }
    var pan by remember(track.pan) { mutableFloatStateOf(track.pan) }

    val cardAlpha = if (isEffectivelyMuted) 0.5f else 1f

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = when {
                isRecording -> MaterialTheme.colorScheme.secondaryContainer
                isEffectivelyMuted -> MaterialTheme.colorScheme.surface.copy(alpha = 0.6f)
                else -> MaterialTheme.colorScheme.surface
            }
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            // Track header
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Role badge
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.primaryContainer)
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        track.role.displayName,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer
                    )
                }

                Spacer(modifier = Modifier.width(8.dp))

                Text(
                    track.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )

                if (track.aiGenerated) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(MaterialTheme.colorScheme.tertiary.copy(alpha = 0.2f))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Default.AutoAwesome,
                                contentDescription = null,
                                modifier = Modifier.size(10.dp),
                                tint = MaterialTheme.colorScheme.tertiary
                            )
                            Spacer(modifier = Modifier.width(2.dp))
                            Text(
                                "AI Gen",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.tertiary,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                    Spacer(modifier = Modifier.width(4.dp))
                } else if (track.aiProcessed) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(MaterialTheme.colorScheme.tertiary.copy(alpha = 0.2f))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text(
                            "AI",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.tertiary,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Spacer(modifier = Modifier.width(4.dp))
                }

                if (isAiProcessing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                }

                IconButton(
                    onClick = onDelete,
                    modifier = Modifier.size(32.dp)
                ) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "Delete track",
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.error.copy(alpha = 0.7f)
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Mute / Solo row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Mute button
                IconButton(
                    onClick = onToggleMute,
                    modifier = Modifier.size(36.dp),
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = if (track.muted)
                            MaterialTheme.colorScheme.error.copy(alpha = 0.15f)
                        else MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Icon(
                        if (track.muted) Icons.AutoMirrored.Filled.VolumeOff
                        else Icons.AutoMirrored.Filled.VolumeUp,
                        contentDescription = if (track.muted) "Unmute" else "Mute",
                        modifier = Modifier.size(18.dp),
                        tint = if (track.muted) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // Solo button
                IconButton(
                    onClick = onToggleSolo,
                    modifier = Modifier.size(36.dp),
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = if (track.soloed)
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                        else MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Icon(
                        Icons.Default.Headphones,
                        contentDescription = if (track.soloed) "Unsolo" else "Solo",
                        modifier = Modifier.size(18.dp),
                        tint = if (track.soloed) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Spacer(modifier = Modifier.weight(1f))

                // Pan label
                Text(
                    "Pan",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Slider(
                    value = pan,
                    onValueChange = { pan = it },
                    onValueChangeFinished = { onPanChange(pan) },
                    valueRange = -1f..1f,
                    modifier = Modifier.width(100.dp),
                    colors = SliderDefaults.colors(
                        thumbColor = MaterialTheme.colorScheme.primary,
                        activeTrackColor = MaterialTheme.colorScheme.primary
                    )
                )
                Text(
                    when {
                        pan < -0.05f -> "L${(-pan * 100).toInt()}"
                        pan > 0.05f -> "R${(pan * 100).toInt()}"
                        else -> "C"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.width(32.dp)
                )
            }

            // Volume slider
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "Vol",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.width(28.dp)
                )
                Slider(
                    value = volume,
                    onValueChange = { volume = it },
                    onValueChangeFinished = { onVolumeChange(volume) },
                    modifier = Modifier.weight(1f),
                    colors = SliderDefaults.colors(
                        thumbColor = MaterialTheme.colorScheme.primary,
                        activeTrackColor = MaterialTheme.colorScheme.primary
                    )
                )
                Text(
                    "${(volume * 100).toInt()}%",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.width(36.dp)
                )
            }

            // Controls row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                FilledTonalButton(
                    onClick = onShowEq,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
                ) {
                    Icon(
                        Icons.Default.Equalizer,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("EQ", style = MaterialTheme.typography.labelSmall)
                }

                // FX button
                val hasFx = track.reverbMix > 0 || track.delayMix > 0 || track.chorusMix > 0 || track.harmonizerMix > 0
                OutlinedButton(
                    onClick = onShowFx,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = if (hasFx) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                    )
                ) {
                    Icon(
                        Icons.Default.Tune,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        if (hasFx) "FX ON" else "FX",
                        style = MaterialTheme.typography.labelSmall
                    )
                }

                // Compressor button
                val compressorColor = if (track.compressorEnabled)
                    MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)

                OutlinedButton(
                    onClick = onToggleCompressor,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = compressorColor)
                ) {
                    Icon(
                        Icons.Default.GraphicEq,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        if (track.compressorEnabled) "Comp" else "Comp",
                        style = MaterialTheme.typography.labelSmall
                    )
                }
            }
        }
    }
}

@Composable
private fun BottomControls(
    isRecording: Boolean,
    isPlaying: Boolean,
    hasTracks: Boolean,
    metronomeRunning: Boolean,
    metronomeBpm: Int,
    metronomeBeat: Int,
    onNewTrack: () -> Unit,
    onStopRecording: () -> Unit,
    onPlayAll: () -> Unit,
    onToggleMetronome: () -> Unit,
    onBpmChange: (Int) -> Unit,
    onAiTrack: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            // Metronome row
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                IconButton(
                    onClick = onToggleMetronome,
                    modifier = Modifier.size(36.dp),
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = if (metronomeRunning)
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                        else MaterialTheme.colorScheme.surface
                    )
                ) {
                    Icon(
                        Icons.Default.Timer,
                        contentDescription = "Metronome",
                        modifier = Modifier.size(20.dp),
                        tint = if (metronomeRunning) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // BPM display
                Text(
                    "$metronomeBpm",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    "BPM",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                )

                Slider(
                    value = metronomeBpm.toFloat(),
                    onValueChange = { onBpmChange(it.toInt()) },
                    valueRange = 40f..300f,
                    modifier = Modifier.weight(1f),
                    colors = SliderDefaults.colors(
                        thumbColor = MaterialTheme.colorScheme.primary,
                        activeTrackColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)
                    )
                )

                // Beat indicator
                if (metronomeRunning) {
                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        repeat(4) { i ->
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (i == metronomeBeat) MaterialTheme.colorScheme.primary
                                        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f)
                                    )
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Transport controls
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Play all button
                IconButton(
                    onClick = onPlayAll,
                    enabled = hasTracks && !isRecording,
                    modifier = Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(
                            if (isPlaying) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.surface
                        )
                ) {
                    Icon(
                        if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                        contentDescription = if (isPlaying) "Stop playback" else "Play all tracks",
                        modifier = Modifier.size(28.dp),
                        tint = if (isPlaying) MaterialTheme.colorScheme.onPrimary
                        else MaterialTheme.colorScheme.primary
                    )
                }

                // Record / Stop button
                if (isRecording) {
                    IconButton(
                        onClick = onStopRecording,
                        modifier = Modifier
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.error)
                    ) {
                        Icon(
                            Icons.Default.Stop,
                            contentDescription = "Stop recording",
                            modifier = Modifier.size(36.dp),
                            tint = MaterialTheme.colorScheme.onError
                        )
                    }
                } else {
                    IconButton(
                        onClick = onNewTrack,
                        enabled = !isPlaying,
                        modifier = Modifier
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.secondary)
                    ) {
                        Icon(
                            Icons.Default.Mic,
                            contentDescription = "New track",
                            modifier = Modifier.size(36.dp),
                            tint = MaterialTheme.colorScheme.onSecondary
                        )
                    }
                }

                // AI Generate button
                IconButton(
                    onClick = onAiTrack,
                    enabled = !isRecording && !isPlaying,
                    modifier = Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.tertiary.copy(alpha = 0.15f))
                ) {
                    Icon(
                        Icons.Default.AutoAwesome,
                        contentDescription = "AI Generate",
                        modifier = Modifier.size(28.dp),
                        tint = MaterialTheme.colorScheme.tertiary
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewTrackDialog(
    onDismiss: () -> Unit,
    onCreate: (String, TrackRole) -> Unit
) {
    var trackName by remember { mutableStateOf("") }
    var selectedRole by remember { mutableStateOf(TrackRole.VOCALS) }
    var expanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New Track") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = trackName,
                    onValueChange = { trackName = it },
                    label = { Text("Track Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                ExposedDropdownMenuBox(
                    expanded = expanded,
                    onExpandedChange = { expanded = it }
                ) {
                    OutlinedTextField(
                        value = selectedRole.displayName,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Instrument / Role") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor()
                    )

                    ExposedDropdownMenu(
                        expanded = expanded,
                        onDismissRequest = { expanded = false }
                    ) {
                        TrackRole.entries.forEach { role ->
                            DropdownMenuItem(
                                text = { Text(role.displayName) },
                                onClick = {
                                    selectedRole = role
                                    expanded = false
                                }
                            )
                        }
                    }
                }

                if (selectedRole != TrackRole.VOCALS && selectedRole != TrackRole.OTHER) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f)
                        )
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                Icons.Default.GraphicEq,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                                tint = MaterialTheme.colorScheme.primary
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                "AI will transform your recording to sound like ${selectedRole.displayName.lowercase()}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onCreate(trackName, selectedRole) },
                enabled = trackName.isNotBlank()
            ) {
                Text("Create & Record")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun EqDialog(
    track: Track,
    onDismiss: () -> Unit,
    onApply: (Float, Float, Float) -> Unit
) {
    var bass by remember { mutableFloatStateOf(track.eqBass) }
    var mids by remember { mutableFloatStateOf(track.eqMids) }
    var treble by remember { mutableFloatStateOf(track.eqTreble) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("EQ - ${track.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                EqSlider("Bass", bass) { bass = it }
                EqSlider("Mids", mids) { mids = it }
                EqSlider("Treble", treble) { treble = it }
            }
        },
        confirmButton = {
            Button(onClick = { onApply(bass, mids, treble) }) {
                Text("Apply")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun EqSlider(
    label: String,
    value: Float,
    onValueChange: (Float) -> Unit
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(
                "${((value - 0.5f) * 24).toInt()} dB",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Slider(
            value = value,
            onValueChange = onValueChange,
            colors = SliderDefaults.colors(
                thumbColor = MaterialTheme.colorScheme.primary,
                activeTrackColor = MaterialTheme.colorScheme.primary
            )
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FxDialog(
    track: Track,
    onDismiss: () -> Unit,
    onApply: (Float, Float, Float, Float, Float, Int, String) -> Unit
) {
    var reverbMix by remember { mutableFloatStateOf(track.reverbMix) }
    var delayMix by remember { mutableFloatStateOf(track.delayMix) }
    var delayTime by remember { mutableFloatStateOf(track.delayTime) }
    var chorusMix by remember { mutableFloatStateOf(track.chorusMix) }
    var harmonizerMix by remember { mutableFloatStateOf(track.harmonizerMix) }
    var harmonizerInterval by remember { mutableIntStateOf(track.harmonizerInterval) }
    var harmonizerDirection by remember { mutableStateOf(track.harmonizerDirection) }
    var intervalExpanded by remember { mutableStateOf(false) }
    var directionExpanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Effects - ${track.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Reverb
                FxSlider("Reverb", reverbMix) { reverbMix = it }

                // Delay
                FxSlider("Delay", delayMix) { delayMix = it }

                if (delayMix > 0f) {
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text("Delay Time", style = MaterialTheme.typography.bodySmall)
                            Text(
                                "${(delayTime * 1000).toInt()} ms",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Slider(
                            value = delayTime,
                            onValueChange = { delayTime = it },
                            valueRange = 0.05f..1f
                        )
                    }
                }

                // Chorus
                FxSlider("Chorus", chorusMix) { chorusMix = it }

                // Harmonizer
                FxSlider("Harmonizer", harmonizerMix) { harmonizerMix = it }

                if (harmonizerMix > 0f) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        // Interval selector
                        ExposedDropdownMenuBox(
                            expanded = intervalExpanded,
                            onExpandedChange = { intervalExpanded = it },
                            modifier = Modifier.weight(1f)
                        ) {
                            OutlinedTextField(
                                value = if (harmonizerInterval == 5) "5th" else "3rd",
                                onValueChange = {},
                                readOnly = true,
                                label = { Text("Interval") },
                                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(intervalExpanded) },
                                modifier = Modifier.menuAnchor()
                            )
                            ExposedDropdownMenu(
                                expanded = intervalExpanded,
                                onDismissRequest = { intervalExpanded = false }
                            ) {
                                DropdownMenuItem(
                                    text = { Text("3rd") },
                                    onClick = {
                                        harmonizerInterval = 3
                                        intervalExpanded = false
                                    }
                                )
                                DropdownMenuItem(
                                    text = { Text("5th") },
                                    onClick = {
                                        harmonizerInterval = 5
                                        intervalExpanded = false
                                    }
                                )
                            }
                        }

                        // Direction selector
                        ExposedDropdownMenuBox(
                            expanded = directionExpanded,
                            onExpandedChange = { directionExpanded = it },
                            modifier = Modifier.weight(1f)
                        ) {
                            OutlinedTextField(
                                value = harmonizerDirection.replaceFirstChar { it.uppercase() },
                                onValueChange = {},
                                readOnly = true,
                                label = { Text("Direction") },
                                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(directionExpanded) },
                                modifier = Modifier.menuAnchor()
                            )
                            ExposedDropdownMenu(
                                expanded = directionExpanded,
                                onDismissRequest = { directionExpanded = false }
                            ) {
                                DropdownMenuItem(
                                    text = { Text("Above") },
                                    onClick = {
                                        harmonizerDirection = "above"
                                        directionExpanded = false
                                    }
                                )
                                DropdownMenuItem(
                                    text = { Text("Below") },
                                    onClick = {
                                        harmonizerDirection = "below"
                                        directionExpanded = false
                                    }
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                onApply(reverbMix, delayMix, delayTime, chorusMix, harmonizerMix, harmonizerInterval, harmonizerDirection)
            }) {
                Text("Apply")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun FxSlider(
    label: String,
    value: Float,
    onValueChange: (Float) -> Unit
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(
                "${(value * 100).toInt()}%",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Slider(
            value = value,
            onValueChange = onValueChange,
            colors = SliderDefaults.colors(
                thumbColor = MaterialTheme.colorScheme.primary,
                activeTrackColor = MaterialTheme.colorScheme.primary
            )
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiTrackDialog(
    song: com.singsong.app.data.Song?,
    onDismiss: () -> Unit,
    onGenerate: (String, TrackRole, String, Int, Float, Float, Float) -> Unit
) {
    var selectedRole by remember { mutableStateOf(TrackRole.GUITAR) }
    var roleExpanded by remember { mutableStateOf(false) }
    var description by remember { mutableStateOf("") }
    var bpm by remember { mutableIntStateOf(120) }
    var temperature by remember { mutableFloatStateOf(1.0f) }
    var density by remember { mutableFloatStateOf(0.5f) }
    var brightness by remember { mutableFloatStateOf(0.5f) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.AutoAwesome,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.size(24.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text("AI Generate Track")
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Instrument selector
                ExposedDropdownMenuBox(
                    expanded = roleExpanded,
                    onExpandedChange = { roleExpanded = it }
                ) {
                    OutlinedTextField(
                        value = selectedRole.displayName,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Instrument") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(roleExpanded) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor()
                    )
                    ExposedDropdownMenu(
                        expanded = roleExpanded,
                        onDismissRequest = { roleExpanded = false }
                    ) {
                        TrackRole.entries.forEach { role ->
                            DropdownMenuItem(
                                text = { Text(role.displayName) },
                                onClick = {
                                    selectedRole = role
                                    roleExpanded = false
                                }
                            )
                        }
                    }
                }

                // Description
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("Style Description (optional)") },
                    placeholder = { Text("e.g. funky bass groove, soft piano ballad") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 2
                )

                // BPM
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("Tempo", style = MaterialTheme.typography.bodyMedium)
                        Text("$bpm BPM", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Slider(
                        value = bpm.toFloat(),
                        onValueChange = { bpm = it.toInt() },
                        valueRange = 40f..240f
                    )
                }

                // Temperature (randomness)
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("Randomness", style = MaterialTheme.typography.bodyMedium)
                        Text("${(temperature * 100).toInt()}%", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Slider(value = temperature, onValueChange = { temperature = it })
                }

                // Density
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("Density", style = MaterialTheme.typography.bodyMedium)
                        Text("${(density * 100).toInt()}%", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Slider(value = density, onValueChange = { density = it })
                }

                // Brightness
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("Brightness", style = MaterialTheme.typography.bodyMedium)
                        Text("${(brightness * 100).toInt()}%", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Slider(value = brightness, onValueChange = { brightness = it })
                }

                if (song != null) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant
                        )
                    ) {
                        Row(
                            modifier = Modifier.padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                Icons.Default.MusicNote,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                "Key: ${song.aiKey} ${song.aiScale}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                onGenerate(
                    selectedRole.displayName.lowercase(),
                    selectedRole,
                    description,
                    bpm,
                    temperature,
                    density,
                    brightness
                )
            }) {
                Icon(
                    Icons.Default.AutoAwesome,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp)
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text("Generate")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun InviteCollaboratorDialog(
    onDismiss: () -> Unit,
    onInvite: (String, String) -> Unit
) {
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Invite Collaborator") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Invite someone to collaborate on this song. They'll be able to add their own tracks.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onInvite(name, email) },
                enabled = name.isNotBlank() && email.contains("@")
            ) {
                Text("Send Invite")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}
