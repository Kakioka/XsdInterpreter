// test/undoService.test.mjs — js/core/undoService.js.
//
// dev/phase4-check.html drives undo through rendered DOM, which is the right
// way to check that the DOM comes back correctly. This suite checks the other
// half: the stack mechanics, and each action's effect on FormEngine state
// alone, through a ctx whose switchToForm does exactly what app.js's does
// MINUS the rendering — which is legitimate precisely because actions only
// ever touch state through the mutateState hook (§22 invariant 14: actions
// store paths, values, keys and flags, never live DOM references).

import test from 'node:test';
import assert from 'node:assert/strict';

import { FormEngine, FormInstanceKey, createEmptyFormState } from '../js/core/formEngine.js';
import {
  UndoService,
  DEFAULT_UNDO_LIMIT,
  FieldValueChangeAction,
  RadioBranchSwapAction,
  RepeatingInstanceAddAction,
  RepeatingInstanceRemoveAction,
  FillTestDataAction,
  ClearAllAction,
  ContainerFillAction,
  ContainerClearAction,
  FormAddAction,
  FormRemoveAction,
} from '../js/core/undoService.js';

/** The DOM-free equivalent of app.js's switchToForm: the same
 *  setActiveForm → mutateState ordering, with the render pipeline omitted. */
function makeCtx() {
  const formEngine = new FormEngine();
  const appState = { formEngine, instanceKeys: [], currentInstanceKey: null };
  const navRebuilds = { count: 0 };
  const switchToForm = (instanceKey, mutateState) => {
    formEngine.setActiveForm(instanceKey);
    if (mutateState) mutateState(formEngine);
    appState.currentInstanceKey = instanceKey;
  };
  return { appState, switchToForm, rebuildNavTree: () => navRebuilds.count++, navRebuilds, formEngine };
}

test('stack mechanics: canUndo/canRedo, and recording clears the redo stack', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const key = new FormInstanceKey('F');
  const action = () => new FieldValueChangeAction({ instanceKey: key, path: 'F.A', oldValue: '', newValue: 'x', oldDirty: false, newDirty: true });

  assert.equal(service.canUndo, false);
  assert.equal(service.canRedo, false);

  service.recordAction(action());
  assert.equal(service.canUndo, true);

  service.undo(ctx);
  assert.equal(service.canUndo, false);
  assert.equal(service.canRedo, true);

  // A NEW action after an undo discards the redo branch.
  service.recordAction(action());
  assert.equal(service.canRedo, false);
});

test('undo/redo on an empty stack is a no-op, not a throw', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  service.undo(ctx);
  service.redo(ctx);
  assert.equal(service.canUndo, false);
});

test("the default cap is well past the spec's 50 (backlog A.4)", () => {
  const service = new UndoService();
  assert.equal(service.maxSize, DEFAULT_UNDO_LIMIT);
  assert.ok(DEFAULT_UNDO_LIMIT >= 500);
});

test('the stack is bounded, dropping the OLDEST, and reports that it has', () => {
  const service = new UndoService({ maxSize: 50 });
  const key = new FormInstanceKey('F');
  for (let i = 0; i < 50; i++) {
    service.recordAction(
      new FieldValueChangeAction({ instanceKey: key, path: 'F.A', oldValue: String(i), newValue: String(i + 1), oldDirty: true, newDirty: true })
    );
  }
  assert.equal(service.historyTruncated, false, 'exactly at the cap nothing has been dropped yet');
  for (let i = 50; i < 55; i++) {
    service.recordAction(
      new FieldValueChangeAction({ instanceKey: key, path: 'F.A', oldValue: String(i), newValue: String(i + 1), oldDirty: true, newDirty: true })
    );
  }
  const ctx = makeCtx();
  let undone = 0;
  while (service.canUndo) {
    service.undo(ctx);
    undone++;
  }
  assert.equal(undone, 50);
  // The oldest 5 are gone, so the earliest reachable oldValue is '5', not '0'.
  assert.equal(ctx.formEngine.getValue('F.A'), '5');
  assert.equal(service.historyTruncated, true);
  assert.equal(service.redoCount, 50);

  service.clearHistory();
  assert.equal(service.historyTruncated, false, 'a schema/XML load starts a fresh history');
  assert.equal(service.undoCount + service.redoCount, 0);
});

test('recordAction is ignored while replaying (§22 invariant 13)', () => {
  const service = new UndoService();
  const key = new FormInstanceKey('F');
  const ctx = makeCtx();
  // An action whose own undo tries to record another action — the recursion
  // isReplaying exists to stop.
  service.recordAction({
    undo() {
      service.recordAction(new FieldValueChangeAction({ instanceKey: key, path: 'F.X', oldValue: '', newValue: 'y', oldDirty: false, newDirty: true }));
    },
    redo() {},
  });
  service.undo(ctx);
  assert.equal(service.canUndo, false, 'the nested recordAction must have been dropped');
});

test('clearHistory empties both stacks and fires "changed"', () => {
  const service = new UndoService();
  let changes = 0;
  service.addEventListener('changed', () => changes++);
  service.recordAction(new FieldValueChangeAction({ instanceKey: new FormInstanceKey('F'), path: 'F.A', oldValue: '', newValue: 'x', oldDirty: false, newDirty: true }));
  service.clearHistory();
  assert.equal(service.canUndo, false);
  assert.equal(service.canRedo, false);
  assert.ok(changes >= 2, 'recordAction and clearHistory each notify');
});

test('FieldValueChangeAction restores the old value and the old dirty flag', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const key = new FormInstanceKey('Header');
  ctx.switchToForm(key);
  ctx.formEngine.setValueSilently('Header.Title', 'new');
  ctx.formEngine.setDirty(true);

  service.recordAction(new FieldValueChangeAction({ instanceKey: key, path: 'Header.Title', oldValue: 'old', newValue: 'new', oldDirty: false, newDirty: true }));

  service.undo(ctx);
  assert.equal(ctx.formEngine.getValue('Header.Title'), 'old');
  assert.equal(ctx.formEngine.isDirty, false);

  service.redo(ctx);
  assert.equal(ctx.formEngine.getValue('Header.Title'), 'new');
  assert.equal(ctx.formEngine.isDirty, true);
});

test('undo navigates to the form the change happened in, even from another form', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const header = new FormInstanceKey('Header');
  const other = new FormInstanceKey('Other');

  ctx.switchToForm(header);
  service.recordAction(new FieldValueChangeAction({ instanceKey: header, path: 'Header.Title', oldValue: '', newValue: 'x', oldDirty: false, newDirty: true }));
  ctx.switchToForm(other);
  assert.ok(ctx.appState.currentInstanceKey.equals(other));

  service.undo(ctx);
  assert.ok(ctx.appState.currentInstanceKey.equals(header), 'the user must land on the form the change was in');
});

test('RadioBranchSwapAction restores the previous branch', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const key = new FormInstanceKey('F');
  const choicePath = 'F.Choice.ChoiceChoice';
  ctx.switchToForm(key);

  service.recordAction(
    new RadioBranchSwapAction({
      instanceKey: key,
      radioGroupPath: choicePath,
      oldBranch: `${choicePath}.Option2`,
      newBranch: `${choicePath}.Option1`,
      oldDirty: true,
      newDirty: true,
    })
  );

  service.undo(ctx);
  assert.equal(ctx.formEngine.getRadioSelections()[choicePath.toLowerCase()], `${choicePath}.Option2`);
  service.redo(ctx);
  assert.equal(ctx.formEngine.getRadioSelections()[choicePath.toLowerCase()], `${choicePath}.Option1`);
});

test('RepeatingInstanceAddAction: undo drops the count and purges that instance\'s values', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const key = new FormInstanceKey('F');
  const base = 'F.List.ListEntry';
  ctx.switchToForm(key);
  ctx.formEngine.setRepeatingInstanceCount('ListEntry', 2);
  ctx.formEngine.setAllValues({ [`${base}[0].name`]: 'first', [`${base}[1].name`]: 'second' });

  service.recordAction(new RepeatingInstanceAddAction({ instanceKey: key, elementPathBase: base, addedIndex: 1, oldDirty: true, newDirty: true }));

  service.undo(ctx);
  assert.equal(ctx.formEngine.getRepeatingInstanceCount('ListEntry'), 1);
  assert.equal(ctx.formEngine.getValue(`${base}[1].name`), undefined);
  assert.equal(ctx.formEngine.getValue(`${base}[0].name`), 'first');

  service.redo(ctx);
  assert.equal(ctx.formEngine.getRepeatingInstanceCount('ListEntry'), 2);
  assert.equal(ctx.formEngine.getValue(`${base}[1].name`), undefined, 'a redone Add produces a BLANK instance');
});

test('RepeatingInstanceRemoveAction: undo re-indexes the survivors back up and restores the removed data', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const key = new FormInstanceKey('F');
  const base = 'F.List.ListEntry';
  ctx.switchToForm(key);

  // Post-removal state: instance [0] was removed and [1] shifted down into [0].
  ctx.formEngine.setRepeatingInstanceCount('ListEntry', 1);
  ctx.formEngine.setAllValues({ [`${base}[0].name`]: 'second' });

  service.recordAction(
    new RepeatingInstanceRemoveAction({
      instanceKey: key,
      elementPathBase: base,
      removedIndex: 0,
      fieldValueSnapshot: { [`${base}[0].name`.toLowerCase()]: 'first' },
      radioBranchSelections: {},
      oldDirty: true,
      newDirty: true,
    })
  );

  service.undo(ctx);
  assert.equal(ctx.formEngine.getRepeatingInstanceCount('ListEntry'), 2);
  assert.equal(ctx.formEngine.getValue(`${base}[0].name`), 'first');
  assert.equal(ctx.formEngine.getValue(`${base}[1].name`), 'second');

  service.redo(ctx);
  assert.equal(ctx.formEngine.getRepeatingInstanceCount('ListEntry'), 1);
  assert.equal(ctx.formEngine.getValue(`${base}[0].name`), 'second');
});

test('FillTestDataAction and ClearAllAction restore whole-form snapshots', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const key = new FormInstanceKey('F');
  ctx.switchToForm(key);

  const before = { fieldValues: { 'f.a': 'kept' }, radioSelections: {}, repeatingInstanceCounts: { entry: 2 } };
  const after = { fieldValues: { 'f.a': 'kept', 'f.b': 'filled' }, radioSelections: { 'f.choice': 'opt' }, repeatingInstanceCounts: { entry: 3 } };
  ctx.formEngine.setAllValues(after.fieldValues);
  ctx.formEngine.setRadioSelections(after.radioSelections);
  ctx.formEngine.setRepeatingInstanceCount('entry', 3);

  service.recordAction(new FillTestDataAction({ instanceKey: key, before, after, oldDirty: false, newDirty: true }));
  service.undo(ctx);
  assert.equal(ctx.formEngine.getValue('f.b'), undefined);
  assert.equal(ctx.formEngine.getRepeatingInstanceCount('entry'), 2);

  service.redo(ctx);
  assert.equal(ctx.formEngine.getValue('f.b'), 'filled');

  // ClearAllAction's redo blanks values/radios but, per §22's "clear the
  // content, keep the rows", leaves repeating counts alone.
  const clearAll = new ClearAllAction({ instanceKey: key, before: after, oldDirty: true, newDirty: true });
  clearAll.redo(ctx);
  assert.equal(ctx.formEngine.getValue('f.a'), undefined);
  assert.equal(ctx.formEngine.getRepeatingInstanceCount('entry'), 3, 'rows survive a Clear All');
  clearAll.undo(ctx);
  assert.equal(ctx.formEngine.getValue('f.a'), 'kept');
});

test('ContainerFillAction / ContainerClearAction only touch state under their container path', () => {
  const ctx = makeCtx();
  const key = new FormInstanceKey('F');
  ctx.switchToForm(key);
  ctx.formEngine.setAllValues({ 'f.addr.street': 'filled', 'f.addr.city': 'filled', 'f.outside': 'untouched' });

  const fill = new ContainerFillAction({
    instanceKey: key,
    containerPath: 'F.Addr',
    before: { fieldValues: {}, radioSelections: {} },
    after: { fieldValues: { 'f.addr.street': 'filled', 'f.addr.city': 'filled' }, radioSelections: {} },
    oldDirty: false,
    newDirty: true,
  });

  fill.undo(ctx);
  assert.equal(ctx.formEngine.getValue('f.addr.street'), undefined);
  assert.equal(ctx.formEngine.getValue('f.outside'), 'untouched', 'out-of-scope state must survive');

  fill.redo(ctx);
  assert.equal(ctx.formEngine.getValue('f.addr.city'), 'filled');

  const clear = new ContainerClearAction({
    instanceKey: key,
    containerPath: 'F.Addr',
    before: { fieldValues: { 'f.addr.street': 'filled', 'f.addr.city': 'filled' }, radioSelections: {} },
    oldDirty: true,
    newDirty: true,
  });
  clear.redo(ctx);
  assert.equal(ctx.formEngine.getValue('f.addr.street'), undefined);
  assert.equal(ctx.formEngine.getValue('f.outside'), 'untouched');
  clear.undo(ctx);
  assert.equal(ctx.formEngine.getValue('f.addr.street'), 'filled');
});

test('FormAddAction: undo removes the key and its state, and lands on the prior form', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const prior = new FormInstanceKey('Header');
  const added = new FormInstanceKey('SampleEventLog', 'EVT-TEST');

  ctx.appState.instanceKeys = [prior];
  ctx.switchToForm(prior);
  ctx.appState.instanceKeys.push(added);
  const insertPosition = ctx.appState.instanceKeys.length - 1;
  ctx.switchToForm(added);

  service.recordAction(new FormAddAction({ instanceKey: added, priorInstanceKey: prior, insertPosition, oldDirty: false, newDirty: true }));

  service.undo(ctx);
  assert.ok(!ctx.appState.instanceKeys.some((k) => k.equals(added)));
  assert.equal(ctx.formEngine.getFormState(added), undefined, 'the purge must happen AFTER switching away, or the flush recreates it');
  assert.ok(ctx.appState.currentInstanceKey.equals(prior));

  service.redo(ctx);
  assert.ok(ctx.appState.instanceKeys[insertPosition].equals(added));
  assert.ok(ctx.appState.currentInstanceKey.equals(added));
});

test('FormRemoveAction: undo re-inserts at the original position with the snapshotted state', () => {
  const service = new UndoService();
  const ctx = makeCtx();
  const first = new FormInstanceKey('A');
  const removed = new FormInstanceKey('B');
  const third = new FormInstanceKey('C');

  ctx.appState.instanceKeys = [first, third];
  ctx.switchToForm(third);

  const snapshot = createEmptyFormState();
  snapshot.fieldValues['b.title'] = 'had data';

  service.recordAction(
    new FormRemoveAction({
      instanceKey: removed,
      stateSnapshot: snapshot,
      originalPosition: 1,
      wasActive: true,
      postRemovalActiveKey: third,
      oldDirty: true,
      newDirty: true,
    })
  );

  service.undo(ctx);
  assert.ok(ctx.appState.instanceKeys[1].equals(removed));
  assert.equal(ctx.formEngine.getFormState(removed).fieldValues['b.title'], 'had data');
  assert.ok(ctx.appState.currentInstanceKey.equals(removed));

  service.redo(ctx);
  assert.ok(!ctx.appState.instanceKeys.some((k) => k.equals(removed)));
  assert.equal(ctx.formEngine.getFormState(removed), undefined);
  assert.ok(ctx.appState.currentInstanceKey.equals(third));
});

test('every action stores only serializable data — no live DOM references (§22 invariant 14)', () => {
  const key = new FormInstanceKey('F');
  const actions = [
    new FieldValueChangeAction({ instanceKey: key, path: 'F.A', oldValue: '', newValue: 'x', oldDirty: false, newDirty: true }),
    new RadioBranchSwapAction({ instanceKey: key, radioGroupPath: 'F.C', oldBranch: null, newBranch: 'F.C.O1', oldDirty: false, newDirty: true }),
    new RepeatingInstanceAddAction({ instanceKey: key, elementPathBase: 'F.L.LEntry', addedIndex: 0, oldDirty: false, newDirty: true }),
    new RepeatingInstanceRemoveAction({ instanceKey: key, elementPathBase: 'F.L.LEntry', removedIndex: 0, oldDirty: false, newDirty: true }),
    new FormAddAction({ instanceKey: key, priorInstanceKey: null, insertPosition: 0, oldDirty: false, newDirty: true }),
  ];
  for (const action of actions) {
    // JSON.stringify would throw on a cyclic DOM node and silently drop
    // functions; a clean round-trip is a decent proxy for "paths and flags only".
    assert.doesNotThrow(() => JSON.stringify(action), `${action.type} must be serializable`);
    assert.ok(action.type, 'every action carries a type label for the debug panel');
  }
});
