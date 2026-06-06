// ==========================
// notrace.js — Scan controller (MV3-safe)
// ==========================
(function () {
  if (typeof chrome === "undefined") return;

  // ✅ FIX: guard flag prevents re-entrant button state changes
  let _scanInProgress = false;

  function toast(message, type = "info") {
    if (typeof window.showNoTraceToast === "function") {
      window.showNoTraceToast(message, type);
    } else {
      window.dispatchEvent(new CustomEvent("notrace:toast", { detail: { message, type } }));
    }
  }

  const pGet = keys => new Promise(res => {
    try { chrome.storage?.local?.get(keys, v => res(v || {})); }
    catch { res({}); }
  });

  const pSet = obj => new Promise(res => {
    try { chrome.storage?.local?.set(obj, () => res()); }
    catch { res(); }
  });

  const pTabsQuery = q => new Promise(res => {
    try { chrome.tabs?.query(q, tabs => res(tabs || [])); }
    catch { res([]); }
  });

  function safeSendMessage(msg) {
    try {
      chrome.runtime?.sendMessage(msg, () => void chrome.runtime?.lastError);
    } catch {}
  }

  async function getScanState() {
    const { NOTRACE_SCAN_ON } = await pGet("NOTRACE_SCAN_ON");
    return {
      on: !!(NOTRACE_SCAN_ON && NOTRACE_SCAN_ON.on),
      startedAt: NOTRACE_SCAN_ON?.startedAt || 0
    };
  }

  async function setScanState(on) {
    await pSet({ NOTRACE_SCAN_ON: { on, startedAt: on ? Date.now() : 0 } });
  }

  function setButtons(scanning) {
    const startBtn = document.getElementById("start-scan-btn");
    const stopBtn  = document.getElementById("stop-scan-btn");
    if (!startBtn || !stopBtn) return;
    startBtn.style.display = scanning ? "none"         : "inline-block";
    stopBtn.style.display  = scanning ? "inline-block" : "none";
    startBtn.disabled = false;
    stopBtn.disabled  = false;
  }

  async function injectContentIntoAllHttpTabs() {
    if (!chrome?.scripting?.executeScript) return;
    const tabs = await pTabsQuery({});
    for (const t of tabs) {
      if (!/^https?:/i.test(t?.url || "")) continue;
      try {
        await new Promise(resolve => {
          chrome.scripting.executeScript(
            { target: { tabId: t.id, allFrames: false }, files: ["js/content.js"] },
            () => { void chrome.runtime?.lastError; resolve(); }
          );
        });
      } catch {}
    }
  }

  async function startScan() {
    if (_scanInProgress) return;
    _scanInProgress = true;

    await setScanState(true);
    await pSet({ NOTRACE_PRIMED: { on: true, ts: Date.now() }, lastScan: Date.now() });

    // Set buttons immediately — before any async that could trigger listeners
    setButtons(true);

    // Send to background — background will NOT echo scan-start back to UI pages
    safeSendMessage({ type: "scan-start" });
    safeSendMessage({ type: "hydrate-request" });

    await injectContentIntoAllHttpTabs();

    toast("🔍 Scan Started! Fetching trackers in real-time…", "success");
  }

  async function stopScan() {
    if (!_scanInProgress) return;
    _scanInProgress = false;

    await setScanState(false);

    // Set buttons immediately
    setButtons(false);

    safeSendMessage({ type: "scan-stop" });

    toast("🛑 Scan Stopped!", "warning");
  }

  function attachButtons() {
    const startBtn = document.getElementById("start-scan-btn");
    const stopBtn  = document.getElementById("stop-scan-btn");
    if (!startBtn || !stopBtn) return;
    startBtn.addEventListener("click", () => startScan());
    stopBtn.addEventListener("click",  () => stopScan());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachButtons);
  } else {
    attachButtons();
  }

  // Restore button state on load
  (async () => {
    const s = await getScanState();
    _scanInProgress = s.on;
    setButtons(s.on);
    if (s.on) safeSendMessage({ type: "hydrate-request" });
  })();

  // ✅ FIX: removed BroadcastChannel listener for scan-start/stop
  //    — was causing flicker when background echoed the message back
  //    Button state is set directly in startScan/stopScan, no need for echo

  // ✅ FIX: storage.onChanged only syncs buttons across OTHER tabs (not current)
  //    Use a small debounce so rapid storage writes don't flicker
  let _storageDebounce = null;
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes?.NOTRACE_SCAN_ON) {
        clearTimeout(_storageDebounce);
        _storageDebounce = setTimeout(() => {
          const on = !!changes.NOTRACE_SCAN_ON.newValue?.on;
          // Only update if different from current state to prevent flicker
          const startBtn = document.getElementById("start-scan-btn");
          const currentlyScanning = startBtn?.style.display === "none";
          if (on !== currentlyScanning) {
            _scanInProgress = on;
            setButtons(on);
          }
        }, 200);
      }
    });
  }

  // ✅ FIX: runtime listener REMOVED for scan-start/stop
  //    — background.js now skips echoing scan-start/stop to UI pages
  //    to prevent the re-entrant button flicker loop

  function updateYear() {
    const el = document.getElementById("notrace-year");
    if (el) el.textContent = new Date().getFullYear();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateYear);
  } else {
    updateYear();
  }

})();