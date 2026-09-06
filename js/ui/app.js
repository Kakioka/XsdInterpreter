// js/ui/app.js — Bootstrap, wiring, global event bus.
//
// See web-implementation-spec.md §20 (Application Bootstrap). Full bootstrap —
// settings load, theme apply, toolbar/keyboard-shortcut wiring, schema load flow —
// lands in Phase 3.3 onward. See IMPLEMENTATION_PLAN.md.
//
// This Phase 0 stub only proves the ES module graph loads and renders a placeholder,
// per Phase 0's "done when" criteria.

const appState = {
  manifest: null,
  currentInstanceKey: null,
  flatDoc: null,
  targetNamespace: null, // from flattener.flattenFromRoot (§3); threaded into buildPacketXml (§10) on Save XML
  schemaParser: null,
  // formEngine: new FormEngine(),   // wired in once js/core/formEngine.js has a real implementation (Phase 2.1)
  // undoService: new UndoService(), // wired in once js/core/undoService.js has a real implementation (Phase 4.2)
};

function renderScaffoldPlaceholder() {
  const app = document.getElementById('app');
  app.textContent = 'XML Form Editor — Phase 0 scaffold. No functionality yet.';
}

renderScaffoldPlaceholder();

export { appState };
