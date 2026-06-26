'use strict';

/* ---------------------------------------------------------------
   Session Archive – browse and load past sessions in replay mode
   --------------------------------------------------------------- */

let _replayCarMap = new Map(); // nr -> full car record (with lapHistory)

// -----------------------------------------------------------------------
// Public API used by app.js
// -----------------------------------------------------------------------

window.SessionArchive = {
  open: openArchiveModal,
  getReplayCar: (nr) => _replayCarMap.get(String(nr)) || null,
};

// -----------------------------------------------------------------------
// Modal
// -----------------------------------------------------------------------

function openArchiveModal() {
  let modal = document.getElementById('archive-modal');
  if (!modal) modal = buildModal();
  modal.classList.remove('hidden');
  loadSessionList(modal.querySelector('#archive-list'));
}

function closeArchiveModal() {
  const modal = document.getElementById('archive-modal');
  if (modal) modal.classList.add('hidden');
}

function buildModal() {
  const modal = document.createElement('div');
  modal.id = 'archive-modal';
  modal.className = 'archive-modal hidden';
  modal.innerHTML = `
    <div class="archive-modal-inner">
      <div class="archive-modal-header">
        <span class="archive-modal-title">Session Archive</span>
        <button class="archive-modal-close" id="archive-close">✕</button>
      </div>
      <div id="archive-list" class="archive-list">
        <div class="archive-loading">Loading…</div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#archive-close').addEventListener('click', closeArchiveModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeArchiveModal(); });

  return modal;
}

async function loadSessionList(container) {
  container.innerHTML = '<div class="archive-loading">Loading…</div>';
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();

    if (!sessions.length) {
      container.innerHTML = '<div class="archive-empty">No archived sessions yet.<br>Sessions are saved automatically when a new session starts.</div>';
      return;
    }

    container.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'archive-row';
      row.innerHTML = `
        <div class="archive-row-label">${esc(s.label)}</div>
        <div class="archive-row-meta">
          <span class="archive-row-date">${formatDate(s.savedAt)}</span>
          <span class="archive-row-cars">${s.carCount} cars</span>
        </div>
      `;
      row.addEventListener('click', () => loadReplaySession(s.id));
      container.appendChild(row);
    }
  } catch {
    container.innerHTML = '<div class="archive-empty">Failed to load sessions.</div>';
  }
}

// -----------------------------------------------------------------------
// Load & activate replay
// -----------------------------------------------------------------------

async function loadReplaySession(id) {
  closeArchiveModal();

  const replayLabel = document.getElementById('replay-label');
  if (replayLabel) replayLabel.textContent = 'Loading…';

  try {
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();

    // Build a fast lookup map for detail view
    _replayCarMap = new Map();
    for (const car of (data.carsDetail || [])) {
      _replayCarMap.set(String(car.nr), car);
    }

    // Hand off to app.js
    window.AppControl.enterReplay(data.vm, data.label);
  } catch (e) {
    alert('Failed to load session: ' + e.message);
    window.AppControl.exitReplay();
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
