package com.rallygps.app

import java.security.MessageDigest

object StopUnlock {
    fun sha256Hex(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { b -> "%02x".format(b) }
    }

    /** Matches server auth.offlineStopProof(code, salt). */
    fun matches(code: String, salt: String?, offlineProof: String?): Boolean {
        if (salt.isNullOrBlank() || offlineProof.isNullOrBlank()) return false
        if (!code.matches(Regex("\\d{4,6}"))) return false
        val next = sha256Hex("$salt:$code")
        if (next.length != offlineProof.length) return false
        var diff = 0
        for (i in next.indices) {
            diff = diff or (next[i].code xor offlineProof[i].code)
        }
        return diff == 0
    }
}
