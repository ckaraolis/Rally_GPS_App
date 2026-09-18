/* Rally GPS service worker.
 *
 * This is a reminder + tap-back helper, not a GPS engine.
 * Service workers cannot read geolocation, and Periodic Background Sync
 * cannot help live rally tracking (no location access; Chrome may wait hours).
 * iOS Safari cannot do true background GPS from a web page.
 */
const TRACKING_TAG = "rally-tracking";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "tracking-on") {
    event.waitUntil(showTrackingNotification(data.body));
  } else if (data.type === "tracking-off") {
    event.waitUntil(clearTrackingNotification());
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(focusDriver());
});

async function showTrackingNotification(body) {
  if (!self.registration.showNotification) return;
  await self.registration.showNotification("Rally GPS tracking", {
    body:
      body ||
      "Keep Rally GPS open. GPS may pause if this phone sleeps or you switch apps.",
    tag: TRACKING_TAG,
    silent: true,
    requireInteraction: true,
    icon: "/icons/icon.svg",
    badge: "/icons/icon.svg",
    data: { url: "/driver.html" },
  });
}

async function clearTrackingNotification() {
  const notes = await self.registration.getNotifications({ tag: TRACKING_TAG });
  notes.forEach((note) => note.close());
}

async function focusDriver() {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    if (client.url.includes("driver") && "focus" in client) {
      await client.focus();
      return;
    }
  }
  if (self.clients.openWindow) await self.clients.openWindow("/driver.html");
}
