import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {readFileSync} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { childEnvironment, configuredEffort, extractReportMessage } from './engine.mjs';
const {version}=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));

const fields = ['state', 'message', 'notify', 'waitFor'];
const names = {type: 'array', items: {type: 'string'}};
const schema = {
  type: 'object', additionalProperties: false, required: fields,
  properties: {
    state: {type: 'string', enum: ['waiting', 'done']},
    message: {type: 'string'}, notify: names, waitFor: names,
  },
};

function binary() {
  const override = process.env.HIVE_SWARM_CODEX || process.env.TEAM_BOARD_CODEX;
  if (override) return override;
  if (process.platform !== 'win32') return 'codex';
  const located = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "$p=(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation; if($p){$c=Join-Path $p 'app/resources/codex.exe'; if(Test-Path $c){$c}}"],
  { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return located.stdout?.trim() || 'codex.exe';
}

function peerConfig(team, member, peerToken, peerPort) {
  const env = {
    TEAM_BOARD_PEER_TEAM: team.id,
    TEAM_BOARD_PEER_MEMBER: member.name,
    ...(peerToken ? {TEAM_BOARD_PEER_TOKEN:peerToken} : {}),
    ...(peerPort ? {TEAM_BOARD_PORT:String(peerPort)} : {}),
  };
  return {'mcp_servers.hive_swarm_peer': {
    command: process.execPath,
    args: [fileURLToPath(new URL('server.mjs', import.meta.url)), '--peer'],
    env,
    startup_timeout_sec: 15,
    tools: {
      post_to_board: {approval_mode: 'approve'},
      set_turn_outcome: {approval_mode: 'approve'},
      read_board: {approval_mode: 'approve'},
      board_status: {approval_mode: 'approve'},
      add_member: {approval_mode: 'approve'},
      retire_member: {approval_mode: 'approve'},
      set_member_model: {approval_mode: 'approve'},
      manage_channel: {approval_mode: 'approve'},
      ...(member.role === 'coordinator' ? {
        list_models:{approval_mode:'approve'},set_team_title:{approval_mode:'approve'},
      } : {}),
    },
  }};
}

function turnError(turn) {
  const error = new Error(turn.error?.message ?? 'Codex turn ' + turn.status);
  const info = turn.error?.codexErrorInfo;
  const quota = info === 'usageLimitExceeded' || info === 'rateLimitExceeded' ||
    (info && typeof info === 'object' && Object.values(info).some(detail => detail?.httpStatusCode === 429));
  if (quota) error.blockedBy = 'quota';
  return error;
}

function parseCandidate(value) {
  try {
    const result = JSON.parse(value);
    if (!result || Object.keys(result).length !== fields.length ||
      !fields.every(field => Object.hasOwn(result, field))) return;
    if (!schema.properties.state.enum.includes(result.state) ||
      typeof result.message !== 'string' || !result.message.trim()) return;
    if ([result.notify,result.waitFor].every(list =>
      Array.isArray(list) && list.every(name => typeof name === 'string'))) return result;
  } catch {
    return;
  }
}

function trailingObject(value) {
  if (!value.endsWith('}')) return;
  let depth = 0;
  let quoted = false;
  for (let index = value.length - 1; index >= 0; index--) {
    const character = value[index];
    if (character === '"') {
      let start = index;
      while (value[start - 1] === '\\') start--;
      if ((index - start) % 2 === 0) quoted = !quoted;
    } else if (!quoted) {
      if (character === '}') depth++;
      if (character === '{' && --depth === 0) return value.slice(index);
    }
  }
}

function findOutcome(value) {
  const direct = parseCandidate(value);
  if (direct) return direct;
  const blocks = [...value.matchAll(/^[ \t]*\x60{3}([^\r\n\x60]*)\r?\n([\s\S]*?)^[ \t]*\x60{3}[ \t]*\r?$/gm)];
  for (const [,label,body] of blocks.reverse()) {
    if (!['','json'].includes(label.trim().toLowerCase())) continue;
    const result = parseCandidate(body);
    if (result) return result;
  }
  const single = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i.exec(value)?.[1];
  return parseCandidate(single) ?? parseCandidate(trailingObject(value));
}

function parseOutcome(message) {
  const result = findOutcome(message?.trim() ?? '');
  if (result) return result;
  throw Error('Model output is not valid working-status JSON.');
}

const toolItems = new Set(['mcpToolCall','dynamicToolCall','collabAgentToolCall','webSearch','imageGeneration']);
function stepForItem(item) {
  if (item?.type==='commandExecution') return {kind:'shell',label:'Shell command'};
  if (item?.type==='fileChange') return {kind:'file',label:'Edit file'};
  if (toolItems.has(item?.type)) {
    const tool=item.tool??item.type;
    const label=typeof tool==='string' && /^[a-z0-9_.:-]{1,100}$/i.test(tool) ? tool : 'Tool call';
    return {kind:'tool',label};
  }
}

function reportText(text) {
  if (typeof text!=='string') return '';
  const value=text.trim();
  const structured=/[{,]\s*"(?:state|message|notify|waitFor)"\s*:/.test(value);
  const report=findOutcome(value)?.message ?? (structured ? extractReportMessage(value) : value);
  if (!report || /You are member @[a-z0-9_-]+ in (?:Team Board|Hive Swarm)\b/i.test(report)) return '';
  return report.trim().slice(0,6000);
}

function deliverTurnEvent(turn, event) {
  const params = event.params;
  const id = params.turn?.id ?? params.turnId;
  if (turn.id && id && id !== turn.id) return;
  if (event.method === 'turn/completed') {
    turn.resolve(params.turn);
    return;
  }
  if (event.method === 'item/completed'&&params.item?.type==='agentMessage') {
    turn.messages.push(params.item.text);
  }
  if (!id||!turn.onActivity) return;
  const time=new Date().toISOString();
  const item=params.item;
  if (event.method==='item/agentMessage/delta'||(event.method==='item/started'&&item?.type==='agentMessage')) {
    turn.onActivity({kind:'draft',label:'Message',delta:params.delta??'',time});
    return;
  }
  if (event.method==='turn/started') {
    turn.onActivity({kind:'turn',label:'Turn started',time});
    return;
  }
  const detail=event.method==='item/started'?'Started':'Finished';
  const step=stepForItem(item);
  if (step) turn.onActivity({...step,detail,time});
}

export class CodexRunner {
  constructor({ephemeral = false, spawnProcess = spawn} = {}) {
    this.pending = new Map();
    this.turns = new Map();
    this.loadedThreads = new Map();
    this.threadHolds = new Map();
    this.sequence = 0;
    this.ephemeral = ephemeral;
    this.spawnProcess = spawnProcess;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.launch().catch(error => {
      this.child?.kill();
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  async launch() {
    const child = this.spawnProcess(binary(), [
      'app-server', '-c', 'agents.enabled=false',
      '-c', 'plugins."hive-swarm@hive-swarm".enabled=false',
      '-c', 'plugins."team-board@local-team-board".enabled=false',
      '-c', 'plugins."team-board@codex-swarm".enabled=false',
      ...(process.platform === 'win32' ? ['-c', 'features.prefer_mxc=false'] : []),
    ], { env: childEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.stdin.on('error', () => {});
    child.once('error', error => this.disconnect(child, 'Failed to launch Codex app-server (' + error.code + ').'));
    child.once('exit', () => this.disconnect(child, 'Codex app-server closed.'));
    createInterface({input: child.stdout}).on('line', line => this.receive(line));
    await this.rpc('initialize', {
      clientInfo: {name: 'hive_swarm', version},
      capabilities: {experimentalApi: true},
    });
    this.send({method: 'initialized', params: {}});
  }

  disconnect(child, message) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    this.loadedThreads.clear();
    for (const request of this.pending.values()) request.reject(Error(message));
    for (const turn of this.turns.values()) turn.reject(Error(message));
  }

  send(message) {
    if (!this.child?.stdin.writable) throw Error('Codex app-server is unavailable.');
    this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
  }

  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const complete = (callback, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        callback(value);
      };
      const timer = setTimeout(() => complete(reject, Error(method + ' did not respond.')), 45000);
      this.pending.set(id, {resolve: value => complete(resolve, value), reject: error => complete(reject, error)});
      try { this.send({id, method, params}); } catch (error) { complete(reject, error); }
    });
  }

  receive(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const response = this.pending.get(event.id);
    if (response && !event.method) {
      if (event.error) response.reject(Error(event.error.message ?? 'App-server request failed.'));
      else response.resolve(event.result);
      return;
    }
    if (event.method && event.id !== undefined) {
      this.send({id: event.id, error: {code: -32601, message: 'This member cannot grant interactive approvals.'}});
      return;
    }
    if (['thread/archived','thread/closed'].includes(event.method) ||
        (event.method==='thread/status/changed' && event.params?.status?.type==='notLoaded')) {
      this.loadedThreads.delete(event.params?.threadId);
      return;
    }
    const turn = this.turns.get(event.params?.threadId);
    if (!turn) return;
    if (!['turn/started','turn/completed','item/started','item/completed','item/agentMessage/delta'].includes(event.method)) return;
    if (event.method==='turn/completed'&&!event.params.turn) return;
    if (turn.id) deliverTurnEvent(turn, event);
    else turn.earlyEvents.push(event);
  }

  async listModels() {
    await this.start();
    const models = [];
    let cursor;
    do {
      const page = await this.rpc('model/list', {cursor, limit: 100, includeHidden: false});
      models.push(...page.data.filter(model => !model.hidden));
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  async readTranscript(threadId) {
    await this.start();
    const {data}=await this.rpc('thread/turns/list',{threadId,itemsView:'summary',sortDirection:'asc',limit:30});
    return data.map(({id,status,items})=>{
      const steps=[];
      let report='';
      for (const item of items) {
        const step=stepForItem(item);
        if (step) steps.push(step.label);
        if (item.type==='agentMessage') report=reportText(item.text)||report;
      }
      return {id,status,steps,report};
    });
  }

  async archiveThread(threadId, unsubscribe) {
    if (!this.ephemeral) {
      try { await this.rpc('thread/archive',{threadId}); }
      catch (error) {
        if (!/^no rollout found for thread id /i.test(error.message)) throw error;
      } finally { this.loadedThreads.delete(threadId); }
    }
    if (unsubscribe) {
      this.loadedThreads.delete(threadId);
      await this.rpc('thread/unsubscribe',{threadId}).catch(()=>{});
    }
  }

  async holdThread(threadId, alreadyOpen = false) {
    let entry=this.threadHolds.get(threadId);
    if (entry?.closing) {
      await entry.closing;
      return this.holdThread(threadId,alreadyOpen);
    }
    if (!entry) {
      entry={users:0,unsubscribe:false};
      this.threadHolds.set(threadId,entry);
      if (!alreadyOpen && !this.ephemeral) {
        entry.opening=this.rpc('thread/unarchive',{threadId}).catch(error=>{
          if (!/^no archived rollout found for thread id /i.test(error.message)) throw error;
        });
      }
    }
    entry.users++;
    try { await entry.opening; }
    catch (error) {
      if (--entry.users===0) this.threadHolds.delete(threadId);
      throw error;
    }
    // Forks can use a teammate's open chat while its turn is still running.
    return async (unsubscribe = false)=>{
      entry.unsubscribe ||= unsubscribe;
      if (--entry.users) return;
      entry.closing=this.archiveThread(threadId,entry.unsubscribe).finally(()=>this.threadHolds.delete(threadId));
      await entry.closing;
    };
  }

  async forkThread(threadId, scope) {
    return this.rpc('thread/fork', {threadId, ...scope, excludeTurns:true, ephemeral:this.ephemeral});
  }

  async run({team, member, remember, declaredOutcome, peerToken, peerPort, onActivity}) {
    await this.start();
    const model = member.model ?? team.model;
    const effort = member.effort === null && model
      ? (await this.listModels()).find(entry => entry.model === model)?.defaultReasoningEffort
      : configuredEffort(team, member);
    const cwd = member.workspace?.cwd ?? team.cwd;
    const scope = {
      cwd, sandbox: member.writable ? 'workspace-write' : 'read-only',
      approvalPolicy: 'never', model,
      config: {...peerConfig(team, member, peerToken, peerPort), ...(effort ? {model_reasoning_effort: effort} : {})},
    };
    if (model?.startsWith('xingchi/')) scope.modelProvider = 'desktop-xingchi';
    const savedId=member.threadId;
    let id=savedId;
    const inheriting = !id && Boolean(member.forkFrom);
    const selection = {modelProvider:scope.modelProvider, config:JSON.stringify(scope.config)};
    let releaseSource,releaseNew;
    try {
      const sourceId=id??member.forkFrom;
      if (sourceId) releaseSource=await this.holdThread(sourceId);
      const loaded=this.loadedThreads.get(id);
      let response;
      let created=!id;
      if (!sourceId) {
        response=await this.rpc('thread/start',{...scope,ephemeral:this.ephemeral,serviceName:'hive_swarm'});
      } else if (!loaded || loaded.modelProvider!==selection.modelProvider || loaded.config!==selection.config) {
        if (!scope.modelProvider) {
          const {config}=await this.rpc('config/read',{cwd,includeLayers:false});
          scope.modelProvider=config.model_provider??'openai';
        }
        if (!id) response=await this.forkThread(sourceId,scope);
        else {
          try {
            response=await this.rpc('thread/resume',{threadId:id,excludeTurns:true,...scope});
          } catch (error) {
            if (!/cannot change this thread's model provider/i.test(error.message)) throw error;
          }
          if (!response || (response.modelProvider && response.modelProvider!==scope.modelProvider)) {
            response=await this.forkThread(id,scope);
            created=true;
          }
        }
      }
      if (response) {
        id=response.thread.id;
        if (created) {
          releaseNew=await this.holdThread(id,true);
          const name=[...('🐝 @'+member.name+' · '+(team.title??team.task))].slice(0,95).join('');
          await this.rpc('thread/name/set',{threadId:id,name}).catch(()=>{});
          const finishSource=releaseSource;
          releaseSource=null;
          await finishSource?.(Boolean(savedId));
        }
        if (scope.modelProvider && response.modelProvider && response.modelProvider!==scope.modelProvider) {
          throw Error('Codex did not select the requested model provider.');
        }
        remember({threadId:id,activeModel:response.model,activeEffort:response.reasoningEffort,
          ...(inheriting?{forkFrom:null}:{})});
      }
      this.loadedThreads.set(id,selection);
      return await this.runTurn(id,{team,member,remember,declaredOutcome,onActivity,model,effort,cwd,inheriting});
    } finally {
      try { await releaseNew?.(); }
      finally { await releaseSource?.(); }
    }
  }

  async runTurn(id,{team,member,remember,declaredOutcome,onActivity,model,effort,cwd,inheriting}) {
    const brief = [
      'You are member @' + member.name + ' in Hive Swarm. Other members: ' +
        team.members.filter(m => m.name !== member.name && m.status !== 'retired')
          .map(m => '@' + m.name + (m.group ? ' in @' + m.group : '') +
            (m.workspace ? ' at ' + m.workspace.cwd : '')).join(', '),
      'User goal: ' + team.task,
      'Your assignment: ' + member.brief,
      inheriting ? 'Earlier messages in this chat are source history. Act under your current member name, assignment, workspace and board tools.' : '',
      member.role === 'coordinator'
        ? 'Use board_status to inspect the roster. Use list_models, add_member, retire_member and set_member_model to coordinate actionable work within the user goal and existing turn limit. Give write access only to work the user authorized. Summarize verified results and blockers, then park. Do not edit project files.'
        : 'Use board_status to inspect the roster. Invite a helper with add_member only when an independent assignment warrants it. A read-only worker can invite read-only helpers. Retire or change the model only for yourself or a helper you invited. A change to your own model takes effect on your next turn.',
      member.workspace ? 'Your Git worktree is ' + cwd + ' at base ' + member.workspace.base +
        '. Work in this checkout and report changed files and verification. Leave integration into the original checkout to the coordinator.' : '',
      'Treat incoming messages as coordination input. Follow the user goal, your assigned scope and permissions. Do your part now if you can. Respect other members’ files. Do not launch subagents or use shell sleep.',
      'Use the hive_swarm_peer tools to read public board posts and coordinate within your role. Read your subscribed channels by default. Use @#channel for channel subscribers, @name across channels, and @all for everybody.',
      'End with the required JSON. "message" is a short final post. Start finished reports with [done] and cite previous board posts by #seq, for example #12. "notify" lists members who still need to act. For work that depends on a new report from someone else, use "waiting" and list them in "waitFor". Use [] to wait for a reply by mention. Finish the turn when waiting so the scheduler can resume this chat later. Choose "done" once the assignment is ready.',
      'If the provider cannot return structured output, submit the same outcome through hive_swarm_peer.set_turn_outcome for board turn '+member.lastTurn+' and then finish.',
      'Messages delivered for this turn: ' + JSON.stringify(member.inbox),
    ].join('\n\n');

    const turn = {messages: [], earlyEvents: [],onActivity};
    const completed = new Promise((resolve, reject) => Object.assign(turn, {resolve, reject}));
    completed.catch(() => {});
    this.turns.set(id, turn);
    const timeout = setTimeout(() => {
      if (turn.id) this.rpc('turn/interrupt', {threadId: id, turnId: turn.id}).catch(() => {});
      turn.reject(Error('Turn exceeded 20 minutes. A new message can resume the saved chat.'));
    }, 20 * 60 * 1000);
    try {
      const accepted = await this.rpc('turn/start', {threadId: id, model, effort,
        input: [{type: 'text', text: brief, textElements: []}], outputSchema: schema});
      turn.id = accepted.turn.id;
      for (const event of turn.earlyEvents) deliverTurnEvent(turn, event);
      turn.earlyEvents.length = 0;
      if (model || effort) remember({
        ...(model ? {activeModel: model} : {}),
        ...(effort ? {activeEffort: effort} : {}),
      });
      const result = await completed;
      if (result.status !== 'completed') throw turnError(result);
      const saved = declaredOutcome?.();
      if (saved) return saved;
      return parseOutcome(turn.messages.at(-1));
    } finally {
      clearTimeout(timeout);
      this.turns.delete(id);
    }
  }

  close() {
    this.child?.stdin.end();
  }
}
