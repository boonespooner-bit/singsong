package com.singsong.app

import android.app.Application
import com.singsong.app.data.SingSongDatabase

class SingSongApplication : Application() {
    val database: SingSongDatabase by lazy {
        SingSongDatabase.getDatabase(this)
    }
}
