// js/ui/chooseRootDialog.js — root schema file/element picker dialog.
//
// Backs the §20 step 6/9 "Multiple possible root files/elements found" case
// in app.js's Schema Load Flow. Originally a window.prompt() the user had to
// retype a filename into by hand; this renders a real dropdown of the
// detected candidates instead. Built into #choose-root-dialog-overlay on
// first use, same empty-container pattern as #debug-panel/#context-menu/
// #package-dialog-overlay (see packaging.js's file-level comment).

let _resolve = null;

function settle(value) {
  const overlay = document.getElementById('choose-root-dialog-overlay');
  overlay?.classList.add('hidden');
  const resolve = _resolve;
  _resolve = null;
  if (resolve) resolve(value || null);
}

function buildDialog(overlay) {
  overlay.innerHTML = '';

  const dialog = document.createElement('div');
  dialog.id = 'choose-root-dialog';

  const header = document.createElement('div');
  header.id = 'choose-root-dialog-header';
  const title = document.createElement('span');
  title.id = 'choose-root-dialog-title';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => settle(null));
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.id = 'choose-root-dialog-body';
  const select = document.createElement('select');
  select.id = 'choose-root-dialog-select';
  body.appendChild(select);

  const footer = document.createElement('div');
  footer.id = 'choose-root-dialog-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => settle(null));
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.textContent = 'OK';
  okBtn.addEventListener('click', () => settle(select.value));
  footer.append(cancelBtn, okBtn);

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) settle(null);
  });
}

/** Same contract as the old window.prompt-based chooseOne it replaces:
 *  candidates.length === 1 → auto-pick, no dialog shown. 0 → alert + null.
 *  >1 → a dropdown of the detected candidates with OK/Cancel; resolves to the
 *  chosen candidate, or null if cancelled/closed. */
export async function chooseOne(candidates, emptyMessage, multipleMessage) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    window.alert(emptyMessage);
    return null;
  }

  const overlay = document.getElementById('choose-root-dialog-overlay');
  if (!overlay) {
    // Fallback for harnesses (dev/*.html) that don't include the dialog container.
    const chosen = window.prompt(`${multipleMessage}\n(${candidates.join(', ')})`, candidates[0]);
    return chosen && candidates.includes(chosen) ? chosen : null;
  }

  buildDialog(overlay);
  document.getElementById('choose-root-dialog-title').textContent = multipleMessage;
  const select = document.getElementById('choose-root-dialog-select');
  for (const candidate of candidates) {
    const opt = document.createElement('option');
    opt.value = candidate;
    opt.textContent = candidate;
    select.appendChild(opt);
  }
  overlay.classList.remove('hidden');
  select.focus();

  return new Promise((resolve) => {
    _resolve = resolve;
  });
}
