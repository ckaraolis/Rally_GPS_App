package com.rallygps.app

import android.content.Context
import org.json.JSONObject

object SessionStore {
    private const val PREFS = "rally_gps"
    private const val KEY = "session"
    private const val KEY_TRACKING = "trackingWanted"
    private const val KEY_STOP_LOCK_KNOWN = "stopLockKnown"
    private const val KEY_STOP_LOCK = "stopLock"
    private const val KEY_THEME = "themeMode"

    const val THEME_DARK = "dark"
    const val THEME_LIGHT = "light"

    fun save(context: Context, session: Session) {
        val json = JSONObject()
            .put("serverUrl", session.serverUrl)
            .put("id", session.id)
            .put("token", session.token)
            .put("carNumber", session.carNumber)
            .put("driverName", session.driverName)
            .put("color", session.color)
            .toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, json)
            .apply()
    }

    fun load(context: Context): Session? {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            ?: return null
        return try {
            val json = JSONObject(raw)
            Session(
                serverUrl = json.getString("serverUrl"),
                id = json.getString("id"),
                token = json.getString("token"),
                carNumber = json.getString("carNumber"),
                driverName = json.getString("driverName"),
                color = json.optString("color", "#ff7a18")
            )
        } catch (_: Exception) {
            null
        }
    }

    fun setTrackingWanted(context: Context, wanted: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_TRACKING, wanted)
            .apply()
    }

    fun trackingWanted(context: Context): Boolean {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_TRACKING, false)
    }

    fun setStopLock(context: Context, locked: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_STOP_LOCK_KNOWN, true)
            .putBoolean(KEY_STOP_LOCK, locked)
            .apply()
    }

    fun clearStopLockKnown(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_STOP_LOCK_KNOWN)
            .remove(KEY_STOP_LOCK)
            .apply()
    }

    fun stopLock(context: Context): Boolean? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_STOP_LOCK_KNOWN, false)) return null
        return prefs.getBoolean(KEY_STOP_LOCK, false)
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY)
            .putBoolean(KEY_TRACKING, false)
            .remove(KEY_STOP_LOCK_KNOWN)
            .remove(KEY_STOP_LOCK)
            .apply()
    }

    fun saveServerUrl(context: Context, url: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("serverUrl", url)
            .apply()
    }

    fun loadServerUrl(context: Context): String {
        // Prefer the baked-in public HTTPS server so the APK works on any network.
        if (ServerConfig.DEFAULT_PUBLIC_URL.isNotBlank()) {
            return ServerConfig.DEFAULT_PUBLIC_URL
        }
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("serverUrl", "https://rallygpsapp.vercel.app")
            ?: "https://rallygpsapp.vercel.app"
    }

    fun saveTheme(context: Context, theme: String) {
        val mode = if (theme == THEME_LIGHT) THEME_LIGHT else THEME_DARK
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_THEME, mode)
            .apply()
    }

    fun loadTheme(context: Context): String {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_THEME, THEME_DARK)
            ?: THEME_DARK
    }

    fun isDarkTheme(context: Context): Boolean = loadTheme(context) != THEME_LIGHT
}
