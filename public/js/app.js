'use strict';

/* ---------------------------------------------------------------
   Main App – native WebSocket client, state management, orchestration
   --------------------------------------------------------------- */

let _vm = null;
let _selectedNr = null;
let _selectedNrs = [];
let _activeClass = null;
let _activeSeries = 'GTWorldCh';
let _sectorCount = 3;
let _socket = null;   // native WebSocket
let _replayMode = false;
const WIDE_LAYOUT_MIN_WIDTH = 1920;
const WIDE_LAYOUT_SPLIT_SIZE = 38;

// ---- DOM refs (populated on DOMContentLoaded) ----
let elStatusDot, elSessionName, elFlag, elTimeRemaining, elLocalTime, elLapInfo;
let _sessionStartMs = null;
let elFilterBar, elSidebar, elFullscreenBtn, elTimingChartHost, elTimingPaneRight;
let elTableSections = [];

document.addEventListener('DOMContentLoaded', () => {
  elStatusDot = document.getElementById('status-dot');
  elSessionName = document.getElementById('session-name');
  elFlag = document.getElementById('flag-status');
  elTimeRemaining = document.getElementById('time-remaining');
  elLocalTime = document.getElementById('local-time');
  elLapInfo = document.getElementById('lap-info');
  elFilterBar = document.getElementById('filter-bar');
  elSidebar = document.getElementById('sidebar');

  // Series selector
  document.getElementById('series-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.series-btn');
    if (!btn) return;
    const key = btn.dataset.series;
    if (key === _activeSeries) return;
    _activeSeries = key;
    _activeClass = null;
    for (const b of document.querySelectorAll('.series-btn')) b.classList.toggle('active', b.dataset.series === key);
    socketSend({ type: 'setSeries', data: key });
  });
  elFullscreenBtn = document.getElementById('fullscreen-btn');
  elTimingChartHost = document.getElementById('timing-chart-host');
  elTimingPaneRight = document.getElementById('timing-pane-right');
  elTableSections = [
    {
      thead: document.getElementById('timing-thead-left'),
      tbody: document.getElementById('timing-tbody-left'),
    },
    {
      thead: document.getElementById('timing-thead-right'),
      tbody: document.getElementById('timing-tbody-right'),
    },
  ];

  // Init table module
  window.TableRenderer.initTable((nr, event) => {
    handleCarSelection(nr, event);
  });

  // Local clock + elapsed timer
  setInterval(updateLocalTime, 1000);
  setInterval(updateElapsed, 1000);
  updateLocalTime();

  window.addEventListener('resize', handleViewportResize);
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  if (elFullscreenBtn) elFullscreenBtn.addEventListener('click', toggleFullscreen);
  syncFullscreenButton();

  connectSocket();
});

// -----------------------------------------------------------------------
// Public control surface (used by sessions.js)
// -----------------------------------------------------------------------
window.AppControl = {
  enterReplay(vm, label) {
    _replayMode = true;
    if (_socket) { try { _socket.close(); } catch (_) {} _socket = null; }

    document.getElementById('replay-banner').classList.remove('hidden');
    document.getElementById('replay-label').textContent = label || '';
    elStatusDot.className = 'replay';
    elStatusDot.title = 'Replay mode';

    _vm = vm;
    applyUpdate(vm);
  },

  exitReplay() {
    _replayMode = false;
    document.getElementById('replay-banner').classList.add('hidden');
    elStatusDot.className = '';
    elStatusDot.title = 'Connecting…';
    connectSocket();
  },

  toggleFullscreen,
};

// -----------------------------------------------------------------------
// Native WebSocket (replaces Socket.IO)
// -----------------------------------------------------------------------
let _reconnectTimer = null;

function connectSocket() {
  if (_socket) {
    try { _socket.close(); } catch (_) {}
    _socket = null;
  }
  clearTimeout(_reconnectTimer);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  _socket = ws;

  ws.addEventListener('open', () => {
    elStatusDot.className = 'connected';
    elStatusDot.title = 'Connected';
    // Re-apply series and class filter after reconnect
    ws.send(JSON.stringify({ type: 'setSeries', data: _activeSeries }));
    if (_activeClass) {
      ws.send(JSON.stringify({ type: 'setClassFilter', data: _activeClass }));
    }
  });

  ws.addEventListener('close', () => {
    if (_replayMode) return;
    elStatusDot.className = 'error';
    elStatusDot.title = 'Disconnected – reconnecting…';
    _reconnectTimer = setTimeout(connectSocket, 3000);
  });

  ws.addEventListener('error', () => {
    try { ws.close(); } catch (_) {}
  });

  ws.addEventListener('message', (event) => {
    if (_replayMode) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'update') {
      _vm = msg.data;
      updateSeriesBar(_vm.availableSeries);
      applyUpdate(_vm);
    }

    if (msg.type === 'carDetail') {
      const car = msg.data;
      if (_vm && car.nr) {
        const idx = _vm.cars.findIndex(c => c.nr === car.nr);
        if (idx >= 0) {
          _vm.cars[idx].lapHistory = car.lapHistory || [];
          _vm.cars[idx].bestLapByDriver = car._bestLapByDriver || {};
          _vm.cars[idx].bestSectorsByKey = car._bestSectors || {};
          updateSidebar();
          updateTimingChart();
        }
      }
    }
  });
}

function socketSend(msg) {
  if (_socket && _socket.readyState === WebSocket.OPEN) {
    _socket.send(JSON.stringify(msg));
  }
}

// -----------------------------------------------------------------------
// Main update cycle
// -----------------------------------------------------------------------
function applyUpdate(vm) {
  updateHeader(vm.session);
  updateFilterBar(vm.classes, vm.activeClass);
  updateTable(vm.cars);
  updateSidebar();
  updateTimingChart();
}

// -----------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------
function updateHeader(session) {
  if (!session) return;
  if (session.sessionName) elSessionName.textContent = session.sessionName;

  const flag = session.flag || session.Flag || '';
  if (flag) {
    elFlag.textContent = flag.toUpperCase();
    elFlag.className = `flag-badge flag-${flag.toUpperCase().replace(/\s+/g, '')}`;
  }

  if (session.startTimeMs) _sessionStartMs = session.startTimeMs;
}

function updateElapsed() {
  if (!_sessionStartMs || !elTimeRemaining) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - _sessionStartMs) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  elTimeRemaining.textContent =
    (h > 0 ? `${h}:` : '') +
    String(m).padStart(h > 0 ? 2 : 1, '0') + ':' +
    String(s).padStart(2, '0');
}

function updateLocalTime() {
  if (!elLocalTime) return;
  const now = new Date();
  elLocalTime.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function updateSeriesBar(availableSeries) {
  if (!availableSeries) return;
  for (const s of availableSeries) {
    const btn = document.querySelector(`.series-btn[data-series="${s.key}"]`);
    if (!btn) continue;
    btn.classList.toggle('active', s.key === _activeSeries);
    // Dim series buttons that have no live data yet
    btn.style.opacity = s.active ? '1' : '0.45';
    btn.title = s.active ? s.label : `${s.label} (no active session)`;
  }
}

// -----------------------------------------------------------------------
// Filter bar
// -----------------------------------------------------------------------
function updateFilterBar(classes, activeClass) {
  if (!classes || classes.length === 0) return;

  _activeClass = activeClass || null;

  const allBtn = makeClassBtn('ALL', null, !_activeClass);
  const classBtns = classes.map(cls => makeClassBtn(cls, cls, _activeClass === cls));

  elFilterBar.innerHTML = `<span class="filter-label">Class:</span>`;
  [allBtn, ...classBtns].forEach(b => elFilterBar.appendChild(b));
}

function makeClassBtn(label, value, isActive) {
  const btn = document.createElement('button');
  btn.className = 'class-btn' + (isActive ? ' active' : '');
  btn.textContent = label;
  const classColors = {
    PRO: ['#ffffff', '#000'],
    GOLD: ['#d4a017', '#000'],
    SILVER: ['#3a6bbf', '#fff'],
    BRONZE: ['#7b4f2e', '#fff'],
    'PRO-AM': ['#2d7a3a', '#fff'],
    AM: ['#7b4f2e', '#fff'],
  };
  if (value && classColors[value.toUpperCase()]) {
    const [bg, text] = classColors[value.toUpperCase()];
    btn.style.background = bg;
    btn.style.color = text;
  } else if (!value) {
    btn.style.background = '#333';
    btn.style.color = '#eee';
  }
  btn.addEventListener('click', () => {
    _activeClass = value;
    if (!_replayMode) {
      socketSend({ type: 'setClassFilter', data: value });
    } else if (_vm) {
      applyReplayFilter(value);
    }
    for (const b of elFilterBar.querySelectorAll('.class-btn')) b.classList.remove('active');
    btn.classList.add('active');
  });
  return btn;
}

function applyReplayFilter(cls) {
  if (!_vm) return;
  const filtered = cls ? _vm.cars.filter(c => c.className === cls) : _vm.cars;
  updateTable(filtered);
}

// -----------------------------------------------------------------------
// Table
// -----------------------------------------------------------------------
function updateTable(cars) {
  if (!cars) return;

  const sectorKeys = new Set();
  for (const car of cars) {
    for (const k of Object.keys(car.sectors || {})) sectorKeys.add(k);
  }
  const newSectorCount = Math.max(0, ...Array.from(sectorKeys).map(k => parseInt(k.replace('S', ''), 10) || 0));
  const needsHeader = elTableSections.some(section => !section.thead.innerHTML);
  if (newSectorCount !== _sectorCount || needsHeader) {
    _sectorCount = newSectorCount;
    const headerHtml = `<tr>${window.TableRenderer.buildTableHeader(_sectorCount)}</tr>`;
    for (const section of elTableSections) {
      section.thead.innerHTML = headerHtml;
    }
  }

  const [leftCars, rightCars] = splitCarsForLayout(cars);
  window.TableRenderer.renderTable(elTableSections[0].tbody, leftCars, _sectorCount);
  window.TableRenderer.renderTable(elTableSections[1].tbody, rightCars, _sectorCount);
  window.TableRenderer.setSelectedNrs(_selectedNrs);
}

function splitCarsForLayout(cars) {
  return [cars, []];
}

function isWideTimingLayout() {
  return window.innerWidth >= WIDE_LAYOUT_MIN_WIDTH;
}

function handleViewportResize() {
  if (!_vm) return;
  const cars = _vm.cars || [];
  const filteredCars = _activeClass ? cars.filter(c => c.className === _activeClass) : cars;
  updateTable(filteredCars);
  updateTimingChart();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.error('Fullscreen toggle failed:', err);
  }
}

function syncFullscreenButton() {
  if (!elFullscreenBtn) return;
  const isFullscreen = !!document.fullscreenElement;
  elFullscreenBtn.textContent = isFullscreen ? 'Fenster' : 'Vollbild';
  elFullscreenBtn.classList.toggle('active', isFullscreen);
  elFullscreenBtn.title = isFullscreen ? 'Vollbild verlassen' : 'Vollbild aktivieren';
}

// -----------------------------------------------------------------------
// Sidebar
// -----------------------------------------------------------------------
function updateSidebar() {
  if (!_vm) return;
  if (_replayMode) {
    if (_selectedNr) {
      const car = window.SessionArchive.getReplayCar(_selectedNr);
      if (car && _vm) {
        const idx = _vm.cars.findIndex(c => c.nr === String(_selectedNr));
        if (idx >= 0) {
          _vm.cars[idx].lapHistory = car.lapHistory || [];
          _vm.cars[idx].bestLapByDriver = car._bestLapByDriver || {};
          _vm.cars[idx].bestSectorsByKey = car._bestSectors || {};
        }
      }
    }
  } else if (_selectedNr && _socket) {
    for (const nr of _selectedNrs) {
      socketSend({ type: 'getCarDetail', data: nr });
    }
  }
  window.SidebarRenderer.renderSidebar(elSidebar, _vm, _selectedNr);
}

function updateTimingChart() {
  if (!elTimingChartHost || !elTimingPaneRight) return;
  if (!_vm || _selectedNrs.length === 0 || !isWideTimingLayout()) {
    elTimingChartHost.innerHTML = '';
    elTimingPaneRight.classList.remove('has-chart');
    return;
  }

  const selectedCars = _selectedNrs
    .map(nr => (_vm.cars || []).find(c => c.nr === String(nr) || c.nr === nr))
    .filter(car => car && car.lapHistory && car.lapHistory.length > 0);
  if (selectedCars.length === 0) {
    elTimingChartHost.innerHTML = '';
    elTimingPaneRight.classList.remove('has-chart');
    return;
  }

  const chartHtml = window.SidebarRenderer.renderMultiLapTimeChart(selectedCars, {
    showHeader: false,
    phases: _vm.neutralizationPhases || [],
  });
  if (chartHtml) {
    const primaryCar = selectedCars.find(car => String(car.nr) === String(_selectedNr)) || selectedCars[0];
    const bestLap = primaryCar.bestLap?.raw || '-';
    const lastLap = primaryCar.lastLap?.raw || '-';
    const title = selectedCars.length === 1
      ? `Car #${escapeHtml(primaryCar.nr)} Lap Times`
      : `${selectedCars.length} Cars Lap Times`;
    const subtitle = selectedCars.length === 1
      ? escapeHtml(primaryCar.team || '')
      : selectedCars.map(car => `#${escapeHtml(car.nr)}`).join(' · ');
    elTimingPaneRight.classList.add('has-chart');
    elTimingChartHost.innerHTML = `<div class="timing-chart-panel">
      <div class="timing-chart-head">
        <div class="timing-chart-title-row">
          <span class="timing-chart-caption">${title}</span>
          <span class="timing-chart-team">${subtitle}</span>
        </div>
        <div class="timing-chart-meta">
          <span>Best ${escapeHtml(bestLap)}</span>
          <span>Last ${escapeHtml(lastLap)}</span>
        </div>
      </div>
      ${chartHtml}
    </div>`;
  } else {
    elTimingChartHost.innerHTML = '';
    elTimingPaneRight.classList.remove('has-chart');
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function handleCarSelection(nr, event) {
  const id = String(nr);
  const isMultiToggle = !!(event?.ctrlKey || event?.metaKey);

  if (isMultiToggle) {
    if (_selectedNrs.includes(id)) {
      _selectedNrs = _selectedNrs.filter(selectedNr => selectedNr !== id);
      if (String(_selectedNr) === id) {
        _selectedNr = _selectedNrs[_selectedNrs.length - 1] || null;
      }
    } else {
      _selectedNrs = [..._selectedNrs, id];
      _selectedNr = id;
    }
  } else {
    _selectedNrs = [id];
    _selectedNr = id;
  }

  window.TableRenderer.setSelectedNrs(_selectedNrs);
  updateSidebar();
  updateTimingChart();
}
