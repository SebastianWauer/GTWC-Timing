'use strict';

/* ---------------------------------------------------------------
   Timing Table Renderer
   Builds and incrementally updates the main timing table.
   --------------------------------------------------------------- */


let _tableSelectedNrs = new Set();
let _onCarSelect = null;

function initTable(onCarSelect) {
  _onCarSelect = onCarSelect;
}

/**
 * Render/update the full timing table.
 * @param {HTMLTableSectionElement} tbody
 * @param {Array}  cars        – view-model car array
 * @param {number} sectorCount – how many sector columns to show
 */
function renderTable(tbody, cars, sectorCount) {
  const existingRows = new Map();
  for (const tr of tbody.rows) {
    existingRows.set(tr.dataset.nr, tr);
  }

  // Track which nrs we still see
  const seen = new Set();

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    seen.add(car.nr);

    let tr = existingRows.get(car.nr);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.nr = car.nr;
      tr.addEventListener('click', (event) => {
        if (_onCarSelect) _onCarSelect(car.nr, event);
      });
      tbody.appendChild(tr);
    }

    updateRow(tr, car, sectorCount, i);
  }

  // Remove rows for cars no longer in data
  for (const [nr, tr] of existingRows) {
    if (!seen.has(nr)) tr.remove();
  }

  // Re-order rows in DOM to match sorted order
  const rows = Array.from(tbody.rows);
  rows.sort((a, b) => {
    const ia = cars.findIndex(c => c.nr === a.dataset.nr);
    const ib = cars.findIndex(c => c.nr === b.dataset.nr);
    return ia - ib;
  });
  rows.forEach(r => tbody.appendChild(r));
  updateSelected(tbody);
}

function updateSelected(tbody) {
  for (const tr of tbody.rows) {
    tr.classList.toggle('selected', _tableSelectedNrs.has(tr.dataset.nr));
  }
}

function setSelectedNrs(selectedNrs) {
  _tableSelectedNrs = new Set((selectedNrs || []).map(String));
  for (const tbody of document.querySelectorAll('.timing-table tbody')) {
    updateSelected(tbody);
  }
}

function updateRow(tr, car, sectorCount, rowIndex) {
  tr.classList.toggle('in-pit', !!car.inPit);

  const sectorKeys = Array.from({ length: sectorCount }, (_, i) => `S${i + 1}`);
  const cells = buildCellContent(car, sectorKeys);

  // If column count changed, rebuild
  const expectedColCount = 17 + sectorCount; // base cols + sector cols
  if (tr.cells.length !== expectedColCount) {
    tr.innerHTML = cells;
    return;
  }

  // Incremental update: only change cells that differ
  const tmpDiv = document.createElement('tbody');
  tmpDiv.innerHTML = `<tr>${cells}</tr>`;
  const newCells = tmpDiv.firstChild.cells;
  for (let i = 0; i < newCells.length; i++) {
    const existing = tr.cells[i];
    const updated = newCells[i];
    if (existing && (existing.innerHTML !== updated.innerHTML || existing.className !== updated.className)) {
      existing.innerHTML = updated.innerHTML;
      existing.className = updated.className;
    }
  }
}

function buildCellContent(car, sectorKeys) {
  const { colorClass } = window.ColorUtils;

  // Pos + change since start
  const pc = car.posChange;
  let pcHtml = '-';
  let pcClass = '';
  if (pc !== null && pc !== undefined) {
    if (pc > 0)      { pcHtml = `+${pc}`;  pcClass = 'pos-gained'; }
    else if (pc < 0) { pcHtml = `${pc}`;   pcClass = 'pos-lost'; }
    else             { pcHtml = '=';        pcClass = 'pos-same'; }
  }
  const posCell = car.statusLabel
    ? `<span class="status-badge status-${car.statusLabel.toLowerCase()}">${car.statusLabel}</span>`
    : (car.pos || '');
  let html = `<td class="col-pos">${posCell}</td>`;
  html += `<td class="col-poschange ${pcClass}">${car.statusLabel ? '' : pcHtml}</td>`;

  // # (number badge with class colour)
  const cc = car.classColor || {};
  html += `<td class="col-nr"><span class="nr-badge" style="background:${cc.bg||'#444'};color:${cc.text||'#fff'}">${car.nr}</span></td>`;

  // Driver
  const fastestDriverId = car.fastestDriverId || null;
  const lapsByDriver = car.lapsByDriver || {};

  function driverLabel(name, driverId) {
    const bolt = (fastestDriverId && driverId === fastestDriverId) ? '*' : '';
    const laps = lapsByDriver[driverId];
    const lapStr = laps !== undefined ? ` (${laps})` : '';
    return escHtml(name) + bolt + lapStr;
  }

  const activeDriverId = car.activeDriverId || (car.drivers || []).find(d => d.name === car.activeDriverName)?.id || null;
  const active = driverLabel(car.activeDriverName || '', activeDriverId);
  const mateNames = (car.drivers || [])
    .filter(d => d.name && d.name !== car.activeDriverName)
    .map(d => driverLabel(d.name, d.id))
    .join(' / ');
  html += `<td class="col-driver"><div class="driver-cell">
    <span class="driver-active${car.inPit ? ' in-pit' : ''}">${active}</span>
    ${mateNames ? `<span class="driver-mates">${mateNames}</span>` : ''}
  </div></td>`;

  // Manufacturer logo
  html += `<td class="col-logo">${window.LogoUtils.imgTag(car.manufacturer, 28)}</td>`;

  // Team / Car
  html += `<td class="col-team"><div class="team-cell">
    <span class="team-name${car.inPit ? ' in-pit' : ''}">${escHtml(car.team || '')}</span>
    <span class="vehicle-name">${escHtml(car.vehicle || '')}</span>
  </div></td>`;

  // Laps
  html += `<td class="col-rd">${car.laps || ''}</td>`;

  // Gap
  html += `<td class="col-gap">${escHtml(car.gap || '-')}</td>`;

  // Int
  html += `<td class="col-int">${escHtml(car.interval || '-')}</td>`;

  // Sectors
  for (const key of sectorKeys) {
    const sec = car.sectors?.[key];
    if (sec) {
      html += `<td class="col-sec ${colorClass(sec.color)}">${escHtml(sec.raw || '-')}</td>`;
    } else {
      html += `<td class="col-sec">-</td>`;
    }
  }

  // Last lap (or IN PIT / OUTLAP badge)
  if (car.inPit) {
    html += `<td class="col-last"><span class="pit-badge">IN PIT</span></td>`;
  } else if (car.isOnOutLap) {
    html += `<td class="col-last"><span class="outlap-badge">OUTLAP</span></td>`;
  } else {
    html += `<td class="col-last ${colorClass(car.lastLap?.color)}">${escHtml(car.lastLap?.raw || '-')}</td>`;
  }

  // Best lap
  html += `<td class="col-best ${colorClass(car.bestLap?.color)}">${escHtml(car.bestLap?.raw || '-')}</td>`;

  // Best Lap #
  html += `<td class="col-bestl">${car.bestLapNr || ''}</td>`;

  // PTIME
  html += `<td class="col-ptime">${escHtml(car.pitTime || '-')}</td>`;

  // PIT count
  html += `<td class="col-pit">${car.pitCount !== undefined ? car.pitCount : ''}</td>`;

  // Stint
  html += `<td class="col-stint">${escHtml(car.stintTime || '-')}</td>`;

  // TLW
  html += `<td class="col-tlw">${car.tlw !== undefined ? car.tlw : ''}</td>`;

  // CPos
  html += `<td class="col-cpos">${car.classPos || ''}</td>`;

  return html;
}

function buildTableHeader(sectorCount) {
  const sectorHeaders = Array.from({ length: sectorCount }, (_, i) =>
    `<th class="col-sec">S${i + 1}</th>`
  ).join('');
  return `
    <th class="col-pos">Pos</th>
    <th class="col-poschange">+/-</th>
    <th class="col-nr">#</th>
    <th class="col-driver">Driver</th>
    <th class="col-logo"></th>
    <th class="col-team">Team / Car</th>
    <th class="col-rd">Rd</th>
    <th class="col-gap">Gap</th>
    <th class="col-int">Int</th>
    ${sectorHeaders}
    <th class="col-last">Last</th>
    <th class="col-best">Best</th>
    <th class="col-bestl">Lap#</th>
    <th class="col-ptime">PTIME</th>
    <th class="col-pit">PIT</th>
    <th class="col-stint">Stint</th>
    <th class="col-tlw">TLW</th>
    <th class="col-cpos">CPos</th>
  `;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.TableRenderer = { initTable, renderTable, buildTableHeader, setSelectedNrs };
