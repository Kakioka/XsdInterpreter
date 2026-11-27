// test/themes.test.mjs — the theme token set (dev/PARITY_GAP_ANALYSIS.md 3.1).
//
// The default palette is written down three times on purpose — theme.js's
// DEFAULT_COLORS (fallback for tokens a theme omits), themes/default.theme.json
// (the selectable Default), and css/main.css's :root block (first paint,
// before any JS runs) — so this checks they agree, and that every bundled
// theme defines every token. theme.js is importable here because it touches
// the DOM only inside functions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { repoPath } from './helpers/env.mjs';

const { getDefaultColors, camelToKebab } = await import('../js/ui/theme.js');

// The WPF app's Docs/theme-template.theme.json: 11 required + 24 optional.
const ALL_TOKENS = [
  'windowBackground', 'panelBackground', 'controlBackground', 'controlBorder', 'primaryText', 'secondaryText',
  'accentColor', 'buttonBackground', 'buttonText', 'selectionBackground', 'selectionText',
  'coloringIncomplete', 'coloringComplete', 'coloringOptional', 'lineNumberText',
  'addButtonBackground', 'addButtonForeground', 'addButtonBorder', 'addButtonHover',
  'removeButtonBackground', 'removeButtonForeground', 'removeButtonBorder',
  'validationPanelBackground', 'validationPanelBorder', 'validationErrorText',
  'overlayBackground', 'searchHighlightBorder', 'searchHighlightBackground',
  'validationHighlightBorder', 'validationHighlightBackground',
  'disabledBackground', 'disabledText', 'disabledBorder', 'navRequiredText', 'navOptionalText',
];

async function loadThemes() {
  const themes = [];
  for (const name of await readdir(repoPath('themes'))) {
    if (name.endsWith('.theme.json')) themes.push({ file: name, theme: JSON.parse(await readFile(repoPath('themes', name), 'utf8')) });
  }
  return themes;
}

test('theme.js defaults define exactly the 35 tokens', () => {
  assert.equal(ALL_TOKENS.length, 35);
  assert.deepEqual(Object.keys(getDefaultColors()).sort(), [...ALL_TOKENS].sort());
});

test('every bundled theme defines every token, and nothing else', async () => {
  const themes = await loadThemes();
  assert.equal(themes.length, 4);
  for (const { file, theme } of themes) {
    assert.deepEqual(Object.keys(theme.colors).sort(), [...ALL_TOKENS].sort(), file);
    for (const [token, value] of Object.entries(theme.colors)) {
      assert.match(value, /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/, `${file} ${token}`);
    }
  }
});

test('themes/default.theme.json matches theme.js defaults', async () => {
  const theme = JSON.parse(await readFile(repoPath('themes', 'default.theme.json'), 'utf8'));
  assert.deepEqual(theme.colors, getDefaultColors());
});

test('css/main.css :root block matches theme.js defaults (first paint)', async () => {
  const css = await readFile(repoPath('css', 'main.css'), 'utf8');
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)[1];
  const declared = Object.fromEntries([...rootBlock.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().toLowerCase()]));
  for (const [token, value] of Object.entries(getDefaultColors())) {
    assert.equal(declared[camelToKebab(token)], value.toLowerCase(), `--${camelToKebab(token)}`);
  }
});

test('every token the stylesheet reads is one a theme can set (or derived)', async () => {
  const css = await readFile(repoPath('css', 'main.css'), 'utf8');
  const tokens = new Set(ALL_TOKENS.map(camelToKebab));
  const used = new Set([...css.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
  const unknown = [...used].filter((name) => !tokens.has(name) && !/^depth-color-\d$/.test(name));
  assert.deepEqual(unknown, []);
});

test('overlayBackground is a translucent dim in CSS #RRGGBBAA order', async () => {
  // The desktop app's template writes "#99000000" (#AARRGGBB). Copied into a
  // theme here as-is, CSS reads it as a fully transparent dark red — a
  // backdrop that silently stops dimming. Alpha belongs last.
  for (const { file, theme } of await loadThemes()) {
    const m = /^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})$/.exec(theme.colors.overlayBackground);
    assert.ok(m, `${file}: overlayBackground should carry an alpha channel`);
    const alpha = parseInt(m[2], 16);
    assert.ok(alpha > 0x20 && alpha < 0xff, `${file}: overlayBackground alpha ${m[2]} is not a dim`);
  }
});
