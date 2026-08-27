package com.rallygps.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.DrawableCompat
import com.rallygps.app.databinding.ActivityMainBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val io = Executors.newSingleThreadExecutor()
    private var session: Session? = null
    private var tracking = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val fine = result[Manifest.permission.ACCESS_FINE_LOCATION] == true
        val notificationsOk = if (Build.VERSION.SDK_INT >= 33) {
            result[Manifest.permission.POST_NOTIFICATIONS] != false
        } else {
            true
        }
        if (fine && notificationsOk) {
            startTrackingService()
            maybeRequestBackgroundLocation()
        } else {
            showError("Location permission is required to track the car.")
        }
    }

    private val backgroundLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        // Foreground tracking still works even if background is denied.
    }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != TrackingActions.STATUS) return
            tracking = intent.getBooleanExtra(TrackingActions.EXTRA_TRACKING, false)
            renderTrackingState()

            val error = intent.getStringExtra(TrackingActions.EXTRA_ERROR)
            if (!error.isNullOrBlank()) {
                showError(error)
            } else {
                binding.errorRead.visibility = View.GONE
            }

            if (!intent.hasExtra(TrackingActions.EXTRA_LAT)) return

            val lat = intent.getDoubleExtra(TrackingActions.EXTRA_LAT, 0.0)
            val lon = intent.getDoubleExtra(TrackingActions.EXTRA_LON, 0.0)
            val speed = if (intent.hasExtra(TrackingActions.EXTRA_SPEED)) {
                intent.getFloatExtra(TrackingActions.EXTRA_SPEED, 0f)
            } else null
            val heading = if (intent.hasExtra(TrackingActions.EXTRA_HEADING)) {
                intent.getFloatExtra(TrackingActions.EXTRA_HEADING, 0f)
            } else null
            val accuracy = if (intent.hasExtra(TrackingActions.EXTRA_ACCURACY)) {
                intent.getFloatExtra(TrackingActions.EXTRA_ACCURACY, 0f)
            } else null

            binding.speedRead.text = speed?.let { "${(it * 3.6f).toInt()} km/h" } ?: "—"
            binding.accRead.text = accuracy?.let { "±${it.toInt()} m" } ?: "—"
            binding.headRead.text = heading?.let { "${it.toInt()}°" } ?: "—"
            binding.fixRead.text = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
            binding.coordRead.text = String.format(Locale.US, "%.6f, %.6f", lat, lon)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.serverUrl.setText(SessionStore.loadServerUrl(this))
        session = SessionStore.load(this)
        if (session != null) showTrackPanel() else showSetupPanel()

        binding.continueBtn.setOnClickListener { joinRally() }
        binding.toggleBtn.setOnClickListener {
            if (tracking) stopTrackingService() else ensurePermissionsAndStart()
        }
        binding.changeCarBtn.setOnClickListener {
            stopTrackingService()
            SessionStore.clear(this)
            session = null
            showSetupPanel()
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(TrackingActions.STATUS)
        ContextCompat.registerReceiver(
            this,
            statusReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    override fun onStop() {
        unregisterReceiver(statusReceiver)
        super.onStop()
    }

    private fun joinRally() {
        val server = binding.serverUrl.text?.toString()?.trim()?.trimEnd('/').orEmpty()
        val car = binding.carNumber.text?.toString()?.trim().orEmpty()
        val driver = binding.driverName.text?.toString()?.trim().orEmpty()

        if (server.isEmpty() || car.isEmpty() || driver.isEmpty()) {
            showError("Server URL, car number, and driver name are required.")
            return
        }
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            showError("Server URL must start with http:// or https://")
            return
        }

        binding.continueBtn.isEnabled = false
        binding.continueBtn.text = "Connecting…"
        binding.setupError.visibility = View.GONE
        binding.errorRead.visibility = View.GONE
        SessionStore.saveServerUrl(this, server)

        io.execute {
            try {
                val joined = RallyApi(server).register(car, driver)
                SessionStore.save(this, joined)
                runOnUiThread {
                    session = joined
                    binding.continueBtn.isEnabled = true
                    binding.continueBtn.setText(R.string.continue_btn)
                    showTrackPanel()
                    Toast.makeText(this, "Joined as #$car", Toast.LENGTH_SHORT).show()
                }
            } catch (error: Exception) {
                val message = friendlyNetworkError(error, server)
                runOnUiThread {
                    binding.continueBtn.isEnabled = true
                    binding.continueBtn.setText(R.string.continue_btn)
                    showError(message)
                }
            }
        }
    }

    private fun friendlyNetworkError(error: Exception, server: String): String {
        val raw = error.message.orEmpty()
        return when {
            raw.contains("Failed to connect", true) ||
                raw.contains("Unable to resolve", true) ||
                raw.contains("timeout", true) ||
                raw.contains("ECONNREFUSED", true) ||
                raw.contains("ENETUNREACH", true) ->
                "Cannot reach server at $server. Use http://192.168.20.234:3000 and keep phone + PC on the same Wi‑Fi."
            raw.contains("CLEARTEXT", true) ->
                "Phone blocked plain HTTP. Use the RallyGPS.apk from this project (cleartext is allowed)."
            raw.isBlank() -> "Could not reach the Rally server at $server"
            else -> raw
        }
    }

    private fun ensurePermissionsAndStart() {
        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 33) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            permissionLauncher.launch(missing.toTypedArray())
        } else {
            maybeRequestBackgroundLocation()
            startTrackingService()
        }
    }

    private fun maybeRequestBackgroundLocation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            backgroundLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
    }

    private fun startTrackingService() {
        if (session == null) {
            showError("Join the rally first.")
            return
        }
        val intent = Intent(this, TrackingService::class.java)
        ContextCompat.startForegroundService(this, intent)
        tracking = true
        renderTrackingState()
    }

    private fun stopTrackingService() {
        val intent = Intent(this, TrackingService::class.java).setAction(TrackingService.ACTION_STOP)
        startService(intent)
        tracking = false
        renderTrackingState()
    }

    private fun showSetupPanel() {
        binding.setupPanel.visibility = View.VISIBLE
        binding.trackPanel.visibility = View.GONE
        binding.serverUrl.setText(SessionStore.loadServerUrl(this))
    }

    private fun showTrackPanel() {
        val current = session ?: return
        binding.setupPanel.visibility = View.GONE
        binding.trackPanel.visibility = View.VISIBLE
        binding.plateNumber.text = "#${current.carNumber}"
        binding.plateName.text = current.driverName
        renderTrackingState()
    }

    private fun renderTrackingState() {
        if (tracking) {
            binding.statusText.setText(R.string.status_tracking)
            binding.statusHint.setText(R.string.status_hint_tracking)
            binding.statusText.setTextColor(ContextCompat.getColor(this, R.color.go))
            binding.toggleBtn.setText(R.string.stop_tracking)
            binding.toggleBtn.backgroundTintList =
                ContextCompat.getColorStateList(this, R.color.stop)
            binding.toggleBtn.setTextColor(ContextCompat.getColor(this, android.R.color.white))
            DrawableCompat.setTint(
                binding.statusLamp.background,
                ContextCompat.getColor(this, R.color.panel)
            )
        } else {
            binding.statusText.setText(R.string.status_ready)
            binding.statusHint.setText(R.string.status_hint_ready)
            binding.statusText.setTextColor(ContextCompat.getColor(this, R.color.ink))
            binding.toggleBtn.setText(R.string.start_tracking)
            binding.toggleBtn.backgroundTintList =
                ContextCompat.getColorStateList(this, R.color.go)
            binding.toggleBtn.setTextColor(ContextCompat.getColor(this, R.color.black))
        }
    }

    private fun showError(message: String) {
        if (binding.setupPanel.visibility == View.VISIBLE) {
            binding.setupError.visibility = View.VISIBLE
            binding.setupError.text = message
        }
        binding.errorRead.visibility = View.VISIBLE
        binding.errorRead.text = message
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
