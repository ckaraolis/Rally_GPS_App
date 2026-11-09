package com.rallygps.app

import android.content.Context
import android.location.Location
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

object FixQueue {
    private const val PREFS = "rally_gps"
    private const val KEY = "fix_queue"
    private const val MAX = 2500
    private const val MIN_METERS = 3.0
    private const val MIN_INTERVAL_MS = 1000L

    data class Fix(
        val lat: Double,
        val lon: Double,
        val heading: Float?,
        val speed: Float?,
        val accuracy: Float?,
        val ts: Long
    ) {
        fun toJson(): JSONObject {
            val json = JSONObject()
                .put("lat", lat)
                .put("lon", lon)
                .put("ts", ts)
            if (heading != null && !heading.isNaN()) json.put("heading", heading.toDouble())
            if (speed != null && !speed.isNaN()) json.put("speed", speed.toDouble())
            if (accuracy != null && !accuracy.isNaN()) json.put("accuracy", accuracy.toDouble())
            return json
        }

        companion object {
            fun from(location: Location): Fix {
                // Always stamp with device receive time. Bluetooth / mock GPS clocks
                // (e.g. Garmin GLO) are often minutes off; max-by-gps-time then kept
                // picking the start fix and HQ looked frozen while the car moved.
                return Fix(
                    lat = location.latitude,
                    lon = location.longitude,
                    heading = if (location.hasBearing()) location.bearing else null,
                    speed = if (location.hasSpeed()) location.speed else null,
                    accuracy = if (location.hasAccuracy()) location.accuracy else null,
                    ts = System.currentTimeMillis()
                )
            }

            fun fromJson(json: JSONObject): Fix {
                return Fix(
                    lat = json.getDouble("lat"),
                    lon = json.getDouble("lon"),
                    heading = if (json.has("heading")) json.getDouble("heading").toFloat() else null,
                    speed = if (json.has("speed")) json.getDouble("speed").toFloat() else null,
                    accuracy = if (json.has("accuracy")) json.getDouble("accuracy").toFloat() else null,
                    ts = json.optLong("ts", System.currentTimeMillis())
                )
            }
        }
    }

    // In-memory queue is authoritative while tracking. Disk writes are debounced so
    // live GPS never waits on serializing thousands of points (phone-only lag).
    private var memory: MutableList<Fix>? = null
    private var liveTip: Fix? = null
    private val persistExecutor = Executors.newSingleThreadExecutor()
    private val persistPending = AtomicBoolean(false)
    @Volatile private var appContext: Context? = null

    @Synchronized
    fun enqueue(context: Context, fix: Fix) {
        rememberContext(context)
        val queue = queue(context)
        val last = queue.lastOrNull()
        if (last != null && !shouldKeep(last, fix)) {
            queue[queue.lastIndex] = fix
        } else {
            queue.add(fix)
        }
        while (queue.size > MAX) queue.removeAt(0)
        liveTip = fix
        schedulePersist()
    }

    /** Take the live HQ tip without removing trail points. */
    @Synchronized
    fun takeLive(): Fix? {
        val tip = liveTip ?: return null
        liveTip = null
        return tip
    }

    /** Put a failed live tip back only if nothing newer arrived meanwhile. */
    @Synchronized
    fun restoreLive(fix: Fix) {
        val cur = liveTip
        if (cur == null || fix.ts >= cur.ts) liveTip = fix
    }

    @Synchronized
    fun peek(context: Context, limit: Int): List<Fix> {
        rememberContext(context)
        return queue(context).take(limit)
    }

    @Synchronized
    fun removeFirst(context: Context, count: Int) {
        if (count <= 0) return
        rememberContext(context)
        val queue = queue(context)
        repeat(minOf(count, queue.size)) { queue.removeAt(0) }
        schedulePersist()
    }

    @Synchronized
    fun size(context: Context): Int {
        rememberContext(context)
        return queue(context).size
    }

    /** Flush queue to disk now (call when tracking stops). */
    fun flushToDisk(context: Context) {
        rememberContext(context)
        val snapshot = synchronized(this) { queue(context).toList() }
        writePrefs(context.applicationContext, snapshot)
    }

    private fun rememberContext(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    private fun queue(context: Context): MutableList<Fix> {
        memory?.let { return it }
        val loaded = loadFromPrefs(context.applicationContext)
        memory = loaded
        return loaded
    }

    private fun shouldKeep(prev: Fix, next: Fix): Boolean {
        return meters(prev, next) >= MIN_METERS || next.ts - prev.ts >= MIN_INTERVAL_MS
    }

    private fun schedulePersist() {
        if (!persistPending.compareAndSet(false, true)) return
        persistExecutor.execute {
            try {
                Thread.sleep(500L)
            } catch (_: InterruptedException) {
                /* ignore */
            }
            persistPending.set(false)
            val ctx = appContext ?: return@execute
            val snapshot = synchronized(this) { memory?.toList() ?: return@execute }
            writePrefs(ctx, snapshot)
        }
    }

    private fun loadFromPrefs(context: Context): MutableList<Fix> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            ?: return mutableListOf()
        return try {
            val arr = JSONArray(raw)
            MutableList(arr.length()) { Fix.fromJson(arr.getJSONObject(it)) }
        } catch (_: Exception) {
            mutableListOf()
        }
    }

    private fun writePrefs(context: Context, queue: List<Fix>) {
        val arr = JSONArray()
        queue.forEach { arr.put(it.toJson()) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, arr.toString())
            .apply()
    }

    private fun meters(a: Fix, b: Fix): Double {
        val r = 6371000.0
        val dLat = Math.toRadians(b.lat - a.lat)
        val dLon = Math.toRadians(b.lon - a.lon)
        val lat1 = Math.toRadians(a.lat)
        val lat2 = Math.toRadians(b.lat)
        val h = sin(dLat / 2) * sin(dLat / 2) +
            cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * atan2(sqrt(h), sqrt(1 - h))
    }
}
