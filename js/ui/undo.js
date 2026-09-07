// js/ui/undo.js — Undo/redo UI wiring.
//
// See web-implementation-spec.md §14 (Undo / Redo System), §13 (Ctrl+Z is
// wired at the document level and bypasses individual button `disabled`
// state, so the busy overlay's own guard is what actually blocks it while a
// long operation is running). IMPLEMENTATION_PLAN.md Phase 4.2.

/**
 * @param {import('../core/undoService.js').UndoService} undoService
 * @param {object} ctx — see undoService.js's file-level comment for the shape
 *   every Action's undo()/redo() expects.
 */
export function wireUndo(undoService, ctx) {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');

  function refreshButtons() {
    if (undoBtn) undoBtn.disabled = !undoService.canUndo;
    if (redoBtn) redoBtn.disabled = !undoService.canRedo;
  }

  undoService.addEventListener('changed', refreshButtons);
  undoBtn?.addEventListener('click', () => undoService.undo(ctx));
  redoBtn?.addEventListener('click', () => undoService.redo(ctx));

  document.addEventListener('keydown', (e) => {
    if (isOverlayVisible()) return; // §13: the overlay is the real guard against keyboard shortcuts firing mid-operation
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoService.undo(ctx);
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      undoService.redo(ctx);
    }
  });

  refreshButtons();
}

function isOverlayVisible() {
  const overlay = document.getElementById('loading-overlay');
  return !!overlay && !overlay.classList.contains('hidden');
}
