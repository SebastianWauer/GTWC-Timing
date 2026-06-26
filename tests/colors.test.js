'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyTimeColor, getClassColor, CLASS_COLORS } = require('../src/timing-logic');

// -----------------------------------------------------------------------
// classifyTimeColor
// -----------------------------------------------------------------------
test('returns null when timeMs is null', () => {
  assert.equal(classifyTimeColor(null, 60000, 59500, 59000, 58000), null);
});

test('returns null when timeMs is undefined', () => {
  assert.equal(classifyTimeColor(undefined, 60000, 59500, 59000, 58000), null);
});

test('purple: overall best (equal)', () => {
  assert.equal(classifyTimeColor(58000, 60000, 59500, 59000, 58000), 'purple');
});

test('purple: faster than overall best', () => {
  assert.equal(classifyTimeColor(57999, null, null, null, 58000), 'purple');
});

test('blue: class best, not overall best', () => {
  assert.equal(classifyTimeColor(59000, 60000, 59500, 59000, 58000), 'blue');
});

test('blue: faster than class best', () => {
  assert.equal(classifyTimeColor(58500, null, null, 59000, 58001), 'blue');
});

test('green: car best, not class best', () => {
  assert.equal(classifyTimeColor(59500, 60000, 59500, 59000, 58000), 'green');
});

test('yellow: driver personal best only', () => {
  assert.equal(classifyTimeColor(60000, 60000, 59500, 59000, 58000), 'yellow');
});

test('null: slower than driver best', () => {
  assert.equal(classifyTimeColor(60001, 60000, 59500, 59000, 58000), null);
});

test('null when all bests are null', () => {
  assert.equal(classifyTimeColor(60000, null, null, null, null), null);
});

// -----------------------------------------------------------------------
// getClassColor
// -----------------------------------------------------------------------
test('PRO class: white background', () => {
  const c = getClassColor('PRO');
  assert.equal(c.bg, '#ffffff');
  assert.equal(c.text, '#000000');
});

test('GOLD class: yellow background', () => {
  const c = getClassColor('GOLD');
  assert.equal(c.bg, '#d4a017');
});

test('SILVER class: blue background', () => {
  const c = getClassColor('SILVER');
  assert.equal(c.bg, '#3a6bbf');
});

test('BRONZE class: brown background', () => {
  const c = getClassColor('BRONZE');
  assert.equal(c.bg, '#7b4f2e');
});

test('PRO-AM class: green background', () => {
  const c = getClassColor('PRO-AM');
  assert.equal(c.bg, '#2d7a3a');
});

test('Unknown class: fallback colour', () => {
  const c = getClassColor('UNKNOWN');
  assert.equal(c.bg, '#444');
  assert.equal(c.label, 'UNKNOWN');
});

test('case insensitive: pro -> PRO', () => {
  const c = getClassColor('pro');
  assert.equal(c.bg, CLASS_COLORS.PRO.bg);
});

test('null/empty class: fallback', () => {
  const c = getClassColor('');
  assert.equal(c.bg, '#444');
});
