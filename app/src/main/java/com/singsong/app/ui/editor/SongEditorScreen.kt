package com.singsong.app.ui.editor

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Compress
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Equalizer
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
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
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
    val showNewTrackDialog by viewModel.showNewTrackDialog.collectAsState()
    val showInviteDialog by viewModel.showInviteDialog.collectAsState()
    val showEqDialogTrackId by viewModel.showEqDialog.collectAsState()
    val collaborators by viewModel.collaborators.collectAsState()

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Text(
                        song?.name ?: "Song Editor",
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
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
                onNewTrack = { viewModel.showNewTrackDialog() },
                onStopRecording = { viewModel.stopRecording() },
                onPlayAll = { viewModel.playAllTracks() }
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
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Text(
                            "AI is transforming your recording...",
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }

            if (tracks.isEmpty()) {
                // Empty state for tracks
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
                            "Tap the mic button to add your first track",
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
                            onVolumeChange = { viewModel.updateTrackVolume(track.id, it) },
                            onShowEq = { viewModel.showEqDialog(track.id) },
                            onToggleCompressor = { viewModel.toggleCompressor(track.id) },
                            onDelete = { viewModel.deleteTrack(track) }
                        )
                    }

                    // Collaborators section
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
}

@Composable
private fun TrackCard(
    track: Track,
    isAiProcessing: Boolean,
    isRecording: Boolean,
    onVolumeChange: (Float) -> Unit,
    onShowEq: () -> Unit,
    onToggleCompressor: () -> Unit,
    onDelete: () -> Unit
) {
    var volume by remember(track.volume) { mutableFloatStateOf(track.volume) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isRecording)
                MaterialTheme.colorScheme.secondaryContainer
            else MaterialTheme.colorScheme.surface
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

                if (track.aiProcessed) {
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
                    Spacer(modifier = Modifier.width(8.dp))
                }

                if (isAiProcessing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp
                    )
                    Spacer(modifier = Modifier.width(8.dp))
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

            Spacer(modifier = Modifier.height(12.dp))

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
                // EQ button
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

                // Compressor button
                val compressorColor = if (track.compressorEnabled)
                    MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)

                OutlinedButton(
                    onClick = onToggleCompressor,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = compressorColor
                    )
                ) {
                    Icon(
                        Icons.Default.GraphicEq,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        if (track.compressorEnabled) "Comp ON" else "Comp OFF",
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
    onNewTrack: () -> Unit,
    onStopRecording: () -> Unit,
    onPlayAll: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
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

            // Add track button
            IconButton(
                onClick = onNewTrack,
                enabled = !isRecording && !isPlaying,
                modifier = Modifier
                    .size(56.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surface)
            ) {
                Icon(
                    Icons.Default.Add,
                    contentDescription = "Add track",
                    modifier = Modifier.size(28.dp),
                    tint = MaterialTheme.colorScheme.primary
                )
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
        title = {
            Text("EQ - ${track.name}")
        },
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
            Text(
                label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
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
