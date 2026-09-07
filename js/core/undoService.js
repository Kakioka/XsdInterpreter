// js/core/undoService.js — Command stack (undo/redo).
//
// See web-implementation-spec.md §14 (Undo / Redo System). Implemented in
// IMPLEMENTATION_PLAN.md Phase 4.2.
//
// Pure logic, no DOM dependencies. Action objects store paths/values/counts/
// flags only — never live DOM references (§22 invariant 14). Every action
// replays through one generic mechanism instead of ten bespoke DOM patchers:
// `ctx.switchToForm(instanceKey, mutateFormEngine)` — the SAME function
// js/ui/app.js uses for ordinary nav-tree clicks — with an extra hook that
// runs right after the target instance becomes FormEngine's active form (so
// getRepeatingInstanceCount/renamePathPrefix/etc. all resolve against it) and
// right before the schema is parsed and the DOM is (re)built from scratch.
// This is what makes undo work correctly across a form switch (WALKTHROUGH.md
// item 26, §22 invariant 23's "form add/remove are undoable") for free: the
// full, already-correct render pipeline (inflate → register → restore →
// select-radio-branches → recolor) reads back whatever the mutation wrote,
// and the user visibly lands on the form the change actually happened in.
//
// Expected `ctx` shape (constructed once in app.js's init()):
//   {
//     appState,                                   // the live, mutable app state object
//     switchToForm(instanceKey, mutateFormEngine), // app.js's own function; mutateFormEngine
//                                                   // is called as mutateFormEngine(appState.formEngine)
//     rebuildNavTree(),                            // re-renders the sidebar from appState.instanceKeys
//   }

function lastPathSegment(path) {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Shared by ContainerFillAction/ContainerClearAction's undo+redo (§22
 *  invariant 16's "scoped merge pattern"): clear whatever currently lives
 *  under the container path, then lay the target snapshot's scoped keys back
 *  down. Out-of-scope state is untouched because purge/set both only ever
 *  touch keys matching (or extending) `pathPrefix`. */
function restoreScopedState(formEngine, pathPrefix, snapshot) {
  formEngine.purgeValuesUnderPathPrefix(pathPrefix);
  formEngine.setAllValues(snapshot.fieldValues || {});
  formEngine.setRadioSelections(snapshot.radioSelections || {});
  for (const [name, count] of Object.entries(snapshot.repeatingInstanceCounts || {})) {
    formEngine.setRepeatingInstanceCount(name, count);
  }
}

// ---------------------------------------------------------------------------
// UndoService (spec §14)
// ---------------------------------------------------------------------------

export class UndoService extends EventTarget {
  constructor() {
    super();
    this._undoStack = [];
    this._redoStack = [];
    this._isReplaying = false;
    this._maxSize = 50;
  }

  get isReplaying() {
    return this._isReplaying;
  }

  get canUndo() {
    return this._undoStack.length > 0;
  }

  get canRedo() {
    return this._redoStack.length > 0;
  }

  /** §22 invariant 13: every recording site checks isReplaying itself before
   *  calling this, but recordAction re-checks too — belt and suspenders. */
  recordAction(action) {
    if (this._isReplaying) return;
    this._undoStack.push(action);
    if (this._undoStack.length > this._maxSize) this._undoStack.shift();
    this._redoStack = [];
    this._notifyChanged();
  }

  undo(ctx) {
    if (!this._undoStack.length) return;
    this._isReplaying = true;
    try {
      const action = this._undoStack.pop();
      action.undo(ctx);
      this._redoStack.push(action);
    } finally {
      this._isReplaying = false;
      this._notifyChanged();
    }
  }

  redo(ctx) {
    if (!this._redoStack.length) return;
    this._isReplaying = true;
    try {
      const action = this._redoStack.pop();
      action.redo(ctx);
      this._undoStack.push(action);
    } finally {
      this._isReplaying = false;
      this._notifyChanged();
    }
  }

  /** §22 invariant 23: schema load, root switch, XML load. Form add/remove
   *  are undoable and must NOT call this. */
  clearHistory() {
    this._undoStack = [];
    this._redoStack = [];
    this._notifyChanged();
  }

  /** Returns a disposable that force-sets isReplaying for the duration of a
   *  block of code, restoring whatever it was before (nestable). Not
   *  currently called anywhere in this codebase — undo/redo already run
   *  entirely inside their own try/finally above — but kept per §14 for any
   *  future caller (e.g. a bulk programmatic import) that needs to suppress
   *  recording without going through undo()/redo() itself. */
  suppressRecording() {
    const previous = this._isReplaying;
    this._isReplaying = true;
    return { dispose: () => { this._isReplaying = previous; } };
  }

  _notifyChanged() {
    this.dispatchEvent(new CustomEvent('changed'));
  }
}

// ---------------------------------------------------------------------------
// Action Objects (spec §14 "Action Objects")
// ---------------------------------------------------------------------------

export class FieldValueChangeAction {
  constructor({ instanceKey, path, oldValue, newValue, oldDirty, newDirty }) {
    this.type = 'FieldValueChange';
    Object.assign(this, { instanceKey, path, oldValue, newValue, oldDirty, newDirty });
  }
  undo(ctx) { this._apply(ctx, this.oldValue, this.oldDirty); }
  redo(ctx) { this._apply(ctx, this.newValue, this.newDirty); }
  _apply(ctx, value, dirty) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      formEngine.setValueSilently(this.path, value);
      formEngine.setDirty(dirty);
    });
  }
}

export class RadioBranchSwapAction {
  constructor({ instanceKey, radioGroupPath, oldBranch, newBranch, oldDirty, newDirty }) {
    this.type = 'RadioBranchSwap';
    Object.assign(this, { instanceKey, radioGroupPath, oldBranch, newBranch, oldDirty, newDirty });
  }
  undo(ctx) { this._apply(ctx, this.oldBranch, this.oldDirty); }
  redo(ctx) { this._apply(ctx, this.newBranch, this.newDirty); }
  _apply(ctx, branch, dirty) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      formEngine.setRadioSelections({ [this.radioGroupPath]: branch });
      formEngine.setDirty(dirty);
    });
  }
}

export class RepeatingInstanceAddAction {
  constructor({ instanceKey, elementPathBase, addedIndex, oldDirty, newDirty }) {
    this.type = 'RepeatingInstanceAdd';
    Object.assign(this, { instanceKey, elementPathBase, addedIndex, oldDirty, newDirty });
  }
  undo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      const entryName = lastPathSegment(this.elementPathBase);
      formEngine.purgeValuesUnderPathPrefix(`${this.elementPathBase}[${this.addedIndex}]`);
      formEngine.setRepeatingInstanceCount(entryName, this.addedIndex);
      formEngine.setDirty(this.oldDirty);
    });
  }
  redo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      const entryName = lastPathSegment(this.elementPathBase);
      // A fresh blank instance, same as a live "Add" click — any values a user
      // typed into it afterward were separately recorded as their own
      // FieldValueChangeActions and already got undone first (undo is LIFO),
      // so by the time this redo runs it's blank again; nothing to restore.
      formEngine.setRepeatingInstanceCount(entryName, this.addedIndex + 1);
      formEngine.setDirty(this.newDirty);
    });
  }
}

export class RepeatingInstanceRemoveAction {
  constructor({ instanceKey, elementPathBase, removedIndex, fieldValueSnapshot, radioBranchSelections, oldDirty, newDirty }) {
    this.type = 'RepeatingInstanceRemove';
    Object.assign(this, {
      instanceKey,
      elementPathBase,
      removedIndex,
      fieldValueSnapshot: fieldValueSnapshot || {},
      radioBranchSelections: radioBranchSelections || {},
      oldDirty,
      newDirty,
    });
    // NOTE: no nestedRepeatingCounts snapshot/restore here — repeatingInstanceCounts
    // is keyed by bare entry name, not by path (see formEngine.js's renamePathPrefix
    // comment), so a repeating section nested INSIDE a repeating instance can't be
    // scoped to "this particular removed instance" any more precisely than the live
    // remove button already handles it. Not exercised by the sample schema (no
    // repeating-within-repeating case exists there) — same accepted limitation.
  }
  undo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      const entryName = lastPathSegment(this.elementPathBase);
      const currentCount = formEngine.getRepeatingInstanceCount(entryName);
      // Shift every instance at/after removedIndex UP by one to free its slot
      // back up — descending order so an in-place rename never overwrites a
      // not-yet-moved instance (mirror image of formRenderer's reindexInstances).
      for (let i = currentCount - 1; i >= this.removedIndex; i--) {
        formEngine.renamePathPrefix(`${this.elementPathBase}[${i}]`, `${this.elementPathBase}[${i + 1}]`);
      }
      formEngine.setAllValues(this.fieldValueSnapshot);
      formEngine.setRadioSelections(this.radioBranchSelections);
      formEngine.setRepeatingInstanceCount(entryName, currentCount + 1);
      formEngine.setDirty(this.oldDirty);
    });
  }
  redo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      const entryName = lastPathSegment(this.elementPathBase);
      const currentCount = formEngine.getRepeatingInstanceCount(entryName);
      formEngine.purgeValuesUnderPathPrefix(`${this.elementPathBase}[${this.removedIndex}]`);
      for (let i = this.removedIndex + 1; i < currentCount; i++) {
        formEngine.renamePathPrefix(`${this.elementPathBase}[${i}]`, `${this.elementPathBase}[${i - 1}]`);
      }
      formEngine.setRepeatingInstanceCount(entryName, currentCount - 1);
      formEngine.setDirty(this.newDirty);
    });
  }
}

// --- The following four action types are recorded by Phase 6 features
// (testDataFiller.js / contextMenu.js) that don't exist yet. The mechanism is
// built now, per the plan, so Phase 6 only has to call recordAction(...) —
// nothing here is wired to a live UI trigger yet. ---------------------------

export class FillTestDataAction {
  constructor({ instanceKey, before, after, oldDirty, newDirty }) {
    this.type = 'FillTestData';
    Object.assign(this, { instanceKey, before, after, oldDirty, newDirty });
  }
  undo(ctx) { this._apply(ctx, this.before, this.oldDirty); }
  redo(ctx) { this._apply(ctx, this.after, this.newDirty); }
  _apply(ctx, snapshot, dirty) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      const state = formEngine.getFormState(this.instanceKey);
      state.fieldValues = { ...(snapshot.fieldValues || {}) };
      state.radioSelections = { ...(snapshot.radioSelections || {}) };
      state.repeatingInstanceCounts = { ...(snapshot.repeatingInstanceCounts || {}) };
      formEngine.setDirty(dirty);
    });
  }
}

export class ClearAllAction {
  constructor({ instanceKey, before, oldDirty, newDirty }) {
    this.type = 'ClearAll';
    Object.assign(this, { instanceKey, before, oldDirty, newDirty });
  }
  undo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      const state = formEngine.getFormState(this.instanceKey);
      state.fieldValues = { ...(this.before.fieldValues || {}) };
      state.radioSelections = { ...(this.before.radioSelections || {}) };
      state.repeatingInstanceCounts = { ...(this.before.repeatingInstanceCounts || {}) };
      formEngine.setDirty(this.oldDirty);
    });
  }
  redo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      const state = formEngine.getFormState(this.instanceKey);
      state.fieldValues = {};
      state.radioSelections = {};
      formEngine.setDirty(this.newDirty);
    });
  }
}

export class ContainerFillAction {
  constructor({ instanceKey, containerPath, before, after, oldDirty, newDirty }) {
    this.type = 'ContainerFill';
    Object.assign(this, { instanceKey, containerPath, before, after, oldDirty, newDirty });
  }
  undo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      restoreScopedState(formEngine, this.containerPath, this.before);
      formEngine.setDirty(this.oldDirty);
    });
  }
  redo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      restoreScopedState(formEngine, this.containerPath, this.after);
      formEngine.setDirty(this.newDirty);
    });
  }
}

export class ContainerClearAction {
  constructor({ instanceKey, containerPath, before, oldDirty, newDirty }) {
    this.type = 'ContainerClear';
    Object.assign(this, { instanceKey, containerPath, before, oldDirty, newDirty });
  }
  undo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      restoreScopedState(formEngine, this.containerPath, this.before);
      formEngine.setDirty(this.oldDirty);
    });
  }
  redo(ctx) {
    ctx.switchToForm(this.instanceKey, (formEngine) => {
      formEngine.purgeValuesUnderPathPrefix(this.containerPath);
      formEngine.setDirty(this.newDirty);
    });
  }
}

// --- Whole-form-instance actions (nav tree add/remove). FormAddAction is
// wired to the existing "+ Add" button (app.js's addFormInstance).
// FormRemoveAction has no UI trigger yet (there is no "remove form instance"
// button in the sidebar) — implemented per spec for when one is added. -------

export class FormAddAction {
  constructor({ instanceKey, priorInstanceKey, insertPosition, oldDirty, newDirty }) {
    this.type = 'FormAdd';
    Object.assign(this, { instanceKey, priorInstanceKey, insertPosition, oldDirty, newDirty });
  }
  undo(ctx) {
    ctx.appState.instanceKeys = ctx.appState.instanceKeys.filter((k) => !k.equals(this.instanceKey));
    ctx.rebuildNavTree();
    const fallback = this.priorInstanceKey && ctx.appState.instanceKeys.some((k) => k.equals(this.priorInstanceKey))
      ? this.priorInstanceKey
      : ctx.appState.instanceKeys[0];
    // Switch away BEFORE purging: switchToForm's setActiveForm flushes the
    // OUTGOING (still-active) form's registered controls first — since that's
    // still this.instanceKey at this point, flushing before the purge would
    // silently recreate the very FormState we're about to delete. Purging
    // last (once this.instanceKey is no longer active) avoids that entirely.
    if (fallback) ctx.switchToForm(fallback);
    ctx.appState.formEngine.purgeFormState(this.instanceKey);
  }
  redo(ctx) {
    const idx = Math.min(this.insertPosition, ctx.appState.instanceKeys.length);
    ctx.appState.instanceKeys.splice(idx, 0, this.instanceKey);
    ctx.rebuildNavTree();
    ctx.switchToForm(this.instanceKey);
  }
}

export class FormRemoveAction {
  constructor({ instanceKey, stateSnapshot, originalPosition, wasActive, postRemovalActiveKey, oldDirty, newDirty }) {
    this.type = 'FormRemove';
    Object.assign(this, { instanceKey, stateSnapshot, originalPosition, wasActive, postRemovalActiveKey, oldDirty, newDirty });
  }
  undo(ctx) {
    const idx = Math.min(this.originalPosition, ctx.appState.instanceKeys.length);
    ctx.appState.instanceKeys.splice(idx, 0, this.instanceKey);
    ctx.appState.formEngine.restoreFormState(this.instanceKey, this.stateSnapshot);
    ctx.rebuildNavTree();
    if (this.wasActive) ctx.switchToForm(this.instanceKey);
  }
  redo(ctx) {
    ctx.appState.instanceKeys = ctx.appState.instanceKeys.filter((k) => !k.equals(this.instanceKey));
    ctx.rebuildNavTree();
    // Same ordering fix as FormAddAction.undo above: switch away first, purge after.
    if (this.wasActive && this.postRemovalActiveKey) ctx.switchToForm(this.postRemovalActiveKey);
    ctx.appState.formEngine.purgeFormState(this.instanceKey);
  }
}
