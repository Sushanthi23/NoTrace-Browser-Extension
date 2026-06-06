// ==============================
// content.js — MV3-safe, stable + real-time updates
// ==============================
(() => {
  console.log("[NoTrace] content.js loaded on:", window.location.href);

  const SCAN_INTERVAL_MS = 3000;
  const MUTATION_SAMPLE_LIMIT = 50;

  let heartbeatInterval = null;
  let lastSignalsJson = null;
  let lastSignalsObj = null;

  // ---- permission state ----
  const LAST_KNOWN_PERMS = Object.create(null);
  const PERM_WATCH_HANDLES = Object.create(null);
  let _lastSentPermsJson = null;

  // ---- fingerprinting counters ----
  let canvasCalls = 0,
    getImageDataCalls = 0,
    webglGetParamCalls = 0;

  // ---- tracker rules ----
  let KNOWN_TRACKERS = [
    // Analytics & tag managers
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /googletagservices\.com/i,
    /analytics\.google\.com/i,
    // Advertising networks
    /doubleclick\.net/i,
    /adservice\.google\.com/i,
    /googlesyndication\.com/i,
    /adsystem\.com/i,
    /adnxs\.com/i,
    /criteo\.com/i,
    /criteo\.net/i,
    /amazon-adsystem\.com/i,
    /media-amazon\.com/i,
    /serving-sys\.com/i,
    /rubiconproject\.com/i,
    /openx\.net/i,
    /pubmatic\.com/i,
    /casalemedia\.com/i,
    /contextweb\.com/i,
    /advertising\.com/i,
    /taboola\.com/i,
    /outbrain\.com/i,
    /mgid\.com/i,
    // Social trackers
    /facebook\.net/i,
    /connect\.facebook\.net/i,
    /twitter\.com\/i\/adsct/i,
    /t\.co\/[a-z]/i,
    /linkedin\.com\/px/i,
    /snap\.licdn\.com/i,
    // Analytics tools
    /hotjar\.com/i,
    /clarity\.ms/i,
    /segment\.com/i,
    /mixpanel\.com/i,
    /amplitude\.com/i,
    /optimizely\.com/i,
    /fullstory\.com/i,
    /mouseflow\.com/i,
    /logrocket\.com/i,
    // Indian ad networks & trackers
    /mxptint\.net/i,
    /rediff\.com\/tracker/i,
    /flipkart\.com\/track/i,
    /naukri\.com\/track/i,
    /indiatimes\.com\/track/i,
    /sharechat\.com\/track/i,
    /inmobi\.com/i,
    /vdoai\.com/i,
    /adjustcom/i,
    /adjust\.com/i,
    /appsflyer\.com/i,
    /branch\.io/i,
    /moengage\.com/i,
    /clevertap\.com/i,
    /webengage\.com/i,
    // Data brokers & fingerprinting
    /scorecardresearch\.com/i,
    /quantserve\.com/i,
    /addthis\.com/i,
    /sharethis\.com/i,
    /zemanta\.com/i,
    /chartbeat\.com/i,
    /newrelic\.com/i,
    /nr-data\.net/i,
    /sentry\.io/i,
  ];

// Load external tracker rules if present
(async () => {
  try {
    const url = chrome.runtime?.getURL
      ? chrome.runtime.getURL("data/tracker_rules.json")
      : null;

    if (!url) return;

    const res = await fetch(url);
    if (!res.ok) return;

    const rules = await res.json();
    if (Array.isArray(rules)) {
      KNOWN_TRACKERS = rules.map(d => new RegExp(d, "i"));
    }
  } catch (e) {
    console.warn("[NoTrace] tracker rules load failed", e);
  }
})();

  const VALID = new Set(["granted", "denied", "prompt"]);
  const normalize = v =>
    !v ? "unknown" : v === "default" ? "prompt" : VALID.has(v) ? v : "unknown";

  const memoPerm = (name, raw) => {
    const v = normalize(raw);
    const prev = LAST_KNOWN_PERMS[name];
    if (prev === "granted" || prev === "denied") return prev;
    if (v === "granted" || v === "denied") LAST_KNOWN_PERMS[name] = v;
    if (v === "prompt" && !prev) LAST_KNOWN_PERMS[name] = v;
    return LAST_KNOWN_PERMS[name] ?? "unknown";
  };

  const isTrackerUrl = u => KNOWN_TRACKERS.some(re => re.test(u));

  // ---- permission helpers ----
  async function queryPermission(name) {
    try {
      if (name === "notifications" && typeof Notification !== "undefined") {
        return memoPerm(name, Notification.permission);
      }
      if (!navigator.permissions?.query) return LAST_KNOWN_PERMS[name] ?? "unknown";

      if (!PERM_WATCH_HANDLES[name]) {
        const status = await navigator.permissions.query({ name });
        PERM_WATCH_HANDLES[name] = status;
        status.onchange = () => {
          const nv = normalize(status.state);
          if (
            nv === "granted" ||
            nv === "denied" ||
            (nv === "prompt" && !LAST_KNOWN_PERMS[name])
          ) {
            LAST_KNOWN_PERMS[name] = nv;
          }
          _maybeSendPermsUpdate({ [name]: LAST_KNOWN_PERMS[name] });
        };
      }
      return memoPerm(name, PERM_WATCH_HANDLES[name].state);
    } catch {
      return LAST_KNOWN_PERMS[name] ?? "unknown";
    }
  }

  async function collectPermissions() {
    const names = [
      "geolocation",
      "notifications",
      "camera",
      "microphone",
      "clipboard-read",
    ];
    const out = {};
    await Promise.all(
      names.map(async n => {
        out[n] = await queryPermission(n);
      })
    );
    for (const n of names) {
      if ((out[n] === "unknown" || out[n] === undefined) && LAST_KNOWN_PERMS[n]) {
        out[n] = LAST_KNOWN_PERMS[n];
      }
    }
    return out;
  }

  function _maybeSendPermsUpdate(delta) {
    try {
      const merged = { ...LAST_KNOWN_PERMS, ...(delta || {}) };
      const json = JSON.stringify(merged);
      if (json !== _lastSentPermsJson) {
        _lastSentPermsJson = json;
        safeSend({ type: "permissions-update", permissions: merged });
      }
    } catch {}
  }

  // ---- fingerprint detection ----
  function installFPHooks() {
    try {
      const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
      if (_toDataURL)
        HTMLCanvasElement.prototype.toDataURL = function (...a) {
          canvasCalls++;
          return _toDataURL.apply(this, a);
        };
    } catch {}
    try {
      const _getImageData = CanvasRenderingContext2D.prototype.getImageData;
      if (_getImageData)
        CanvasRenderingContext2D.prototype.getImageData = function (...a) {
          getImageDataCalls++;
          return _getImageData.apply(this, a);
        };
    } catch {}
    try {
      const GLProto = WebGLRenderingContext?.prototype;
      if (GLProto?.getParameter) {
        const _g = GLProto.getParameter;
        GLProto.getParameter = function (...a) {
          webglGetParamCalls++;
          return _g.apply(this, a);
        };
      }
    } catch {}
  }

  // ---- static DOM tracker scan (for background "tracker-results") ----
  function scanExternal() {
    const found = [];
    try {
      // Scripts / iframes / images
      document
        .querySelectorAll("script[src],iframe[src],img[src]")
        .forEach(el => {
          const src = el.getAttribute("src");
          if (!src) return;
          found.push({
            tag: el.tagName.toLowerCase(),
            src,
            tracker: isTrackerUrl(src),
            ts: Date.now(),
          });
        });

      // Preconnect / DNS-prefetch hints
      document
        .querySelectorAll("link[rel='preconnect'],link[rel='dns-prefetch']")
        .forEach(el => {
          const href = el.getAttribute("href");
          if (!href) return;
          found.push({
            tag: "link",
            src: href,
            tracker: isTrackerUrl(href),
            ts: Date.now(),
          });
        });
    } catch {}
    return found;
  }

  // ---- mutation tracker (dynamic resources) ----
  function watchMutations() {
    try {
      const mo = new MutationObserver(list => {
        let seen = 0;
        for (const m of list) {
          if (m.type !== "childList") continue;
          m.addedNodes.forEach(n => {
            if (seen >= MUTATION_SAMPLE_LIMIT) return;
            if (n.nodeType !== 1) return;
            let src = null,
              tag = null;
            if (n.tagName === "SCRIPT") {
              src = n.getAttribute("src");
              tag = "script";
            } else if (n.tagName === "IFRAME") {
              src = n.getAttribute("src");
              tag = "iframe";
            } else if (n.tagName === "IMG") {
              src = n.getAttribute("src");
              tag = "img";
            } else if (
              n.tagName === "LINK" &&
              /preconnect|dns-prefetch/i.test(n.getAttribute("rel") || "")
            ) {
              src = n.getAttribute("href");
              tag = "link";
            }
            if (src) {
              seen++;
              safeSend({
                type: "tracker-added",
                tracker: {
                  tag,
                  src,
                  tracker: isTrackerUrl(src),
                  ts: Date.now(),
                },
              });
            }
          });
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  }

  // ---- safe send wrapper ----
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch {}
  }

  // ---- heartbeat ----
  const encoder = new TextEncoder();

  async function heartbeat() {
    try {
      const permissions = await collectPermissions();
      _maybeSendPermsUpdate(permissions);

      const cookiesHint = (document.cookie || "")
        .split(";")
        .filter(Boolean).length;
      const storageBytesHint = encoder.encode(
        JSON.stringify(localStorage)
      ).length;

      const external = scanExternal(); // static tracker scan

      const signals = {
        url: location.href,
        title: document.title || "",
        timestamp: Date.now(),
        dnt:
          navigator.doNotTrack ||
          window.doNotTrack ||
          navigator.msDoNotTrack ||
          "unspecified",
        cookiesHint,
        storageBytesHint,
        permissions: { ...LAST_KNOWN_PERMS, ...permissions },
        fingerprintHints: { canvasCalls, getImageDataCalls, webglGetParamCalls },
        external,
      };

      const json = JSON.stringify(signals);
      if (json !== lastSignalsJson) {
        lastSignalsJson = json;
        lastSignalsObj = signals;

        // individual channels the background cares about
        safeSend({ type: "storage-update", storageBytes: storageBytesHint });
        safeSend({ type: "cookies-update", cookies: cookiesHint });
        // main tracker payload — background.js will read data.external
        safeSend({ type: "tracker-results", data: signals });
      }
    } catch (err) {
      console.warn("[NoTrace] heartbeat error", err);
    }
  }

  // ---- scan control ----
  function startScan() {
    if (heartbeatInterval) return;
    installFPHooks();
    watchMutations();
    heartbeat(); // run once immediately
    heartbeatInterval = setInterval(heartbeat, SCAN_INTERVAL_MS);
    safeSend({ type: "scan-start" });
  }

  function stopScan() {
    if (!heartbeatInterval) return;
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    safeSend({ type: "scan-stop" });
  }

  // ---- runtime messages ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg?.type === "notrace:get-live-permissions") {
        collectPermissions()
          .then(perms => sendResponse({ permissions: perms }))
          .catch(() =>
            sendResponse({ permissions: { ...LAST_KNOWN_PERMS } })
          );
        return true;
      }
      if (msg?.type === "notrace:get-live-signals") {
        collectPermissions()
          .then(perms =>
            sendResponse({ permissions: perms, signals: lastSignalsObj })
          )
          .catch(() =>
            sendResponse({
              permissions: { ...LAST_KNOWN_PERMS },
              signals: lastSignalsObj,
            })
          );
        return true;
      }
      if (msg?.type === "scan-start") startScan();
      if (msg?.type === "scan-stop") stopScan();
    } catch {}
    return false;
  });

  // ---- startup: auto on/off ----
  chrome.storage.local.get("NOTRACE_SCAN_ON", res => {
    (res?.NOTRACE_SCAN_ON?.on || false) ? startScan() : stopScan();
  });

  // ---- BroadcastChannel sync ----
  try {
    const bc = new BroadcastChannel("notrace");
    bc.onmessage = e => {
      const t = e?.data?.type;
      if (t === "scan-start") startScan();
      if (t === "scan-stop") stopScan();
    };
  } catch {}

  // ---- visibility-based cleanup (instead of unload) ----
  document.addEventListener("visibilitychange", () => {
    try {
      if (document.visibilityState === "hidden") {
        stopScan();
      } else if (document.visibilityState === "visible") {
        chrome.storage.local.get("NOTRACE_SCAN_ON", res => {
          if (res?.NOTRACE_SCAN_ON?.on) startScan();
        });
      }
    } catch {}
  });

  // debug helper
  window.__notrace_lastSignals = () => lastSignalsObj;
})();