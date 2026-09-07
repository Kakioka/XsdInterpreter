// js/ui/theme.js — Theme loading and CSS variable application.
//
// See web-implementation-spec.md §12 (Theming). IMPLEMENTATION_PLAN.md Phase 7.1.
//
// Built-in theme files are fetched relative to THIS module's own URL (not the
// document's) via `new URL(..., import.meta.url)` — that way it resolves
// correctly regardless of which page imports theme.js (index.html at the repo
// root, or a dev/*-check.html harness one directory down), unlike a bare
// fetch('themes/x.json') which resolves against the document's location.

const REQUIRED_TOKENS = [
  'windowBackground', 'panelBackground', 'controlBackground', 'controlBorder',
  'primaryText', 'secondaryText', 'accentColor', 'buttonBackground', 'buttonText',
  'selectionBackground', 'selectionText',
];

// Mirrors themes/default.theme.json exactly — the fallback for any token a
// loaded theme (built-in or user-supplied) omits (§12: "The rest are optional;
// if absent, defaults are used").
const DEFAULT_COLORS = {
  windowBackground: '#F5F5F5',
  panelBackground: '#FFFFFF',
  controlBackground: '#FFFFFF',
  controlBorder: '#DDDDDD',
  primaryText: '#333333',
  secondaryText: '#666666',
  accentColor: '#3A7BD5',
  buttonBackground: '#FFFFFF',
  buttonText: '#333333',
  selectionBackground: '#3A7BD5',
  selectionText: '#FFFFFF',
  coloringIncomplete: '#D32F2F',
  coloringComplete: '#2E7D32',
  coloringOptional: '#F9A825',
  lineNumberText: '#888888',
  addButtonBackground: '#4A8C6F',
  removeButtonBackground: '#A34A5A',
};

const BUILTIN_THEME_URLS = [
  new URL('../../themes/default.theme.json', import.meta.url),
  new URL('../../themes/dark.theme.json', import.meta.url),
  new URL('../../themes/high-contrast.theme.json', import.meta.url),
  new URL('../../themes/ocean-blue.theme.json', import.meta.url),
];

const ACTIVE_THEME_KEY = 'xmlEditor.activeTheme';

export function getDefaultColors() {
  return { ...DEFAULT_COLORS };
}

export function camelToKebab(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function clamp01(t) {
  return Math.min(1, Math.max(0, t));
}

function parseHexColor(hex) {
  const s = String(hex).trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex(n) {
  return Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
}

/** Linear RGB interpolation between two hex colors. Falls back to `from` on
 *  an unparseable color rather than throwing — a malformed user-supplied
 *  theme file shouldn't crash the whole apply. */
export function interpolateColor(from, to, t) {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) return from;
  const k = clamp01(t);
  return `#${toHex(a.r + (b.r - a.r) * k)}${toHex(a.g + (b.g - a.g) * k)}${toHex(a.b + (b.b - a.b) * k)}`;
}

export function saveThemePreference(name) {
  try {
    localStorage.setItem(ACTIVE_THEME_KEY, name);
  } catch {
    // localStorage unavailable (private browsing, etc.) — theming still works
    // for the current session, it just won't survive a reload.
  }
}

export function getSavedThemePreference() {
  try {
    return localStorage.getItem(ACTIVE_THEME_KEY);
  } catch {
    return null;
  }
}

/**
 * §12 "Applying a Theme". Writes every color as a `--kebab-case` CSS custom
 * property on :root, derives 5 depth-level background colors by interpolating
 * panelBackground → windowBackground (used by formRenderer's `.depth-N`
 * container classes), and persists the theme name as the active preference.
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  const colors = { ...getDefaultColors(), ...(theme?.colors || {}) };
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(`--${camelToKebab(key)}`, value);
  }
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    root.style.setProperty(`--depth-color-${i}`, interpolateColor(colors.panelBackground, colors.windowBackground, t));
  }
  if (theme?.name) saveThemePreference(theme.name);
}

/** Loads and validates a theme object parsed from JSON (built-in fetch or a
 *  user-supplied file) — throws with a readable message on anything that
 *  isn't a usable theme, rather than silently applying a broken/partial one. */
function validateTheme(theme) {
  if (!theme || typeof theme !== 'object') throw new Error('Not a valid theme file');
  if (!theme.name) throw new Error('Theme is missing a "name"');
  if (!theme.colors || typeof theme.colors !== 'object') throw new Error('Theme is missing a "colors" object');
  const missing = REQUIRED_TOKENS.filter((t) => !(t in theme.colors));
  if (missing.length > 0) throw new Error(`Theme is missing required color token(s): ${missing.join(', ')}`);
  return theme;
}

export async function loadBuiltinThemes() {
  const themes = [];
  for (const url of BUILTIN_THEME_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      themes.push(validateTheme(await res.json()));
    } catch (err) {
      console.error(`Failed to load built-in theme at ${url}:`, err);
    }
  }
  return themes;
}

/** Populates the toolbar's theme <select>, wires "Load Theme File", and
 *  restores the last-applied theme (falling back to the first built-in —
 *  Default — if nothing was saved, or the saved name no longer matches). */
export async function wireTheme() {
  const select = document.getElementById('theme-select');
  const loadBtn = document.getElementById('load-theme-btn');
  const fileInput = document.getElementById('theme-file-input');
  if (!select) return;

  const themesByName = new Map();
  const addOption = (theme) => {
    themesByName.set(theme.name, theme);
    let opt = [...select.options].find((o) => o.value === theme.name);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = theme.name;
      select.appendChild(opt);
    }
    opt.textContent = theme.name;
  };

  const builtins = await loadBuiltinThemes();
  builtins.forEach(addOption);
  select.disabled = builtins.length === 0;

  select.addEventListener('change', () => {
    const theme = themesByName.get(select.value);
    if (theme) applyTheme(theme);
  });

  if (loadBtn && fileInput) {
    loadBtn.disabled = false;
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const theme = validateTheme(JSON.parse(await file.text()));
        addOption(theme);
        select.value = theme.name;
        select.disabled = false;
        applyTheme(theme);
      } catch (err) {
        window.alert(`Failed to load theme file: ${err.message}`);
      }
    });
  }

  const savedName = getSavedThemePreference();
  const initial = (savedName && themesByName.get(savedName)) || builtins[0];
  if (initial) {
    select.value = initial.name;
    applyTheme(initial);
  }
}
