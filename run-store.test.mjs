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

test('abandon settles cancelled/failed/quota runs cleanly, stays idempotent, and keeps setOutcome strict', t => {
  const store = open(t);
  store.begin(identity);
  assert.throws(() => store.setOutcome(identity, {...outcome, state: 'cancelled'}), /done, waiting, failed, or quota/i);
  assert.throws(() => store.abandon(identity, {state: 'done'}), /cancelled, failed, or quota/i);

  // Overwrites a previously declared pending outcome when abandoned before settlement.
  store.setOutcome(identity, outcome);
  const res = store.abandon(identity, {state: 'cancelled', message: 'Turn cancelled by coordinator.'});
  assert.equal(res.settled, true);
  assert.equal(res.run.settled, true);
  assert.equal(res.run.hostIdle, true);
  assert.equal(res.run.status, 'cancelled');
  assert.deepEqual(res.run.outcome, {
    state: 'cancelled', message: 'Turn cancelled by coordinator.', notify: [], waitFor: [],
  });
  assert.deepEqual(store.listPending(), []);
  assert.deepEqual(store.readJournal(identity.sessionId), [{
    turn: 4, status: 'cancelled', report: 'Turn cancelled by coordinator.', steps: [],
  }]);

  // Idempotent on already settled runs.
  const again = store.abandon(identity, {state: 'failed', message: 'Should not overwrite.'});
  assert.equal(again.settled, false);
  assert.deepEqual(again.run, res.run);
});

test('abandonPendingForMember settles only unsettled runs for the matching team and member', t => {
  const store = open(t);
  const id1 = {...identity, turn: 1, requestId: 'req-1'};
  const id2 = {...identity, turn: 2, requestId: 'req-2'};
  const settledId = {...identity, turn: 3, requestId: 'req-3'};
  const otherMember = {...identity, member: 'reviewer', turn: 1, requestId: 'req-rev', sessionId: 'session-rev'};

  store.begin(id1);
  store.begin(id2);
  store.begin(settledId);
  store.setOutcome(settledId, outcome);
  store.patch(settledId, terminal);
  store.finish(settledId);
  store.begin(otherMember);

  const settled = store.abandonPendingForMember(identity.teamId, identity.member, {
    state: 'failed', message: 'Dismissed stale runs.',
  });
  assert.equal(settled.length, 2);
  assert.deepEqual(settled.map(r => [r.turn, r.status, r.settled]), [
    [1, 'failed', true],
    [2, 'failed', true],
  ]);
  assert.deepEqual(store.listPending().map(r => r.member), ['reviewer']);
  assert.deepEqual(store.abandonPendingForMember(identity.teamId, identity.member), []);
});

test('RunStore safely migrates legacy runs.sqlite tables lacking cancelled settlement CHECK', async t => {
  const {DatabaseSync} = await import('node:sqlite');
  const {filename, cleanup} = disk(t);
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE run_sessions (
        session_id TEXT PRIMARY KEY NOT NULL,
        team_id TEXT NOT NULL,
        member TEXT NOT NULL,
        UNIQUE (session_id, team_id, member)
      ) STRICT;
      CREATE TABLE runs (
        request_id TEXT PRIMARY KEY NOT NULL,
        team_id TEXT NOT NULL,
        member TEXT NOT NULL,
        turn INTEGER NOT NULL CHECK (turn > 0),
        session_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        accepted_seq INTEGER NOT NULL DEFAULT 0 CHECK (accepted_seq >= 0),
        claim_seq INTEGER NOT NULL DEFAULT 0 CHECK (claim_seq >= 0),
        turn_end_seq INTEGER NOT NULL DEFAULT 0 CHECK (turn_end_seq >= 0),
        host_idle INTEGER NOT NULL DEFAULT 0 CHECK (host_idle IN (0, 1)),
        outcome TEXT,
        steps TEXT NOT NULL DEFAULT '[]',
        settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
        UNIQUE (team_id, member, turn),
        FOREIGN KEY (session_id, team_id, member) REFERENCES run_sessions (session_id, team_id, member),
        CHECK (settled = 0 OR (outcome IS NOT NULL AND claim_seq > 0 AND turn_end_seq >= claim_seq AND host_idle = 1))
      ) STRICT;
      INSERT INTO run_sessions VALUES ('session-1', 'team-1', 'builder');
      INSERT INTO runs (request_id, team_id, member, turn, session_id, workspace, settled)
        VALUES ('request-4', 'team-1', 'builder', 4, 'session-1', '/work/project', 0);
    `);
    legacy.close();

    const migrated = new RunStore(filename);
    try {
      const settled = migrated.abandon(identity, {state: 'cancelled', message: 'Migrated cancel.'});
      assert.equal(settled.settled, true);
      assert.equal(settled.run.status, 'cancelled');
      assert.deepEqual(migrated.listPending(), []);
    } finally {
      migrated.close();
    }
  } finally {
    cleanup();
  }
});
