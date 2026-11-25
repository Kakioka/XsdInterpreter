// test/moduleGraph.test.mjs — static import-graph check across js/.
//
// There is no build step and no type checker (CLAUDE.md, "No build system"),
// so a mistyped import path or a renamed export fails at runtime in the
// browser, usually as a blank page. js/ui/ can't be imported in Node (it
// touches the DOM at module scope), but its import statements can still be
// read as text and checked against what the target module actually exports —
// which catches exactly that class of mistake, for every file, in one pass.
//
// Also checks the Core/UI boundary: js/core/ must never import from js/ui/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { repoPath } from './helpers/env.mjs';

async function listModules(dir) {
  const out = [];
  for (const entry of await readdir(repoPath(...dir), { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await listModules([...dir, entry.name])));
    else if (entry.name.endsWith('.js')) out.push([...dir, entry.name]);
  }
  return out;
}

const modules = await listModules(['js']);
const sources = new Map();
for (const segments of modules) {
  sources.set(segments.join('/'), await readFile(repoPath(...segments), 'utf8'));
}

/** Import statements, as text. Covers the three forms this codebase uses:
 *  `import { a, b as c } from '…'`, `import * as ns from '…'`, and a bare
 *  side-effect import. */
function parseImports(source) {
  const imports = [];
  const pattern = /^import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+)|([\w$]+))?\s*(?:from\s*)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    const [, , braced, namespace, defaultName, specifier] = match;
    const names = braced
      ? braced
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => part.split(/\s+as\s+/)[0].trim())
      : [];
    imports.push({ specifier, names, namespace: namespace ?? null, defaultName: defaultName ?? null });
  }
  return imports;
}

/** Exported names, as text. Covers the declaration forms this codebase uses. */
function parseExports(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const pieces = trimmed.split(/\s+as\s+/);
      names.add((pieces[1] ?? pieces[0]).trim());
    }
  }
  return names;
}

const exportsByModule = new Map();
for (const [key, source] of sources) exportsByModule.set(key, parseExports(source));

test('every js/ module is reachable and non-empty', () => {
  assert.ok(sources.size >= 24, `expected the full js/ tree, found ${sources.size} files`);
  for (const [key, source] of sources) assert.match(source, /\S/, `${key} is empty`);
});

test('every relative import resolves to a file that exists', () => {
  const missing = [];
  for (const [key, source] of sources) {
    for (const { specifier } of parseImports(source)) {
      if (!specifier.startsWith('.')) continue; // no bare specifiers in this codebase; a new one is worth noticing
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(key), specifier));
      if (!sources.has(resolved)) missing.push(`${key} → ${specifier}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every named import exists as an export of its target module', () => {
  const broken = [];
  for (const [key, source] of sources) {
    for (const { specifier, names } of parseImports(source)) {
      if (!specifier.startsWith('.') || names.length === 0) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(key), specifier));
      const exported = exportsByModule.get(resolved);
      if (!exported) continue; // already reported by the test above
      for (const name of names) {
        if (!exported.has(name)) broken.push(`${key} imports { ${name} } from ${specifier}, which does not export it`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('no bare module specifiers — the app ships with zero dependencies', () => {
  const bare = [];
  for (const [key, source] of sources) {
    for (const { specifier } of parseImports(source)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) bare.push(`${key} → ${specifier}`);
    }
  }
  assert.deepEqual(bare, [], 'a bare specifier would need a bundler or an import map');
});

test('js/core/ never imports from js/ui/ (the one structural rule)', () => {
  const violations = [];
  for (const [key, source] of sources) {
    if (!key.startsWith('js/core/')) continue;
    for (const { specifier } of parseImports(source)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(key), specifier));
      if (resolved.startsWith('js/ui/')) violations.push(`${key} → ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('js/core/ touches no DOM-rendering API', async () => {
  // DOMParser, XMLSerializer, document.implementation and CompressionStream are
  // explicitly allowed (bytes-and-strings APIs — CLAUDE.md, "Core/UI split").
  // These are the rendering APIs that are not.
  const forbidden = /\b(?:document\.(?:getElementById|querySelector|createElement\b|body|head|addEventListener)|window\.|navigator\.|localStorage|HTMLElement|requestAnimationFrame)/;
  const violations = [];
  for (const [key, source] of sources) {
    if (!key.startsWith('js/core/')) continue;
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return; // prose, not code
      if (forbidden.test(line)) violations.push(`${key}:${i + 1} ${line.trim()}`);
    });
  }
  // settingsStore.js is the one module in core/ that persists settings, so it
  // is the one known exception (and why test/helpers/env.mjs stubs localStorage).
  const unexpected = violations.filter((v) => !/^js\/core\/settingsStore\.js:\d+ .*localStorage/.test(v));
  assert.deepEqual(unexpected, []);
});

test('index.html loads app.js as a module and declares the containers the UI builds into', async () => {
  const html = await readFile(repoPath('index.html'), 'utf8');
  assert.match(html, /<script type="module" src="js\/ui\/app\.js"><\/script>/);

  // Every dynamically-populated overlay/panel needs its empty container to
  // already exist in the markup; a missing one degrades silently to "the
  // dialog never appears".
  for (const id of [
    'loading-overlay',
    'form-content-host',
    'nav-tree',
    'debug-panel',
    'context-menu',
    'package-dialog-overlay',
    'choose-root-dialog-overlay',
    'schema-settings-overlay',
    'error-boundary-overlay',
    'recovery-dialog-overlay',
    'autosave-status',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
});
