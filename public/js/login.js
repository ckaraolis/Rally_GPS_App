const loginPanel = document.getElementById("loginPanel");
const changePanel = document.getElementById("changePanel");
const signedInPanel = document.getElementById("signedInPanel");
const loginForm = document.getElementById("loginForm");
const changeForm = document.getElementById("changeForm");
const loginError = document.getElementById("loginError");
const changeError = document.getElementById("changeError");

function safeControlNext() {
  const next = new URLSearchParams(location.search).get("next");
  if (next === "/test.html") return "/test.html";
  return "/control.html";
}

function showError(el, message) {
  el.textContent = message;
  el.classList.remove("hidden");
}

function showChange() {
  loginPanel.classList.add("hidden");
  signedInPanel?.classList.add("hidden");
  changePanel.classList.remove("hidden");
}

function showSignedIn() {
  const next = safeControlNext();
  if (next === "/test.html") {
    location.replace("/test.html");
    return;
  }
  loginPanel.classList.add("hidden");
  changePanel.classList.add("hidden");
  signedInPanel?.classList.remove("hidden");
}

if (new URLSearchParams(location.search).get("change") === "1") {
  showChange();
}

fetch("/api/me")
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data) return;
    if (data.mustChangePassword && safeControlNext() !== "/test.html") showChange();
    else if (data.mustChangePassword && safeControlNext() === "/test.html") location.replace("/test.html");
    else showSignedIn();
  })
  .catch(() => {});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.classList.add("hidden");
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not sign in");
    if (data.mustChangePassword) {
      if (safeControlNext() === "/test.html") {
        location.replace("/test.html");
        return;
      }
      document.getElementById("currentPassword").value = document.getElementById("password").value;
      showChange();
      return;
    }
    location.replace(safeControlNext());
  } catch (err) {
    showError(loginError, err.message || "Could not sign in");
  }
});

changeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  changeError.classList.add("hidden");
  const next = document.getElementById("newPassword").value;
  const confirm = document.getElementById("confirmPassword").value;
  if (next !== confirm) {
    showError(changeError, "New passwords do not match.");
    return;
  }
  try {
    const res = await fetch("/api/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: document.getElementById("currentPassword").value,
        newPassword: next,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not save password");
    location.replace(safeControlNext());
  } catch (err) {
    showError(changeError, err.message || "Could not save password");
  }
});
