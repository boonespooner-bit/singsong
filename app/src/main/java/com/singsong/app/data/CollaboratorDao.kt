package com.singsong.app.data

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface CollaboratorDao {
    @Query("SELECT * FROM collaborators WHERE songId = :songId ORDER BY invitedAt DESC")
    fun getCollaboratorsForSong(songId: Long): Flow<List<Collaborator>>

    @Insert
    suspend fun insertCollaborator(collaborator: Collaborator): Long

    @Delete
    suspend fun deleteCollaborator(collaborator: Collaborator)
}
