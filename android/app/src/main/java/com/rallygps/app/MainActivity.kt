package com.rallygps.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.animation.ValueAnimator
import android.graphics.Color
import android.widget.LinearLayout
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.widget.EditText
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.rallygps.app.databinding.ActivityMainBinding
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
    private var settingsSheet: BottomSheetDialog? = null
    private var pendingAfterStop: (() -> Unit)? = null
    private val baseContentPadLeft = 20
    private val baseContentPadTop = 16
    private val baseContentPadRight = 20
    private val baseContentPadBottom = 24

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (stopDialog?.isShowing == true) {
                pendingAfterStop = null
                stopDialog?.dismiss()
                return
            }
            if (settingsSheet?.isShowing == true) {
                settingsSheet?.dismiss()
                return
            }
            val active = tracking || TrackingService.isActive
            if (active) {
                if (shouldShowRedFlag() || crewAlertVisible) return
                // Fail closed: only leave freely when the server said unlocked.
                if (stopLock == false) {
                    leaveTrackingScreen()
                    return
                }
                if (stopLock == true) {
                    showStopCodeDialog(null)
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
            var reportedTracking = intent.getBooleanExtra(TrackingActions.EXTRA_TRACKING, false)
            // Ignore stale post-stop broadcasts that would resurrect "tracking" UI
            // (and stick the No GSM hint) after the service has already stopped.
            if (reportedTracking &&
                !TrackingService.isActive &&
                !SessionStore.trackingWanted(this@MainActivity)
            ) {
                reportedTracking = false
            }
            tracking = reportedTracking

            val error = intent.getStringExtra(TrackingActions.EXTRA_ERROR)
            val queued = intent.getIntExtra(TrackingActions.EXTRA_QUEUED, 0)
            val sent = intent.getBooleanExtra(TrackingActions.EXTRA_SENT, false)
            if (!tracking) {
                clearNetworkHint()
            } else if (!error.isNullOrBlank() && error != "queued") {
                showError(error)
            } else if ((error == "queued" || queued > 0) && !hasValidatedInternet()) {
                // Only show No GSM when the phone truly has no validated data path.
                // A single failed ping with 5G up must not stick this message.
                binding.errorRead.visibility = View.VISIBLE
                binding.errorRead.text = getString(R.string.status_hint_queued)
            } else if (sent || hasValidatedInternet()) {
                clearNetworkHint()
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
                SessionStore.setStopLock(this@MainActivity, locked)
            }

            val speed = if (intent.hasExtra(TrackingActions.EXTRA_SPEED)) {
                intent.getFloatExtra(TrackingActions.EXTRA_SPEED, 0f)
            } else null

            if (inStage && !shouldShowRedFlag()) {
                updateStopWatch(speed)
            }

            renderMode()

            if (!intent.hasExtra(TrackingActions.EXTRA_LAT) &&
                !intent.hasExtra(TrackingActions.EXTRA_SPEED) &&
                !intent.hasExtra(TrackingActions.EXTRA_ACCURACY)
            ) {
                return
            }

            val accuracy = if (intent.hasExtra(TrackingActions.EXTRA_ACCURACY)) {
                intent.getFloatExtra(TrackingActions.EXTRA_ACCURACY, 0f)
            } else null

            val speedText = speed?.let { "${(it * 3.6f).toInt()} km/h" } ?: "—"
            binding.speedRead.text = speedText
            binding.stageSpeed.text = "Speed $speedText"
            binding.accRead.text = accuracy?.let { "±${it.toInt()} m" } ?: "—"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        ThemeHelper.applyFromStore(this)
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applySafeInsets()

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
        binding.toggleBtn.setOnClickListener { ensurePermissionsAndStart() }
        binding.settingsBtn.setOnClickListener { showSettingsSheet() }
        binding.settingsBtnStage.setOnClickListener { showSettingsSheet() }
        binding.settingsBtnTrack.setOnClickListener { showSettingsSheet() }

        bindHold(binding.okHoldWrap, binding.okHoldFill, "ok")
        bindHold(binding.sosHoldWrap, binding.sosHoldFill, "sos")
        bindHold(binding.alertOkHoldWrap, binding.alertOkHoldFill, "ok")
        bindHold(binding.alertSosHoldWrap, binding.alertSosHoldFill, "sos")
        layoutCrewAlertButtons()
        applyCrewAlertChromeFromDimens()
        applyCrewStatusUi()
        maybeHandleStopRequest(intent)
        binding.redFlagOkBtn.setOnClickListener {
            flagAcked = true
            hideRedFlagAlert()
            sendFlagAck()
            renderMode()
        }
    }

    private fun applySafeInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val density = resources.displayMetrics.density
        val baseL = (baseContentPadLeft * density).toInt()
        val baseT = (baseContentPadTop * density).toInt()
        val baseR = (baseContentPadRight * density).toInt()
        val baseB = (baseContentPadBottom * density).toInt()
        ViewCompat.setOnApplyWindowInsetsListener(binding.rootFrame) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            binding.contentScroll.setPadding(
                baseL + bars.left,
                baseT + bars.top,
                baseR + bars.right,
                baseB + bars.bottom
            )
            binding.redFlagAlert.setPadding(
                baseL + bars.left,
                baseT + bars.top,
                baseR + bars.right,
                baseB + bars.bottom
            )
            insets
        }
        ViewCompat.requestApplyInsets(binding.rootFrame)
    }

    private fun showSettingsSheet() {
        if (shouldShowRedFlag() || crewAlertVisible) return
        settingsSheet?.dismiss()
        val sheet = BottomSheetDialog(this)
        val view = LayoutInflater.from(this).inflate(R.layout.sheet_settings, null)
        val themeGroup = view.findViewById<RadioGroup>(R.id.themeGroup)
        val themeDark = view.findViewById<RadioButton>(R.id.themeDark)
        val themeLight = view.findViewById<RadioButton>(R.id.themeLight)
        val changeCarBtn = view.findViewById<MaterialButton>(R.id.settingsChangeCarBtn)
        val stopBtn = view.findViewById<MaterialButton>(R.id.settingsStopBtn)
        val statusText = view.findViewById<TextView>(R.id.settingsStatusText)
        val statusHint = view.findViewById<TextView>(R.id.settingsStatusHint)

        if (SessionStore.isDarkTheme(this)) themeDark.isChecked = true else themeLight.isChecked = true

        themeGroup.setOnCheckedChangeListener { _, checkedId ->
            val wantDark = checkedId == R.id.themeDark
            if (wantDark == SessionStore.isDarkTheme(this)) return@setOnCheckedChangeListener
            sheet.dismiss()
            ThemeHelper.setTheme(this, wantDark)
        }

        val active = tracking || TrackingService.isActive
        if (active) {
            statusText.setText(R.string.settings_status_tracking)
            statusText.setTextColor(ContextCompat.getColor(this, R.color.go))
            statusHint.setText(
                if (stopLock == true) R.string.status_hint_locked_short else R.string.status_hint_tracking
            )
            statusHint.visibility = View.VISIBLE
        } else {
            statusText.setText(R.string.settings_status_ready)
            statusText.setTextColor(ContextCompat.getColor(this, R.color.ink))
            statusHint.setText(R.string.status_hint_ready)
            statusHint.visibility = View.VISIBLE
        }

        stopBtn.visibility = if (active) View.VISIBLE else View.GONE
        stopBtn.setOnClickListener {
            sheet.dismiss()
            requestStopTracking()
        }
        changeCarBtn.setOnClickListener {
            sheet.dismiss()
            changeCarOrServer()
        }

        sheet.setContentView(view)
        sheet.setOnDismissListener {
            if (settingsSheet === sheet) settingsSheet = null
        }
        settingsSheet = sheet
        sheet.show()
    }

    private fun changeCarOrServer() {
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        maybeHandleStopRequest(intent)
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applyTrackChromeFromDimens()
        layoutCrewAlertButtons()
        applyCrewAlertChromeFromDimens()
        renderMode()
    }

    private fun applyCrewAlertChromeFromDimens() {
        if (!::binding.isInitialized) return
        val density = resources.displayMetrics.scaledDensity
        binding.crewAlertTitle.textSize =
            resources.getDimension(R.dimen.crew_alert_title) / density
        binding.crewAlertCopy.textSize =
            resources.getDimension(R.dimen.crew_alert_copy) / density
        val btnSp = resources.getDimension(R.dimen.crew_alert_btn_text) / density
        binding.alertOkBtn.textSize = btnSp
        binding.alertSosBtn.textSize = btnSp
    }

    /** Re-apply road/track paddings & text sizes after landscape/portrait switch (configChanges). */
    private fun applyTrackChromeFromDimens() {
        val platePad = resources.getDimensionPixelSize(R.dimen.track_plate_pad)
        binding.plateRow.setPadding(platePad, platePad, platePad, platePad)
        binding.plateNumber.textSize = resources.getDimension(R.dimen.track_plate_number) /
            resources.displayMetrics.scaledDensity
        binding.plateName.textSize = resources.getDimension(R.dimen.track_plate_name) /
            resources.displayMetrics.scaledDensity
        val roadPad = resources.getDimensionPixelSize(R.dimen.track_road_pad)
        binding.roadSectionBox.setPadding(roadPad, roadPad, roadPad, roadPad)
        binding.roadSectionLabel.textSize = resources.getDimension(R.dimen.track_road_label) /
            resources.displayMetrics.scaledDensity
        binding.roadSectionRead.textSize = resources.getDimension(R.dimen.track_road_value) /
            resources.displayMetrics.scaledDensity
        val telePad = resources.getDimensionPixelSize(R.dimen.track_tele_pad)
        for (i in 0 until binding.telemetryRow.childCount) {
            binding.telemetryRow.getChildAt(i).setPadding(telePad, telePad, telePad, telePad)
        }
        binding.speedRead.textSize = resources.getDimension(R.dimen.track_tele_value) /
            resources.displayMetrics.scaledDensity
        binding.accRead.textSize = resources.getDimension(R.dimen.track_tele_value) /
            resources.displayMetrics.scaledDensity
        val toggleLp = binding.toggleBtn.layoutParams
        toggleLp.height = resources.getDimensionPixelSize(R.dimen.track_toggle_height)
        binding.toggleBtn.layoutParams = toggleLp
        val gap = resources.getDimensionPixelSize(R.dimen.track_gap)
        (binding.trackMainRow.layoutParams as? android.view.ViewGroup.MarginLayoutParams)?.let {
            it.topMargin = gap
            binding.trackMainRow.layoutParams = it
        }
        (binding.toggleBtn.layoutParams as? android.view.ViewGroup.MarginLayoutParams)?.let {
            it.topMargin = gap
            binding.toggleBtn.layoutParams = it
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
        // GPS updates keep calling this while stopped — never cancel an in-progress hold.
        if (crewAlertVisible && binding.crewAlert.visibility == View.VISIBLE) return
        dismissStopDialog()
        crewAlertVisible = true
        binding.crewAlert.visibility = View.VISIBLE
        binding.trackPanel.visibility = View.GONE
        binding.stagePanel.visibility = View.GONE
        binding.setupPanel.visibility = View.GONE
        binding.alertOkBtn.text = idleHoldLabel("ok", alert = true, change = false)
        binding.alertSosBtn.text = idleHoldLabel("sos", alert = true, change = false)
        layoutCrewAlertButtons()
    }

    private fun layoutCrewAlertButtons() {
        if (!::binding.isInitialized) return
        val landscape =
            resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val gap = resources.getDimensionPixelSize(R.dimen.crew_alert_btn_gap)
        binding.crewAlertButtons.orientation =
            if (landscape) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        fun applyGaps(wrap: View, endOfFirst: Boolean) {
            val lp = wrap.layoutParams as LinearLayout.LayoutParams
            lp.width = if (landscape) 0 else LinearLayout.LayoutParams.MATCH_PARENT
            lp.height = 0
            lp.weight = 1f
            if (landscape) {
                lp.topMargin = 0
                lp.bottomMargin = 0
                lp.marginStart = if (endOfFirst) 0 else gap / 2
                lp.marginEnd = if (endOfFirst) gap / 2 else 0
            } else {
                lp.marginStart = 0
                lp.marginEnd = 0
                lp.topMargin = if (endOfFirst) 0 else gap / 2
                lp.bottomMargin = if (endOfFirst) gap / 2 else 0
            }
            wrap.layoutParams = lp
        }
        applyGaps(binding.alertOkHoldWrap, endOfFirst = true)
        applyGaps(binding.alertSosHoldWrap, endOfFirst = false)
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
            binding.roadSectionBox.setBackgroundColor(ContextCompat.getColor(this, R.color.road_idle))
            return
        }
        if (sectionType == "road") {
            binding.roadSectionRead.text = sectionLabel ?: "Road section"
            binding.roadSectionBox.setBackgroundColor(ContextCompat.getColor(this, R.color.road_on))
        } else {
            binding.roadSectionRead.text = "Off route"
            binding.roadSectionBox.setBackgroundColor(ContextCompat.getColor(this, R.color.road_off))
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
        val slop = (24 * resources.displayMetrics.density).toInt()
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
                    if (event.x < -slop || event.y < -slop ||
                        event.x > view.width + slop || event.y > view.height + slop
                    ) {
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
            if (binding.stagePanel.visibility == View.VISIBLE) {
                binding.contentScroll.post { fitStageMainRowHeight() }
            }
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
            "You confirmed OK. Hold SOS 2 seconds to change."
        } else {
            "You confirmed SOS. Hold OK 2 seconds to change."
        }
        binding.okBtn.text = if (ok) sentHoldLabel("ok", false) else idleHoldLabel("ok", false, true)
        binding.sosBtn.text = if (!ok) sentHoldLabel("sos", false) else idleHoldLabel("sos", false, true)
        binding.alertOkBtn.text = if (ok) sentHoldLabel("ok", true) else idleHoldLabel("ok", true, true)
        binding.alertSosBtn.text = if (!ok) sentHoldLabel("sos", true) else idleHoldLabel("sos", true, true)
        if (binding.stagePanel.visibility == View.VISIBLE) {
            binding.crewStatusBanner.post { fitStageMainRowHeight() }
        }
    }

    private fun idleHoldLabel(status: String, alert: Boolean, change: Boolean): String {
        return when {
            alert && status == "ok" && change -> "GREEN OK\nHold 2s to change"
            alert && status == "sos" && change -> "RED SOS\nHold 2s to change"
            alert && status == "ok" -> "GREEN OK\nHold 2s · Both crew OK"
            alert && status == "sos" -> "RED SOS\nHold 2s · Need help"
            status == "ok" && change -> "OK\nHold 2s to change"
            status == "sos" && change -> "SOS\nHold 2s to change"
            status == "ok" -> "OK\nHold 2s"
            else -> "SOS\nHold 2s"
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
        clearNetworkHint()
        val intent = Intent(this, TrackingService::class.java)
        ContextCompat.startForegroundService(this, intent)
        tracking = true
        renderMode()
        refreshStopLock()
    }

    private fun refreshStopLock() {
        val current = session ?: return
        io.execute {
            val locked = runCatching { RallyApi(current.serverUrl).fetchStopLock() }.getOrNull()
            runOnUiThread {
                if (locked != null) {
                    stopLock = locked
                    SessionStore.setStopLock(this, locked)
                } else if (stopLock == false) {
                    // Stale unlock is unsafe if we cannot re-check.
                    stopLock = null
                    SessionStore.clearStopLockKnown(this)
                }
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
        // Fail closed: prompt unless the server explicitly said unlocked.
        if (stopLock != false) {
            showStopCodeDialog(null)
            return
        }
        verifyStopCode(null)
    }

    private fun verifyStopCode(code: String?) {
        val current = session
        if (current == null) {
            if (stopLock == false) finishStop(code) else showStopCodeDialog(null)
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
                    // Fail closed — never stop when the server cannot verify the code.
                    showStopCodeDialog(getString(R.string.stop_code_offline))
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
            showStopCodeDialog(null)
            return
        }
        io.execute {
            val locked = runCatching { RallyApi(current.serverUrl).fetchStopLock() }.getOrNull()
            runOnUiThread {
                if (locked != null) {
                    stopLock = locked
                    SessionStore.setStopLock(this, locked)
                }
                // Fail closed when unknown or locked.
                if (stopLock == false) leaveTrackingScreen() else showStopCodeDialog(null)
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
        clearNetworkHint()
        hideCrewAlert()
        hideRedFlagAlert()
        resetCrewStatusUi()
        renderMode()
    }

    private fun clearNetworkHint() {
        binding.errorRead.visibility = View.GONE
        binding.errorRead.text = ""
    }

    private fun hasValidatedInternet(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return true
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun showSetupPanel() {
        binding.setupPanel.visibility = View.VISIBLE
        binding.trackPanel.visibility = View.GONE
        binding.stagePanel.visibility = View.GONE
        binding.topBar.visibility = View.VISIBLE
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
            binding.topBar.visibility = View.GONE
            binding.stageName.text = stageName ?: "SPECIAL STAGE"
            binding.stageLockNote.visibility = if (stopLock == true) View.VISIBLE else View.GONE
            applyStageFlagUi()
            applyStageCompactUi()
        } else {
            binding.stagePanel.visibility = View.GONE
            binding.trackPanel.visibility = View.VISIBLE
            binding.stageSpeed.visibility = View.VISIBLE
            binding.crewStatusHint.visibility = View.VISIBLE
            updateRoadSectionUi()
            if (tracking) {
                binding.toggleBtn.visibility = View.GONE
            } else {
                binding.toggleBtn.visibility = View.VISIBLE
                binding.toggleBtn.setText(R.string.start_tracking)
                binding.toggleBtn.backgroundTintList =
                    ContextCompat.getColorStateList(this, R.color.go)
                binding.toggleBtn.setTextColor(ContextCompat.getColor(this, R.color.black))
                binding.stageLockNote.visibility = View.GONE
            }
            applyRoadCompactUi()
        }
    }

    /** Landscape road/track: plate + road + speed/GPS (+ gear) on one screen, no scroll. */
    private fun applyRoadCompactUi() {
        val cfg = resources.configuration
        val landscape = cfg.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        val shortLandscape = landscape && cfg.screenHeightDp > 0 && cfg.screenHeightDp <= 480

        if (landscape) {
            binding.topBar.visibility = View.GONE
            binding.settingsBtnTrack.visibility = View.VISIBLE
            binding.trackMainRow.orientation = android.widget.LinearLayout.HORIZONTAL
            val roadLp = binding.roadSectionBox.layoutParams as android.widget.LinearLayout.LayoutParams
            roadLp.width = 0
            roadLp.height = android.widget.LinearLayout.LayoutParams.MATCH_PARENT
            roadLp.weight = 1f
            roadLp.marginEnd = (6 * resources.displayMetrics.density).toInt()
            roadLp.topMargin = 0
            binding.roadSectionBox.layoutParams = roadLp
            val teleLp = binding.telemetryRow.layoutParams as android.widget.LinearLayout.LayoutParams
            teleLp.width = 0
            teleLp.height = android.widget.LinearLayout.LayoutParams.MATCH_PARENT
            teleLp.weight = 1.15f
            teleLp.topMargin = 0
            teleLp.marginStart = (6 * resources.displayMetrics.density).toInt()
            binding.telemetryRow.layoutParams = teleLp
        } else {
            binding.topBar.visibility = View.VISIBLE
            binding.settingsBtnTrack.visibility = View.GONE
            binding.trackMainRow.orientation = android.widget.LinearLayout.VERTICAL
            val roadLp = binding.roadSectionBox.layoutParams as android.widget.LinearLayout.LayoutParams
            roadLp.width = android.widget.LinearLayout.LayoutParams.MATCH_PARENT
            roadLp.height = android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
            roadLp.weight = 0f
            roadLp.marginEnd = 0
            roadLp.topMargin = 0
            binding.roadSectionBox.layoutParams = roadLp
            val teleLp = binding.telemetryRow.layoutParams as android.widget.LinearLayout.LayoutParams
            teleLp.width = android.widget.LinearLayout.LayoutParams.MATCH_PARENT
            teleLp.height = android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
            teleLp.weight = 0f
            teleLp.topMargin = resources.getDimensionPixelSize(R.dimen.track_gap)
            teleLp.marginStart = 0
            binding.telemetryRow.layoutParams = teleLp
        }

        // Match web short-landscape: hide secondary labels when height is tight.
        val labelVisibility = if (shortLandscape) View.GONE else View.VISIBLE
        binding.roadSectionLabel.visibility = labelVisibility
        binding.speedLabel.visibility = labelVisibility
        binding.accLabel.visibility = labelVisibility
    }

    /** Drop secondary stage chrome on short landscape so the confirm banner stays on-screen. */
    private fun applyStageCompactUi() {
        val cfg = resources.configuration
        val shortLandscape = cfg.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE &&
            cfg.screenHeightDp > 0 &&
            cfg.screenHeightDp <= 480
        binding.stageSpeed.visibility = if (shortLandscape) View.GONE else View.VISIBLE
        binding.crewStatusHint.visibility = if (shortLandscape) View.GONE else View.VISIBLE
        if (shortLandscape && stopLock == true) {
            binding.stageLockNote.visibility = View.GONE
        }
        binding.contentScroll.post { fitStageMainRowHeight() }
    }

    /** Size the flag/OK/SOS row so stage chrome + confirm banner fit without scrolling. */
    private fun fitStageMainRowHeight() {
        if (binding.stagePanel.visibility != View.VISIBLE) return
        val scrollH = binding.contentScroll.height -
            binding.contentScroll.paddingTop -
            binding.contentScroll.paddingBottom
        if (scrollH <= 0) return
        fun marginTopOf(view: View): Int =
            (view.layoutParams as? android.view.ViewGroup.MarginLayoutParams)?.topMargin ?: 0
        fun occupied(view: View): Int =
            if (view.visibility == View.VISIBLE) view.height + marginTopOf(view) else 0

        val density = resources.displayMetrics.density
        // Reserve banner space even before confirm so showing it doesn't force a scroll.
        val bannerSpace = if (binding.crewStatusBanner.visibility == View.VISIBLE) {
            occupied(binding.crewStatusBanner).coerceAtLeast((48 * density).toInt())
        } else {
            (48 * density).toInt()
        }
        val used =
            binding.tapeBar.height +
                marginTopOf(binding.panelHost) +
                bannerSpace +
                occupied(binding.stageSpeed) +
                occupied(binding.stageLockNote)
        val minMain = (110 * density).toInt()
        val maxMain = (280 * density).toInt()
        val target = (scrollH - used).coerceIn(minMain, maxMain)
        val lp = binding.stageMainRow.layoutParams
        if (lp.height != target) {
            lp.height = target
            binding.stageMainRow.layoutParams = lp
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
        private const val CREW_HOLD_MS = 2_000L
        private const val STATE_CREW_STATUS = "crewStatusSent"
        private const val STATE_IN_STAGE = "inStage"
        private const val STATE_STAGE_ID = "stageId"
    }
}
