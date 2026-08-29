package com.rallygps.app

object ServerConfig {
    /**
     * Public HTTPS Rally server. Update this after deploying, then rebuild the APK.
     * Leave empty to fall back to the last typed / saved URL on the phone.
     */
    const val DEFAULT_PUBLIC_URL = "https://rallygpsapp.vercel.app"
}
