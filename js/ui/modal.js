// js/ui/modal.js — opening and closing the app's <dialog> elements.
//
// Every modal in the app — message/confirm (dialogs.js), choose-root,
// recovery, packaging, schema settings, the error boundary and the busy
// overlay itself — is a <dialog> shown with showModal(). The browser then
// does what the old overlay <div>s needed a z-index ladder and comments for:
//
//   - the dialog renders in the top layer, above everything, so one opened
//     from inside withBusyOverlay is clickable without out-ranking anything;
//   - the most recently opened modal is on top and the only interactive one,
//     so a confirm raised from the packaging dialog, or the error boundary
//     raised while anything at all is open, just stacks;
//   - everything behind it is inert (no clicks, no Tab, no find-in-page);
//   - focus moves in on open and back to where it was on close.
//
// What is left for this module: Escape and backdrop clicks routed to one
// `onDismiss` callback (or ignored, for a dialog that needs an answer), and
// keystrokes kept inside the dialog so the app's document-level shortcuts
// (Ctrl+Z, Ctrl+F, Ctrl+Shift+D, …) don't act on the page behind it.
//
// No imports: errorBoundary.js uses this, and the fewer modules the boundary
// depends on, the fewer ways it can be broken by the crash it is reporting.

const states = new WeakMap();

function stateOf(dialog) {
  let s = states.get(dialog);
  if (!s) {
    s = { onDismiss: null, dismissible: true, expectedCloses: 0 };
    states.set(dialog, s);
    wire(dialog, s);
  }
  return s;
}

function dismiss(dialog, s) {
  if (!s.dismissible) return;
  closeModal(dialog);
  s.onDismiss?.();
}

function wire(dialog, s) {
  // Bubble phase on the dialog: its own controls see every key first, and
  // nothing reaches document. Browser defaults (typing, copy, Tab, the
  // Escape close request) are not affected by stopping propagation.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());

  // Escape. Prevented so a non-dismissible dialog stays put, and so the
  // dismissible ones close through the same path as a backdrop click.
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    dismiss(dialog, s);
  });

  // A click whose target is the <dialog> itself landed on the backdrop: the
  // element is styled as a bare wrapper around its content box. Requiring the
  // press to start there too keeps a text selection dragged out of an input
  // from counting as a backdrop click.
  let pressedOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => {
    pressedOnBackdrop = e.target === dialog;
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && pressedOnBackdrop) dismiss(dialog, s);
    pressedOnBackdrop = false;
  });

  // A close this module didn't ask for: browsers may force one past a
  // prevented `cancel` (a repeated Escape with no user activation between).
  dialog.addEventListener('close', () => {
    if (s.expectedCloses > 0) {
      s.expectedCloses--;
      return;
    }
    if (!s.dismissible) {
      show(dialog);
      return;
    }
    s.onDismiss?.();
  });
}

function show(dialog) {
  try {
    dialog.showModal();
  } catch {
    // Not connected, or already open non-modally. Showing it in place beats
    // not showing it — this path matters most for the error boundary.
    dialog.setAttribute('open', '');
  }
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {{onDismiss?: () => void, dismissible?: boolean}} [opts]
 *   onDismiss runs after Escape or a backdrop click has closed the dialog.
 *   dismissible: false ignores both, for a dialog that must be answered.
 */
export function openModal(dialog, { onDismiss = null, dismissible = true } = {}) {
  if (!dialog) return;
  const s = stateOf(dialog);
  s.onDismiss = onDismiss;
  s.dismissible = dismissible;
  if (!dialog.open) show(dialog);
}

/** Closes without calling onDismiss. Safe to call on a closed dialog. */
export function closeModal(dialog) {
  if (!dialog?.open) return;
  stateOf(dialog).expectedCloses++;
  dialog.close();
}

export function isModalOpen(dialog) {
  return !!dialog?.open;
}

/**
 * Whether the busy overlay is up. Its being modal already keeps keystrokes
 * from reaching the page; the shortcut handlers check this as well, as a
 * guard for a key event that starts outside it. Harness pages declare the
 * overlay as a plain <div class="hidden">, so that form is understood too.
 */
export function isBusyOverlayVisible() {
  const el = document.getElementById('loading-overlay');
  if (!el) return false;
  return 'open' in el ? el.open : !el.classList.contains('hidden');
}
