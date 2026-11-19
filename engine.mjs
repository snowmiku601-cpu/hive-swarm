import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(label + ' must contain 1–' + max + ' characters.');
  }
  return value.trim();
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
  }
  return value;
}

const reserved = new Set(['all', 'coordinator', 'system', 'user']);
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const workerLimit = 12;
const main = {name:'main',archived:false};
const wakePhases = new Set(['done','stalled','budget','paused','retired']);
const hostEnvironmentVariables = [
  'CODEX_WINDOWS_REGISTERED_CORE',
  'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
  'CODEX_WINDOWS_SANDBOX_PROXY_PORTS',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_SANDBOX_LAUNCH_COUNT',
  'CODEX_SANDBOX_LAUNCH_BYTES',
  'CODEX_THREAD_ID',
  'CODEX_TOOL_CALL_ID',
  'CODEX_SESSION_ID',
  'CODEX_DAEMON_SHUTDOWN_FILE',
  'CODEX_DAEMON_SHUTDOWN_SOCKET',
  'CODEX_DAEMON_TELEMETRY_HANDOFF',
];

/**
 * Copy a process environment without parent Codex session or Windows MSIX
 * package-identity markers so standalone daemons and worker runtimes can spawn
 * their own sandboxes outside the Desktop package container.
 */
export function childEnvironment(base = process.env) {
  const env = {...base};
  for (const name of hostEnvironmentVariables) delete env[name];
  return env;
}

export function boardWaitTimeout(value) {
  return integer(value??45,1,55,'Wait timeout');
}

function reasoningEffort(value) {
  if (value == null) return undefined;
  if (!efforts.has(value)) throw Error('Unrecognized reasoning effort.');
  return value;
}

export function configuredEffort(team, member) {
  return member.effort === null ? undefined : member.effort ?? team.effort;
}

function memberLabel(value, label) {
  const name = text(value, label, 30);
  if (!/^[a-z][a-z0-9_-]*$/.test(name) || reserved.has(name)) {
    throw Error(label + ' must be a lowercase name such as builder or reviewers.');
  }
  return name;
}

function channelName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(value)) {
    throw Error('Channel must be a lowercase name of at most 30 characters.');
  }
  return value;
}

function openChannel(team, value) {
  const name = channelName(value);
  const channel = team.channels.find(entry=>entry.name===name);
  if (!channel) throw Error('Channel not found: #'+name);
  if (channel.archived) throw Error('Channel is archived: #'+name);
  return channel;
}

function subscriptions(team, values) {
  if (!Array.isArray(values)) throw Error('Channels must be a list of channel names.');
  return [...new Set(values.map(name=>openChannel(team,name).name))].filter(name=>name!=='main');
}

function postingChannel(team, member, requested) {
  if (requested != null) return openChannel(team,requested).name;
  return member?.channels.find(name=>team.channels.some(channel=>channel.name===name&&!channel.archived))??'main';
}

function addressesIn(body,names) {
  const mentions = [...body.matchAll(/(?:^|[^a-z0-9_])@(#?[a-z][a-z0-9_-]*)/gi)].map(match=>match[1].toLowerCase());
  return new Set([...names,...mentions]);
}

export function visibleChannels(member) {
  return member && member.role !== 'coordinator' ? ['main',...member.channels] : null;
}

function expandMember(spec, replaces) {
  if (!spec || typeof spec !== 'object') throw Error('Member details are required.');
  if (spec.n === undefined && spec.tasks === undefined) return [newMember(spec)];
  if (replaces != null) throw Error('A sharded invite cannot use replaces.');
  if (spec.n !== undefined && spec.tasks !== undefined) throw Error('Choose either n or tasks.');
  const name = memberLabel(spec.name,'Shard name');
  const brief = text(spec.brief,'Member brief',4000);
  let notes;
  if (spec.tasks !== undefined) {
    if (!Array.isArray(spec.tasks)) throw Error('Shard tasks must be an array.');
    integer(spec.tasks.length,2,8,'Shard tasks');
    notes=spec.tasks.map(task=>'\n\nAssigned slice: '+text(task,'Assigned slice',4000));
  } else notes=Array(integer(spec.n,2,8,'Shard count')).fill('');
  return notes.map((note,index)=>newMember({...spec,name:name+'-'+(index+1),group:name,brief:brief+note}));
}

function newMember(spec) {
  if (!spec || typeof spec !== 'object') throw Error('Member details are required.');
  const waitFor = spec.waitFor ?? [];
  if (!Array.isArray(waitFor)) throw Error('waitFor must be a list of member names.');
  return {
    name: memberLabel(spec.name, 'Member name'),
    group: spec.group == null ? undefined : memberLabel(spec.group, 'Group name'),
    brief: text(spec.brief, 'Member brief', 4000),
    model: spec.model == null ? undefined : text(spec.model, 'Model', 100),
    effort: reasoningEffort(spec.effort),
    writable: spec.writable === true, worktree: spec.worktree === true,
    waitFor: [...new Set(waitFor)],channels:spec.channels ?? [],
    status: waitFor.length ? 'waiting' : 'queued', threadId: null, inbox: [], completed: 0,
  };
}

function activeMember(member) {
  return member.status !== 'retired' && !member.retireAfterTurn;
}

function isWorker(member) {
  return member.role !== 'coordinator';
}

function authorizeMemberChange(actor, member) {
  if (actor && actor.role !== 'coordinator' && actor !== member && member.addedBy !== actor.name) {
    throw Error('Workers can manage only themselves and their own helpers.');
  }
}

function pendingDependency(member, dependency) {
  return member.waitFor.includes(dependency.name) &&
    (dependency.completed ?? 0) <= (member.waitAfter?.[dependency.name] ?? 0);
}

function validateRoster(members) {
  const names = new Set(members.map(member => member.name));
  if (names.size !== members.length) throw Error('Member names must be unique, including retired members.');
  if (members.some(member => names.has(member.group))) throw Error('Groups and members must have distinct names.');
}

function validateDependencies(members, roots) {
  const roster = new Map(members.map(member => [member.name, member]));
  const visiting = new Set();
  const settled = new Set();
  function visit(member) {
    if (settled.has(member.name)) return;
    if (visiting.has(member.name)) throw Error('Dependencies cannot create a cycle.');
    visiting.add(member.name);
    for (const name of member.waitFor) {
      const dependency = roster.get(name);
      if (!dependency) throw Error('Dependency must refer to a member: @' + name);
      if (pendingDependency(member, dependency)) visit(dependency);
    }
    visiting.delete(member.name);
    settled.add(member.name);
  }
  for (const member of roots) visit(member);
}

function retire(member) {
  member.status = 'retired';
  member.waitFor = [];
  delete member.retireAfterTurn;
}

function numberPosts(team) {
  let seq = 0;
  for (const event of team.events) {
    event.seq ??= seq + 1;
    seq = event.seq;
  }
  return team;
}

function restore(team) {
  numberPosts(team);
  team.channels ??= [{...main}];
  for (const member of team.members) member.channels ??= [];
  delete team.overview;
  const removed = new Set(team.members.filter(member=>member.role==='narrator').map(member=>member.name));
  if (removed.size) {
    team.members = team.members.filter(member=>!removed.has(member.name));
    for (const member of team.members) {
      if (!member.waitFor.some(name=>removed.has(name))) continue;
      member.waitFor = member.waitFor.filter(name=>!removed.has(name));
      if (member.status==='waiting' && !member.waitFor.length) member.status='queued';
    }
  }
  return team;
}

function enqueue(member, event, addressed = false) {
  const {seq, author, text, channel} = event;
  member.inbox.push({seq, author, text, ...(channel && channel!=='main'?{channel}:{}),
    ...(addressed ? {addressed:true} : {})});
  if (member.inbox.length > 24) member.inbox.shift();
}

export function extractReportMessage(output) {
  // Match complete JSON string characters, even if the closing quote has not streamed yet.
  const fields = output.matchAll(/[,{]\s*"message"\s*:\s*"((?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*)/g);
  let message;
  for (const [, encoded] of fields) message = JSON.parse('"'+encoded+'"');
  return message;
}

function completedWorkerRound(workers) {
  if (!workers.length || workers.some(worker => worker.status !== 'done')) return null;
  return workers.map(worker => worker.name + ':' + worker.completed).join(',');
}

export function teamPhase(team) {
  if (team.paused) return 'paused';
  const members = team.members.filter(member => member.status !== 'retired');
  if (!members.length && team.members.length) return 'retired';
  const coordinator = members.find(member => member.role === 'coordinator');
  const round = coordinator && completedWorkerRound(members.filter(isWorker));
  const summaryPending = round && coordinator.lastRound !== round;
  if (!summaryPending && members.every(member => member.status === 'done' ||
    (member === coordinator && member.status === 'waiting' && !member.waitFor.length))) return 'done';
  if (members.some(member => member.status === 'working')) return 'working';
  if (team.turns >= team.turnLimit) return 'budget';
  if (members.some(member => member.status === 'queued')) return 'queued';
  return 'stalled';
}

export class TeamBoard {
  constructor(filename, runTurn) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (
        team_id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (team_id, seq)
      );
    `);
    this.read = this.db.prepare('SELECT value FROM teams WHERE id = ?');
    this.write = this.db.prepare('INSERT INTO teams VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value');
    this.writePost = this.db.prepare('INSERT INTO posts VALUES (?, ?, ?) ON CONFLICT(team_id,seq) DO NOTHING');
    this.bounds = this.db.prepare('SELECT coalesce(min(seq),0) AS earliest, coalesce(max(seq),0) AS head FROM posts WHERE team_id = ?');
    const filter = " AND (? IS NULL OR COALESCE(json_extract(posts.value,'$.channel'),'main') IN (SELECT value FROM json_each(?)))" +
      " AND (?=0 OR json_extract(posts.value,'$.coordinatorMention')=1 OR json_extract(posts.value,'$.broadcast')=1" +
      " OR EXISTS(SELECT 1 FROM json_each(posts.value,'$.targets') WHERE value='coordinator'))";
    this.postPage = this.db.prepare('SELECT value FROM posts WHERE team_id = ? AND seq > ?'+filter+' ORDER BY seq LIMIT ?');
    this.postTail = this.db.prepare('SELECT value FROM posts WHERE team_id = ?'+filter+' ORDER BY seq DESC LIMIT ?');
    this.runTurn = runTurn;
    this.pending = new Set();
    this.removingWorktrees = new Set();
    this.signals = new EventEmitter().setMaxListeners(0);
    this.activity = new Map();
    this.closed = false;

    for (const { value } of this.db.prepare('SELECT value FROM teams').all()) {
      const team = JSON.parse(value);
      const count = team.members.length;
      const hadOverview = Object.hasOwn(team,'overview');
      restore(team);
      if (!team.members.some(m => m.status === 'working' || m.status === 'queued')) {
        if (hadOverview || team.members.length!==count || this.bounds.get(team.id).head < (team.events.at(-1)?.seq ?? 0)) {
          this.save(team);
        }
        continue;
      }
      team.paused = true;
      for (const member of team.members.filter(m => m.status === 'working')) {
        member.status = 'failed';
        member.waitFor = [];
        member.inbox = [...(member.inFlight ?? []), ...member.inbox].slice(-24);
        delete member.inFlight;
        delete member.declaredOutcome;
        if (member.retireAfterTurn) {
          retire(member);
          this.record(team, 'system', 'Retired @' + member.name + ' on service shutdown.');
        } else {
          this.record(team, 'system', member.name + ': turn interrupted on service shutdown. Mention @' + member.name + ' to resume from saved chat.');
        }
      }
      this.save(team);
    }
  }

  create(input, worktreeSource) {
    const cwd = realpathSync(text(input.cwd, 'Workspace', 1024));
    if (!statSync(cwd).isDirectory()) throw Error('Workspace must be a directory.');
    if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > workerLimit) {
      throw Error('Choose between 1 and '+workerLimit+' workers.');
    }
    const members = input.members.flatMap(spec=>expandMember(spec));
    if (members.length > workerLimit) throw Error('A team can have up to '+workerLimit+' active workers.');
    validateRoster(members);
    validateDependencies(members, members);
    if (members.some(member => member.worktree) && !worktreeSource) throw Error('A Git workspace is required for worktrees.');

    const task = text(input.task, 'Task', 8000);
    const team = {
      id: randomUUID(), cwd, task, title: text(input.title ?? task.slice(0, 95), 'Title', 95),
      ...(input.model ? {model: text(input.model, 'Model', 100)} : {}),
      effort: reasoningEffort(input.effort),
      concurrency: integer(input.concurrency ?? 2, 1, 4, 'Concurrency'),
      turns: 0, turnLimit: integer(input.turnLimit ?? 24, 1, 100, 'Turn limit'),
      paused: false, members, channels:[{...main}], events: [], worktreeSource,
    };
    for (const member of members) {
      if (!Array.isArray(member.channels)) throw Error('Channels must be a list of channel names.');
      for (const name of member.channels.map(channelName)) {
        if (!team.channels.some(channel=>channel.name===name)) team.channels.push({name,archived:false});
      }
      member.channels=subscriptions(team,member.channels);
    }
    this.record(team, 'system', 'Team created.');
    for (const member of members) {
      this.record(team, 'coordinator', member.brief, [member.name], 'brief', postingChannel(team,member));
    }
    if (input.coordinator === true) {
      const brief = 'Summarize verified member results on the board. Confirm only what has direct evidence. Highlight missing pieces, user decisions needed, and how to verify outputs. For follow-up requests, coordinate within the assigned goal.';
      members.push({name:'coordinator',role:'coordinator',brief,writable:false,waitFor:[],status:'waiting',
        threadId:null,inbox:[],channels:[],completed:0});
      this.record(team,'system','Coordinator is awaiting reports.', ['coordinator']);
    }
    this.save(team);
    this.signals.emit('teams');
    this.schedule(team.id);
    return team;
  }

  get(id) {
    const row = this.read.get(id);
    if (!row) throw Error('Team not found.');
    return restore(JSON.parse(row.value));
  }

  hasRunningTurns() {
    return Boolean(this.db.prepare("SELECT 1 FROM teams, json_each(teams.value,'$.members') AS member " +
      "WHERE json_extract(member.value,'$.status')='working' LIMIT 1").get());
  }

  liveMember(team, name) {
    const member = team.members.find(member => member.name === name && activeMember(member));
    if (!member) throw Error('Active member not found: @' + name);
    return member;
  }

  peerMember(team, name, requireWorking = true) {
    const member = team.members.find(entry => entry.name === name && entry.status !== 'retired');
    if (!member || (requireWorking && member.status !== 'working')) {
      throw Error('This member does not have a running turn on this board.');
    }
    return member;
  }

  addMember(id, spec, {replaces, worktreeSource, actor, fork} = {}) {
    const team = this.get(id);
    const peer = actor && this.liveMember(team, this.peerMember(team, actor).name);
    const previous = replaces == null ? null : this.liveMember(team, replaces);
    if (previous && !isWorker(previous)) throw Error('The '+previous.role+' cannot be replaced by a worker.');
    if (previous) authorizeMemberChange(peer, previous);
    if (previous?.status === 'working') throw Error('Wait for @' + replaces + ' to finish its current turn before replacing it.');
    const added = expandMember(spec,replaces);
    const member = added[0];
    const channels = spec.channels==null ? (peer?.channels??[]) : subscriptions(team,spec.channels);
    if (peer) {
      if (peer.role !== 'coordinator' && !peer.writable && member.writable) {
        throw Error('A read-only worker may only invite read-only helpers.');
      }
      for (const entry of added) entry.addedBy = peer.name;
    }
    if (fork != null) {
      const source = team.members.find(entry => entry.name === fork);
      if (!source?.threadId) throw Error('The fork source must be a member with a saved chat in this team.');
      for (const entry of added) entry.forkFrom = source.threadId;
    }
    if (previous && spec.waitFor == null) {
      member.waitFor = previous.waitFor.filter(name => {
        const dependency = team.members.find(entry => entry.name === name);
        return dependency && pendingDependency(previous, dependency);
      });
      member.waitAfter = previous.waitAfter;
      if (member.waitFor.length) member.status = 'waiting';
    }
    const live = team.members.filter(activeMember);
    const workers = live.filter(entry => isWorker(entry) && entry !== previous);
    if (workers.length+added.length > workerLimit) throw Error('A team can have up to '+workerLimit+' active workers.');
    const eligible = new Set(live.filter(entry => entry !== previous).map(entry => entry.name));
    if (member.waitFor.some(name => !eligible.has(name))) throw Error('New dependencies must refer to active teammates.');
    team.members.push(...added);
    for (const entry of added) entry.channels=[...channels];
    validateRoster(team.members);
    team.worktreeSource ??= worktreeSource;
    if (member.worktree && !team.worktreeSource) throw Error('A Git workspace is required for worktrees.');
    if (previous) {
      for (const waiting of live.filter(entry => pendingDependency(entry, previous))) {
        waiting.waitFor = waiting.waitFor.map(name => name === replaces ? member.name : name);
      }
      retire(previous);
      const handoff = this.record(team, actor ?? 'coordinator',
        '@' + member.name + ' took over from @' + replaces + '.' +
        (previous.workspace ? ' Previous worktree: ' + previous.workspace.cwd : ''), [member.name]);
      enqueue(member, handoff);
    }
    validateDependencies(team.members, added);
    for (const entry of added) {
      this.record(team, actor ?? 'coordinator', entry.brief, [entry.name], 'brief', postingChannel(team,entry));
    }
    this.unblockDependencies(team);
    this.save(team);
    this.schedule(id);
    return team;
  }

  retireMember(id, name, {actor} = {}) {
    const team = this.get(id);
    const live = team.members.filter(activeMember);
    const targets = live.filter(member=>member.name===name||member.group===name);
    if (!targets.length) throw Error('Active member or group not found: @'+name);
    const peer = actor && this.peerMember(team, actor);
    for (const target of targets) authorizeMemberChange(peer,target);
    const waiting = live.filter(entry=>targets.some(target=>pendingDependency(entry,target)));
    if (waiting.length) {
      throw Error(waiting.map(entry => '@' + entry.name).join(', ') +
        ' still need a report. Wait for the report or add a replacement.');
    }
    for (const member of targets) {
      if (member.status==='working') member.retireAfterTurn=true;
      else retire(member);
      this.record(team,actor??'coordinator','@'+member.name+
        (member.retireAfterTurn?' will retire after current turn.':' retired from the team.'),[member.name]);
    }
    this.save(team);
    this.schedule(id);
    return team;
  }

  setTeamTitle(id, title, actor) {
    const team = this.get(id);
    if (actor && this.peerMember(team,actor).role!=='coordinator') {
      throw Error('Only the user or coordinator can rename a team.');
    }
    team.title=text(title,'Title',95);
    this.save(team);
    this.signals.emit('teams');
    return team;
  }

  manageChannel(id, {op,channel,topic,member}, actor) {
    const team = this.get(id);
    const peer = actor && this.peerMember(team,actor);
    if (op==='list') return {channels:team.channels};
    if (op==='create'||op==='archive') {
      if (peer && peer.role!=='coordinator') throw Error('Only the user or coordinator can create or archive channels.');
      const name=channelName(channel);
      if (op==='create') {
        if (team.channels.some(entry=>entry.name===name)) throw Error('Channel already exists: #'+name);
        team.channels.push({name,archived:false,...(topic?{topic:text(topic,'Topic',600)}:{})});
      } else {
        if (name==='main') throw Error('The main channel cannot be archived.');
        openChannel(team,name).archived=true;
      }
    } else if (op==='subscribe'||op==='unsubscribe') {
      const target=this.liveMember(team,member??actor);
      authorizeMemberChange(peer,target);
      const name=channelName(channel);
      if (op==='unsubscribe'&&name==='main') throw Error('Every member stays subscribed to main.');
      if (op==='subscribe') {
        openChannel(team,name);
        if (name!=='main') target.channels=[...new Set([...target.channels,name])];
      } else {
        if (!team.channels.some(entry=>entry.name===name)) throw Error('Channel not found: #'+name);
        target.channels=target.channels.filter(entry=>entry!==name);
      }
    } else throw Error('Unknown channel operation.');
    this.save(team);
    return {channels:team.channels,members:team.members.map(({name,channels})=>({name,channels}))};
  }

  switchModel(id, name, model, {resume = false, effort, actor} = {}) {
    const team = this.get(id);
    const member = this.liveMember(team, name);
    const peer = actor && this.peerMember(team, actor);
    authorizeMemberChange(peer, member);
    if (member.status === 'working' && member !== peer) {
      throw Error('Wait for @' + name + ' to finish its current turn before switching models.');
    }
    member.model = text(model, 'Model', 100);
    if (effort !== undefined) member.effort = effort === null ? null : reasoningEffort(effort);
    delete member.activeModel;
    delete member.activeEffort;
    this.record(team, actor ?? 'coordinator', '@' + name + ' will use ' + member.model + ' on the next turn.', [name]);
    if (resume === true && ['waiting', 'failed', 'quota'].includes(member.status) && !member.waitFor.length) {
      member.status = 'queued';
      enqueue(member, this.record(team, 'system', 'Resuming work in the current chat.', [name]));
    }
    this.save(team);
    this.schedule(id);
    return team;
  }

  async removeWorktree(id, name, remove) {
    const team = this.get(id);
    const member = team.members.find(entry => entry.name === name);
    if (!member) throw Error('Team member not found: @' + name);
    if (member.status !== 'retired' && teamPhase({...team,paused:false}) !== 'done') {
      throw Error('Remove worktrees only after the team is finished or the member is retired.');
    }
    if (!member.workspace) return team;
    if (this.removingWorktrees.has(id)) throw Error('A worktree is already being removed from this team.');
    this.removingWorktrees.add(id);
    try {
      await remove({team,member});
      const current = this.get(id);
      delete current.members.find(entry => entry.name === name).workspace;
      this.record(current, 'system', 'Removed worktree for @' + name + '.');
      this.save(current);
      return current;
    } finally {
      this.removingWorktrees.delete(id);
      this.schedule(id);
    }
  }

  readPosts(id, {after, limit = 10, channel, actor} = {}) {
    integer(limit, 1, 20, 'Post limit');
    return this.readHistory(id,{after,limit,channel,actor});
  }

  readHistory(id, {after, limit = 100, channel, actor, mentionsOnly = false} = {}) {
    const team=this.get(id);
    integer(limit, 1, 200, 'History page size');
    if (after != null) integer(after, 0, Number.MAX_SAFE_INTEGER, 'After post');
    const selected=channel==='*'?null:channel!=null?[channelName(channel)]:
      actor?visibleChannels(this.peerMember(team,actor,false)):null;
    const filter=selected ? JSON.stringify(selected) : null;
    const condition=[filter,filter,mentionsOnly?1:0];
    const {earliest,head} = this.bounds.get(id);
    const rows = after == null ? this.postTail.all(id,...condition,limit).reverse()
      : this.postPage.all(id,after,...condition,limit+1);
    const posts=rows.slice(0,limit).map(row=>{
      const post=JSON.parse(row.value);
      post.channel??='main';
      return post;
    });
    return {posts,head,earliest,hasMore:rows.length>limit};
  }

  subscribe(topic, listener) {
    this.signals.on(topic,listener);
    return ()=>this.signals.off(topic,listener);
  }

  async waitForBoard(id, {since,mentionsOnly=false,channel,timeoutSec} = {}, signal) {
    signal?.throwIfAborted();
    const initial=this.get(id);
    const duration=boardWaitTimeout(timeoutSec)*1000;
    const after=since??this.bounds.get(id).head;
    const page=()=>this.readHistory(id,{after,channel,mentionsOnly,limit:200});
    const result=(wokeBy,data,status)=>({wokeBy,posts:data.posts,head:data.head,phase:teamPhase(status),status,
      ...(data.hasMore?{hasMore:true}:{})});
    const first=page();
    if (first.posts.length) return result('post',first,initial);
    const initialPhase=teamPhase(initial);
    if (wakePhases.has(initialPhase)) return result('phase',first,initial);
    return new Promise((resolve,reject)=>{
      let phase=initialPhase;
      const finish=(error,value)=>{
        clearTimeout(timer);
        unsubscribe();
        this.signals.off('close',closed);
        signal?.removeEventListener('abort',aborted);
        if (error) reject(error); else resolve(value);
      };
      const closed=()=>finish(Error('Team Board closed.'));
      const aborted=()=>finish(signal.reason);
      const unsubscribe=this.subscribe(id,status=>{
        const next=teamPhase(status);
        const changed=next!==phase;
        phase=next;
        const data=page();
        if (changed&&wakePhases.has(next)) finish(null,result('phase',data,status));
        else if (data.posts.length) finish(null,result('post',data,status));
      });
      const timer=setTimeout(()=>finish(null,result('timeout',page(),this.get(id))),duration);
      this.signals.once('close',closed);
      signal?.addEventListener('abort',aborted,{once:true});
    });
  }

  list() {
    return this.db.prepare('SELECT value FROM teams ORDER BY rowid DESC LIMIT 40').all()
      .map(({value}) => { const {id, title, cwd, paused} = JSON.parse(value); return {id, title, cwd, paused}; });
  }

  latestIn(cwd) {
    const workspace = realpathSync(text(cwd,'Workspace',1024));
    const caseRule = process.platform === 'win32' ? ' COLLATE NOCASE' : '';
    const row = this.db.prepare("SELECT value FROM teams WHERE json_extract(value,'$.cwd') = ?" +
      caseRule + ' ORDER BY rowid DESC LIMIT 1').get(workspace);
    return row ? restore(JSON.parse(row.value)) : null;
  }

  save(team) {
    numberPosts(team);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const {head} = this.bounds.get(team.id);
      for (const event of team.events) {
        if (event.seq > head) this.writePost.run(team.id,event.seq,JSON.stringify(event));
      }
      this.write.run(team.id, JSON.stringify(team));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.signals.emit(team.id,team);
  }

  record(team, author, body, targets = [], kind = 'status', channel = 'main') {
    const event = {seq: (team.events.at(-1)?.seq ?? 0) + 1, time: new Date().toISOString(), kind, author, text: body, targets,channel};
    team.events.push(event);
    if (team.events.length > 300) team.events.shift();
    return event;
  }

  deliver(team, author, body, names = [], channel = 'main') {
    const addresses=addressesIn(body,names);
    if (addresses.has('#main')) throw Error('Use @all for everyone instead of @#main.');
    const addressedChannels=new Set(team.channels.filter(entry=>!entry.archived&&addresses.has('#'+entry.name))
      .map(entry=>entry.name));
    const targets = team.members.filter(member => activeMember(member) && member.name !== author &&
      (addresses.has(member.name) || addresses.has(member.group) || addresses.has('all') ||
        member.channels.some(name=>addressedChannels.has(name))));
    const event = this.record(team, author, body, targets.map(member => member.name), 'message',channel);
    if (addresses.has('all')) event.broadcast = true;
    if (addresses.has('coordinator')) event.coordinatorMention=true;
    for (const target of targets) {
      const addressed = addresses.has(target.name);
      enqueue(target, event, addressed);
      this.wakeForMessage(target, addressed);
    }
    return event;
  }

  wakeForMessage(member, addressed) {
    if (member.status === 'working' || (member.waitFor.length && !addressed)) return;
    if ((member.status === 'quota' || !isWorker(member)) && !addressed) return;
    member.waitFor = [];
    member.status = 'queued';
  }

  post(id, body, channel) {
    const team = this.get(id);
    this.deliver(team, 'user', text(body, 'Message', 6000),[],postingChannel(team,null,channel));
    this.save(team);
    this.schedule(id);
    return team;
  }

  postFrom(id, author, body, channel) {
    const team = this.get(id);
    const member=this.peerMember(team,author);
    const event = this.deliver(team, author, text(body, 'Message', 6000),[],postingChannel(team,member,channel));
    this.save(team);
    this.schedule(id);
    return event;
  }

  declareOutcome(id, name, {turn,state,message,notify=[],waitFor=[]}) {
    const team = this.get(id);
    const member = team.members.find(entry=>entry.name===name);
    if (member?.status!=='working' || member.lastTurn!==turn) throw Error('This board turn is no longer active.');
    if (!['done','waiting'].includes(state) || !Array.isArray(notify) || !Array.isArray(waitFor)) {
      throw Error('Choose a valid outcome for the active turn.');
    }
    member.declaredOutcome={state,message:text(message,'Report',6000),notify,waitFor};
    this.save(team);
    return {accepted:true,turn};
  }

  pause(id) {
    const team = this.get(id);
    team.paused = true;
    this.record(team, 'system', 'Paused dispatching new turns.');
    this.save(team);
    return team;
  }

  resume(id, extraTurns = 0) {
    const team = this.get(id);
    team.turnLimit += integer(extraTurns, 0, 100, 'Extra turns');
    team.paused = false;
    this.record(team, 'system', 'Team resumed.');
    this.save(team);
    this.schedule(id);
    return team;
  }

  schedule(id) {
    if (this.closed || this.pending.has(id)) return;
    this.pending.add(id);
    queueMicrotask(() => {
      this.pending.delete(id);
      if (!this.closed) this.dispatch(id);
    });
  }

  dispatch(id) {
    if (this.removingWorktrees.has(id)) return;
    const team = this.get(id);
    if (team.paused || team.turns >= team.turnLimit) {
      this.monitor(team);
      return;
    }
    if (this.queueCoordinator(team)) this.save(team);
    const active = team.members.filter(m => m.status === 'working');
    if (active.length >= team.concurrency) return;
    const sharedWriterActive = active.some(member => member.writable && !member.worktree);
    const member = team.members.filter(m => m.status === 'queued' && (!m.writable || m.worktree || !sharedWriterActive))
      .sort((a, b) => (a.lastTurn ?? 0) - (b.lastTurn ?? 0))[0];
    if (!member) {
      this.monitor(team);
      return;
    }

    member.status = 'working';
    member.lastTurn = ++team.turns;
    delete member.declaredOutcome;
    delete team.monitorPhase;
    // A queued private inbox entry from an older release must not enter a public turn.
    member.inbox = member.inbox.filter(post=>post.visibility!=='direct');
    const request = structuredClone(member);
    const completions = Object.fromEntries(team.members.map(m => [m.name, m.completed ?? 0]));
    member.inFlight = member.inbox;
    member.inbox = [];
    this.record(team, 'system', '@' + member.name + ' started turn ' + team.turns + '.');
    const live=this.activity.get(id)??new Map();
    const activity={steps:[],draft:''};
    live.set(member.name,activity);
    this.activity.set(id,live);
    // Retain enough prefix for the JSON envelope and an escaped 6,000-character report.
    let output = '';
    const onActivity=({kind,label,detail,delta,time})=>{
      if (this.closed||live.get(member.name)!==activity) return;
      if (kind==='draft') {
        output=delta ? output+String(delta).slice(0,40000-output.length) : '';
        const message=extractReportMessage(output);
        activity.draft=message?.trim() ? message.slice(-600) : 'Drafting report…';
      }
      else {
        activity.steps.push({kind,label:String(label??'').slice(0,120),detail:String(detail??'').slice(0,180),time});
        if (activity.steps.length>10) activity.steps.shift();
      }
      this.signals.emit('activity:'+id);
    };
    this.save(team);
    const remember = details => {
      if (this.closed) return;
      const fresh = this.get(id);
      const current = fresh.members.find(m => m.name === member.name);
      Object.assign(current, typeof details === 'string' ? {threadId: details} : details);
      if (current.forkFrom === null) delete current.forkFrom;
      this.save(fresh);
    };
    const declaredOutcome = () => this.get(id).members.find(entry=>entry.name===member.name &&
      entry.status==='working' && entry.lastTurn===request.lastTurn)?.declaredOutcome;
    Promise.resolve().then(() => this.runTurn({team, member: request, remember, declaredOutcome, onActivity})).then(
      result => this.settle(id, member.name, completions, result),
      error => {
        const message = String(error?.message ?? error).slice(0, 6000);
        const quota = error?.blockedBy === 'quota' ||
          /\b429\b|too many requests|rate.limit|insufficient.quota|quota exceeded|usage limit/i.test(message);
        this.settle(id, member.name, completions, {state: quota ? 'quota' : 'failed', message});
      },
    );
    this.schedule(id);
  }

  activityFor(id) {
    return structuredClone(Object.fromEntries(this.activity.get(id)??[]));
  }

  queueCoordinator(team) {
    const coordinator = team.members.find(member => member.role === 'coordinator' && activeMember(member));
    if (!coordinator || ['failed','quota'].includes(coordinator.status)) return false;
    const workers = team.members.filter(member => isWorker(member) && member.status !== 'retired');
    const round = completedWorkerRound(workers);
    if (!round || coordinator.lastRound === round) return false;
    coordinator.lastRound = round;
    const notice = this.record(team,'system','Workers submitted reports. Coordinator is summarizing this round.',
      [coordinator.name],'checkpoint');
    enqueue(coordinator,notice,true);
    for (const worker of workers) {
      if (worker.lastReport && !coordinator.inbox.some(post => post.seq === worker.lastReport.seq)) {
        enqueue(coordinator,worker.lastReport);
      }
    }
    if (coordinator.status !== 'working') coordinator.status = 'queued';
    return true;
  }

  monitor(team) {
    const phase = teamPhase(team);
    if ((phase !== 'stalled' && phase !== 'budget') || team.monitorPhase === phase) return;
    team.monitorPhase = phase;
    const blockers = team.members.filter(member => activeMember(member) && member.status !== 'done').map(member => {
      if (member.status === 'quota') return '@' + member.name + ' hit model quota limit';
      if (member.status === 'failed') return '@' + member.name + ' failed';
      if (member.waitFor.length) return '@' + member.name + ' is waiting on ' + member.waitFor.map(name => '@' + name).join(', ');
      return '@' + member.name + ' is waiting for work';
    });
    const message = phase === 'budget'
      ? 'Team reached its turn limit. Add extra turns to continue.'
      : 'Team waiting. ' + blockers.join('. ') + '. Send an @mention to continue a member.';
    this.record(team, 'system', message, [], 'monitor');
    this.save(team);
  }

  settle(id, name, completions, result) {
    if (this.closed) return;
    const team = this.get(id);
    const member = team.members.find(m => m.name === name);
    const live=this.activity.get(id);
    live?.delete(name);
    if (!live?.size) this.activity.delete(id);
    const valid = result && ['waiting', 'done', 'failed', 'quota'].includes(result.state) &&
      typeof result.message === 'string' && result.message.trim() &&
      (['failed', 'quota'].includes(result.state) || (Array.isArray(result.waitFor) && Array.isArray(result.notify)));
    if (!valid) result = { state: 'failed', message: 'Model returned invalid format. Mention @' + name + ' to retry.' };
    if (addressesIn(result.message,result.notify??[]).has('#main')) {
      result={state:'failed',message:'@#main is invalid. Use @all to address everyone.'};
    }
    const failed = result.state === 'failed' || result.state === 'quota';
    const names = new Set(team.members.filter(activeMember).map(m => m.name));
    member.status = result.state;
    member.waitFor = result.state === 'waiting' ? [...new Set(result.waitFor)].filter(n => n !== name && names.has(n)) : [];
    member.waitAfter = result.state === 'waiting' ? completions : {};
    if (failed) member.inbox = [...(member.inFlight ?? []), ...member.inbox].slice(-24);
    if (result.state === 'done') member.completed = (member.completed ?? 0) + 1;
    delete member.inFlight;
    delete member.declaredOutcome;
    if (member.inbox.length && !failed) this.wakeForMessage(member,member.inbox.some(post=>post.addressed));
    if (member.retireAfterTurn) {
      retire(member);
      this.record(team, 'system', '@' + member.name + ' retired after turn.', [member.name]);
    }
    const message = result.message.slice(0, 6000);
    if (failed) this.record(team, name, message);
    else {
      const report = this.deliver(team, name, message, result.notify, postingChannel(team,member));
      if (result.state === 'done') member.lastReport = report;
    }
    this.unblockDependencies(team);
    this.save(team);
    this.signals.emit('activity:'+id);
    this.schedule(id);
  }

  unblockDependencies(team) {
    for (const waiting of team.members.filter(m => m.status === 'waiting' && m.waitFor.length)) {
      const dependencies = waiting.waitFor.map(dependency => team.members.find(m => m.name === dependency));
      if (dependencies.some(dependency => !dependency || pendingDependency(waiting, dependency))) continue;
      enqueue(waiting, this.record(team, 'system', 'Completed pending dependencies: ' + waiting.waitFor.join(', '), [waiting.name]));
      for (const dependency of dependencies) {
        const report = dependency.lastReport;
        if (report && !waiting.inbox.some(event => event.seq === report.seq)) enqueue(waiting, report);
      }
      waiting.waitFor = [];
      waiting.status = 'queued';
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.signals.emit('close');
    this.signals.removeAllListeners();
    this.activity.clear();
    this.db.close();
  }
}
