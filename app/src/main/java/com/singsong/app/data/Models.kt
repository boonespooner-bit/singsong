package com.singsong.app.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

enum class TrackRole(val displayName: String) {
    VOCALS("Vocals"),
    GUITAR("Guitar"),
    BASS("Bass"),
    DRUMS("Drums"),
    PIANO("Piano"),
    SYNTH("Synth"),
    STRINGS("Strings"),
    OTHER("Other")
}

@Entity(tableName = "songs")
data class Song(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val name: String,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
    val aiMode: Boolean = false,
    val aiKey: String = "C",
    val aiScale: String = "major"
)

@Entity(
    tableName = "tracks",
    foreignKeys = [
        ForeignKey(
            entity = Song::class,
            parentColumns = ["id"],
            childColumns = ["songId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("songId")]
)
data class Track(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val songId: Long,
    val name: String,
    val role: TrackRole,
    val filePath: String = "",
    val volume: Float = 0.8f,
    val eqBass: Float = 0.5f,
    val eqMids: Float = 0.5f,
    val eqTreble: Float = 0.5f,
    val compressorEnabled: Boolean = false,
    val aiProcessed: Boolean = false,
    val createdAt: Long = System.currentTimeMillis(),
    val pan: Float = 0f,
    val reverbMix: Float = 0f,
    val delayMix: Float = 0f,
    val delayTime: Float = 0.3f,
    val chorusMix: Float = 0f,
    val harmonizerMix: Float = 0f,
    val harmonizerInterval: Int = 3,
    val harmonizerDirection: String = "above",
    val aiGenerated: Boolean = false,
    val muted: Boolean = false,
    val soloed: Boolean = false
)

@Entity(
    tableName = "collaborators",
    foreignKeys = [
        ForeignKey(
            entity = Song::class,
            parentColumns = ["id"],
            childColumns = ["songId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("songId")]
)
data class Collaborator(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val songId: Long,
    val name: String,
    val email: String,
    val invitedAt: Long = System.currentTimeMillis(),
    val accepted: Boolean = false
)
