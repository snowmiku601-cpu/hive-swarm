import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RunStore } from './run-store.mjs';

const identity = {
  teamId: 'team-1', member: 'builder', turn: 4, requestId: 'request-4',
  sessionId: 'session-1', workspace: '/work/project',
};
const outcome = {state: 'done', message: 'Finished safely.', notify: ['coordinator'], waitFor: []};
const terminal = {acceptedSeq: 2, claimSeq: 3, turnEndSeq: 4, hostIdle: true};

test('an empty outcome cannot become immutable settlement evidence', t => {
  const store = open(t);
  store.begin(identity);
  assert.throws(() => store.setOutcome(identity, {...outcome, message: '   '}), /message|text/i);
  assert.equal(store.read(identity).outcome, null);
  store.setOutcome(identity, outcome);
  assert.equal(store.read(identity).outcome.message, 'Finished safely.');
});

function open(t, filename = ':memory:') {
  const store = new RunStore(filename);
  t.after(() => store.close());
  return store;
}

function disk(t) {
  const scratch = fileURLToPath(new URL('./.tmp/', import.meta.url));
  mkdirSync(scratch, {recursive: true});
  const directory = mkdtempSync(join(scratch, 'run-store '));
  const filename = join(directory, 'runs.sqlite');
  // Register cleanup after opening any connections to allow file removal on Windows.
  return {filename, cleanup: () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, {force: true});
    rmdirSync(directory);
  }};
}

test('admits one immutable run per request and team/member turn', t => {
  const store = open(t);
  const run = store.begin(identity);
  assert.equal(run.status, 'pending');
  assert.equal(run.settled, false);
  assert.deepEqual(run.steps, []);
  assert.deepEqual(store.begin(identity), run);
  assert.deepEqual(store.listPending(), [run]);

  for (const different of [
    {requestId: 'another-request'}, {sessionId: 'another-session'}, {workspace: '/work/other'},
    {turn: 5}, {teamId: 'other-team', turn: 5, sessionId: 'other-team-session'},
  ]) {
    assert.throws(() => store.begin({...identity, ...different}), /conflict|identity/i);
  }
  assert.deepEqual(store.read(identity), run);
  assert.equal(store.findSession('other-team-session'), null);
  assert.equal(store.read({...identity, turn: 999}), null);
});

test('admits a session only for its owning team and member', t => {
  const store = open(t);
  const later = store.begin({...identity, turn: 8, requestId: 'request-8'});
  store.begin(identity);
  assert.throws(() => store.begin({...identity, turn: 9, requestId: 'request-9', member: 'reviewer'}), /session|owner/i);
  assert.throws(() => store.begin({...identity, teamId: 'team-2', requestId: 'team-2-request'}), /session|owner/i);
  assert.deepEqual(store.findSession(identity.sessionId), later);
  assert.deepEqual(store.readJournal('unknown-session'), []);
});

test('persists admission, evidence, outcome and settlement across SQLite connections', t => {
  const {filename, cleanup} = disk(t);
  try {
    const writer = new RunStore(filename);
    let pending;
    try {
      writer.begin(identity);
      writer.patch(identity, terminal);
      writer.appendStep(identity, {kind: 'tool', label: 'Tested change', time: '2026-11-20T10:30:00.000Z'});
      writer.setOutcome(identity, outcome);
      pending = writer.read(identity);
    } finally {
      writer.close();
    }

    const first = new RunStore(filename);
    try {
      const second = new RunStore(filename);
      try {
        assert.deepEqual(first.listPending(), [pending]);
        assert.deepEqual(first.begin(identity), pending);
        assert.deepEqual(first.read(identity).outcome, outcome);
        for (const [key, value] of Object.entries(terminal)) assert.equal(first.read(identity)[key], value);
        const finished = first.finish(identity);
        assert.equal(finished.settled, true);
        assert.deepEqual(second.finish(identity), {settled: false, run: finished.run});
        assert.deepEqual(second.listPending(), []);
        assert.deepEqual(second.readJournal(identity.sessionId), [{
          turn: 4,
          status: 'done',
          report: 'Finished safely.',
          steps: [{kind: 'tool', label: 'Tested change', time: '2026-11-20T10:30:00.000Z'}],
        }]);
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  } finally {
    cleanup();
  }
});

test('refuses changes through an unknown or mismatched identity', t => {
  const store = open(t);
  const before = store.begin(identity);
  for (const identityChange of [
    {teamId: 'other-team'}, {member: 'reviewer'}, {turn: 8}, {requestId: 'foreign'},
    {sessionId: 'foreign'}, {workspace: '/work/foreign'},
  ]) {
    const wrong = {...identity, ...identityChange};
    assert.equal(store.read(wrong), null);
    assert.throws(() => store.patch(wrong, {acceptedSeq: 1}), /identity|run|found/i);
    assert.throws(() => store.setOutcome(wrong, outcome), /identity|run|found/i);
    assert.throws(() => store.appendStep(wrong, {kind: 'turn', label: 'Foreign step'}), /identity|run|found/i);
    assert.throws(() => store.finish(wrong), /identity|run|found/i);
  }
  assert.deepEqual(store.listPending(), [before]);
});

test('rejects invalid or backward sequence evidence without writing any part of the patch', t => {
  const store = open(t);
  store.begin(identity);
  store.patch(identity, {acceptedSeq: 4});
  assert.throws(() => store.patch(identity, {claimSeq: 3}), /sequence|claim/i);
  assert.throws(() => store.patch(identity, {acceptedSeq: 6, turnEndSeq: 5}), /sequence|turn-end/i);
  store.patch(identity, {claimSeq: 5, turnEndSeq: 6});
  const before = store.read(identity);
  for (const patch of [
    {acceptedSeq: 3}, {claimSeq: 4}, {turnEndSeq: 5}, {claimSeq: 7},
    {acceptedSeq: 0}, {claimSeq: -1}, {turnEndSeq: 6.5}, {claimSeq: '6'},
    {hostIdle: 1}, {hostIdle: true, rawToolArgs: {secret: 'Do not write'}},
  ]) {
    assert.throws(() => store.patch(identity, patch));
    assert.deepEqual(store.read(identity), before);
  }
  assert.deepEqual(store.patch(identity, {acceptedSeq: 4, claimSeq: 5, turnEndSeq: 6}), before);
});

test('cannot settle before the matching outcome, claim, end and current idle evidence arrive', t => {
  const store = open(t);
  const {teamId, member, turn, requestId} = store.begin(identity);
  const key = {teamId, member, turn, requestId};
  store.patch(key, {acceptedSeq: 2, hostIdle: true});
  assert.throws(() => store.finish(key), /outcome/i);
  store.setOutcome(key, {state: 'waiting', message: 'Waiting for review.', waitFor: ['reviewer']});
  assert.throws(() => store.finish(key), /claim/i);
  store.patch(key, {claimSeq: 3});
  assert.throws(() => store.finish(key), /turn|end/i);
  store.patch(key, {turnEndSeq: 3});
  assert.throws(() => store.finish(key), /idle|active/i);
  assert.equal(store.readJournal(identity.sessionId)[0].report, null);
  store.patch(key, {hostIdle: true});
  store.patch(key, {hostIdle: false});
  assert.throws(() => store.finish(key), /idle|active/i);
  store.patch(key, {hostIdle: true});
  const finished = store.finish(key);
  assert.equal(finished.settled, true);
  assert.equal(finished.run.status, 'waiting');
  assert.deepEqual(finished.run.outcome.waitFor, ['reviewer']);
  assert.throws(() => store.patch(key, {claimSeq: 10}), /settled/i);
  assert.throws(() => store.setOutcome(key, outcome), /settled/i);
  assert.throws(() => store.appendStep(key, {kind: 'tool', label: 'Late step'}), /settled/i);
  assert.deepEqual(store.begin(identity), finished.run);
});

test('a durable declaration can be replayed but a conflicting declaration cannot replace it', t => {
  const store = open(t);
  store.begin(identity);
  for (const invalid of [{state: 'unknown'}, {notify: ['coordinator', {credential: 'secret'}]}, {waitFor: Array(1)}]) {
    assert.throws(() => store.setOutcome(identity, {...outcome, ...invalid}));
  }
  assert.equal(store.read(identity).outcome, null);
  const pending = store.setOutcome(identity, outcome);
  assert.deepEqual(store.setOutcome(identity, outcome), pending);
  assert.throws(() => store.setOutcome(identity, {...outcome, state: 'quota'}), /outcome/i);
  assert.deepEqual(store.read(identity), pending);
});

test('bounds stored journal content and omits unknown fields from the actual database', t => {
  const {filename, cleanup} = disk(t);
  const secret = 'PRIVATE_FIXTURE_DO_NOT_PERSIST';
  try {
    const store = new RunStore(filename);
    try {
      store.begin({...identity, rawPrompt: secret, credentials: {apiKey: secret}});
      assert.throws(() => store.appendStep(identity, {kind: 'tool', label: 'x'.repeat(121)}), /label/i);
      assert.throws(() => store.appendStep(identity, {kind: 'tool', label: 'safe', detail: 'x'.repeat(181)}), /detail/i);
      assert.throws(() => store.setOutcome(identity, {...outcome, message: 'x'.repeat(6001)}), /report|message/i);
      for (let index = 1; index <= 12; index += 1) {
        store.appendStep(identity, {
          kind: 'tool', label: ('Step ' + index).padEnd(120, '.'), detail: 'd'.repeat(180),
          rawToolArgs: {credential: secret},
        });
      }
      store.setOutcome(identity, {...outcome, state: 'failed', message: 'm'.repeat(6000), rawPrompt: secret});
      store.patch(identity, terminal);
      store.finish(identity);
      const [turn] = store.readJournal(identity.sessionId);
      assert.equal(turn.status, 'failed');
      assert.equal(turn.report.length, 6000);
      assert.equal(turn.steps.length, 10);
      assert.equal(turn.steps[0].label, 'Step 3'.padEnd(120, '.'));
      assert.equal(turn.steps.at(-1).label, 'Step 12'.padEnd(120, '.'));
      assert.equal(turn.steps.at(-1).detail.length, 180);
      assert.doesNotMatch(JSON.stringify(store.read(identity)), /PRIVATE_FIXTURE|rawPrompt|rawToolArgs|credentials/i);
    } finally {
      store.close();
    }
    assert.equal(readFileSync(filename).includes(secret), false);
  } finally {
    cleanup();
  }
});

test('journal returns the most recent turns in turn order, with a maximum of thirty', t => {
  const store = open(t);
  for (let turn = 32; turn >= 1; turn -= 1) {
    store.begin({...identity, turn, requestId: 'request-' + turn});
  }
  const latest = store.findSession(identity.sessionId);
  store.setOutcome(latest, {...outcome, state: 'quota'});
  store.patch(latest, terminal);
  store.finish(latest);
  assert.deepEqual(store.readJournal(identity.sessionId).map(entry => entry.turn), Array.from({length: 30}, (_, i) => i + 3));
  const page = store.readJournal(identity.sessionId, {limit: 2});
  assert.deepEqual(page.map(entry => [entry.turn, entry.status]), [[31, 'pending'], [32, 'quota']]);
  assert.throws(() => store.readJournal(identity.sessionId, {limit: 31}), /limit/i);
});
