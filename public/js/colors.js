'use strict';
/* Color classification helpers – mirrors src/timing-logic.js for frontend use */

const COLOR_CSS = {
  purple: 'time-purple',
  blue: 'time-blue',
  green: 'time-green',
  yellow: 'time-yellow',
};

function colorClass(colorName) {
  return colorName ? (COLOR_CSS[colorName] || '') : '';
}

function applyTimeColor(el, colorName) {
  el.className = el.className.replace(/\btime-\S+/g, '').trim();
  if (colorName && COLOR_CSS[colorName]) {
    el.classList.add(COLOR_CSS[colorName]);
  }
}

// Mirrors classifyTimeColor from timing-logic.js
function classify(timeMs, driverBestMs, carBestMs, classBestMs, overallBestMs) {
  if (timeMs === null || timeMs === undefined) return null;
  if (overallBestMs != null && timeMs <= overallBestMs) return 'purple';
  if (classBestMs   != null && timeMs <= classBestMs)   return 'blue';
  if (carBestMs     != null && timeMs <= carBestMs)     return 'green';
  if (driverBestMs  != null && timeMs <= driverBestMs)  return 'yellow';
  return null;
}

window.ColorUtils = { colorClass, applyTimeColor, classify };

window.LogoUtils = {
  LOGOS: {
    'Aston Martin': 'astonmartin.png',
    'Audi':         'audi.png',
    'BMW':          'bmwm.png',
    'Chevrolet':    'chevrolet.png',
    'Ferrari':      'ferrari.png',
    'Ford':         'ford.png',
    'Ginetta':      'ginetta.png',
    'Lamborghini':  'lamborghini.png',
    'Lotus':        'lotus.png',
    'McLaren':      'mclaren.png',
    'Mercedes-AMG': 'mercedes-amg.png',
    'Porsche':      'porsche.png',
    'Toyota':       'toyota.png',
  },
  WHITE: new Set(['Aston Martin', 'Audi', 'Mercedes-AMG']),
  imgTag(manufacturer, size = 20) {
    const file = this.LOGOS[manufacturer];
    if (!file) return '';
    const cls = 'mfr-logo' + (this.WHITE.has(manufacturer) ? ' mfr-logo--white' : '');
    return `<img src="/logos/${file}" alt="" class="${cls}" style="width:${size}px;height:${size}px">`;
  },
};
