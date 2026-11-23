import { DatabaseSync } from 'node:sqlite';

const states = new Set(['done', 'waiting', 'failed', 'quota']);
const abandonStates = new Set(['cancelled', 'failed', 'quota']);
const sequences = ['acceptedSeq', 'claimSeq', 'turnEndSeq'];
const evidenceFields = new Set([...sequences, 'hostIdle']);
const stepLimit = 10;
const journalLimit = 30;
const runsTableSql = name => `CREATE TABLE IF NOT EXISTS ${name} (
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
  CHECK (settled = 0 OR (outcome IS NOT NULL AND ((claim_seq > 0 AND turn_end_seq >= claim_seq AND host_idle = 1) OR json_extract(outcome, '$.state') IN ('cancelled', 'failed', 'quota'))))
) STRICT`;

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(name + ' must be an object.');
  }
  return value;
}

function text(value, name, limit, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') ||
      !value.isWellFormed() || (!allowEmpty && !value.trim())) {
    throw new TypeError(name + ' must be text of ' + (allowEmpty ? 'at most ' : '1 to ') + limit + ' characters.');
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + ' must be a positive safe integer.');
  return value;
}

function keys(value) {
  const {teamId, member, turn, requestId} = record(value, 'Run identity');
  return [text(teamId, 'Team ID', 256), text(member, 'Member', 120),
    positiveInteger(turn, 'Turn'), text(requestId, 'Request ID', 256)];
}

function targets(value = [], name) {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError(name + ' must be a list of at most 100 names.');
  return Array.from(value, nameValue => text(nameValue, name + ' entry', 120));
}

function toRun(row) {
  if (!row) return null;
  const outcome = JSON.parse(row.outcome);
  return {
    teamId: row.team_id, member: row.member, turn: row.turn, requestId: row.request_id,
    sessionId: row.session_id, workspace: row.workspace,
    acceptedSeq: row.accepted_seq, claimSeq: row.claim_seq, turnEndSeq: row.turn_end_seq, hostIdle: row.host_idle === 1,
    outcome, settled: row.settled === 1, status: row.settled ? outcome.state : 'pending',
    steps: JSON.parse(row.steps),
  };
}

// Stores only Hive's evidence. The host correlates events and TeamBoard settles the scheduler turn.
export class RunStore {
  #db;
  #sql;
  #closed = false;

  constructor(filename = ':memory:') {
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS run_sessions (
          session_id TEXT PRIMARY KEY NOT NULL,
          team_id TEXT NOT NULL,
          member TEXT NOT NULL,
          UNIQUE (session_id, team_id, member)
        ) STRICT;
        ${runsTableSql('runs')};
        CREATE INDEX IF NOT EXISTS runs_session_turn ON runs (session_id, turn);
      `);
      const schema = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
      if (schema?.sql && !schema.sql.includes("'cancelled'")) {
        this.#db.exec('PRAGMA foreign_keys = OFF');
        try {
          this.#transaction(() => {
            const current = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
            if (!current?.sql || current.sql.includes("'cancelled'")) return;
            this.#db.exec(`
              DROP TABLE IF EXISTS runs_v2;
              ${runsTableSql('runs_v2')};
              INSERT INTO runs_v2 (
                request_id, team_id, member, turn, session_id, workspace,
                accepted_seq, claim_seq, turn_end_seq, host_idle, outcome, steps, settled
              )
              SELECT
                request_id, team_id, member, turn, session_id, workspace,
                accepted_seq, claim_seq, turn_end_seq, host_idle, outcome, steps, settled
              FROM runs;
              DROP TABLE runs;
              ALTER TABLE runs_v2 RENAME TO runs;
              CREATE INDEX IF NOT EXISTS runs_session_turn ON runs (session_id, turn);
            `);
          });
        } finally {
          this.#db.exec('PRAGMA foreign_keys = ON');
        }
      }
      const prepare = sql => this.#db.prepare(sql);
      this.#sql = {
        run: prepare('SELECT * FROM runs WHERE team_id = ? AND member = ? AND turn = ? AND request_id = ?'),
        conflict: prepare('SELECT 1 FROM runs WHERE request_id = ? OR (team_id = ? AND member = ? AND turn = ?)'),
        owner: prepare('SELECT team_id, member FROM run_sessions WHERE session_id = ?'),
        admitSession: prepare('INSERT INTO run_sessions (session_id, team_id, member) VALUES (?, ?, ?)'),
        admitRun: prepare('INSERT INTO runs (team_id, member, turn, request_id, session_id, workspace) VALUES (?, ?, ?, ?, ?, ?)'),
        latest: prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY turn DESC LIMIT 1'),
        pending: prepare('SELECT * FROM runs WHERE settled = 0 ORDER BY rowid'),
        pendingForMember: prepare('SELECT * FROM runs WHERE team_id = ? AND member = ? AND settled = 0 ORDER BY rowid'),
        evidence: prepare('UPDATE runs SET accepted_seq = ?, claim_seq = ?, turn_end_seq = ?, host_idle = ? WHERE request_id = ?'),
        outcome: prepare('UPDATE runs SET outcome = ? WHERE request_id = ?'),
        steps: prepare('UPDATE runs SET steps = ? WHERE request_id = ?'),
        finish: prepare('UPDATE runs SET settled = 1 WHERE request_id = ? AND settled = 0'),
        abandon: prepare('UPDATE runs SET outcome = ?, host_idle = 1, settled = 1 WHERE request_id = ? AND settled = 0'),
        journal: prepare('SELECT turn, settled, outcome, steps FROM runs WHERE session_id = ? ORDER BY turn DESC LIMIT ?'),
      };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #transaction(action) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  #change(identity, update, {allowSettled = false} = {}) {
    return this.#transaction(() => {
      const run = this.read(identity);
      if (!run) throw new Error('Run identity not found.');
      if (run.settled && !allowSettled) throw new Error('Run is already settled.');
      return update(run);
    });
  }

  begin(input) {
    const identity = keys(input);
    const [teamId, member, turn, requestId] = identity;
    const sessionId = text(input.sessionId, 'Session ID', 256);
    const workspace = text(input.workspace, 'Workspace', 4096);
    return this.#transaction(() => {
      const existing = this.#sql.run.get(...identity);
      if (existing?.session_id === sessionId && existing.workspace === workspace) return toRun(existing);
      if (existing || this.#sql.conflict.get(requestId, teamId, member, turn)) {
        throw new Error('Run identity conflict: request or team/member turn is already admitted.');
      }
      const owner = this.#sql.owner.get(sessionId);
      if (owner && (owner.team_id !== teamId || owner.member !== member)) {
        throw new Error('Session is already owned by another team or member.');
      }
      if (!owner) this.#sql.admitSession.run(sessionId, teamId, member);
      this.#sql.admitRun.run(...identity, sessionId, workspace);
      return toRun(this.#sql.run.get(...identity));
    });
  }

  read(identity) {
    const key = keys(identity);
    const {sessionId, workspace} = identity;
    const row = this.#sql.run.get(...key);
    if (!row || (sessionId !== undefined && sessionId !== row.session_id) ||
        (workspace !== undefined && workspace !== row.workspace)) return null;
    return toRun(row);
  }

  findSession(sessionId) {
    return toRun(this.#sql.latest.get(text(sessionId, 'Session ID', 256)));
  }

  listPending() {
    return this.#sql.pending.all().map(toRun);
  }

  patch(identity, input = {}) {
    const fields = Reflect.ownKeys(record(input, 'Evidence patch'));
    if (fields.some(field => !evidenceFields.has(field))) throw new Error('Unknown evidence patch field.');
    const patch = {};
    for (const key of fields) {
      const value = input[key];
      if (value === undefined) continue;
      if (key === 'hostIdle') {
        if (typeof value !== 'boolean') throw new TypeError('hostIdle must be a boolean.');
        patch.hostIdle = value;
      } else {
        patch[key] = positiveInteger(value, key);
      }
    }
    return this.#change(identity, run => {
      let advanced = false;
      for (const key of sequences) {
        if (!Object.hasOwn(patch, key)) continue;
        if (patch[key] < run[key]) throw new Error(key + ' cannot roll back sequence evidence.');
        if (patch[key] > run[key]) advanced = true;
        run[key] = patch[key];
      }
      const {acceptedSeq, claimSeq, turnEndSeq} = run;
      if (claimSeq && claimSeq < acceptedSeq) throw new Error('Claim sequence cannot precede acceptance.');
      if (turnEndSeq && turnEndSeq < Math.max(claimSeq, acceptedSeq)) {
        throw new Error('Turn-end sequence cannot precede acceptance or claim.');
      }
      // An idle observation belongs to the evidence available when it was made.
      run.hostIdle = patch.hostIdle ?? (advanced ? false : run.hostIdle);
      this.#sql.evidence.run(acceptedSeq, claimSeq, turnEndSeq, Number(run.hostIdle), run.requestId);
      return run;
    });
  }

  setOutcome(identity, input) {
    const {state, message = '', notify, waitFor} = record(input, 'Outcome');
    if (!states.has(state)) throw new Error('Outcome state must be done, waiting, failed, or quota.');
    const outcome = {state, message: text(message, 'Outcome message', 6000),
      notify: targets(notify, 'Notify'), waitFor: targets(waitFor, 'Wait-for')};
    const encoded = JSON.stringify(outcome);
    return this.#change(identity, run => {
      if (run.outcome) {
        if (JSON.stringify(run.outcome) !== encoded) throw new Error('A different pending outcome already exists.');
        return run;
      }
      this.#sql.outcome.run(encoded, run.requestId);
      return {...run, outcome};
    });
  }

  appendStep(identity, input) {
    const {kind, label, detail, time} = record(input, 'Journal step');
    const step = {kind: text(kind, 'Step kind', 60), label: text(label, 'Step label', 120),
      ...(detail == null ? {} : {detail: text(detail, 'Step detail', 180, true)}),
      time: time === undefined ? new Date().toISOString() : text(time, 'Step time', 80)};
    return this.#change(identity, run => {
      const steps = [...run.steps, step].slice(-stepLimit);
      this.#sql.steps.run(JSON.stringify(steps), run.requestId);
      return {...run, steps};
    });
  }

  finish(identity) {
    return this.#change(identity, run => {
      if (run.settled) return {settled: false, run};
      if (!run.outcome) throw new Error('Cannot settle without a pending outcome.');
      if (run.claimSeq < 1) throw new Error('Cannot settle without claim evidence.');
      if (run.turnEndSeq < run.claimSeq) throw new Error('Cannot settle before the claimed turn ends.');
      if (!run.hostIdle) throw new Error('Cannot settle while the host is active.');
      this.#sql.finish.run(run.requestId);
      return {settled: true, run: {...run, settled: true, status: run.outcome.state}};
    }, {allowSettled: true});
  }

  /** Settle an interrupted, failed, or quota-blocked run without waiting for turn_end_seq. */
  abandon(identity, {state = 'cancelled', message = 'Cancelled.'} = {}) {
    if (!abandonStates.has(state)) throw new Error('Abandon state must be cancelled, failed, or quota.');
    const outcome = {state, message: text(message, 'Outcome message', 6000), notify: [], waitFor: []};
    const encoded = JSON.stringify(outcome);
    return this.#change(identity, run => {
      if (run.settled) return {settled: false, run};
      this.#sql.abandon.run(encoded, run.requestId);
      return {settled: true, run: {...run, outcome, hostIdle: true, settled: true, status: state}};
    }, {allowSettled: true});
  }

  /** Settle all unsettled runs belonging to a team member (e.g. on cancel or dismiss recovery). */
  abandonPendingForMember(teamId, member, {state = 'cancelled', message = 'Resolved.'} = {}) {
    const cleanTeam = text(teamId, 'Team ID', 256);
    const cleanMember = text(member, 'Member', 120);
    if (!abandonStates.has(state)) throw new Error('Abandon state must be cancelled, failed, or quota.');
    const outcome = {state, message: text(message, 'Outcome message', 6000), notify: [], waitFor: []};
    const encoded = JSON.stringify(outcome);
    return this.#transaction(() => {
      const rows = this.#sql.pendingForMember.all(cleanTeam, cleanMember);
      if (!rows.length) return [];
      return rows.map(row => {
        const run = toRun(row);
        this.#sql.abandon.run(encoded, run.requestId);
        return {...run, outcome, hostIdle: true, settled: true, status: state};
      });
    });
  }

  readJournal(sessionId, {limit = journalLimit} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > journalLimit) {
      throw new RangeError('Journal limit must be between 1 and ' + journalLimit + '.');
    }
    return this.#sql.journal.all(text(sessionId, 'Session ID', 256), limit).reverse().map(row => {
      const outcome = row.settled ? JSON.parse(row.outcome) : null;
      return {turn: row.turn, status: outcome?.state ?? 'pending',
        report: outcome?.message ?? null, steps: JSON.parse(row.steps)};
    });
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
