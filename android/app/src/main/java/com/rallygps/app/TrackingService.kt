package com.rallygps.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.Granularity
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.util.concurrent.Executors

class TrackingService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }
    private var api: RallyApi? = null
    private var session: Session? = null
    private var lastLocation: Location? = null
    private var lastPingOkAt = 0L
    private var wakeLock: PowerManager.WakeLock? = null
    private var flushing = false
    @Volatile private var running = false

    private val pollRunnable = object : Runnable {
        override fun run() {
            pollAndRefresh()
            handler.postDelayed(this, 4000L)
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            executor.execute { flushQueue() }
        }
    }

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            lastLocation = location
            val heading = if (location.hasBearing()) location.bearing else null
            val speed = if (location.hasSpeed()) location.speed else null
            val accuracy = if (location.hasAccuracy()) location.accuracy else null
            broadcast(
                tracking = true,
                lat = location.latitude,
                lon = location.longitude,
                speed = speed,
                heading = heading,
                accuracy = accuracy,
                sent = false
            )
            queueAndFlush(location)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopTracking()
                return START_NOT_STICKY
            }
            ACTION_CREW_STATUS -> {
                val status = intent.getStringExtra(EXTRA_CREW_STATUS) ?: return START_STICKY
                val current = session ?: SessionStore.load(this)
                val client = api ?: current?.let { RallyApi(it.serverUrl) }
                if (current != null && client != null) {
                    executor.execute {
                        runCatching { client.crewStatus(current.id, current.token, status) }
                    }
                }
                return START_STICKY
            }
            ACTION_FLAG_ACK -> {
                val current = session ?: SessionStore.load(this)
                val client = api ?: current?.let { RallyApi(it.serverUrl) }
                if (current != null && client != null) {
                    executor.execute {
                        runCatching { client.ackFlag(current.id, current.token) }
                    }
                }
                return START_STICKY
            }
            else -> startTracking()
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (running && SessionStore.load(this) != null) {
            val restart = Intent(applicationContext, TrackingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(restart)
            } else {
                startService(restart)
            }
        }
        super.onTaskRemoved(rootIntent)
    }

    private fun startTracking() {
        val current = SessionStore.load(this)
        if (current == null) {
            stopSelf()
            return
        }
        session = current
        api = RallyApi(current.serverUrl)
        running = true
        fused.removeLocationUpdates(locationCallback)
        handler.removeCallbacks(pollRunnable)
        unregisterNetworkCallback()

        createChannel()
        val notification = buildNotification()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            } else {
                0
            }
        )
        acquireWakeLock()
        registerNetworkCallback()

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000L)
            .setMinUpdateIntervalMillis(1000L)
            .setMinUpdateDistanceMeters(0f)
            .setMaxUpdateDelayMillis(2000L)
            .setWaitForAccurateLocation(false)
            .setGranularity(Granularity.GRANULARITY_FINE)
            .build()

        try {
            fused.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
            broadcast(tracking = true)
            handler.removeCallbacks(pollRunnable)
            handler.postDelayed(pollRunnable, 4000L)
            executor.execute { flushQueue() }
        } catch (error: SecurityException) {
            broadcast(tracking = false, error = "Location permission missing")
            stopSelf()
        }
    }

    private fun stopTracking() {
        running = false
        handler.removeCallbacks(pollRunnable)
        fused.removeLocationUpdates(locationCallback)
        unregisterNetworkCallback()
        releaseWakeLock()
        val current = session
        val client = api
        if (current != null && client != null) {
            executor.execute {
                flushQueue()
                runCatching { client.stop(current.id, current.token) }
            }
        }
        broadcast(tracking = false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacks(pollRunnable)
        fused.removeLocationUpdates(locationCallback)
        unregisterNetworkCallback()
        releaseWakeLock()
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun pollAndRefresh() {
        if (wakeLock?.isHeld != true) acquireWakeLock()
        val current = session ?: return
        val client = api ?: return
        executor.execute {
            runCatching { client.poll(current.id, current.token) }
            handler.post { sendFreshFix() }
        }
    }

    private fun sendFreshFix() {
        val current = session ?: return
        try {
            fused.getCurrentLocation(
                Priority.PRIORITY_HIGH_ACCURACY,
                CancellationTokenSource().token
            ).addOnSuccessListener { location ->
                val fix = location ?: lastLocation ?: return@addOnSuccessListener
                lastLocation = fix
                queueAndFlush(fix)
            }.addOnFailureListener {
                val fix = lastLocation ?: return@addOnFailureListener
                queueAndFlush(fix)
            }
        } catch (_: SecurityException) {
            /* permission dropped */
        }
    }

    private fun queueAndFlush(location: Location) {
        executor.execute {
            FixQueue.enqueue(this, FixQueue.Fix.from(location))
            flushQueue()
        }
    }

    private fun flushQueue() {
        if (flushing) return
        val current = session ?: return
        val client = api ?: return
        flushing = true
        try {
            while (true) {
                val batch = FixQueue.peek(this, 80)
                if (batch.isEmpty()) break
                try {
                    val ping = client.pingBatch(current.id, current.token, batch)
                    FixQueue.removeFirst(this, batch.size)
                    lastPingOkAt = System.currentTimeMillis()
                    val last = batch.last()
                    broadcast(
                        tracking = true,
                        lat = last.lat,
                        lon = last.lon,
                        speed = last.speed,
                        heading = last.heading,
                        accuracy = last.accuracy,
                        sent = true,
                        queued = FixQueue.size(this),
                        sectionType = ping.sectionType,
                        sectionName = ping.sectionName,
                        sectionLabel = ping.sectionLabel,
                        sectionId = ping.sectionId,
                        flagStatus = ping.flagStatus,
                        flagTs = ping.flagTs,
                        flagAcked = ping.flagAcked
                    )
                } catch (error: Exception) {
                    if (error.message?.contains("Unknown car", ignoreCase = true) == true) {
                        running = false
                    }
                    val last = lastLocation
                    broadcast(
                        tracking = true,
                        lat = last?.latitude,
                        lon = last?.longitude,
                        speed = last?.takeIf { it.hasSpeed() }?.speed,
                        heading = last?.takeIf { it.hasBearing() }?.bearing,
                        accuracy = last?.takeIf { it.hasAccuracy() }?.accuracy,
                        sent = false,
                        queued = FixQueue.size(this),
                        error = "queued"
                    )
                    break
                }
            }
        } finally {
            flushing = false
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rallygps:tracking").apply {
            setReferenceCounted(false)
            acquire(12 * 60 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { cm.registerNetworkCallback(request, networkCallback) }
    }

    private fun unregisterNetworkCallback() {
        val cm = getSystemService(ConnectivityManager::class.java)
        runCatching { cm.unregisterNetworkCallback(networkCallback) }
    }

    private fun broadcast(
        tracking: Boolean,
        lat: Double? = null,
        lon: Double? = null,
        speed: Float? = null,
        heading: Float? = null,
        accuracy: Float? = null,
        sent: Boolean = false,
        queued: Int = 0,
        error: String? = null,
        sectionType: String? = null,
        sectionName: String? = null,
        sectionLabel: String? = null,
        sectionId: String? = null,
        flagStatus: String? = null,
        flagTs: Long? = null,
        flagAcked: Boolean? = null
    ) {
        val intent = Intent(TrackingActions.STATUS).apply {
            setPackage(packageName)
            putExtra(TrackingActions.EXTRA_TRACKING, tracking)
            putExtra(TrackingActions.EXTRA_SENT, sent)
            putExtra(TrackingActions.EXTRA_QUEUED, queued)
            if (lat != null) putExtra(TrackingActions.EXTRA_LAT, lat)
            if (lon != null) putExtra(TrackingActions.EXTRA_LON, lon)
            if (speed != null) putExtra(TrackingActions.EXTRA_SPEED, speed)
            if (heading != null) putExtra(TrackingActions.EXTRA_HEADING, heading)
            if (accuracy != null) putExtra(TrackingActions.EXTRA_ACCURACY, accuracy)
            if (error != null) putExtra(TrackingActions.EXTRA_ERROR, error)
            if (sectionType != null || sent) {
                putExtra(TrackingActions.EXTRA_SECTION_TYPE, sectionType ?: "")
                putExtra(TrackingActions.EXTRA_SECTION_NAME, sectionName ?: "")
                putExtra(TrackingActions.EXTRA_SECTION_LABEL, sectionLabel ?: "")
                putExtra(TrackingActions.EXTRA_SECTION_ID, sectionId ?: "")
            }
            if (flagStatus != null) putExtra(TrackingActions.EXTRA_FLAG_STATUS, flagStatus)
            if (flagTs != null) putExtra(TrackingActions.EXTRA_FLAG_TS, flagTs)
            if (flagAcked != null) putExtra(TrackingActions.EXTRA_FLAG_ACKED, flagAcked)
        }
        sendBroadcast(intent)
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.channel_desc)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, TrackingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(openApp)
            .addAction(0, getString(R.string.stop_tracking), stopIntent)
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.rallygps.app.STOP"
        const val ACTION_CREW_STATUS = "com.rallygps.app.CREW_STATUS"
        const val ACTION_FLAG_ACK = "com.rallygps.app.FLAG_ACK"
        const val EXTRA_CREW_STATUS = "crewStatus"
        private const val CHANNEL_ID = "rally_tracking"
        private const val NOTIFICATION_ID = 42
    }
}
