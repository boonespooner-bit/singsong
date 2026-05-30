package com.singsong.app.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [Song::class, Track::class, Collaborator::class],
    version = 2,
    exportSchema = false
)
abstract class SingSongDatabase : RoomDatabase() {
    abstract fun songDao(): SongDao
    abstract fun trackDao(): TrackDao
    abstract fun collaboratorDao(): CollaboratorDao

    companion object {
        @Volatile
        private var INSTANCE: SingSongDatabase? = null

        fun getDatabase(context: Context): SingSongDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    SingSongDatabase::class.java,
                    "singsong_database"
                )
                    .fallbackToDestructiveMigration()
                    .build()
                INSTANCE = instance
                instance
            }
        }
    }
}
