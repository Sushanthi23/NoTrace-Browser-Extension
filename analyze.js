document.getElementById('notrace-year').textContent = new Date().getFullYear();

function getBarColor(score) {
  if (score >= 80) return 'bar-red';
  if (score >= 60) return 'bar-orange';
  if (score >= 40) return 'bar-yellow';
  if (score >= 20) return 'bar-lime';
  return 'bar-green';
}

function renderChart(tabScores) {
  const barsEl   = document.getElementById('riskChart');
  const labelsEl = document.getElementById('riskChartLabels');
  if (!barsEl) return;

  if (!tabScores || tabScores.length === 0) {
    barsEl.innerHTML = '<p style="color:#5f8a92;font-size:0.85rem;padding:20px">No tab data yet. Start a scan to populate scores.</p>';
    if (labelsEl) labelsEl.innerHTML = '';
    return;
  }

  barsEl.innerHTML   = '';
  if (labelsEl) labelsEl.innerHTML = '';

  tabScores.forEach(({ label, score }) => {
    // Bar column
    const wrap = document.createElement('div');
    wrap.className = 'chart-bar-wrap';

    const scoreLabel = document.createElement('span');
    scoreLabel.className = 'chart-score-label';
    scoreLabel.textContent = score;

    const bar = document.createElement('div');
    bar.className = 'chart-bar ' + getBarColor(score);
    bar.style.height = Math.max(score, 1) + '%';
    bar.title = label + ': ' + score;

    wrap.appendChild(scoreLabel);
    wrap.appendChild(bar);
    barsEl.appendChild(wrap);

    // X-axis label (separate row)
    if (labelsEl) {
      const lbl = document.createElement('div');
      lbl.className = 'chart-site-label';
      // Show only hostname without www for readability
      lbl.textContent = label.replace(/^www\./, '');
      lbl.title = label;
      labelsEl.appendChild(lbl);
    }
  });
}

let _lastAlertJson = null;

function applyTrackerData(alert) {
  const grid   = document.getElementById('trackerGrid');
  const noScan = document.getElementById('noScanMsg');
  const isValid = !!(alert && alert.domain &&
                     alert.domain !== 'unknown' &&
                     alert.domain !== '—');

  if (!isValid) {
    if (grid)   grid.style.display   = 'none';
    if (noScan) noScan.style.display = '';
    _lastAlertJson = null;
    return;
  }

  const alertJson = JSON.stringify(alert);
  if (alertJson === _lastAlertJson) return;
  _lastAlertJson = alertJson;

  if (grid)   grid.style.display   = '';
  if (noScan) noScan.style.display = 'none';

  const el = id => document.getElementById(id);
  if (el('trackerName'))   el('trackerName').textContent   = 'Unknown Tracker Detected: ' + alert.domain;
  if (el('trackerOwner'))  el('trackerOwner').textContent  = alert.owner  || '—';
  if (el('trackerReason')) el('trackerReason').textContent = alert.reason || '—';

  const riskLevel = alert.riskLevel || 'Unknown';
  const badge = el('riskBadge');
  if (badge) {
    badge.textContent = (riskLevel === 'High Risk' ? '⚠️ ' : '') + riskLevel;
    badge.style.color = riskLevel === 'High Risk'   ? '#f87171'
                      : riskLevel === 'Medium Risk' ? '#fbbf24' : '#34d399';
  }

  const score  = alert.riskScore || 0;
  const dotsEl = el('riskDots');
  if (dotsEl) {
    dotsEl.innerHTML = score + ' / 10 &nbsp;';
    for (let i = 1; i <= 10; i++) {
      const d = document.createElement('span');
      d.className = 'risk-dot ' + (
        i <= score
          ? (score >= 8 ? 'filled-red' : score >= 5 ? 'filled-orange' : 'filled-yellow')
          : 'empty'
      );
      dotsEl.appendChild(d);
    }
  }

  const whyDesc = el('whyDescription');
  if (whyDesc) {
    whyDesc.innerHTML =
      `<strong>${alert.domain}</strong>, owned by ` +
      `<a href="#">${alert.owner || '—'}</a>, is flagged due to ` +
      `${alert.description || 'aggressive tracking activities'}.`;
  }
}

// ── Init: fetch both data sources in parallel, reveal UI once both done ──
function init() {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    document.getElementById('analyzeWrapper').style.visibility = 'visible';
    return;
  }

  const wrapper = document.getElementById('analyzeWrapper');

  chrome.storage.local.get(['tabRiskScores', 'latestAlert'], (result) => {
    // Render chart
    renderChart(result.tabRiskScores && result.tabRiskScores.length
      ? result.tabRiskScores : []);

    // Clean stale alert then apply
    const a = result.latestAlert;
    const isStale = !a || !a.domain || a.domain === 'unknown' || a.domain === '—';
    if (isStale) {
      chrome.storage.local.remove(['latestAlert']);
      applyTrackerData(null);
    } else {
      applyTrackerData(a);
    }

    // ✅ Reveal wrapper only after both are rendered — single storage call
    if (wrapper) wrapper.style.visibility = 'visible';
  });
}

init();

// ── Live updates ──
let _liveDebounce = null;
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    clearTimeout(_liveDebounce);
    _liveDebounce = setTimeout(() => {
      if (changes.tabRiskScores) {
        renderChart(changes.tabRiskScores.newValue || []);
      }
      if (changes.latestAlert) {
        applyTrackerData(changes.latestAlert.newValue || null);
      }
    }, 300);
  });
}