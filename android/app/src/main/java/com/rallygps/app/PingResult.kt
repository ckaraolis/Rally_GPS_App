package com.rallygps.app

data class PingResult(
    val sectionType: String? = null,
    val sectionName: String? = null,
    val sectionLabel: String? = null,
    val sectionId: String? = null,
    val flagStatus: String = "green",
    val flagTs: Long = 0L,
    val flagAcked: Boolean = true
)
