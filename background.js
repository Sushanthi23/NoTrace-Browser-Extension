// ==================================
// background.js — MV3-safe, Real-time Messaging
// Flow: content.js → background.js → tracker.js / analyze.js / score.js
// ==================================

console.log("[NoTrace] background.js loaded ✅");

const MAX_TRACKER_EVENTS_PER_TAB = 500;
const ACTIVE_SYNC_INTERVAL_MS = 12_000;

// ---------------- state ----------------
let PER_TAB_STATE = {};
let currentHttpTabId = -1;
let currentHttpTabUrl = "";

// ---------------- BroadcastChannel ----------------
let bc = null;
try {
  bc = new BroadcastChannel("notrace");
  bc.onmessage = e => handleMessage(e?.data, "bc", null);
} catch (e) {
  console.warn("[NoTrace] BroadcastChannel failed", e);
}

function getBc() {
  try {
    if (!bc || bc.readyState === "closed") {
      bc = new BroadcastChannel("notrace");
      bc.onmessage = e => handleMessage(e?.data, "bc", null);
    }
    return bc;
  } catch { return null; }
}

// Debounced broadcast for data updates
const broadcastDebounced = (() => {
  let timer = null;
  let lastMsg = null;
  return (msg) => {
    lastMsg = msg;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!lastMsg) return;
      const m = lastMsg; lastMsg = null;
      try { const ch = getBc(); if (ch) ch.postMessage({ ...m, __from: "sw" }); } catch { }
      try { chrome.runtime.sendMessage({ ...m, __from: "sw" }, () => void chrome.runtime.lastError); } catch { }
    }, 500);
  };
})();

function broadcastNow(msg) {
  try { const ch = getBc(); if (ch) ch.postMessage({ ...msg, __from: "sw" }); } catch { }
  try { chrome.runtime.sendMessage({ ...msg, __from: "sw" }, () => void chrome.runtime.lastError); } catch { }
}

function broadcast(msg) {
  if (msg.type === "scan-start" || msg.type === "scan-stop") {
    broadcastNow(msg);
  } else {
    broadcastDebounced(msg);
  }
}

// promisify callback-style chrome APIs
const getBytesInUse = (keys = null) => new Promise(resolve => {
  try {
    if (chrome.storage?.local?.getBytesInUse) {
      chrome.storage.local.getBytesInUse(keys, bytes => resolve(bytes || 0));
    } else resolve(0);
  } catch { resolve(0); }
});

const cookiesGetAll = (details) => new Promise(resolve => {
  try {
    if (chrome.cookies?.getAll) {
      chrome.cookies.getAll(details, arr => resolve(arr || []));
    } else resolve([]);
  } catch { resolve([]); }
});

const storageGet = (keys) => new Promise(resolve => {
  try {
    chrome.storage.local.get(keys, res => resolve(res || {}));
  } catch { resolve({}); }
});

const storageSet = (obj) => new Promise(resolve => {
  try {
    chrome.storage.local.set(obj, () => resolve());
  } catch { resolve(); }
});

// ---------------- Debounced Storage ----------------
const persistDebounced = (() => {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { chrome.storage.local.set({ perTabState: PER_TAB_STATE }); } catch { }
    }, 400);
  };
})();

// ---------------- Debounced updateSummary per tab ----------------
const updateSummaryDebounced = (() => {
  const timers = {};
  return (tabId) => {
    clearTimeout(timers[tabId]);
    timers[tabId] = setTimeout(() => {
      delete timers[tabId];
      updateSummaryNow(tabId);
    }, 300);
  };
})();

function updateSummary(tabId) {
  updateSummaryDebounced(tabId);
}

// ---------------- Summary ----------------
function updateSummaryNow(tabId) {
  const st = PER_TAB_STATE[tabId];
  if (!st) return;

  const trackerList = Array.isArray(st.trackers) ? st.trackers : [];

  // Build latestAlert from known trackers
  const knownTrackers = trackerList.filter(t => t.tracker === true);
  if (knownTrackers.length > 0) {
    const domainCount = {};
    knownTrackers.forEach(t => {
      try {
        const d = new URL(t.src).hostname;
        domainCount[d] = (domainCount[d] || 0) + 1;
      } catch { }
    });
    const topDomain = Object.entries(domainCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    // ✅ FIX: skip saving alert if domain is empty or unresolvable
    if (!topDomain || topDomain === "unknown") return;
    const count = knownTrackers.length;
    const riskScore = Math.min(10, Math.max(1, Math.round(Math.log10(count + 1) / Math.log10(51) * 10)));
    const riskLevel = riskScore >= 8 ? "High Risk" : riskScore >= 5 ? "Medium Risk" : "Low Risk";

    const latestAlert = {
      domain: topDomain,
      owner: topDomain.split('.').slice(-2, -1)[0] || "Unknown",
      reason: "Behavioral profiling & ad targeting",
      riskScore,
      riskLevel,
      description: "aggressive tracking (fingerprinting, cross-site requests) and high-risk behavioral profiling activities",
      ts: Date.now()
    };
    try { chrome.storage.local.set({ latestAlert }); } catch { }
  }

  const summary = {
    url: st.url || "",
    lastScan: Date.now(),
    permissions: st.permissions || {},
    storageBytes: st.storageBytes || 0,
    cookies: st.cookies ?? 0,
    totalTrackers: knownTrackers.length,
  };

  try { chrome.storage.local.set({ lastResults: summary }); } catch { }
  broadcast({ type: "summary-updated", summary, perTab: PER_TAB_STATE });

  // ✅ FIX: keep tabRiskScores in sync with lastResults/latestAlert
  // debounced so it doesn't fire on every single tracker — max once per 2s
  buildTabRiskScoresDebounced();
}

const buildTabRiskScoresDebounced = (() => {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(() => buildTabRiskScores(), 2000);
  };
})();

// ---------------- Tab Risk Scores ----------------
// ✅ FIX: only include tabs that are currently open
function buildTabRiskScores() {
  chrome.tabs.query({}, openTabs => {
    if (chrome.runtime.lastError) return;

    // Get set of currently open tab IDs
    const openTabIds = new Set((openTabs || []).map(t => String(t.id)));

    // ✅ FIX: remove closed tabs from PER_TAB_STATE
    Object.keys(PER_TAB_STATE).forEach(id => {
      if (!openTabIds.has(id)) {
        delete PER_TAB_STATE[id];
      }
    });

    const scores = Object.values(PER_TAB_STATE)
      .filter(st => st.url && /^https?:/.test(st.url))
      .map(st => {
        let label = "unknown";
        try { label = new URL(st.url).hostname; } catch { }
        const trackerCount = Array.isArray(st.trackers)
          ? st.trackers.filter(t => t.tracker === true).length
          : 0;
        const trackerScore = trackerCount > 0
          ? Math.round(Math.log10(trackerCount + 1) / Math.log10(51) * 85)
          : 0;
        const cookieScore = Math.round(Math.min(15, (st.cookies || 0) * 0.5));
        const score = Math.min(100, trackerScore + cookieScore);
        return { label, score };
      })
      .filter(s => s.label !== "unknown")
      .reduce((acc, cur) => {
        const existing = acc.find(a => a.label === cur.label);
        if (existing) { if (cur.score > existing.score) existing.score = cur.score; }
        else acc.push(cur);
        return acc;
      }, [])
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const overallScore = scores.length
      ? Math.round(scores.reduce((s, t) => s + t.score, 0) / scores.length)
      : 0;

    try { chrome.storage.local.set({ tabRiskScores: scores, overallScore }); } catch { }
  });
}

// ---------------- Active Tab Sync ----------------
async function syncActiveTab(tab) {
  if (!tab?.id || !tab?.url || !/^https?:/.test(tab.url)) return;

  currentHttpTabId = tab.id;
  currentHttpTabUrl = tab.url;

  PER_TAB_STATE[tab.id] = {
    ...(PER_TAB_STATE[tab.id] || {}),
    url: tab.url,
    lastScan: Date.now(),
  };

  computeStorage(tab.id);
  computeCookies(tab.id, tab.url);
  updateSummary(tab.id);
}

chrome.tabs.onActivated.addListener(info => {
  try {
    chrome.tabs.get(info.tabId, tab => {
      if (chrome.runtime.lastError) return;
      syncActiveTab(tab);
    });
  } catch { }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") syncActiveTab(tab);
});

// ✅ FIX: remove closed tabs from state immediately
chrome.tabs.onRemoved.addListener((tabId) => {
  if (PER_TAB_STATE[tabId]) {
    delete PER_TAB_STATE[tabId];
    persistDebounced();
    buildTabRiskScores();
  }
});

// Fallback polling
setInterval(() => {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (chrome.runtime.lastError) return;
      const tab = tabs?.[0];
      if (tab) syncActiveTab(tab);
    });
  } catch { }
}, ACTIVE_SYNC_INTERVAL_MS);

// ---------------- Helpers: Storage & Cookies ----------------
async function computeStorage(tabId) {
  try {
    const usage = await getBytesInUse(null);
    updateTabField(tabId, "storageBytes", usage, "storage-update");
  } catch (e) {
    console.warn("[NoTrace] computeStorage failed", e);
  }
}

async function computeCookies(tabId, url) {
  try {
    if (!url) return;
    const cookies = await cookiesGetAll({ url });
    updateTabField(tabId, "cookies", Array.isArray(cookies) ? cookies.length : 0, "cookies-update");
  } catch (e) {
    console.warn("[NoTrace] computeCookies failed", e);
  }
}

const resolveTabId = (msg, sender) => {
  return msg?.tabId ?? sender?.tab?.id ?? currentHttpTabId;
};

// ---------------- Update Helpers ----------------
const updateTabField = (tabId, field, value, broadcastType) => {
  if (!tabId) return;
  PER_TAB_STATE[tabId] = {
    ...(PER_TAB_STATE[tabId] || {}),
    [field]: value,
    lastScan: Date.now()
  };
  persistDebounced();
  if (broadcastType) {
    broadcast({ type: broadcastType, tabId, [field]: value });
  }
  updateSummary(tabId);
};

const updateTrackers = (tabId, tracker) => {
  if (!tabId || !tracker) return;
  const st = PER_TAB_STATE[tabId] || {};
  const curList = Array.isArray(st.trackers) ? st.trackers : [];

  // Deduplicate by src
  if (curList.some(t => t.src === tracker.src)) return;

  if (curList.length >= MAX_TRACKER_EVENTS_PER_TAB) curList.shift();
  curList.push(tracker);

  PER_TAB_STATE[tabId] = {
    ...st,
    trackers: curList,
    totalTrackers: curList.length,
    lastScan: Date.now(),
  };
  persistDebounced();
  updateSummary(tabId);
};

// ---------------- Message Handling ----------------
function handleMessage(msg, source = "runtime", sender = null) {
  if (!msg || msg.__from === "sw") return;

  const tabId = resolveTabId(msg, sender);

  switch (msg.type) {
    case "summary-request":
      return {
        summary: PER_TAB_STATE[currentHttpTabId] || null,
        perTab: PER_TAB_STATE,
      };

    case "scan-start":
    case "notrace:scan-activated":
      // ✅ FIX: on new scan, keep tab URLs but clear tracker data only
      Object.keys(PER_TAB_STATE).forEach(id => {
        if (PER_TAB_STATE[id]) {
          PER_TAB_STATE[id].trackers = [];
          PER_TAB_STATE[id].totalTrackers = 0;
        }
      });
      try { chrome.storage.local.remove(['latestAlert', 'tabRiskScores', 'overallScore']); } catch { }
      // Forward to content scripts only — do NOT echo back to UI
      try {
        chrome.tabs.query({}, tabs => {
          tabs.forEach(tab => {
            if (tab?.id && /^https?:/.test(tab.url || "")) {
              chrome.tabs.sendMessage(tab.id, { type: "scan-start" }, () =>
                void chrome.runtime.lastError
              );
            }
          });
        });
      } catch { }
      break;

    case "scan-stop":
    case "notrace:scan-ended":
      // Forward stop to content scripts only — do NOT echo back to UI
      try {
        chrome.tabs.query({}, tabs => {
          tabs.forEach(tab => {
            if (tab?.id) {
              chrome.tabs.sendMessage(tab.id, { type: "scan-stop" }, () =>
                void chrome.runtime.lastError
              );
            }
          });
        });
      } catch { }
      // Build final scores after scan stops — all tabs scored equally at this point
      setTimeout(() => buildTabRiskScores(), 800);
      break;

    case "permissions-update":
      updateTabField(tabId, "permissions", msg.permissions, "permissions-update");
      break;

    case "storage-update":
      updateTabField(tabId, "storageBytes", msg.storageBytes, "storage-update");
      break;

    case "cookies-update":
      updateTabField(tabId, "cookies", msg.cookies, "cookies-update");
      break;

    case "tracker-results":
      if (msg.data?.external && Array.isArray(msg.data.external)) {
        msg.data.external.forEach(tr => {
          try {
            if (!tr?.src) return;
            // ✅ FIX: trust content.js tracker flag — don't force true on all third-party
            if (tr.tracker === true) {
              updateTrackers(tabId, tr);
            }
          } catch { }
        });
      }
      break;

    case "tracker-added":
      // ✅ FIX: trust content.js tracker flag
      if (msg.tracker?.tracker === true) {
        updateTrackers(tabId, msg.tracker);
      }
      break;

    case "hydrate-request":
      broadcastNow({
        type: "summary-updated",
        summary: PER_TAB_STATE[currentHttpTabId] || null,
        perTab: PER_TAB_STATE
      });
      break;
  }

  if (msg.action === "START_SCAN") handleMessage({ type: "scan-start" }, source, sender);
  if (msg.action === "STOP_SCAN") handleMessage({ type: "scan-stop" }, source, sender);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    const resp = handleMessage(msg, "runtime", sender);
    sendResponse(resp || { ok: true });
  } catch (e) {
    try { sendResponse({ ok: false, error: String(e) }); } catch { }
  }
  return true;
});

// ---------------- Startup hydration ----------------
(async function startup() {
  try {
    // ✅ FIX: validate persisted tab IDs against actually open tabs
    const stored = await storageGet(['perTabState']);
    const openTabs = await new Promise(res => {
      chrome.tabs.query({}, tabs => {
        if (chrome.runtime.lastError) res([]);
        else res(tabs || []);
      });
    });
    const openTabIds = new Set(openTabs.map(t => String(t.id)));

    if (stored?.perTabState) {
      // Only keep state for tabs that are still open
      PER_TAB_STATE = Object.fromEntries(
        Object.entries(stored.perTabState).filter(([id]) => openTabIds.has(id))
      );
    } else {
      PER_TAB_STATE = {};
    }

    // Sync all currently open HTTP tabs
    openTabs.forEach(tab => {
      if (tab?.url && /^https?:/.test(tab.url)) {
        PER_TAB_STATE[tab.id] = {
          ...(PER_TAB_STATE[tab.id] || {}),
          url: tab.url,
        };
      }
    });

    // Set current active tab
    const activeTabs = openTabs.filter(t => t.active);
    if (activeTabs.length) {
      const tab = activeTabs[0];
      if (tab?.url && /^https?:/.test(tab.url)) {
        currentHttpTabId = tab.id;
        currentHttpTabUrl = tab.url;
      }
    }

    buildTabRiskScores();

    // ✅ FIX: clear latestAlert if domain is unknown/empty
    const storedAlert = await storageGet(['latestAlert']);
    if (!storedAlert?.latestAlert?.domain || storedAlert.latestAlert.domain === 'unknown') {
      try { chrome.storage.local.remove(['latestAlert']); } catch { }
    }

    // ✅ FIX: clear lastResults if stored URL doesn't match any open tab
    const stored2 = await storageGet(['lastResults']);
    if (stored2?.lastResults?.url) {
      let storedHost = "";
      try { storedHost = new URL(stored2.lastResults.url).hostname; } catch { }
      const openHosts = openTabs.map(t => { try { return new URL(t.url || "").hostname; } catch { return ""; } });
      if (storedHost && !openHosts.includes(storedHost)) {
        try { chrome.storage.local.remove(['lastResults', 'latestAlert']); } catch { }
      }
    }

    broadcastNow({
      type: "summary-updated",
      summary: PER_TAB_STATE[currentHttpTabId] || null,
      perTab: PER_TAB_STATE
    });
  } catch (e) {
    console.warn("[NoTrace] startup hydration failed", e);
  }
})();

// ---------------- Action Click → Dashboard ----------------
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// ---------------- Keep Alive ----------------
try {
  chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === "keepAlive") chrome.runtime.getPlatformInfo(() => { });
  });
} catch { }