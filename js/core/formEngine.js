// js/core/formEngine.js — Central state manager.
//
// See web-implementation-spec.md §6 (Form Engine), §2 (FormState, FormInstanceKey).
// IMPLEMENTATION_PLAN.md Phase 2.1.
//
// Pure logic. Uses EventTarget/CustomEvent for the controlValueChanged notification —
// a generic browser event-dispatch primitive, not a rendering/DOM dependency (no
// querySelector, no createElement, no document access anywhere in this file).

// ---------------------------------------------------------------------------
// FormInstanceKey (spec §2)
// ---------------------------------------------------------------------------

export class FormInstanceKey {
  /**
   * @param {string} formName
   * @param {string} [instanceId] same as formName for non-repeatable forms; a UUID
   *   (or a documentId-derived id) for repeatable instances. Defaults to formName.
   */
  constructor(formName, instanceId) {
    this.formName = formName;
    this.instanceId = instanceId != null ? instanceId : formName;
  }

  /** "formName" for non-repeatable (instanceId === formName), else "formName#instanceId". */
  toString() {
    return this.instanceId === this.formName ? this.formName : `${this.formName}#${this.instanceId}`;
  }

  /** Case-insensitive on both fields, per §2. */
  equals(other) {
    if (!other) return false;
    return this.formName.toLowerCase() === other.formName.toLowerCase() && this.instanceId.toLowerCase() === other.instanceId.toLowerCase();
  }

  static parse(str) {
    const idx = str.indexOf('#');
    return idx === -1 ? new FormInstanceKey(str, str) : new FormInstanceKey(str.slice(0, idx), str.slice(idx + 1));
  }
}

/** Canonical, case-insensitive Map key for a FormInstanceKey. Shared with
 *  xmlWriter/xmlReader so every module keys storedStates identically. */
export function keyOf(instanceKey) {
  return instanceKey.toString().toLowerCase();
}

export function createEmptyFormState() {
  return { fieldValues: {}, repeatingInstanceCounts: {}, radioSelections: {}, unmatchedFields: [], isDirty: false };
}

/** True if `key` is `prefix` itself, or continues it with `.` (nested field) or
 *  `[` (repeating index) — the shared rule for every "under this path" operation. */
function hasPathPrefix(key, prefix) {
  return key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}[`);
}

// ---------------------------------------------------------------------------
// FormEngine (spec §6)
// ---------------------------------------------------------------------------

export class FormEngine extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, object>} keyOf(instanceKey) → FormState */
    this.storedStates = new Map();
    /** @type {Map<string, {getValue:Function,setValue:Function,validate?:Function,elementPath:string}>} path.toLowerCase() → ControlRef */
    this.registeredControls = new Map();
    /** @type {FormInstanceKey|null} */
    this.activeInstanceKey = null;
  }

  // --- control registration ---------------------------------------------

  registerControl(path, controlRef) {
    this.registeredControls.set(path.toLowerCase(), controlRef);
  }

  unregisterControlsUnderPath(prefix) {
    const p = prefix.toLowerCase();
    for (const key of this.registeredControls.keys()) {
      if (hasPathPrefix(key, p)) this.registeredControls.delete(key);
    }
  }

  // --- active form -------------------------------------------------------

  /**
   * Critical rule (§6, §22 invariant 3): persist the CURRENTLY active form's
   * registered controls' live values into its stored state BEFORE clearing the
   * registration map — reading straight from each control (not relying on prior
   * setValue calls) is what catches an in-progress edit that hasn't reached a
   * commit event (e.g. a text field mid-edit, not yet blurred) when the user
   * switches forms out from under it.
   */
  setActiveForm(instanceKey) {
    this.flushRegisteredControls();
    this.registeredControls.clear();
    this.activeInstanceKey = instanceKey;
    const key = keyOf(instanceKey);
    if (!this.storedStates.has(key)) this.storedStates.set(key, createEmptyFormState());
  }

  /** The read-straight-from-each-control half of the rule above, factored out
   *  so callers that need a values flush WITHOUT tearing down the active
   *  form's registrations (e.g. "Save XML" while a field is still mid-edit)
   *  don't have to call setActiveForm(sameKey) and lose every registration. */
  flushRegisteredControls() {
    if (!this.activeInstanceKey) return;
    const state = this._getOrCreateActiveState();
    for (const [path, controlRef] of this.registeredControls) {
      state.fieldValues[path] = controlRef.getValue();
    }
  }

  /** Pushes stored values onto currently-registered controls, by path (already
   *  case-insensitive since both sides are lowercased at write time). */
  restoreActiveForm() {
    const state = this._getOrCreateActiveState();
    for (const [path, controlRef] of this.registeredControls) {
      if (Object.prototype.hasOwnProperty.call(state.fieldValues, path)) {
        controlRef.setValue(state.fieldValues[path]);
      }
    }
  }

  // --- field values --------------------------------------------------------

  getValue(path) {
    return this._getOrCreateActiveState().fieldValues[path.toLowerCase()];
  }

  setValue(path, value) {
    this._getOrCreateActiveState().fieldValues[path.toLowerCase()] = value;
    this.dispatchEvent(new CustomEvent('controlValueChanged', { detail: { path } }));
  }

  setValueSilently(path, value) {
    this._getOrCreateActiveState().fieldValues[path.toLowerCase()] = value;
  }

  /** Returns a COPY of all stored values for the active form. */
  getAllValues() {
    return { ...this._getOrCreateActiveState().fieldValues };
  }

  setAllValues(dict) {
    const state = this._getOrCreateActiveState();
    for (const [k, v] of Object.entries(dict)) state.fieldValues[k.toLowerCase()] = v;
  }

  // --- repeating instance counts -------------------------------------------

  getRepeatingInstanceCount(basePath) {
    return this._getOrCreateActiveState().repeatingInstanceCounts[basePath.toLowerCase()] ?? 0;
  }

  setRepeatingInstanceCount(basePath, count) {
    this._getOrCreateActiveState().repeatingInstanceCounts[basePath.toLowerCase()] = count;
  }

  // --- radio selections ------------------------------------------------------

  getRadioSelections() {
    return { ...this._getOrCreateActiveState().radioSelections };
  }

  setRadioSelections(dict) {
    const state = this._getOrCreateActiveState();
    for (const [k, v] of Object.entries(dict)) state.radioSelections[k.toLowerCase()] = v;
  }

  setRadioSelection(path, branch) {
    this._getOrCreateActiveState().radioSelections[path.toLowerCase()] = branch;
  }

  // --- purge (repeating-instance removal — §22 invariant 10, 15) -----------

  /**
   * Read-only snapshot of fieldValues/radioSelections under `prefix` (exact
   * match, or continuing with '.' or '['), for the ACTIVE form. Used by
   * undoService's RepeatingInstanceRemoveAction (§14) — snapshot BEFORE
   * purgeValuesUnderPathPrefix destroys the data (§22 invariant 15).
   */
  snapshotUnderPathPrefix(prefix) {
    const state = this._getOrCreateActiveState();
    const p = prefix.toLowerCase();
    const pick = (dict) => {
      const out = {};
      for (const [k, v] of Object.entries(dict)) {
        if (hasPathPrefix(k, p)) out[k] = v;
      }
      return out;
    };
    return { fieldValues: pick(state.fieldValues), radioSelections: pick(state.radioSelections) };
  }

  purgeValuesUnderPathPrefix(prefix) {
    const state = this._getOrCreateActiveState();
    const p = prefix.toLowerCase();
    for (const dict of [state.fieldValues, state.radioSelections, state.repeatingInstanceCounts]) {
      for (const key of Object.keys(dict)) {
        if (hasPathPrefix(key, p)) delete dict[key];
      }
    }
  }

  /**
   * Renames every fieldValues/radioSelections key under `oldPrefix` to the same
   * key under `newPrefix` instead. Needed when removing one repeating instance
   * shifts the remaining ones' indices down (e.g. instance [1] becomes [0]) —
   * the spec requires this re-indexing (§7 Inflation, WALKTHROUGH.md's "Remove
   * invariant") without spelling out a mechanism; this is that mechanism.
   * repeatingInstanceCounts is keyed by bare entry name, not a full path, so a
   * nested repeating section's own count is unaffected by renumbering its
   * enclosing instance and is deliberately not touched here.
   */
  renamePathPrefix(oldPrefix, newPrefix) {
    const state = this._getOrCreateActiveState();
    const oldP = oldPrefix.toLowerCase();
    const newP = newPrefix.toLowerCase();
    if (oldP === newP) return;
    for (const dict of [state.fieldValues, state.radioSelections]) {
      for (const key of Object.keys(dict)) {
        if (hasPathPrefix(key, oldP)) {
          const renamed = newP + key.slice(oldP.length);
          dict[renamed] = dict[key];
          delete dict[key];
        }
      }
    }
  }

  // --- dirty flag ------------------------------------------------------------

  get isDirty() {
    return this._getOrCreateActiveState().isDirty;
  }

  /** Dispatches 'dirtyChanged' only on an actual flip — the status bar (§13,
   *  Phase 7.2) listens for this rather than 'controlValueChanged' because a
   *  text/numeric/decimal/date field's dirty flag doesn't flip until its
   *  `blur` handler runs recordValueChange (see formRenderer.js), which is
   *  AFTER the `change` handler already fired 'controlValueChanged' via
   *  setValue — listening to that event alone would read a one-step-stale
   *  isDirty. Every setDirty call site (fills, clears, instance add/remove,
   *  radio swap, undo/redo restoring oldDirty/newDirty) goes through here, so
   *  this one event covers all of them uniformly. */
  setDirty(val) {
    const state = this._getOrCreateActiveState();
    const newVal = !!val;
    if (state.isDirty === newVal) return;
    state.isDirty = newVal;
    this.dispatchEvent(new CustomEvent('dirtyChanged', { detail: { isDirty: newVal } }));
  }

  // --- whole-form-state access (used by undo snapshots, xmlReader/xmlWriter) --

  /** Returns a COPY of the storedStates map (shallow — FormState objects themselves are not cloned). */
  getAllFormStates() {
    return new Map(this.storedStates);
  }

  getFormState(instanceKey) {
    return this.storedStates.get(keyOf(instanceKey));
  }

  restoreFormState(instanceKey, state) {
    this.storedStates.set(keyOf(instanceKey), state);
  }

  purgeFormState(instanceKey) {
    this.storedStates.delete(keyOf(instanceKey));
  }

  /** Clears all state — called on schema load, root switch, XML load (§22 invariant 23). */
  reset() {
    this.storedStates.clear();
    this.registeredControls.clear();
    this.activeInstanceKey = null;
  }

  _getOrCreateActiveState() {
    if (!this.activeInstanceKey) throw new Error('FormEngine: no active form set (call setActiveForm first)');
    const key = keyOf(this.activeInstanceKey);
    let state = this.storedStates.get(key);
    if (!state) {
      state = createEmptyFormState();
      this.storedStates.set(key, state);
    }
    return state;
  }
}
