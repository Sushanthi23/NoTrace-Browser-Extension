document.getElementById('notrace-year').textContent = new Date().getFullYear();

function pillClass(score) {
  if (score >= 80) return 'pill-red';
  if (score >= 60) return 'pill-orange';
  if (score >= 45) return 'pill-amber';
  if (score >= 30) return 'pill-yellow';
  return 'pill-green';
}

function renderTables(data) {
  const half = Math.ceil(data.length / 2);
  const left  = data.slice(0, half);
  const right = data.slice(half);

  function buildRows(arr, tbodyId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = '';
    arr.forEach(({ label, score }) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${label}</td>
        <td><span class="score-pill ${pillClass(score)}">${score}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }

  buildRows(left,  'tableBody1');
  buildRows(right, 'tableBody2');
}

// ✅ FIX: null check before setAttribute to prevent the error
function setGauge(score) {
  const needle      = document.getElementById('needle');
  const gaugeNumber = document.getElementById('gaugeNumber');
  const arcProgress = document.getElementById('arcProgress');

  if (!needle || !gaugeNumber || !arcProgress) return;

  const angle = -90 + (score / 100) * 180;
  needle.setAttribute('transform', `rotate(${angle}, 100, 118)`);
  gaugeNumber.textContent = score;

  const offset = 207 - (score / 100) * 207;
  arcProgress.setAttribute('stroke-dashoffset', offset);
}

function loadScoreData() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get(['tabRiskScores', 'overallScore'], (result) => {
      // ✅ FIX: no demo fallback — show empty tables if no real data
      const data  = (result.tabRiskScores && result.tabRiskScores.length)
                    ? result.tabRiskScores : [];
      const score = result.overallScore ?? 0;
      renderTables(data);
      animateGauge(score);
    });
  }
}

function animateGauge(target) {
  let current = 0;
  const step = () => {
    current = Math.min(current + 2, target);
    setGauge(current);
    if (current < target) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

loadScoreData();

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tabRiskScores || changes.overallScore) loadScoreData();
  });
}