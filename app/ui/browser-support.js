// Check the API exposed here, rather than assuming support from a browser name.
export function sensorConnectionProblem({ navigator = globalThis.navigator,
  secureContext = globalThis.isSecureContext,
  policy = globalThis.document?.permissionsPolicy || globalThis.document?.featurePolicy } = {}) {
  const localTools = "Demo, Saved Shots, and local backup/restore still work.";
  if (secureContext === false) {
    return `Sensor connections need a secure page. Open https://openfloatarchery.com or serve the app on localhost. ${localTools}`;
  }
  if (typeof navigator?.bluetooth?.requestDevice !== "function") {
    const isIOS = /iPad|iPhone|iPod/.test(navigator?.userAgent || "")
      || (navigator?.platform === "MacIntel" && navigator?.maxTouchPoints > 1);
    const explanation = isIOS
      ? "Safari, Chrome, and Edge on iPhone or iPad do not provide Web Bluetooth for sensor connections."
      : "This browser does not provide Web Bluetooth for sensor connections.";
    return `${explanation} Use Chrome on Android, or Chrome/Edge on Windows or macOS. ${localTools}`;
  }
  try {
    if (policy?.allowsFeature("bluetooth") === false) {
      return `This page's permissions policy blocks sensor connections. Open OpenFloat directly in a browser tab. ${localTools}`;
    }
  } catch (_) { /* Older policy APIs may not recognize Bluetooth; let the picker decide. */ }
  return "";
}

export function mountBrowserSupport({ el, readProblem = sensorConnectionProblem, onHelp }) {
  function check({ focus = false } = {}) {
    const message = readProblem();
    el.mobileAlertBanner?.classList.toggle("hidden", !message);
    if (el.mobileAlertText) el.mobileAlertText.textContent = message;
    if (el.statusBadge && el.mobileAlertText) {
      if (message) el.statusBadge.setAttribute("aria-describedby", el.mobileAlertText.id);
      else el.statusBadge.removeAttribute("aria-describedby");
    }
    if (message && focus && el.browserSupportHelpLink) {
      const help = el.browserSupportHelpLink;
      // The header grows when navigation wraps. Keep focused help below it,
      // including when a connection attempt starts from a scrolled Guide page.
      const margin = `${(el.statusBadge?.closest("header")?.getBoundingClientRect().height || 0) + 12}px`;
      if (el.mobileAlertBanner) {
        el.mobileAlertBanner.style.scrollMarginTop = margin;
        el.mobileAlertBanner.scrollIntoView({ block: "start" });
      }
      help.style.scrollMarginTop = margin;
      help.focus({ preventScroll: true });
      help.scrollIntoView({ block: "nearest" });
    }
    return !message;
  }
  el.closeMobileAlertBtn?.addEventListener("click", () => {
    const hadFocus = document.activeElement === el.closeMobileAlertBtn;
    el.mobileAlertBanner?.classList.add("hidden");
    if (hadFocus) el.statusBadge?.focus();
  });
  if (onHelp) el.browserSupportHelpLink?.addEventListener("click", (event) => {
    event.preventDefault();
    onHelp();
  });
  check();
  return { check };
}
