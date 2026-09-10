package com.rallygps.app

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class RallyApi(baseUrl: String) {
    private val root = baseUrl.trimEnd('/')
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(25, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    fun register(carNumber: String, driverName: String): Session {
        val body = JSONObject()
            .put("carNumber", carNumber)
            .put("driverName", driverName)
            .toString()
            .toRequestBody(jsonType)

        val request = Request.Builder()
            .url("$root/api/register")
            .post(body)
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                if (!response.isSuccessful) {
                    throw IllegalStateException(json.optString("error", "Register failed (${response.code})"))
                }
                return Session(
                    serverUrl = root,
                    id = json.getString("id"),
                    token = json.getString("token"),
                    carNumber = json.getString("carNumber"),
                    driverName = json.getString("driverName"),
                    color = json.optString("color", "#ff7a18")
                )
            }
        } catch (error: IllegalStateException) {
            throw error
        } catch (error: Exception) {
            throw IllegalStateException(error.message ?: "Network error", error)
        }
    }

    fun ping(
        id: String,
        token: String,
        lat: Double,
        lon: Double,
        heading: Float?,
        speed: Float?,
        accuracy: Float?,
        ts: Long? = null
    ): PingResult {
        val payload = JSONObject()
            .put("id", id)
            .put("token", token)
            .put("lat", lat)
            .put("lon", lon)
        if (heading != null && !heading.isNaN()) payload.put("heading", heading.toDouble())
        if (speed != null && !speed.isNaN()) payload.put("speed", speed.toDouble())
        if (accuracy != null && !accuracy.isNaN()) payload.put("accuracy", accuracy.toDouble())
        if (ts != null) payload.put("ts", ts)
        return postPing("$root/api/ping", payload)
    }

    fun pingBatch(id: String, token: String, points: List<FixQueue.Fix>): PingResult {
        val arr = JSONArray()
        points.forEach { arr.put(it.toJson()) }
        val payload = JSONObject()
            .put("id", id)
            .put("token", token)
            .put("points", arr)
        return postPing("$root/api/ping-batch", payload)
    }

    private fun postPing(url: String, payload: JSONObject): PingResult {
        val request = Request.Builder()
            .url(url)
            .post(payload.toString().toRequestBody(jsonType))
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) {
                throw IllegalStateException(json.optString("error", "Ping failed (${response.code})"))
            }
            val section = json.optJSONObject("section")
            val flag = json.optString("flagStatus").ifBlank {
                section?.optString("flagStatus").orEmpty()
            }
            return PingResult(
                sectionType = section?.optString("type")?.ifBlank { null },
                sectionName = section?.optString("name")?.ifBlank { null },
                sectionLabel = section?.optString("label")?.ifBlank { null },
                sectionId = section?.optString("id")?.ifBlank { null },
                flagStatus = if (flag == "red") "red" else "green",
                flagTs = json.optLong("flagTs", section?.optLong("flagTs", 0L) ?: 0L),
                flagAcked = json.optBoolean("flagAcked", flag != "red")
            )
        }
    }

    fun crewStatus(id: String, token: String, status: String) {
        val payload = JSONObject()
            .put("id", id)
            .put("token", token)
            .put("status", status)
            .toString()
            .toRequestBody(jsonType)

        val request = Request.Builder()
            .url("$root/api/crew-status")
            .post(payload)
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string().orEmpty()
                val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                throw IllegalStateException(json.optString("error", "Crew status failed (${response.code})"))
            }
        }
    }

    fun ackFlag(id: String, token: String) {
        val payload = JSONObject()
            .put("id", id)
            .put("token", token)
            .toString()
            .toRequestBody(jsonType)

        val request = Request.Builder()
            .url("$root/api/flag-ack")
            .post(payload)
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string().orEmpty()
                val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                throw IllegalStateException(json.optString("error", "Flag ack failed (${response.code})"))
            }
        }
    }

    fun poll(id: String, token: String): Boolean {
        val payload = JSONObject()
            .put("id", id)
            .put("token", token)
            .toString()
            .toRequestBody(jsonType)

        val request = Request.Builder()
            .url("$root/api/poll")
            .post(payload)
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) {
                throw IllegalStateException(json.optString("error", "Poll failed (${response.code})"))
            }
            return json.optBoolean("reconnectRequested", false)
        }
    }

    fun stop(id: String, token: String) {
        val payload = JSONObject()
            .put("id", id)
            .put("token", token)
            .toString()
            .toRequestBody(jsonType)

        val request = Request.Builder()
            .url("$root/api/stop")
            .post(payload)
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string().orEmpty()
                val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                throw IllegalStateException(json.optString("error", "Stop failed (${response.code})"))
            }
        }
    }
}
