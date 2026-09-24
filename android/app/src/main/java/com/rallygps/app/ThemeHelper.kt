package com.rallygps.app

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate

object ThemeHelper {
    fun applyFromStore(context: Context) {
        val mode = if (SessionStore.isDarkTheme(context)) {
            AppCompatDelegate.MODE_NIGHT_YES
        } else {
            AppCompatDelegate.MODE_NIGHT_NO
        }
        AppCompatDelegate.setDefaultNightMode(mode)
    }

    fun setTheme(context: Context, dark: Boolean) {
        SessionStore.saveTheme(
            context,
            if (dark) SessionStore.THEME_DARK else SessionStore.THEME_LIGHT
        )
        applyFromStore(context)
    }
}
