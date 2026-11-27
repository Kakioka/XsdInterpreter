// js/ui/dialogs.js — the app's message / confirm / list dialogs.
//
// dev/PARITY_GAP_ANALYSIS.md 3.5: replaces every window.alert/window.confirm
// in the app. Those block the page, can't be themed, can't hold a list the
// user can scan, and some browsers offer to suppress them after a few — at
// which point confirm() silently answers "no".
//
// Built into the <dialog id="app-dialog"> in index.html and shown with
// modal.js's openModal, so it stacks above whatever is already open (the busy
// overlay, the packaging dialog) without any z-index arithmetic.
//
// Requests are queued: a second dialog asked for while one is open is shown
// when the first closes, rather than replacing it and orphaning its promise.

import { openModal, closeModal } from './modal.js';

let queue = Promise.resolve();

function hostEl() {
  return document.getElementById('app-dialog');
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

/** Text with line breaks preserved, as paragraphs. */
function paragraphs(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((para) => el('p', { textContent: para }));
}

/**
 * The general form. Resolves to the clicked button's `value`, or to
 * `cancelValue` on Escape, the ✕, or a click on the backdrop.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string|Node|Array<Node>} [opts.body] a string is split into paragraphs on blank lines
 * @param {Array<{label: string, value: any, primary?: boolean}>} opts.buttons in display order
 * @param {any} [opts.cancelValue]
 * @param {boolean} [opts.wide] for dialogs holding a table
 * @param {string} [opts.fallbackText] what window.confirm/alert shows where the container is missing
 * @returns {Promise<any>}
 */
export function showDialog(opts) {
  const run = () => (hostEl() ? render(opts) : fallback(opts));
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/** Harnesses (dev/*.html) don't include the container. */
function fallback({ buttons, cancelValue, title, body, fallbackText }) {
  const text = fallbackText ?? (typeof body === 'string' ? `${title}\n\n${body}` : title);
  if (buttons.length < 2) {
    window.alert(text);
    return buttons[0]?.value;
  }
  const primary = buttons.find((b) => b.primary) ?? buttons[buttons.length - 1];
  return window.confirm(text) ? primary.value : cancelValue;
}

function render({ title, body, buttons, cancelValue, wide }) {
  const host = hostEl();
  host.innerHTML = '';

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      closeModal(host); // focus returns to where it was, natively
      host.innerHTML = '';
      resolve(value);
    };

    const titleEl = el('span', { id: 'app-dialog-title', textContent: title });
    const closeBtn = el('button', { type: 'button', textContent: '✕', title: 'Close' });
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => settle(cancelValue));

    const bodyEl = el('div', { id: 'app-dialog-body' }, typeof body === 'string' ? paragraphs(body) : body);

    const buttonEls = buttons.map((b) => {
      const btn = el('button', { type: 'button', textContent: b.label });
      if (b.primary) {
        btn.classList.add('primary');
        btn.autofocus = true; // showModal focuses it
      }
      btn.addEventListener('click', () => settle(b.value));
      return btn;
    });

    const box = el('div', { id: 'app-dialog-box' }, [
      el('div', { id: 'app-dialog-header' }, [titleEl, closeBtn]),
      bodyEl,
      el('div', { id: 'app-dialog-footer' }, buttonEls),
    ]);
    box.classList.toggle('wide', !!wide);
    // A question gets alertdialog, so a screen reader reads it out on open.
    host.setAttribute('role', buttons.length > 1 ? 'alertdialog' : 'dialog');
    host.setAttribute('aria-labelledby', 'app-dialog-title');
    host.appendChild(box);
    openModal(host, { onDismiss: () => settle(cancelValue) });
  });
}

/** @returns {Promise<void>} */
export function showMessage(title, body, { fallbackText } = {}) {
  return showDialog({ title, body, buttons: [{ label: 'OK', value: undefined, primary: true }], fallbackText });
}

/** @returns {Promise<boolean>} */
export function confirmAction(title, body, { confirmLabel = 'OK', cancelLabel = 'Cancel', fallbackText } = {}) {
  return showDialog({
    title,
    body,
    buttons: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, primary: true },
    ],
    cancelValue: false,
    fallbackText,
  });
}

// ---------------------------------------------------------------------------
// BOM cleanup (WPF BomCleanupDialogue)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{name: string, hasLeadingBom: boolean, hasInterior: boolean}>} hits from flattener.scanForBom
 * @param {{onDownloadCleaned?: () => Promise<string>}} [opts] builds and downloads the cleaned
 *   files; resolves to a line saying what was downloaded. The page can't rewrite the chosen
 *   folder, so this is how the user fixes the files for good. The dialog stays open.
 * @returns {Promise<boolean>} true to strip and continue
 */
export function confirmBomCleanup(hits, { onDownloadCleaned = null } = {}) {
  const describe = (h) =>
    [h.hasLeadingBom && 'byte-order mark at the start', h.hasInterior && 'invisible U+FEFF inside the text'].filter(Boolean).join(', ');
  const list = el(
    'ul',
    { className: 'app-dialog-file-list' },
    hits.map((h) => el('li', {}, [el('code', { textContent: h.name }), el('span', { className: 'hint', textContent: ` — ${describe(h)}` })]))
  );
  const plural = hits.length === 1 ? 'This file contains' : `These ${hits.length} files contain`;

  let download = null;
  if (onDownloadCleaned) {
    const status = el('span', { className: 'hint', role: 'status' });
    const btn = el('button', { type: 'button', textContent: hits.length === 1 ? 'Download cleaned copy' : 'Download cleaned copies (.zip)' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        status.textContent = await onDownloadCleaned();
      } catch (err) {
        status.textContent = `Could not build the download: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });
    download = el('div', { className: 'app-dialog-actions' }, [btn, status]);
  }

  return showDialog({
    title: 'Invisible characters found in schema files',
    body: [
      el('p', { textContent: `${plural} a U+FEFF character, which can break XSD parsing:` }),
      list,
      el('p', {
        className: 'hint',
        textContent:
          'Removing them here only affects this load — a web page cannot change the files on disk, so this will be asked again next time. ' +
          'To fix them for good, download cleaned copies and put them in place of the originals.',
      }),
      download,
    ],
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Remove and continue', value: true, primary: true },
    ],
    cancelValue: false,
    fallbackText: `These files contain a byte-order mark, which can break XSD parsing:\n\n${hits.map((h) => h.name).join('\n')}\n\nStrip it and continue?`,
  });
}

// ---------------------------------------------------------------------------
// Unmatched fields (WPF UnmatchedFieldsWindow)
// ---------------------------------------------------------------------------

const UNMATCHED_COLUMNS = [
  { key: 'form', label: 'Form' },
  { key: 'xmlPath', label: 'Path' },
  { key: 'value', label: 'Value' },
];

/**
 * Informational: elements an XML load found no schema match for. Sortable by
 * any column; Copy puts the rows on the clipboard as TSV.
 *
 * @param {Array<{form: string, xmlPath: string, value: string}>} rows
 */
export function showUnmatchedFields(rows) {
  let sortKey = 'form';
  let ascending = true;

  const tbody = el('tbody');
  const headerCells = UNMATCHED_COLUMNS.map((col) => {
    const th = el('th', { scope: 'col' }, el('button', { type: 'button', className: 'app-dialog-sort-btn', textContent: col.label }));
    th.firstChild.addEventListener('click', () => {
      ascending = sortKey === col.key ? !ascending : true;
      sortKey = col.key;
      renderRows();
    });
    return th;
  });

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sorted() {
    // Ties keep document order (Array.prototype.sort is stable).
    return [...rows].sort((a, b) => collator.compare(a[sortKey] ?? '', b[sortKey] ?? '') * (ascending ? 1 : -1));
  }
  function renderRows() {
    tbody.innerHTML = '';
    for (const row of sorted()) {
      tbody.appendChild(el('tr', {}, UNMATCHED_COLUMNS.map((col) => el('td', { textContent: row[col.key] ?? '', title: row[col.key] ?? '' }))));
    }
    UNMATCHED_COLUMNS.forEach((col, i) => {
      headerCells[i].setAttribute('aria-sort', col.key === sortKey ? (ascending ? 'ascending' : 'descending') : 'none');
    });
  }
  renderRows();

  const copyStatus = el('span', { className: 'hint', id: 'app-dialog-copy-status' });
  const copyBtn = el('button', { type: 'button', textContent: 'Copy as TSV' });
  copyBtn.addEventListener('click', async () => {
    const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
    const tsv = [UNMATCHED_COLUMNS.map((c) => c.label), ...sorted().map((r) => UNMATCHED_COLUMNS.map((c) => clean(r[c.key])))]
      .map((cells) => cells.join('\t'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      copyStatus.textContent = 'Copied.';
    } catch (err) {
      copyStatus.textContent = `Could not copy: ${err.message}`;
    }
  });

  const count = rows.length;
  return showDialog({
    title: `${count} unrecognized element${count === 1 ? '' : 's'} in the loaded XML`,
    body: [
      el('p', {
        textContent:
          'The schema has no place for these elements, so they were skipped. They are not shown in the form and will not be in a saved file.',
      }),
      el('div', { className: 'app-dialog-table-wrap' }, el('table', { className: 'app-dialog-table' }, [el('thead', {}, el('tr', {}, headerCells)), tbody])),
      el('div', { className: 'app-dialog-actions' }, [copyBtn, copyStatus]),
      el('p', { className: 'hint', textContent: 'They also appear in the Validate panel, as "Unrecognized".' }),
    ],
    buttons: [{ label: 'Close', value: undefined, primary: true }],
    wide: true,
    fallbackText: `Loaded with ${count} field(s) not recognized by the schema:\n\n${rows.map((u) => `${u.xmlPath} = ${u.value}`).join('\n')}`,
  });
}
