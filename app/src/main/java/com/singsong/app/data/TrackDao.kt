package com.singsong.app.data

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface TrackDao {
    @Query("SELECT * FROM tracks WHERE songId = :songId ORDER BY createdAt ASC")
    fun getTracksForSong(songId: Long): Flow<List<Track>>

    @Query("SELECT * FROM tracks WHERE id = :trackId")
    suspend fun getTrackById(trackId: Long): Track?

    @Insert
    suspend fun insertTrack(track: Track): Long

    @Update
    suspend fun updateTrack(track: Track)

    @Delete
    suspend fun deleteTrack(track: Track)

    @Query("SELECT COUNT(*) FROM tracks WHERE songId = :songId")
    suspend fun getTrackCountForSong(songId: Long): Int
}
