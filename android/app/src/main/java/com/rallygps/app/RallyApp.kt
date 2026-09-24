package com.rallygps.app

import android.app.Application

class RallyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ThemeHelper.applyFromStore(this)
    }
}
