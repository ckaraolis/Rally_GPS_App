package com.rallygps.app

import android.content.Context
import org.json.JSONObject

object SessionStore {
    private const val PREFS = "rally_gps"
    private const val KEY = "session"

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

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
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
            .getString("serverUrl", "https://usgs-takes-liberty-counseling.trycloudflare.com")
            ?: "https://usgs-takes-liberty-counseling.trycloudflare.com"
    }
}
