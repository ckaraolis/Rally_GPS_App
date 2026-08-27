package com.rallygps.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.util.concurrent.Executors

class TrackingService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }
    private var api: RallyApi? = null
    private var session: Session? = null

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            val current = session ?: return
            val client = api ?: return

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
                sent = false,
                error = null
            )

            executor.execute {
                try {
                    client.ping(
                        id = current.id,
                        token = current.token,
                        lat = location.latitude,
                        lon = location.longitude,
                        heading = heading,
                        speed = speed,
                        accuracy = accuracy
                    )
                    broadcast(
                        tracking = true,
                        lat = location.latitude,
                        lon = location.longitude,
                        speed = speed,
                        heading = heading,
                        accuracy = accuracy,
                        sent = true,
                        error = null
                    )
                } catch (error: Exception) {
                    broadcast(
                        tracking = true,
                        lat = location.latitude,
                        lon = location.longitude,
                        speed = speed,
                        heading = heading,
                        accuracy = accuracy,
                        sent = false,
                        error = error.message ?: "Network error"
                    )
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopTracking()
                return START_NOT_STICKY
            }
            else -> startTracking()
        }
        return START_STICKY
    }

    private fun startTracking() {
        val current = SessionStore.load(this)
        if (current == null) {
            stopSelf()
            return
        }
        session = current
        api = RallyApi(current.serverUrl)

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

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 3000L)
            .setMinUpdateIntervalMillis(2000L)
            .setMinUpdateDistanceMeters(2f)
            .build()

        try {
            fused.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
            broadcast(tracking = true)
        } catch (error: SecurityException) {
            broadcast(tracking = false, error = "Location permission missing")
            stopSelf()
        }
    }

    private fun stopTracking() {
        fused.removeLocationUpdates(locationCallback)
        val current = session
        val client = api
        if (current != null && client != null) {
            executor.execute {
                runCatching { client.stop(current.id, current.token) }
            }
        }
        broadcast(tracking = false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        fused.removeLocationUpdates(locationCallback)
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun broadcast(
        tracking: Boolean,
        lat: Double? = null,
        lon: Double? = null,
        speed: Float? = null,
        heading: Float? = null,
        accuracy: Float? = null,
        sent: Boolean = false,
        error: String? = null
    ) {
        val intent = Intent(TrackingActions.STATUS).apply {
            setPackage(packageName)
            putExtra(TrackingActions.EXTRA_TRACKING, tracking)
            putExtra(TrackingActions.EXTRA_SENT, sent)
            if (lat != null) putExtra(TrackingActions.EXTRA_LAT, lat)
            if (lon != null) putExtra(TrackingActions.EXTRA_LON, lon)
            if (speed != null) putExtra(TrackingActions.EXTRA_SPEED, speed)
            if (heading != null) putExtra(TrackingActions.EXTRA_HEADING, heading)
            if (accuracy != null) putExtra(TrackingActions.EXTRA_ACCURACY, accuracy)
            if (error != null) putExtra(TrackingActions.EXTRA_ERROR, error)
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
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.rallygps.app.STOP"
        private const val CHANNEL_ID = "rally_tracking"
        private const val NOTIFICATION_ID = 42
    }
}
