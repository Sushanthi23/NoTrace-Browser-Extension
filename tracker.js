// ==================================
// tracker.js — MV3-safe, real-time tracker detection UI
// ==================================
(() => {
  console.log("[NoTrace] tracker.js loaded");

  if (typeof chrome === "undefined") return;

  const $ = id => document.getElementById(id);
  const activeOrigin  = $('activeOrigin');
  const lastUpdated   = $('lastUpdated');
  const permGeo       = $('permGeo');
  const permCam       = $('permCam');
  const permMic       = $('permMic');
  const permNotif     = $('permNotif');
  const storageUsed   = $('storageUsed');
  const storageStatus = $('storageStatus');
  const trackerStatus = $('trackerStatus');
  const cookiesStatus = $('cookiesStatus');
  const trackerInfo   = $('trackerInfo');
  const noScanMessage = $('noScanMessage');

  let ALIVE = true;
  window.addEventListener('unload', () => { ALIVE = false; });

  let LAST_STATE = { scanSummary: null, perTab: {} };
  let HAS_REAL_SITE = false;

  const hideEl = el => el?.classList.add("hidden");
  const showEl = el => el?.classList.remove("hidden");

  const setText = (el, text, cls) => {
    if (!el || !ALIVE) return;
    const str = text == null ? "" : String(text);
    el.textContent = str;
    if (cls) {
      el.classList.remove(
        "status-ok","status-bad","status-warn","status-unknown",
        "status-alert","status-prompt","mono"
      );
      el.classList.add(cls);
    }
  };

  const bytesHuman = n => {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };

  const classifyPermission = state => {
    const s = (state || "").toLowerCase();
    if (s === "granted" || s === "allow")  return { label: "Granted ✅",  cls: "status-ok" };
    if (s === "denied"  || s === "block")  return { label: "Denied 🚫",   cls: "status-bad" };
    if (s === "prompt")                    return { label: "Prompt ❔",    cls: "status-warn" };
    return { label: "Unknown ❓", cls: "status-unknown" };
  };

  const PERM_CACHE = { value: {}, ts: 0 };
  const PERM_TTL_MS = 10_000;

  const nativeQueryPerm = async name => {
    if (!navigator.permissions?.query) return "unknown";
    try { return (await navigator.permissions.query({ name })).state || "unknown"; }
    catch { return "unknown"; }
  };

  const resolvePermissions = async (payload = {}) => {
    if (!ALIVE) return {};
    const keys = ["geolocation", "camera", "microphone", "notifications"];
    const now = Date.now();
    let base = {};
    if ((now - PERM_CACHE.ts) < PERM_TTL_MS) {
      base = { ...PERM_CACHE.value };
    } else {
      try {
        const results = await Promise.all(keys.map(nativeQueryPerm));
        results.forEach((v, i) => base[keys[i]] = v);
        PERM_CACHE.value = { ...base };
        PERM_CACHE.ts = now;
      } catch {
        base = { ...PERM_CACHE.value };
      }
    }
    for (const k of keys) if (payload[k]) base[k] = payload[k];
    return base;
  };

  async function applyPermissions(perms = {}) {
    if (!ALIVE) return;
    const resolved = await resolvePermissions(perms);
    if (!ALIVE) return;
    const map = {
      geolocation:   permGeo,
      camera:        permCam,
      microphone:    permMic,
      notifications: permNotif
    };
    Object.entries(map).forEach(([k, el]) => {
      const { label, cls } = classifyPermission(resolved[k]);
      setText(el, label, cls);
    });
  }

  const applyStorageData = ({ storageBytes, cookies, trackersCount }) => {
    if (!ALIVE) return;
    if (storageBytes != null) {
      setText(storageUsed, bytesHuman(storageBytes), "status-ok");
      setText(storageStatus,
        storageBytes > 5 * 1024 * 1024 ? "(High Usage)" : "(Healthy)", "muted"
      );
    }
    if (typeof cookies === "number") {
      setText(cookiesStatus,
        cookies > 0 ? `${cookies} Cookies` : "No Cookies",
        cookies > 0 ? "status-warn" : "status-ok"
      );
    }
    if (typeof trackersCount === "number") {
      setText(trackerStatus,
        trackersCount > 0 ? `${trackersCount} Trackers Detected` : "No Trackers Detected",
        trackersCount > 0 ? "status-bad" : "status-ok"
      );
      if (trackerInfo) {
        trackerInfo.textContent = trackersCount > 0
          ? `⚠️ ${trackersCount} third-party tracker(s) detected on this page.` : "";
        trackersCount > 0 ? showEl(trackerInfo) : hideEl(trackerInfo);
      }
    }
  };

  const normalizeSummary = raw => {
    if (!raw) return null;
    return {
      url:           raw.page?.url || raw.url || null,
      lastScan:      raw.lastScan || raw.timestamp || Date.now(),
      permissions:   raw.permissions || {},
      storageBytes:  raw.storageBytes ?? 0,
      cookies:       typeof raw.cookies === "number" ? raw.cookies : 0,
      totalTrackers: Array.isArray(raw.trackers)
        ? raw.trackers.length
        : (typeof raw.totalTrackers === "number" ? raw.totalTrackers : 0)
    };
  };

  async function renderSummary(payload) {
    if (!ALIVE) return;
    if (!payload) { showNoScan(); return; }

    const normalized = normalizeSummary(payload.scanSummary || payload) || {};
    const perTab = payload.perTab || {};

    if (!normalized.url && !Object.keys(perTab).length) { showNoScan(); return; }

    hideEl(noScanMessage);

    if (normalized.url) {
      try {
        const hostname = new URL(normalized.url).hostname || normalized.url;
        setText(activeOrigin, hostname, "mono");
        HAS_REAL_SITE = true;
      } catch {
        if (!HAS_REAL_SITE) setText(activeOrigin, "Unknown Site", "mono");
      }
    }

    setText(lastUpdated, new Date(normalized.lastScan || Date.now()).toLocaleTimeString(), "mono");
    applyPermissions(normalized.permissions).catch(() => {});
    applyStorageData({
      storageBytes:  normalized.storageBytes,
      cookies:       normalized.cookies,
      trackersCount: normalized.totalTrackers
    });

    LAST_STATE.scanSummary = { ...normalized };
    LAST_STATE.perTab = { ...LAST_STATE.perTab, ...perTab };
  }

  function showNoScan() {
    if (!ALIVE) return;
    if (!HAS_REAL_SITE) setText(activeOrigin, "No Data", "mono");
    setText(lastUpdated, "Not available", "mono");
    applyPermissions({}).catch(() => {});
    applyStorageData({ storageBytes: 0, cookies: 0, trackersCount: 0 });
    showEl(noScanMessage);
    if (trackerInfo) hideEl(trackerInfo);
    LAST_STATE = { scanSummary: null, perTab: {} };
  }

  const safeSendMessage = msg => new Promise(resolve => {
    if (!ALIVE) return resolve(null);
    try {
      chrome.runtime.sendMessage(msg, res => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res || null);
      });
    } catch { resolve(null); }
  });

  const safeStorageGet = keys => new Promise(resolve => {
    if (!ALIVE) return resolve({});
    try {
      chrome.storage.local.get(keys, res => {
        if (chrome.runtime.lastError) return resolve({});
        resolve(res || {});
      });
    } catch { resolve({}); }
  });

  async function hydrate() {
    try {
      if (!ALIVE) return;
      const stored = await safeStorageGet(['lastResults', 'perTabState']);
      if (!ALIVE) return;

      if (stored?.lastResults || (stored?.perTabState && Object.keys(stored.perTabState).length)) {
        await renderSummary({ scanSummary: stored.lastResults, perTab: stored.perTabState });
        return;
      }

      const resp = await safeSendMessage({ type: 'summary-request' });
      if (!ALIVE) return;

      if (resp?.summary) {
        await renderSummary({ scanSummary: resp.summary, perTab: resp.perTab });
      } else {
        showNoScan();
      }
    } catch (e) {
      console.warn("[NoTrace] hydrate failed", e);
      if (ALIVE) showNoScan();
    }
  }

  hydrate().catch(() => {});

  // ✅ FIX: debounce handleUpdate to prevent rapid re-renders
  let updateTimer = null;
  let pendingUpdate = null;

  const handleUpdate = (d) => {
    if (!ALIVE || !d?.type) return;

    // Control messages handled immediately
    if (d.type === "scan-start" || d.type === "scan-stop") return;

    // ✅ FIX: removed tracker-added case — summary-updated covers it
    // tracker-added was firing on every single tracker causing constant flicker
    if (d.type === "tracker-added") return;

    // Debounce data updates — only render latest
    if (d.type === "summary-updated" || d.type === "permissions-update" ||
        d.type === "storage-update"  || d.type === "cookies-update") {
      pendingUpdate = d;
      clearTimeout(updateTimer);
      updateTimer = setTimeout(async () => {
        const update = pendingUpdate;
        pendingUpdate = null;
        if (!update || !ALIVE) return;
        try {
          switch (update.type) {
            case "summary-updated":
              await renderSummary({ scanSummary: update.summary, perTab: update.perTab });
              break;
            case "permissions-update":
              applyPermissions(update.permissions).catch(() => {});
              break;
            case "storage-update":
              applyStorageData({ storageBytes: update.storageBytes });
              break;
            case "cookies-update":
              applyStorageData({ cookies: update.cookies });
              break;
          }
        } catch (e) {
          if (ALIVE) console.warn("[NoTrace] handleUpdate error", e);
        }
      }, 400);
    }
  };

  let bc = null;
  try {
    bc = new BroadcastChannel("notrace");
    bc.onmessage = e => handleUpdate(e?.data);
  } catch {}

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleUpdate(msg);
    try { if (sendResponse) sendResponse({ ok: true }); } catch {}
    return true;
  });

  // ✅ FIX: debounce storage.onChanged — was re-rendering on every tracker update
  let storageTimer = null;
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.lastResults) {
        clearTimeout(storageTimer);
        storageTimer = setTimeout(() => {
          renderSummary({
            scanSummary: changes.lastResults.newValue,
            perTab: LAST_STATE.perTab
          }).catch(() => {});
        }, 400);
      }
    });
  }

})();