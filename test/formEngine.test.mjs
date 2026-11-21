// test/formEngine.test.mjs — js/core/formEngine.js.
//
// FormEngine needs no DOM shim at all (EventTarget/CustomEvent are Node
// globals), so this suite runs on a bare checkout. It covers the parts the
// browser harnesses can only reach indirectly through rendered controls: the
// path-prefix operations (purge / snapshot / rename), the case-insensitivity
// rules of §2 and §8, and the exact event semantics the status bar and
// coloring depend on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FormEngine, FormInstanceKey, keyOf, createEmptyFormState } from '../js/core/formEngine.js';

/** A ControlRef stand-in: the registry only ever calls getValue/setValue. */
function fakeControl(initial = '') {
  let value = initial;
  return {
    getValue: () => value,
    setValue: (v) => {
      value = v;
    },
    get current() {
      return value;
    },
  };
}

test('FormInstanceKey: toString, equality and parse are case-insensitive on both fields (§2)', () => {
  assert.equal(new FormInstanceKey('SampleHeader').toString(), 'SampleHeader');
  assert.equal(new FormInstanceKey('SampleEventLog', 'EVT-001').toString(), 'SampleEventLog#EVT-001');

  assert.ok(new FormInstanceKey('SampleHeader').equals(new FormInstanceKey('sampleheader')));
  assert.ok(new FormInstanceKey('Log', 'A1').equals(new FormInstanceKey('log', 'a1')));
  assert.ok(!new FormInstanceKey('Log', 'A1').equals(new FormInstanceKey('Log', 'A2')));
  assert.ok(!new FormInstanceKey('Log').equals(null));

  const parsed = FormInstanceKey.parse('SampleEventLog#EVT-001');
  assert.equal(parsed.formName, 'SampleEventLog');
  assert.equal(parsed.instanceId, 'EVT-001');
  // No '#' means a non-repeatable form, whose instanceId IS its form name.
  assert.equal(FormInstanceKey.parse('SampleHeader').instanceId, 'SampleHeader');
  // An instanceId may itself contain '#'; only the FIRST one separates.
  assert.equal(FormInstanceKey.parse('Log#a#b').instanceId, 'a#b');
});

test('keyOf lower-cases the canonical map key', () => {
  assert.equal(keyOf(new FormInstanceKey('SampleEventLog', 'EVT-001')), 'sampleeventlog#evt-001');
});

test('reading or writing with no active form throws rather than silently writing nowhere', () => {
  const engine = new FormEngine();
  assert.throws(() => engine.getValue('A.B'), /no active form set/);
});

test('values round-trip case-insensitively and are isolated per form instance', () => {
  const engine = new FormEngine();
  const a = new FormInstanceKey('Log', 'A');
  const b = new FormInstanceKey('Log', 'B');

  engine.setActiveForm(a);
  engine.setValue('Log.Title', 'first');
  assert.equal(engine.getValue('log.title'), 'first');
  assert.equal(engine.getValue('LOG.TITLE'), 'first');

  engine.setActiveForm(b);
  assert.equal(engine.getValue('Log.Title'), undefined, 'instance B must not see instance A values');
  engine.setValue('Log.Title', 'second');

  engine.setActiveForm(a);
  assert.equal(engine.getValue('Log.Title'), 'first');
});

test('setActiveForm flushes the outgoing form\'s live control values first (§22 invariant 3)', () => {
  const engine = new FormEngine();
  const key = new FormInstanceKey('Header');
  engine.setActiveForm(key);

  // A control holding a value that was never committed through setValue — the
  // mid-edit case the flush exists for.
  const control = fakeControl('typed but not committed');
  engine.registerControl('Header.Title', control);

  engine.setActiveForm(new FormInstanceKey('Other'));
  assert.equal(engine.getFormState(key).fieldValues['header.title'], 'typed but not committed');
  assert.equal(engine.registeredControls.size, 0, 'registrations are cleared after the flush');
});

test('flushRegisteredControls captures live values WITHOUT tearing down registrations', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('Header'));
  const control = fakeControl('mid-edit');
  engine.registerControl('Header.Title', control);

  engine.flushRegisteredControls();
  assert.equal(engine.getValue('Header.Title'), 'mid-edit');
  assert.equal(engine.registeredControls.size, 1, 'Save XML must not lose registrations while flushing');
});

test('restoreActiveForm pushes stored values onto registered controls, and only those it has', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('Header'));
  engine.setValueSilently('Header.Title', 'stored');

  const titled = fakeControl('');
  const untouched = fakeControl('left alone');
  engine.registerControl('Header.Title', titled);
  engine.registerControl('Header.Other', untouched);

  engine.restoreActiveForm();
  assert.equal(titled.current, 'stored');
  assert.equal(untouched.current, 'left alone', 'a path with no stored value must not be blanked');
});

test('unregisterControlsUnderPath covers the path itself, dotted children and [i] indices', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  for (const path of ['F.List', 'F.List.Entry[0].Name', 'F.List[1].Name', 'F.ListOther.Name', 'F.Keep']) {
    engine.registerControl(path, fakeControl());
  }

  engine.unregisterControlsUnderPath('F.List');
  assert.deepEqual([...engine.registeredControls.keys()].sort(), ['f.keep', 'f.listother.name']);
});

test('setValueSilently does not fire controlValueChanged, setValue does', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  let events = 0;
  engine.addEventListener('controlValueChanged', () => events++);

  engine.setValueSilently('F.A', 1);
  assert.equal(events, 0, 'undo/redo replay must be able to write without re-triggering listeners');

  engine.setValue('F.A', 2);
  assert.equal(events, 1);
});

test('dirtyChanged fires only on an actual flip', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  const flips = [];
  engine.addEventListener('dirtyChanged', (e) => flips.push(e.detail.isDirty));

  engine.setDirty(false); // already false
  engine.setDirty(true);
  engine.setDirty(true); // no flip
  engine.setDirty(false);
  assert.deepEqual(flips, [true, false]);
});

test('the dirty flag is per form instance, not global', () => {
  const engine = new FormEngine();
  const a = new FormInstanceKey('Log', 'A');
  const b = new FormInstanceKey('Log', 'B');
  engine.setActiveForm(a);
  engine.setDirty(true);
  engine.setActiveForm(b);
  assert.equal(engine.isDirty, false);
  engine.setActiveForm(a);
  assert.equal(engine.isDirty, true);
});

test('snapshotUnderPathPrefix captures values under the prefix and nothing else', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  engine.setAllValues({
    'f.addr.street': '1 Main',
    'f.addr.city': 'Honolulu',
    'f.addrother.street': 'not this one',
    'f.name': 'keep',
  });
  engine.setRadioSelections({ 'f.addr.kindchoice': 'f.addr.kindchoice.option1', 'f.elsewhere': 'x' });

  const snapshot = engine.snapshotUnderPathPrefix('F.Addr');
  assert.deepEqual(Object.keys(snapshot.fieldValues).sort(), ['f.addr.city', 'f.addr.street']);
  assert.deepEqual(Object.keys(snapshot.radioSelections), ['f.addr.kindchoice']);
  // Deliberately NOT repeatingInstanceCounts — it is keyed by bare entry name,
  // not by path, so it cannot be scoped to a prefix (see the method's comment).
  assert.equal(snapshot.repeatingInstanceCounts, undefined);
});

test('purgeValuesUnderPathPrefix deletes values, radios AND counts under the prefix', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  engine.setAllValues({ 'f.list.entry[0].name': 'a', 'f.list.entry[1].name': 'b', 'f.listother': 'keep', 'f.name': 'keep' });
  engine.setRadioSelections({ 'f.list.entry[0].kindchoice': 'opt', 'f.keepchoice': 'opt' });
  engine.setRepeatingInstanceCount('F.List', 2);

  engine.purgeValuesUnderPathPrefix('F.List');
  const state = engine.getFormState(new FormInstanceKey('F'));
  assert.deepEqual(Object.keys(state.fieldValues).sort(), ['f.listother', 'f.name']);
  assert.deepEqual(Object.keys(state.radioSelections), ['f.keepchoice']);
  assert.deepEqual(Object.keys(state.repeatingInstanceCounts), []);
});

test('renamePathPrefix re-indexes a repeating instance down, leaving counts alone', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  engine.setAllValues({ 'f.list.entry[1].name': 'second', 'f.list.entry[1].reason': 'why', 'f.other': 'keep' });
  engine.setRadioSelections({ 'f.list.entry[1].kindchoice': 'opt' });
  engine.setRepeatingInstanceCount('Entry', 2);

  engine.renamePathPrefix('F.List.Entry[1]', 'F.List.Entry[0]');
  const state = engine.getFormState(new FormInstanceKey('F'));
  assert.equal(state.fieldValues['f.list.entry[0].name'], 'second');
  assert.equal(state.fieldValues['f.list.entry[0].reason'], 'why');
  assert.equal(state.fieldValues['f.list.entry[1].name'], undefined);
  assert.equal(state.radioSelections['f.list.entry[0].kindchoice'], 'opt');
  assert.equal(state.fieldValues['f.other'], 'keep');
  // Counts are keyed by bare entry name, so renumbering an instance must not touch them.
  assert.equal(state.repeatingInstanceCounts['entry'], 2);
});

test('renamePathPrefix is a no-op when the prefixes match case-insensitively', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  engine.setAllValues({ 'f.a.b': 'v' });
  engine.renamePathPrefix('F.A', 'f.a');
  assert.equal(engine.getValue('F.A.B'), 'v');
});

test('getAllFormStates returns a copy of the map (mutating it cannot corrupt the engine)', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  engine.setValue('F.A', 1);
  const copy = engine.getAllFormStates();
  copy.delete(keyOf(new FormInstanceKey('F')));
  assert.ok(engine.getFormState(new FormInstanceKey('F')), 'the engine keeps its own entry');
});

test('restoreFormState / purgeFormState / reset', () => {
  const engine = new FormEngine();
  const key = new FormInstanceKey('F');
  const state = createEmptyFormState();
  state.fieldValues['f.a'] = 'restored';

  engine.restoreFormState(key, state);
  engine.setActiveForm(key);
  assert.equal(engine.getValue('F.A'), 'restored');

  engine.purgeFormState(key);
  assert.equal(engine.getFormState(key), undefined);

  engine.setActiveForm(key);
  engine.setValue('F.A', 'x');
  engine.reset();
  assert.equal(engine.getAllFormStates().size, 0);
  assert.equal(engine.activeInstanceKey, null);
  assert.equal(engine.registeredControls.size, 0);
});

test('repeating instance counts default to 0 and are keyed case-insensitively', () => {
  const engine = new FormEngine();
  engine.setActiveForm(new FormInstanceKey('F'));
  assert.equal(engine.getRepeatingInstanceCount('Entry'), 0);
  engine.setRepeatingInstanceCount('Entry', 3);
  assert.equal(engine.getRepeatingInstanceCount('entry'), 3);
});
