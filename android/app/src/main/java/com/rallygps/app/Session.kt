package com.rallygps.app

data class Session(
    val serverUrl: String,
    val id: String,
    val token: String,
    val carNumber: String,
    val driverName: String,
    val color: String
)
