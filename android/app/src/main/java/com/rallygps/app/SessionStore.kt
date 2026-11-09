package com.rallygps.app

import android.content.Context
import org.json.JSONObject

object SessionStore {
    private const val PREFS = "rally_gps"
    private const val KEY = "session"
    private const val KEY_TRACKING = "trackingWanted"
    private const val KEY_STOP_LOCK_KNOWN = "stopLockKnown"
    private const val KEY_STOP_LOCK = "stopLock"
    private const val KEY_STOP_SALT = "stopSalt"
    private const val KEY_STOP_OFFLINE = "stopOffline"
    private const val KEY_THEME = "themeMode"
    private const val KEY_TRIP_ENABLED = "tripMeterEnabled"
    private const val KEY_TRIP_METERS = "tripMeterMeters"
    private const val KEY_TRIP_LAST_LAT = "tripMeterLastLat"
    private const val KEY_TRIP_LAST_LON = "tripMeterLastLon"
    private const val KEY_TRIP_HAS_LAST = "tripMeterHasLast"

    const val THEME_DARK = "dark"
    const val THEME_LIGHT = "light"

    /** Ignore GPS jitter below this; reject teleport jumps above this. */
    private const val TRIP_MIN_STEP_M = 2.0
    private const val TRIP_MAX_STEP_M = 250.0

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

    fun setStopLock(context: Context, locked: Boolean, salt: String? = null, offline: String? = null) {
        val edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_STOP_LOCK_KNOWN, true)
            .putBoolean(KEY_STOP_LOCK, locked)
        if (locked && !salt.isNullOrBlank() && !offline.isNullOrBlank()) {
            edit.putString(KEY_STOP_SALT, salt).putString(KEY_STOP_OFFLINE, offline)
        } else if (!locked) {
            edit.remove(KEY_STOP_SALT).remove(KEY_STOP_OFFLINE)
        }
        edit.apply()
    }

    fun clearStopLockKnown(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_STOP_LOCK_KNOWN)
            .remove(KEY_STOP_LOCK)
            .remove(KEY_STOP_SALT)
            .remove(KEY_STOP_OFFLINE)
            .apply()
    }

    fun stopLock(context: Context): Boolean? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_STOP_LOCK_KNOWN, false)) return null
        return prefs.getBoolean(KEY_STOP_LOCK, false)
    }

    fun stopUnlockSalt(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_STOP_SALT, null)

    fun stopUnlockOffline(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_STOP_OFFLINE, null)

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY)
            .putBoolean(KEY_TRACKING, false)
            .remove(KEY_STOP_LOCK_KNOWN)
            .remove(KEY_STOP_LOCK)
            .remove(KEY_STOP_SALT)
            .remove(KEY_STOP_OFFLINE)
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

    fun tripMeterEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_TRIP_ENABLED, false)

    fun setTripMeterEnabled(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val edit = prefs.edit().putBoolean(KEY_TRIP_ENABLED, enabled)
        // Re-anchor on the next fix so enabling mid-drive does not jump.
        edit.putBoolean(KEY_TRIP_HAS_LAST, false)
            .remove(KEY_TRIP_LAST_LAT)
            .remove(KEY_TRIP_LAST_LON)
            .apply()
    }

    fun tripMeterMeters(context: Context): Double =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getFloat(KEY_TRIP_METERS, 0f)
            .toDouble()
            .coerceAtLeast(0.0)

    fun resetTripMeter(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putFloat(KEY_TRIP_METERS, 0f)
            .putBoolean(KEY_TRIP_HAS_LAST, false)
            .remove(KEY_TRIP_LAST_LAT)
            .remove(KEY_TRIP_LAST_LON)
            .apply()
    }

    /**
     * Add distance from the previous GPS fix when trip meter is on.
     * Returns the current total metres (unchanged if disabled).
     */
    fun addTripFix(context: Context, lat: Double, lon: Double): Double {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_TRIP_ENABLED, false)) {
            return prefs.getFloat(KEY_TRIP_METERS, 0f).toDouble().coerceAtLeast(0.0)
        }
        if (!lat.isFinite() || !lon.isFinite()) {
            return prefs.getFloat(KEY_TRIP_METERS, 0f).toDouble().coerceAtLeast(0.0)
        }
        var meters = prefs.getFloat(KEY_TRIP_METERS, 0f).toDouble().coerceAtLeast(0.0)
        val hasLast = prefs.getBoolean(KEY_TRIP_HAS_LAST, false)
        if (hasLast) {
            val prevLat = prefs.getFloat(KEY_TRIP_LAST_LAT, 0f).toDouble()
            val prevLon = prefs.getFloat(KEY_TRIP_LAST_LON, 0f).toDouble()
            val step = haversineMeters(prevLat, prevLon, lat, lon)
            if (step >= TRIP_MIN_STEP_M && step <= TRIP_MAX_STEP_M) {
                meters += step
            }
        }
        prefs.edit()
            .putFloat(KEY_TRIP_METERS, meters.toFloat())
            .putBoolean(KEY_TRIP_HAS_LAST, true)
            .putFloat(KEY_TRIP_LAST_LAT, lat.toFloat())
            .putFloat(KEY_TRIP_LAST_LON, lon.toFloat())
            .apply()
        return meters
    }

    fun formatTripKm(meters: Double): String {
        val km = (meters.coerceAtLeast(0.0) / 1000.0)
        return String.format(java.util.Locale.US, "%.2f km", km)
    }

    private fun haversineMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6371000.0
        val p1 = Math.toRadians(lat1)
        val p2 = Math.toRadians(lat2)
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
        return 2 * r * Math.asin(Math.sqrt(a))
    }
}
