package com.rallygps.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.animation.ValueAnimator
import android.graphics.Color
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.MotionEvent
import android.view.View
import android.widget.EditText
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
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
    private var inStage = false
    private var stageName: String? = null
    private var stageId: String? = null
    private var sectionType: String? = null
    private var sectionLabel: String? = null
    private var stoppedSinceMs: Long? = null
    private var acknowledgedStop = false
    private var crewAlertVisible = false
    private var redFlagVisible = false
    private var stageFlagStatus = "green"
    private var stageFlagTs = 0L
    private var flagAcked = true
    private var redFlagBlink: ValueAnimator? = null
    private var flagPlayer: MediaPlayer? = null
    private var crewStatusSent: String? = null
    private val holdHandler = Handler(Looper.getMainLooper())
    private var holdRunnable: Runnable? = null
    private var holdAnimator: ValueAnimator? = null
    private var holdFill: View? = null
    private var holdHintTick: Runnable? = null
    private var stopLock: Boolean? = null
    private var stopDialog: AlertDialog? = null
    private var pendingAfterStop: (() -> Unit)? = null

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (stopDialog?.isShowing == true) {
                pendingAfterStop = null
                stopDialog?.dismiss()
                return
            }
            val active = tracking || TrackingService.isActive
            if (active) {
                if (shouldShowRedFlag() || crewAlertVisible) return
                if (stopLock == true) {
                    showStopCodeDialog(null)
                    return
                }
                if (stopLock == false) {
                    leaveTrackingScreen()
                    return
                }
                probeStopLockThenLeave()
                return
            }
            leaveTrackingScreen()
        }
    }

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

            val error = intent.getStringExtra(TrackingActions.EXTRA_ERROR)
            val queued = intent.getIntExtra(TrackingActions.EXTRA_QUEUED, 0)
            val sent = intent.getBooleanExtra(TrackingActions.EXTRA_SENT, false)
            if (!error.isNullOrBlank() && error != "queued") {
                showError(error)
            } else if (error == "queued" || queued > 0) {
                binding.errorRead.visibility = View.VISIBLE
                binding.errorRead.text = getString(R.string.status_hint_queued)
            } else if (sent) {
                binding.errorRead.visibility = View.GONE
            }

            if (intent.hasExtra(TrackingActions.EXTRA_SECTION_TYPE)) {
                sectionType = intent.getStringExtra(TrackingActions.EXTRA_SECTION_TYPE)?.ifBlank { null }
                val incomingLabel = intent.getStringExtra(TrackingActions.EXTRA_SECTION_LABEL)?.ifBlank { null }
                val sectionName = intent.getStringExtra(TrackingActions.EXTRA_SECTION_NAME)?.ifBlank { null }
                sectionLabel = incomingLabel ?: sectionName
            }
            val wasInStage = inStage
            val prevStageId = stageId
            if (intent.hasExtra(TrackingActions.EXTRA_SECTION_ID)) {
                stageId = intent.getStringExtra(TrackingActions.EXTRA_SECTION_ID)?.ifBlank { null }
            }
            inStage = tracking && sectionType == "stage"
            stageName = sectionLabel
            if (!wasInStage && inStage) {
                stoppedSinceMs = null
                acknowledgedStop = false
                hideCrewAlert()
                resetCrewStatusUi()
            }
            if (wasInStage && !inStage) {
                stoppedSinceMs = null
                acknowledgedStop = false
                hideCrewAlert()
                hideRedFlagAlert()
                stageFlagStatus = "green"
                flagAcked = true
                resetCrewStatusUi()
            }
            if (wasInStage && inStage && stageId != null && prevStageId != null && stageId != prevStageId) {
                stoppedSinceMs = null
                acknowledgedStop = false
                hideCrewAlert()
                resetCrewStatusUi()
            }

            if (intent.hasExtra(TrackingActions.EXTRA_FLAG_STATUS)) {
                applyFlagFromServer(
                    intent.getStringExtra(TrackingActions.EXTRA_FLAG_STATUS) ?: "green",
                    intent.getLongExtra(TrackingActions.EXTRA_FLAG_TS, 0L),
                    intent.getBooleanExtra(TrackingActions.EXTRA_FLAG_ACKED, true)
                )
            }
            if (intent.hasExtra(TrackingActions.EXTRA_STOP_LOCK)) {
                val locked = intent.getBooleanExtra(TrackingActions.EXTRA_STOP_LOCK, false)
                stopLock = locked
                SessionStore.setStopLock(this, locked)
            }

            val speed = if (intent.hasExtra(TrackingActions.EXTRA_SPEED)) {
                intent.getFloatExtra(TrackingActions.EXTRA_SPEED, 0f)
            } else null

            if (inStage && !shouldShowRedFlag()) {
                updateStopWatch(speed)
            }

            renderMode()

            if (!intent.hasExtra(TrackingActions.EXTRA_LAT)) return

            val lat = intent.getDoubleExtra(TrackingActions.EXTRA_LAT, 0.0)
            val lon = intent.getDoubleExtra(TrackingActions.EXTRA_LON, 0.0)
            val heading = if (intent.hasExtra(TrackingActions.EXTRA_HEADING)) {
                intent.getFloatExtra(TrackingActions.EXTRA_HEADING, 0f)
            } else null
            val accuracy = if (intent.hasExtra(TrackingActions.EXTRA_ACCURACY)) {
                intent.getFloatExtra(TrackingActions.EXTRA_ACCURACY, 0f)
            } else null

            val speedText = speed?.let { "${(it * 3.6f).toInt()} km/h" } ?: "—"
            binding.speedRead.text = speedText
            binding.stageSpeed.text = "Speed $speedText"
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
        crewStatusSent = savedInstanceState?.getString(STATE_CREW_STATUS)
        inStage = savedInstanceState?.getBoolean(STATE_IN_STAGE) ?: false
        stageId = savedInstanceState?.getString(STATE_STAGE_ID)
        stopLock = SessionStore.stopLock(this)
        if (session != null) {
            tracking = SessionStore.trackingWanted(this) || TrackingService.isActive
            showTrackPanel()
        } else {
            showSetupPanel()
        }

        onBackPressedDispatcher.addCallback(this, backCallback)
        binding.continueBtn.setOnClickListener { joinRally() }
        binding.toggleBtn.setOnClickListener {
            if (tracking) requestStopTracking() else ensurePermissionsAndStart()
        }
        binding.stageStopBtn.setOnClickListener { requestStopTracking() }
        binding.changeCarBtn.setOnClickListener {
            if (tracking || TrackingService.isActive) {
                requestStopTracking {
                    SessionStore.clear(this)
                    session = null
                    showSetupPanel()
                }
            } else {
                SessionStore.clear(this)
                session = null
                showSetupPanel()
            }
        }

        bindHold(binding.okHoldWrap, binding.okHoldFill, "ok")
        bindHold(binding.sosHoldWrap, binding.sosHoldFill, "sos")
        bindHold(binding.alertOkHoldWrap, binding.alertOkHoldFill, "ok")
        bindHold(binding.alertSosHoldWrap, binding.alertSosHoldFill, "sos")
        applyCrewStatusUi()
        maybeHandleStopRequest(intent)
        binding.redFlagOkBtn.setOnClickListener {
            flagAcked = true
            hideRedFlagAlert()
            sendFlagAck()
            renderMode()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        maybeHandleStopRequest(intent)
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

    override fun onResume() {
        super.onResume()
        restoreTrackingIfNeeded()
    }

    override fun onPause() {
        cancelHold()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_CREW_STATUS, crewStatusSent)
        outState.putBoolean(STATE_IN_STAGE, inStage)
        outState.putString(STATE_STAGE_ID, stageId)
    }

    override fun onStop() {
        unregisterReceiver(statusReceiver)
        super.onStop()
    }

    override fun onDestroy() {
        cancelHold()
        stopRedFlagSound()
        stopRedFlagBlink()
        super.onDestroy()
    }

    private fun updateStopWatch(speed: Float?) {
        val moving = (speed ?: 0f) > STOPPED_SPEED_MPS
        if (moving) {
            stoppedSinceMs = null
            acknowledgedStop = false
            hideCrewAlert()
            return
        }
        val now = System.currentTimeMillis()
        if (stoppedSinceMs == null) stoppedSinceMs = now
        val stoppedFor = now - (stoppedSinceMs ?: now)
        if (stoppedFor >= STOPPED_ALERT_MS && !acknowledgedStop) {
            showCrewAlert()
        }
    }

    private fun applyFlagFromServer(status: String, flagTs: Long, acked: Boolean) {
        val next = if (status == "red") "red" else "green"
        if (next == "green") {
            stageFlagStatus = "green"
            stageFlagTs = flagTs
            flagAcked = true
            hideRedFlagAlert()
            return
        }
        val isNewEvent = flagTs != stageFlagTs || stageFlagStatus != "red"
        stageFlagStatus = "red"
        stageFlagTs = flagTs
        if (isNewEvent) {
            flagAcked = acked
        } else if (acked) {
            flagAcked = true
        }
    }

    private fun shouldShowRedFlag(): Boolean {
        return tracking && inStage && stageFlagStatus == "red" && !flagAcked
    }

    private fun showCrewAlert() {
        if (shouldShowRedFlag()) return
        dismissStopDialog()
        cancelHold()
        crewAlertVisible = true
        binding.crewAlert.visibility = View.VISIBLE
        binding.trackPanel.visibility = View.GONE
        binding.stagePanel.visibility = View.GONE
        binding.setupPanel.visibility = View.GONE
        binding.alertOkBtn.text = idleHoldLabel("ok", alert = true, change = false)
        binding.alertSosBtn.text = idleHoldLabel("sos", alert = true, change = false)
    }

    private fun hideCrewAlert() {
        crewAlertVisible = false
        binding.crewAlert.visibility = View.GONE
    }

    private fun showRedFlagAlert() {
        dismissStopDialog()
        cancelHold()
        redFlagVisible = true
        hideCrewAlert()
        binding.redFlagAlert.visibility = View.VISIBLE
        binding.trackPanel.visibility = View.GONE
        binding.stagePanel.visibility = View.GONE
        binding.setupPanel.visibility = View.GONE
        startRedFlagBlink()
        startRedFlagSound()
    }

    private fun hideRedFlagAlert() {
        redFlagVisible = false
        binding.redFlagAlert.visibility = View.GONE
        stopRedFlagBlink()
        stopRedFlagSound()
    }

    private fun startRedFlagBlink() {
        if (redFlagBlink?.isRunning == true) return
        redFlagBlink = ValueAnimator.ofArgb(
            Color.parseColor("#7A0000"),
            Color.parseColor("#FF1A1A")
        ).apply {
            duration = 550
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener { animator ->
                binding.redFlagAlert.setBackgroundColor(animator.animatedValue as Int)
            }
            start()
        }
        binding.redFlagTitle.alpha = 1f
    }

    private fun stopRedFlagBlink() {
        redFlagBlink?.cancel()
        redFlagBlink = null
        binding.redFlagTitle.alpha = 1f
        binding.redFlagAlert.setBackgroundColor(Color.parseColor("#C80000"))
    }

    private fun startRedFlagSound() {
        if (flagPlayer?.isPlaying == true) return
        stopRedFlagSound()
        try {
            val player = MediaPlayer()
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            val afd = resources.openRawResourceFd(R.raw.red_flag_alert)
            player.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            afd.close()
            player.isLooping = true
            player.setVolume(1f, 1f)
            player.prepare()
            player.start()
            flagPlayer = player
        } catch (_: Exception) {
            flagPlayer = MediaPlayer.create(this, R.raw.red_flag_alert)?.apply {
                isLooping = true
                setVolume(1f, 1f)
                start()
            }
        }
    }

    private fun stopRedFlagSound() {
        flagPlayer?.run {
            runCatching { if (isPlaying) stop() }
            runCatching { release() }
        }
        flagPlayer = null
    }

    private fun updateRoadSectionUi() {
        if (!tracking) {
            binding.roadSectionRead.text = "Start tracking"
            binding.roadSectionBox.setBackgroundColor(Color.parseColor("#0d1628"))
            return
        }
        if (sectionType == "road") {
            binding.roadSectionRead.text = sectionLabel ?: "Road section"
            binding.roadSectionBox.setBackgroundColor(Color.parseColor("#10244a"))
        } else {
            binding.roadSectionRead.text = "Off route"
            binding.roadSectionBox.setBackgroundColor(Color.parseColor("#1a1710"))
        }
    }

    private fun applyStageFlagUi() {
        val red = stageFlagStatus == "red"
        binding.stageFlag.text = if (red) "RED FLAG" else "GREEN FLAG"
        binding.stageFlag.setTextColor(
            ContextCompat.getColor(this, if (red) R.color.stop else R.color.go)
        )
        binding.stageFlagBox.setBackgroundColor(
            if (red) Color.parseColor("#2a0f0f") else Color.parseColor("#10200c")
        )
    }

    private fun sendCrewStatus(status: String) {
        val intent = Intent(this, TrackingService::class.java)
            .setAction(TrackingService.ACTION_CREW_STATUS)
            .putExtra(TrackingService.EXTRA_CREW_STATUS, status)
        startService(intent)
    }

    private fun bindHold(wrap: View, fill: View, status: String) {
        wrap.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val isAlert = wrap === binding.alertOkHoldWrap || wrap === binding.alertSosHoldWrap
                    if (!isAlert && crewStatusSent == status) {
                        return@setOnTouchListener true
                    }
                    view.parent?.requestDisallowInterceptTouchEvent(true)
                    beginHold(fill, status)
                }
                MotionEvent.ACTION_MOVE -> {
                    if (event.x < 0 || event.y < 0 || event.x > view.width || event.y > view.height) {
                        view.parent?.requestDisallowInterceptTouchEvent(false)
                        cancelHold()
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    view.parent?.requestDisallowInterceptTouchEvent(false)
                    cancelHold()
                }
            }
            true
        }
    }

    private fun beginHold(fill: View, status: String) {
        cancelHold()
        fill.pivotX = 0f
        fill.scaleX = 0f
        holdFill = fill
        val startedAt = android.os.SystemClock.elapsedRealtime()
        updateHoldButtonText(status, CREW_HOLD_MS)
        holdAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = CREW_HOLD_MS
            addUpdateListener { fill.scaleX = it.animatedValue as Float }
            start()
        }
        val tick = object : Runnable {
            override fun run() {
                val left = CREW_HOLD_MS - (android.os.SystemClock.elapsedRealtime() - startedAt)
                if (left <= 0L) return
                updateHoldButtonText(status, left)
                holdHandler.postDelayed(this, 200L)
            }
        }
        holdHintTick = tick
        holdHandler.post(tick)
        val done = Runnable {
            clearHoldVisuals()
            confirmCrew(status)
        }
        holdRunnable = done
        holdHandler.postDelayed(done, CREW_HOLD_MS)
    }

    private fun clearHoldVisuals() {
        holdRunnable?.let { holdHandler.removeCallbacks(it) }
        holdHintTick?.let { holdHandler.removeCallbacks(it) }
        holdRunnable = null
        holdHintTick = null
        holdAnimator?.cancel()
        holdAnimator = null
        holdFill?.scaleX = 0f
        holdFill = null
    }

    private fun cancelHold() {
        val wasHolding = holdRunnable != null
        clearHoldVisuals()
        if (wasHolding) applyCrewStatusUi()
    }

    private fun confirmCrew(status: String) {
        acknowledgedStop = true
        hideCrewAlert()
        crewStatusSent = status
        applyCrewStatusUi()
        sendCrewStatus(status)
        renderMode()
    }

    private fun resetCrewStatusUi() {
        clearHoldVisuals()
        crewStatusSent = null
        if (::binding.isInitialized) applyCrewStatusUi()
    }

    private fun applyCrewStatusUi() {
        val status = crewStatusSent
        if (status != "ok" && status != "sos") {
            binding.crewStatusBanner.visibility = View.GONE
            binding.okBtn.text = idleHoldLabel("ok", alert = false, change = false)
            binding.sosBtn.text = idleHoldLabel("sos", alert = false, change = false)
            binding.alertOkBtn.text = idleHoldLabel("ok", alert = true, change = false)
            binding.alertSosBtn.text = idleHoldLabel("sos", alert = true, change = false)
            return
        }
        val ok = status == "ok"
        binding.crewStatusBanner.visibility = View.VISIBLE
        binding.crewStatusBanner.setBackgroundColor(
            Color.parseColor(if (ok) "#10200c" else "#2a0f0f")
        )
        binding.crewStatusRead.text = if (ok) "GREEN OK" else "RED SOS"
        binding.crewStatusRead.setTextColor(
            ContextCompat.getColor(this, if (ok) R.color.go else R.color.stop)
        )
        binding.crewStatusHint.text = if (ok) {
            "You confirmed OK. Hold SOS 3 seconds to change."
        } else {
            "You confirmed SOS. Hold OK 3 seconds to change."
        }
        binding.okBtn.text = if (ok) sentHoldLabel("ok", false) else idleHoldLabel("ok", false, true)
        binding.sosBtn.text = if (!ok) sentHoldLabel("sos", false) else idleHoldLabel("sos", false, true)
        binding.alertOkBtn.text = if (ok) sentHoldLabel("ok", true) else idleHoldLabel("ok", true, true)
        binding.alertSosBtn.text = if (!ok) sentHoldLabel("sos", true) else idleHoldLabel("sos", true, true)
    }

    private fun idleHoldLabel(status: String, alert: Boolean, change: Boolean): String {
        return when {
            alert && status == "ok" && change -> "GREEN OK\nHold 3s to change"
            alert && status == "sos" && change -> "RED SOS\nHold 3s to change"
            alert && status == "ok" -> "GREEN OK\nHold 3s · Both crew OK"
            alert && status == "sos" -> "RED SOS\nHold 3s · Need help"
            status == "ok" && change -> "OK\nHold 3s to change"
            status == "sos" && change -> "SOS\nHold 3s to change"
            status == "ok" -> "OK\nHold 3s"
            else -> "SOS\nHold 3s"
        }
    }

    private fun sentHoldLabel(status: String, alert: Boolean): String {
        return if (alert) {
            if (status == "ok") "GREEN OK\nSent to race control" else "RED SOS\nSent to race control"
        } else {
            if (status == "ok") "OK\nSent to race control" else "SOS\nSent to race control"
        }
    }

    private fun updateHoldButtonText(status: String, remainingMs: Long) {
        val sec = ((remainingMs + 999) / 1000).coerceAtLeast(1)
        val title = when {
            crewAlertVisible && status == "ok" -> "GREEN OK"
            crewAlertVisible && status == "sos" -> "RED SOS"
            status == "ok" -> "OK"
            else -> "SOS"
        }
        val text = "$title\nKeep holding ${sec}s"
        when {
            crewAlertVisible && status == "ok" -> binding.alertOkBtn.text = text
            crewAlertVisible && status == "sos" -> binding.alertSosBtn.text = text
            status == "ok" -> binding.okBtn.text = text
            else -> binding.sosBtn.text = text
        }
    }

    private fun sendFlagAck() {
        val intent = Intent(this, TrackingService::class.java)
            .setAction(TrackingService.ACTION_FLAG_ACK)
        startService(intent)
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
                "Cannot reach server at $server. Check internet, or use https://rallygpsapp.vercel.app"
            raw.contains("CLEARTEXT", true) ->
                "Phone blocked plain HTTP. Use the RallyGPS.apk from this project (cleartext is allowed)."
            raw.isBlank() -> "Could not reach the Rally server at $server"
            else -> raw
        }
    }

    private fun restoreTrackingIfNeeded() {
        val wanted = SessionStore.trackingWanted(this) || TrackingService.isActive
        if (session == null || !wanted) return
        tracking = true
        renderMode()
        if (hasFineLocation()) {
            startTrackingService(promptBattery = false)
        }
    }

    private fun hasFineLocation(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
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

    private fun askUnrestrictedBattery() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val pm = getSystemService(PowerManager::class.java) ?: return
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(
                    Uri.parse("package:$packageName")
                )
            )
        } catch (_: Exception) {
            runCatching {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }
    }

    private fun startTrackingService(promptBattery: Boolean = true) {
        if (session == null) {
            showError("Join the rally first.")
            return
        }
        SessionStore.setTrackingWanted(this, true)
        if (promptBattery) askUnrestrictedBattery()
        val intent = Intent(this, TrackingService::class.java)
        ContextCompat.startForegroundService(this, intent)
        tracking = true
        renderMode()
        refreshStopLock()
    }

    private fun refreshStopLock() {
        val current = session ?: return
        io.execute {
            val locked = runCatching { RallyApi(current.serverUrl).fetchStopLock() }.getOrNull() ?: return@execute
            SessionStore.setStopLock(this, locked)
            runOnUiThread {
                stopLock = locked
                if (tracking) renderMode()
            }
        }
    }

    private fun requestStopTracking(after: (() -> Unit)? = null) {
        if (shouldShowRedFlag() || crewAlertVisible) return
        val active = tracking || TrackingService.isActive
        if (!active) {
            after?.invoke()
            return
        }
        pendingAfterStop = after
        if (stopLock == true) {
            showStopCodeDialog(null)
            return
        }
        verifyStopCode(null)
    }

    private fun verifyStopCode(code: String?) {
        val current = session
        if (current == null) {
            finishStop(code)
            return
        }
        io.execute {
            try {
                RallyApi(current.serverUrl).stop(current.id, current.token, code)
                runOnUiThread { finishStop(code) }
            } catch (error: StopRejectedException) {
                runOnUiThread {
                    stopLock = true
                    SessionStore.setStopLock(this, true)
                    stopDialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = true
                    val message = if (error.needCode && code.isNullOrBlank()) null else error.message
                    showStopCodeDialog(message)
                    renderMode()
                }
            } catch (_: Exception) {
                runOnUiThread {
                    stopDialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = true
                    if (stopLock == true) {
                        showStopCodeDialog(getString(R.string.stop_code_offline))
                    } else {
                        finishStop(code)
                    }
                }
            }
        }
    }

    private fun finishStop(code: String?) {
        val after = pendingAfterStop
        pendingAfterStop = null
        dismissStopDialog()
        stopTrackingService(code)
        after?.invoke()
    }

    private fun showStopCodeDialog(errorText: String?) {
        if (shouldShowRedFlag() || crewAlertVisible) return
        val showing = stopDialog
        if (showing?.isShowing == true) {
            showing.setMessage(errorText ?: getString(R.string.stop_code_message))
            showing.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = true
            return
        }
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            transformationMethod = PasswordTransformationMethod.getInstance()
            filters = arrayOf(InputFilter.LengthFilter(6))
            hint = getString(R.string.stop_code_hint)
            setPadding(48, 24, 48, 24)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.stop_code_title)
            .setMessage(errorText ?: getString(R.string.stop_code_message))
            .setView(input)
            .setNegativeButton(android.R.string.cancel) { _, _ -> pendingAfterStop = null }
            .setPositiveButton(R.string.stop_code_unlock, null)
            .create()
        dialog.setOnCancelListener { pendingAfterStop = null }
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val code = input.text?.toString()?.trim().orEmpty()
                if (!code.matches(Regex("\\d{4,6}"))) {
                    dialog.setMessage(getString(R.string.stop_code_format))
                    return@setOnClickListener
                }
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                verifyStopCode(code)
            }
        }
        dialog.setOnDismissListener {
            if (stopDialog === dialog) stopDialog = null
        }
        stopDialog = dialog
        dialog.show()
    }

    private fun dismissStopDialog() {
        stopDialog?.dismiss()
        stopDialog = null
    }

    private fun maybeHandleStopRequest(source: Intent?) {
        if (source?.action != TrackingService.ACTION_REQUEST_STOP) return
        source.action = Intent.ACTION_MAIN
        if (!(tracking || TrackingService.isActive || SessionStore.trackingWanted(this))) return
        if (shouldShowRedFlag() || crewAlertVisible) return
        requestStopTracking()
    }

    private fun probeStopLockThenLeave() {
        val current = session
        if (current == null) {
            leaveTrackingScreen()
            return
        }
        io.execute {
            val locked = runCatching { RallyApi(current.serverUrl).fetchStopLock() }.getOrNull()
            runOnUiThread {
                if (locked != null) {
                    stopLock = locked
                    SessionStore.setStopLock(this, locked)
                }
                if (stopLock == true) showStopCodeDialog(null) else leaveTrackingScreen()
            }
        }
    }

    private fun leaveTrackingScreen() {
        backCallback.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        backCallback.isEnabled = true
    }

    private fun stopTrackingService(code: String? = null) {
        SessionStore.setTrackingWanted(this, false)
        val intent = Intent(this, TrackingService::class.java).setAction(TrackingService.ACTION_STOP)
        if (!code.isNullOrBlank()) intent.putExtra(TrackingService.EXTRA_STOP_CODE, code)
        startService(intent)
        tracking = false
        inStage = false
        sectionType = null
        sectionLabel = null
        stageId = null
        hideCrewAlert()
        hideRedFlagAlert()
        resetCrewStatusUi()
        renderMode()
    }

    private fun showSetupPanel() {
        binding.setupPanel.visibility = View.VISIBLE
        binding.trackPanel.visibility = View.GONE
        binding.stagePanel.visibility = View.GONE
        hideCrewAlert()
        hideRedFlagAlert()
        binding.serverUrl.setText(SessionStore.loadServerUrl(this))
    }

    private fun showTrackPanel() {
        val current = session ?: return
        binding.setupPanel.visibility = View.GONE
        binding.plateNumber.text = "#${current.carNumber}"
        binding.plateName.text = current.driverName
        updateRoadSectionUi()
        renderMode()
    }

    private fun renderMode() {
        if (shouldShowRedFlag()) {
            showRedFlagAlert()
            return
        }
        hideRedFlagAlert()
        if (crewAlertVisible) return
        if (session == null) {
            showSetupPanel()
            return
        }
        binding.setupPanel.visibility = View.GONE
        if (tracking && inStage) {
            binding.trackPanel.visibility = View.GONE
            binding.stagePanel.visibility = View.VISIBLE
            binding.stageName.text = stageName ?: "SPECIAL STAGE"
            binding.stageLockNote.visibility = if (stopLock == true) View.VISIBLE else View.GONE
            applyStageFlagUi()
        } else {
            binding.stagePanel.visibility = View.GONE
            binding.trackPanel.visibility = View.VISIBLE
            updateRoadSectionUi()
            if (tracking) {
                binding.statusText.setText(R.string.status_tracking)
                binding.statusHint.setText(
                    if (stopLock == true) R.string.status_hint_locked else R.string.status_hint_tracking
                )
                binding.statusText.setTextColor(ContextCompat.getColor(this, R.color.go))
                binding.toggleBtn.setText(R.string.stop_tracking)
                binding.toggleBtn.backgroundTintList =
                    ContextCompat.getColorStateList(this, R.color.stop)
                binding.toggleBtn.setTextColor(ContextCompat.getColor(this, android.R.color.white))
            } else {
                binding.statusText.setText(R.string.status_ready)
                binding.statusHint.setText(R.string.status_hint_ready)
                binding.statusText.setTextColor(ContextCompat.getColor(this, R.color.ink))
                binding.toggleBtn.setText(R.string.start_tracking)
                binding.toggleBtn.backgroundTintList =
                    ContextCompat.getColorStateList(this, R.color.go)
                binding.toggleBtn.setTextColor(ContextCompat.getColor(this, R.color.black))
                binding.stageLockNote.visibility = View.GONE
            }
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

    companion object {
        private const val STOPPED_SPEED_MPS = 1.2f // ~4.3 km/h
        private const val STOPPED_ALERT_MS = 20_000L
        private const val CREW_HOLD_MS = 3_000L
        private const val STATE_CREW_STATUS = "crewStatusSent"
        private const val STATE_IN_STAGE = "inStage"
        private const val STATE_STAGE_ID = "stageId"
    }
}
