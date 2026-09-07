import { FormEngine, FormInstanceKey } from '../js/core/formEngine.js';
import { UndoService, FillTestDataAction, ContainerFillAction, ContainerClearAction } from '../js/core/undoService.js';

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(ok ? 'PASS' : 'FAIL', '-', label, ok ? '' : `(got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const formEngine = new FormEngine();
const undoService = new UndoService();
const key = new FormInstanceKey('Form');
const ctx = { appState: { formEngine }, switchToForm(k, mutateFormEngine) { formEngine.setActiveForm(k); if (mutateFormEngine) mutateFormEngine(formEngine); } };

formEngine.setActiveForm(key);
const state = formEngine.getFormState(key);

// Step 3-5: whole-form required-only fill fills StreetLine1 (required) but not StreetLine2 (optional).
const before1 = { fieldValues: {}, radioSelections: {}, repeatingInstanceCounts: {} };
state.fieldValues['form.entitycode'] = 'AA0000';
state.fieldValues['form.address.streetline1'] = 'X';
const after1 = { fieldValues: { ...state.fieldValues }, radioSelections: {}, repeatingInstanceCounts: {} };
undoService.recordAction(new FillTestDataAction({ instanceKey: key, before: before1, after: after1, oldDirty: false, newDirty: true }));

// Step 6: scoped fill of "Form.Address" — StreetLine1 already non-empty (skipped by merge),
// StreetLine2 newly filled.
const containerPath = 'Form.Address';
const before2 = formEngine.snapshotUnderPathPrefix(containerPath);
state.fieldValues['form.address.streetline2'] = 'NEW';
const after2 = formEngine.snapshotUnderPathPrefix(containerPath);
undoService.recordAction(new ContainerFillAction({ instanceKey: key, containerPath, before: before2, after: after2, oldDirty: true, newDirty: true }));

assertEq('StreetLine2 populated by the scoped fill', formEngine.getValue('Form.Address.StreetLine2'), 'NEW');
undoService.undo(ctx);
assertEq('Undo of the scoped fill removes StreetLine2', formEngine.getValue('Form.Address.StreetLine2'), undefined);
assertEq('...does not disturb EntityCode (outside the container)', formEngine.getValue('Form.EntityCode'), 'AA0000');
assertEq('...or StreetLine1 (in scope, but unchanged by THIS action, so restored right back)', formEngine.getValue('Form.Address.StreetLine1'), 'X');
undoService.redo(ctx);
assertEq('Redo re-applies the scoped fill', formEngine.getValue('Form.Address.StreetLine2'), 'NEW');

// Step 9-10: scoped clear, then undo restores BOTH fields.
const sl1Before = formEngine.getValue('Form.Address.StreetLine1');
const sl2Before = formEngine.getValue('Form.Address.StreetLine2');
const before3 = formEngine.snapshotUnderPathPrefix(containerPath);
formEngine.purgeValuesUnderPathPrefix(containerPath);
undoService.recordAction(new ContainerClearAction({ instanceKey: key, containerPath, before: before3, oldDirty: true, newDirty: true }));

assertEq('Scoped clear purged both', [formEngine.getValue('Form.Address.StreetLine1'), formEngine.getValue('Form.Address.StreetLine2')], [undefined, undefined]);
undoService.undo(ctx);
assertEq('Undo of the scoped clear restores both to their exact prior values', [formEngine.getValue('Form.Address.StreetLine1'), formEngine.getValue('Form.Address.StreetLine2')], [sl1Before, sl2Before]);
