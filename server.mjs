import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TeamBoard, boardWaitTimeout, childEnvironment, configuredEffort, pendingWaitFor, stallIssues, teamPhase, visibleChannels } from './engine.mjs';
import { openWorktree, removeWorktree, worktreeSource } from './worktrees.mjs';

const boardUri = 'ui://hive-swarm/board.html';
const asset = name => readFileSync(new URL(name,import.meta.url),'utf8');
const {version} = JSON.parse(asset('package.json'));
const html = asset('board.html').replace('<!-- hive-style -->', () => '<style>'+asset('board.css')+'</style>')
  .replace('<!-- hive-scripts -->', () => '<script>globalThis.__HIVE_SWARM_VERSION__='+JSON.stringify(version)+';</script>\n' +
    ['hive-graph.js','hive-bees.js','board.js'].map(name => '<script>'+asset(name)+'</script>').join('\n'));
const root = process.env.HIVE_SWARM_DATA || process.env.TEAM_BOARD_DATA || join(process.env.LOCALAPPDATA || homedir(), 'CodexTeamBoard');
const port = Number(process.env.HIVE_SWARM_PORT || process.env.TEAM_BOARD_PORT || 17943);
const origin = 'http://127.0.0.1:' + port;
const string = {type: 'string'};
const integer = {type: 'integer'};
const boolean = {type: 'boolean'};
const strings = {type:'array',items:string};
const shape = (properties, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const teamId = {teamId: string};
const memberForm = shape({
  name: string, brief: string, group: string, model: string, effort: string,
  fallbackModel: string, fallbackEffort: {type:['string','null']},
  fork: string,
  writable:boolean,worktree:boolean,waitFor:strings,channels:strings,
  n:{...integer,minimum:2,maximum:8,description:'Spawn N homogeneous shard copies (<name>-1..<name>-N); omit for a single worker.'},
  tasks:{...strings,minItems:2,maxItems:8,description:'Shard this member into N copies (<name>-1..<name>-N), one per slice; omit for a single worker.'},
}, ['name','brief']);
const threadForm = shape({id:string,title:string,goal:string,members:strings}, ['id','title','goal']);
const tools = [
  {
    name: 'start_team', title: 'Start a team', description: 'Start a user-requested team in a local workspace. Workers wait for their dependencies and mentions. Set writable only for members authorized to edit. Pass fork: "coordinator" on a member to inherit the current conversation. Optionally pass threads (outcome groups) and fallbackModel (quota failover).',
    inputSchema: shape({title: string, cwd: string, task: string, model: string, effort: string,
      fallbackModel: string, fallbackEffort: {type:['string','null']},
      threads: {type:'array',items:threadForm}, coordinator:boolean,
      concurrency: integer, turnLimit: integer, members: {type: 'array', items: memberForm}},
    ['cwd', 'task', 'members']),
  },
  {
    name: 'open_board', title: 'Open Team Board', description: 'Show members, handoffs and messages for a team. Returns a local browser link as a fallback.',
    inputSchema: shape(teamId, ['teamId']), annotations: {readOnlyHint: true},
    _meta: {ui: {resourceUri: boardUri}, 'ui/resourceUri': boardUri},
  },
  {
    name: 'open_swarm_panel', title: 'Open Swarm UI',
    description: 'Resolve a live Swarm for the right-side Codex panel. Use the given team ID, the latest team in the requested workspace, or the empty Swarm page. Pass openInCodex to the Desktop open_in_codex tool.',
    inputSchema: shape({...teamId,cwd:string}), annotations: {readOnlyHint:true},
  },
  {
    name: 'board_status', title: 'Read team status', description: 'Read the latest state of an existing team.',
    inputSchema: shape(teamId, ['teamId']), annotations: {readOnlyHint: true},
  },
  {
    name: 'board_history', title: 'Read saved board history',
    description: 'Page through saved public posts in sequence order, without waking members.',
    inputSchema: shape({...teamId,after:integer,limit:integer,channel:string}, ['teamId']), annotations:{readOnlyHint:true},
  },
  {
    name:'wait_for_board',title:'Wait for the board',
    description:'Wait for a matching post or a stopped phase without polling or spending model turns. A stopped team returns immediately when there are no unread matching posts. Use the last seen sequence as since. If hasMore is true, continue from the last returned post.',
    inputSchema:shape({...teamId,since:integer,mentionsOnly:boolean,channel:string,
      timeoutSec:{...integer,minimum:1,maximum:55}},['teamId']),annotations:{readOnlyHint:true},
  },
  {
    name:'manage_channel',title:'Manage team channels',
    description:'List channels or manage their subscriptions. The user and coordinator may create and archive channels.',
    inputSchema:shape({...teamId,op:{type:'string',enum:['create','list','subscribe','unsubscribe','archive']},
      channel:string,topic:string,member:string},['teamId','op']),
  },
  {
    name:'set_team_title',title:'Rename a team',
    description:'Set a title for the team from the main chat or the coordinator.',
    inputSchema:shape({...teamId,title:string},['teamId','title']),
  },
  {
    name:'set_team_plan',title:'Update outcome threads',
    description:'Set or update outcome-grouped threads displayed in the Swarm Overview.',
    inputSchema:shape({...teamId,threads:{type:'array',items:threadForm}},['teamId','threads']),
  },
  {
    name:'resolve_recovery',title:'Resolve an unconfirmed worker run',
    description:'Clear an unconfirmed native outcome after inspecting the member session. action is dismiss or retry.',
    inputSchema:shape({...teamId,member:string,action:{type:'string',enum:['dismiss','retry']}},['teamId','member']),
  },
  {
    name: 'list_teams', title: 'List teams', description: 'Find existing local teams and their IDs.',
    inputSchema: shape({}), annotations: {readOnlyHint: true},
  },
  {
    name: 'list_models', title: 'List available worker models',
    description: 'Read the configured Codex model catalog with reasoning effort options.',
    inputSchema: shape({}), annotations: {readOnlyHint: true},
  },
  {
    name: 'add_member', title: 'Add or replace a member',
    description: 'Add a named member to a team. Set replaces to transfer an idle member’s unfinished dependencies. Set fork to "coordinator" or the name of a member in this team to start from that conversation. Set worktree for a separate Git checkout.',
    inputSchema: shape({...teamId, member: memberForm, replaces:string, fork:string}, ['teamId','member']),
  },
  {
    name: 'retire_member', title: 'Retire a member',
    description: 'Retire a named member or shard group. A running member retires after its current turn. The saved chat and worktree stay available.',
    inputSchema: shape({...teamId, member:string}, ['teamId','member']),
  },
  {
    name: 'set_member_model', title: 'Set a member model',
    description: 'Set a member’s next model and optional effort. Pass null to use the model default. Set resume to wake an idle member. If Codex requires a new thread for a provider change, a fork carries forward the existing history.',
    inputSchema: shape({...teamId, member:string, model:string, effort:{type:['string','null']}, resume:boolean}, ['teamId','member','model']),
  },
  {
    name: 'post_message', title: 'Post a team message', description: 'Post a message on the board. Use @name, @group or @all to address the members who need the message.',
    inputSchema: shape({...teamId, text:string,channel:string}, ['teamId', 'text']),
  },
  {
    name: 'pause_team', title: 'Pause a team', description: 'Pause dispatch of new turns. Members already working finish their current turn.',
    inputSchema: shape(teamId, ['teamId']),
  },
  {
    name: 'resume_team', title: 'Resume a team', description: 'Resume queued turns. Increase the turn budget only when the user requests it.',
    inputSchema: shape({...teamId, extraTurns: integer}, ['teamId']),
  },
  {
    name: 'remove_worktree', title: 'Remove an owned worktree',
    description: 'Remove a retired member’s checkout or one from a completed team when the user asks. Force discards uncommitted changes and requires an explicit user request.',
    inputSchema: shape({...teamId,member:string,force:boolean}, ['teamId','member']), annotations:{destructiveHint:true},
  },
];

const peerTools = [
  {
    name: 'read_board', title: 'Read the team board',
    description: 'Read recent public posts or page through new posts after a post number. Check messages and briefs without starting another member.',
    inputSchema: shape({after:integer,limit:integer,channel:string,mentionsOnly:boolean}), annotations: {readOnlyHint: true},
  },
  {
    name: 'board_history', title: 'Read saved board history',
    description: 'Page through saved public posts in sequence order (up to 200 per call), without waking members.',
    inputSchema: shape({after:integer,limit:integer,channel:string}), annotations: {readOnlyHint: true},
  },
  {
    name: 'post_to_board', title: 'Message team members',
    description: 'Post as yourself while your turn is active. Use @name or @group to wake members who can act on your message. Reserve @all for messages everyone needs to act on.',
    inputSchema: shape({text:string,channel:string}, ['text']),
  },
  {
    name: 'set_turn_outcome', title: 'Set outcome for this worker turn',
    description: 'Save the result of the current numbered board turn when the provider cannot return structured output. Finish the turn afterward.',
    inputSchema: shape({turn:integer,state:{type:'string',enum:['done','waiting']},message:string,
      notify:{type:'array',items:string},waitFor:{type:'array',items:string}}, ['turn','state','message']),
  },
];

const memberActions = new Set(['board_status','list_models','add_member','retire_member','set_member_model','manage_channel']);
const coordinatorActions = new Set(['set_team_title','set_team_plan']);

function peerCatalog(member) {
  const coordinator=member.role==='coordinator';
  const actions=tools.filter(tool=>memberActions.has(tool.name)||(coordinator&&coordinatorActions.has(tool.name)));
  return [...peerTools,...actions.map(tool => {
    const {teamId, ...properties} = tool.inputSchema.properties;
    if (tool.name==='manage_channel'&&!coordinator) {
      properties.op={type:'string',enum:['list','subscribe','unsubscribe']};
    }
    return {...tool,inputSchema:shape(properties,tool.inputSchema.required.filter(field=>field!=='teamId'))};
  })];
}

function authorized(header, expected) {
  const provided = Buffer.from(header ?? '');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function localKey(directory = root) {
  mkdirSync(directory, {recursive: true});
  const file = join(directory, 'service.key');
  try { writeFileSync(file, randomBytes(32).toString('hex'), {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readFileSync(file, 'utf8');
}

function panelLink(team, origin) {
  const url = origin + (team ? '/board/' + team.id : '/swarm');
  return {
    url, openLabel:'🐝 Open Swarm UI',
    openInCodex:{placement:'right',target:{type:'browser',url}},
  };
}

export function extractParentSessionId(meta, env = process.env) {
  const m = meta && typeof meta === 'object' ? meta : null;
  const candidates = [
    m?.['codex/threadId'],
    m?.threadId,
    m?.thread_id,
    m?.codex && typeof m.codex === 'object' ? m.codex.threadId : undefined,
    env?.CODEX_THREAD_ID,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value && value.length <= 256 && !value.includes('\0')) return value;
  }
  return undefined;
}

function present(team, origin, activity, actor) {
  const {id,title,cwd,task,model,effort,paused,turns,turnLimit,channels} = team;
  const phase=teamPhase(team);
  const issues=stallIssues(team);
  const blockers=issues.filter(issue=>['quota','failed','cycle'].includes(issue.kind)||
    (issue.kind==='dependency'&&!team.members.some(member=>member.name===issue.member&&['working','queued'].includes(member.status))));
  const visible=visibleChannels(actor&&team.members.find(member=>member.name===actor));
  const events=visible?team.events.filter(event=>visible.includes(event.channel??'main')):team.events;
  return {
    id,title,cwd,task,model,effort,paused,turns,turnLimit,channels,activity,phase,
    ...(team.parentSessionId?{parentSessionId:team.parentSessionId}:{}),
    ...(team.fallbackModel?{fallbackModel:team.fallbackModel,...(team.fallbackEffort!==undefined?{fallbackEffort:team.fallbackEffort}:{})}:{}),
    ...(team.threads?.length?{threads:team.threads}:{}),
    attention:phase==='stalled'?issues:phase==='budget'?
      [{kind:'budget',text:'Turn limit reached ('+turns+'/'+turnLimit+'). Add 8 turns to continue.'},...blockers]:blockers,
    ...panelLink(team, origin),
    members: team.members.map(member => {
      const {name,role,group,brief,threadId,status,writable,waitFor,retireAfterTurn,worktree,workspace,addedBy,channels,lastTurn,fallbackModel,fallbackEffort,subagentName} = member;
      const executionMode = member.executionMode ?? (threadId ? 'session' : undefined);
      return {name,role,group,brief,threadId,status,writable,waitFor,retireAfterTurn,worktree,workspace,addedBy,channels,lastTurn,
        ...(executionMode?{executionMode}:{}),
        ...(subagentName?{subagentName}:{}),
        ...(fallbackModel?{fallbackModel,...(fallbackEffort!==undefined?{fallbackEffort}:{})}:{}),
        ...(member.recoveryRequired?{recoveryRequired:true}:{}),
        pendingWaitFor:pendingWaitFor(team,member),
        model:member.model ?? member.activeModel ?? model, effort:member.effort ?? member.activeEffort ?? configuredEffort(team, member)};
    }),
    events: events.slice(-60),
  };
}

function modelOptions(models) {
  return models.map(model => ({id:model.model, label:model.displayName, defaultEffort:model.defaultReasoningEffort,
    efforts:model.supportedReasoningEfforts.map(option => option.reasoningEffort)}));
}

async function verifyModels(runner, selections) {
  if (!selections.length) return [];
  const models = modelOptions(await runner.listModels());
  return selections.map(selection => {
    const model = models.find(candidate => candidate.id === selection.model);
    if (!model) throw Error('Model is unavailable in the Codex picker: ' + selection.model);
    if (selection.effort && !model.efforts.includes(selection.effort)) {
      throw Error(model.id + ' offers these reasoning efforts: ' + model.efforts.join(', '));
    }
    return model;
  });
}

function send(res, code, payload) {
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(payload));
}

function recentTeams(board) {
  return {teams:board.list().map(({id,title})=>({id,title}))};
}

function streamBoard(res, board, id, view) {
  const initial=id?board.get(id):null;
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});
  const write=(event,data)=>{
    if (res.destroyed||res.writableEnded) return;
    if (res.writableLength>1024*1024) return res.end();
    res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');
  };
  let activityTimer;
  const cancel=board.subscribe('close',()=>res.end());
  const unsubscribers=id?[
    board.subscribe(id,status=>write('status',view(status))),
    board.subscribe('activity:'+id,()=>{
      activityTimer??=setTimeout(()=>{
        activityTimer=null;
        write('activity',board.activityFor(id));
      },250);
    }),
  ]:[board.subscribe('teams',()=>write('teams',recentTeams(board)))];
  const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': keep-alive\n\n');},20000);
  res.once('close',()=>{
    cancel();
    for (const unsubscribe of unsubscribers) unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(activityTimer);
  });
  if (initial) write('status',view(initial));
  else write('teams',recentTeams(board));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 128 * 1024) throw Error('Request too large.');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function service({dataDirectory = root, listenPort = port, runner} = {}) {
  const key = Buffer.from('Bearer ' + localKey(dataDirectory));
  const peerSecret = randomBytes(32);
  const tokenFor = (id, name) => createHmac('sha256',peerSecret).update(JSON.stringify([id,name])).digest('hex');
  const {CodexRunner} = await import('./codex.mjs');
  runner ??= new CodexRunner();
  let board;
  let origin, host;
  async function changeModel(args,actor,res) {
    const current=board.get(args.teamId);
    const member=board.liveMember(current,args.member);
    if (member.status==='working' && !actor) {
      throw Error('Wait for @'+member.name+' to finish its current turn before switching models.');
    }
    let effort=args.effort===null?null:args.effort??configuredEffort(current,member)??null;
    const [model]=await verifyModels(runner,[{model:args.model,effort:args.effort}]);
    if (effort&&!model.efforts.includes(effort)) effort=null;
    if (res.destroyed) return;
    return board.switchModel(args.teamId,args.member,args.model,{resume:args.resume,effort,actor});
  }
  const removeCheckout=(id,name,force)=>board.removeWorktree(id,name,({team,member})=>
    removeWorktree(dataDirectory,team.worktreeSource,team.id,member.name,member.workspace,{force}));
  const server = createServer(async (req, res) => {
    if (req.headers.host !== host) return send(res, 403, {error: 'Invalid host.'});
    const view = (team,actor) => present(team,origin,board.activityFor(team.id),actor);
    try {
      const {pathname,searchParams} = new URL(req.url, origin);
      const isBoard = pathname.match(/^\/board\/([a-f0-9-]{36})$/);
      const transcript = pathname.match(/^\/board\/([a-f0-9-]{36})\/member\/([a-z][a-z0-9_-]{0,29})\/transcript$/);
      const api = pathname.match(/^\/board\/([a-f0-9-]{36})\/(status|history|post|pause|resume|events|member-model|member-retire|worktree-remove|title|resolve-recovery)$/);
      if ((isBoard || pathname === '/swarm') && req.method === 'GET') {
        if (isBoard) board.get(isBoard[1]);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        });
        return res.end(html);
      }
      if (pathname === '/swarm/teams' && req.method === 'GET') {
        if (req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, {error:'Open Swarm to list its teams.'});
        return send(res,200,recentTeams(board));
      }
      if (pathname==='/swarm/models'&&req.method==='GET') {
        if (req.headers['sec-fetch-site']!=='same-origin') return send(res,403,{error:'Open Swarm to read available models.'});
        return send(res,200,{models:modelOptions(await runner.listModels())});
      }
      if (req.method==='GET'&&(pathname==='/swarm/events'||api?.[2]==='events')) {
        if (req.headers['sec-fetch-site']!=='same-origin') return send(res,403,{error:'Open Swarm to read its live events.'});
        return streamBoard(res,board,api?.[1],view);
      }
      if (transcript && req.method==='GET') {
        if (req.headers['sec-fetch-site']!=='same-origin') return send(res,403,{error:'Open Swarm to read member history.'});
        const [,id,name]=transcript;
        const member=board.get(id).members.find(entry=>entry.name===name);
        if (!member?.threadId) return send(res,404,{error:'No saved chat for this member yet.'});
        const {status,threadId}=member;
        const live=board.activityFor(id)[name]??null;
        res.setHeader('Cross-Origin-Resource-Policy','same-origin');
        let turns;
        try { turns=await runner.readTranscript(threadId); }
        catch {
          if (!res.destroyed) return send(res,502,{error:'Could not load journal from Codex.'});
        }
        if (!res.destroyed) return send(res,200,{member:name,status,threadId,turns,live});
        return;
      }
      if (api && req.method === 'GET' && api[2] === 'status') {
        if (req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, {error:'Open Swarm to read board status.'});
        return send(res, 200, view(board.get(api[1])));
      }
      if (api && req.method === 'GET' && api[2] === 'history') {
        if (req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, {error:'Open Swarm to read board history.'});
        return send(res,200,board.readHistory(api[1],{
          after:searchParams.has('after') ? Number(searchParams.get('after')) : 0,
          limit:searchParams.has('limit') ? Number(searchParams.get('limit')) : 48,
          channel:searchParams.get('channel')??undefined,
        }));
      }
      if (api && req.method==='POST') {
        const type=req.headers['content-type']?.split(';',1)[0].trim().toLowerCase();
        if (req.headers.origin!==origin||type!=='application/json') return send(res,403,{error:'Open this Swarm board to make changes.'});
        const data = await readBody(req);
        if (api[2] === 'post') return send(res,200,view(board.post(api[1],data.text,data.channel)));
        if (api[2] === 'pause') return send(res, 200, view(board.pause(api[1])));
        if (api[2] === 'resume') {
          const {extraTurns} = data;
          if (extraTurns !== undefined && (extraTurns !== 8 || teamPhase(board.get(api[1])) !== 'budget')) {
            throw Error('Eight extra turns can only be added when the board has run out of turns.');
          }
          return send(res, 200, view(board.resume(api[1], extraTurns)));
        }
        if (api[2]==='member-model') {
          const updated=await changeModel({...data,teamId:api[1]},undefined,res);
          if (updated) send(res,200,view(updated));
          return;
        }
        if (api[2]==='member-retire') return send(res,200,view(board.retireMember(api[1],data.member)));
        if (api[2]==='title') return send(res,200,view(board.setTeamTitle(api[1],data.title)));
        if (api[2]==='resolve-recovery') return send(res,200,view(board.resolveRecovery(api[1],data.member,{action:data.action})));
        if (api[2]==='worktree-remove') {
          try {return send(res,200,view(await removeCheckout(api[1],data.member,false)));}
          catch (error) {
            if (/uncommitted/i.test(error.message)) {
              throw Error('Worktree has uncommitted changes. Request force: true in chat to discard them.');
            }
            throw error;
          }
        }
      }
      const peerRequest = pathname === '/peer' && req.method === 'POST';
      if (!peerRequest && !authorized(req.headers.authorization,key)) {
        return send(res, 403, {error:'Invalid local authorization.'});
      }
      if (req.method === 'GET' && pathname === '/ready') {
        return send(res, board ? 200 : 503, {service: 'codex-team-board', version});
      }
      if (req.method === 'POST' && pathname === '/shutdown') {
        if (board.hasRunningTurns()) return send(res,409,{error:'Team Board still has running turns. Wait for them to finish before upgrading.'});
        res.once('finish',close);
        return send(res,200,{service:'codex-team-board',version,stopping:true});
      }
      if (req.method !== 'POST' || !(pathname === '/tool' || peerRequest)) return send(res, 404, {error: 'Route not found.'});
      const {name, arguments: values = {}, scope, context} = await readBody(req);
      let args = values;
      let actor;
      if (peerRequest) {
        if (typeof scope?.teamId !== 'string' || typeof scope?.member !== 'string' ||
          !authorized(req.headers.authorization,Buffer.from('Bearer ' + tokenFor(scope.teamId,scope.member)))) {
          return send(res,403,{error:'Invalid member authorization.'});
        }
        const current = board.get(scope.teamId);
        const member = board.peerMember(current,scope.member,name !== 'peer_tools');
        const catalog = peerCatalog(member);
        if (name === 'peer_tools') return send(res,200,{tools:catalog});
        if (!catalog.some(tool => tool.name === name)) throw Error('This tool is not available to this member.');
        actor = member.name;
        args = {...values,teamId:current.id};
      }
      if (name === 'list_teams') return send(res, 200, {teams: board.list()});
      if (name === 'open_swarm_panel') {
        const team = args.teamId ? board.get(args.teamId) : args.cwd ? board.latestIn(args.cwd) : null;
        return send(res,200,{teamId:team?.id??null,title:team?.title??'Swarm',...panelLink(team, origin)});
      }
      if (name === 'list_models') return send(res, 200, {models: modelOptions(await runner.listModels())});
      if (name === 'board_history') return send(res,200,board.readHistory(args.teamId,{...args,actor}));
      if (name==='wait_for_board') {
        const controller=new AbortController();
        const cancel=()=>controller.abort();
        const onRequestClose=()=>{if(!req.complete) cancel();};
        req.on('close',onRequestClose);
        res.on('close',cancel);
        if (res.destroyed) cancel();
        try {
          const result=await board.waitForBoard(args.teamId,args,controller.signal);
          if (!res.destroyed) send(res,200,{...result,status:view(result.status)});
        } finally {
          req.off('close',onRequestClose);
          res.off('close',cancel);
        }
        return;
      }
      if (name==='manage_channel') return send(res,200,board.manageChannel(args.teamId,args,actor));
      if (actor && name === 'read_board') return send(res,200,board.readPosts(args.teamId,{...args,actor}));
      if (actor && name === 'post_to_board') return send(res,200,board.postFrom(args.teamId,actor,args.text,args.channel));
      if (actor && name === 'set_turn_outcome') return send(res,200,board.declareOutcome(args.teamId,actor,args));
      let team;
      switch (name) {
        case 'start_team': {
          if (Object.hasOwn(args, 'parentSessionId')) {
            throw Error('Host identity cannot be supplied in tool arguments.');
          }
          const members = Array.isArray(args.members) ? args.members : [];
          const selections = members.flatMap(member => [
            member?.model || (args.model && member?.effort)
              ? {model:member?.model ?? args.model, effort:member?.effort === null ? undefined : (member?.effort ?? args.effort)}
              : null,
            member?.fallbackModel ? {model:member.fallbackModel, effort:member.fallbackEffort ?? undefined} : null,
          ]).filter(Boolean);
          if (args.model) selections.unshift({model:args.model,effort:args.effort});
          if (args.fallbackModel) selections.push({model:args.fallbackModel,effort:args.fallbackEffort ?? undefined});
          const [source] = await Promise.all([
            members.some(member => member?.worktree === true) ? worktreeSource(args.cwd) : undefined,
            verifyModels(runner,selections),
          ]);
          if (res.destroyed) return;
          const trustedParent = !peerRequest
            ? (context && typeof context === 'object' && Object.hasOwn(context, 'parentSessionId')
              ? (context.parentSessionId == null || context.parentSessionId === '' ? undefined : context.parentSessionId)
              : extractParentSessionId(null))
            : undefined;
          team = board.create(args, source, {parentSessionId: trustedParent});
          break;
        }
        case 'add_member': {
          const current = board.get(args.teamId);
          const member = args.member;
          const model = member?.model ?? current.model;
          const effort = member?.effort === null ? undefined : (member?.effort ?? current.effort);
          const checks = [
            ...(model && (member?.model || member?.effort) ? [{model,effort}] : []),
            ...(member?.fallbackModel ? [{model:member.fallbackModel,effort:member.fallbackEffort ?? undefined}] : []),
          ];
          const [source] = await Promise.all([
            member?.worktree === true ? current.worktreeSource ?? worktreeSource(current.cwd) : undefined,
            verifyModels(runner,checks),
          ]);
          if (res.destroyed) return;
          team = board.addMember(args.teamId,member,{replaces:args.replaces,worktreeSource:source,actor,fork:args.fork});
          break;
        }
        case 'retire_member': team = board.retireMember(args.teamId,args.member,{actor}); break;
        case 'set_member_model': {
          team=await changeModel(args,actor,res);
          if (!team) return;
          break;
        }
        case 'remove_worktree': {
          team=await removeCheckout(args.teamId,args.member,args.force);
          break;
        }
        case 'open_board':
        case 'board_status': team = board.get(args.teamId); break;
        case 'post_message': team = board.post(args.teamId,args.text,args.channel); break;
        case 'set_team_title': team = board.setTeamTitle(args.teamId,args.title,actor); break;
        case 'set_team_plan': team = board.setTeamPlan(args.teamId,args.threads,actor); break;
        case 'resolve_recovery': team = board.resolveRecovery(args.teamId,args.member,{action:args.action}); break;
        case 'pause_team': team = board.pause(args.teamId); break;
        case 'resume_team': team = board.resume(args.teamId, args.extraTurns); break;
        default: return send(res, 404, {error: 'Tool not found.'});
      }
      send(res, 200, view(team,actor));
    } catch (error) {
      if (!res.destroyed&&!res.headersSent) send(res,400,{error:String(error.message||error).slice(0,500)});
      else if (!res.destroyed) res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  host = '127.0.0.1:' + server.address().port;
  origin = 'http://' + host;
  try {
    board = new TeamBoard(join(dataDirectory, 'teams.sqlite'), async request => {
      const {team,member,remember} = request;
      if (member.worktree) {
        const workspace = await openWorktree(dataDirectory,team.worktreeSource,team.id,member.name,{mustExist:!!member.workspace});
        if (!member.workspace) remember({workspace});
        member.workspace = workspace;
      }
      return runner.run({...request,peerToken:tokenFor(team.id,member.name),peerPort:server.address().port});
    });
  } catch (error) {
    server.close();
    throw error;
  }
  let closing;
  function close() {
    return closing ??= new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
      runner.close();
      board.close();
    });
  }
  return {origin, close};
}

export function launchDaemon(spawnProcess = spawn) {
  const child = spawnProcess(process.execPath, [fileURLToPath(import.meta.url), '--service'], {
    detached:true,windowsHide:true,stdio:'ignore',env:childEnvironment(),
  });
  child.on('error',()=>{});
  child.unref();
}

export async function ensureService({address=origin,dataDirectory=root,launch=launchDaemon} = {}) {
  const authorization = 'Bearer ' + localKey(dataDirectory);
  const ready = async () => {
    try {
      const response = await fetch(address+'/ready',{headers:{authorization},signal:AbortSignal.timeout(500)});
      if (response.ok) return await response.json();
    } catch {}
  };
  const matches = data => data?.service === 'codex-team-board' && data.version === version;
  let running = await ready();
  if (matches(running)) return authorization;
  if (running) {
    if (running.service !== 'codex-team-board' || !/^\d+\.\d+\.\d+$/.test(running.version) ||
      version.localeCompare(running.version,undefined,{numeric:true}) <= 0) {
      throw Error('A service incompatible with Team Board '+version+' is listening at '+address+'.');
    }
    const stopped = await fetch(address+'/shutdown',{method:'POST',headers:{authorization},signal:AbortSignal.timeout(3000)});
    if ([404,405].includes(stopped.status)) {
      throw Error('Team Board '+running.version+' has no shutdown route. Close the old Team Board Node process at '+address+' and reopen Swarm.');
    }
    if (!stopped.ok) throw Error((await stopped.json()).error??'Team Board upgrade could not stop the older daemon.');
    for (let attempt=0;running&&attempt<22;attempt++) {
      running=await ready();
      if (matches(running)) return authorization;
      if (running) await delay(180);
    }
    if (running) throw Error('The older Team Board daemon is still listening at '+address+'.');
  }
  await launch();
  for (let attempt=0;attempt<22;attempt++) {
    if (matches(await ready())) return authorization;
    await delay(180);
  }
  throw Error('Team Board '+version+' could not start at '+address+'.');
}

let startup;
async function toolCall(payload, peer, cancellation) {
  if (peer && (!peer.scope.teamId || !peer.scope.member || !peer.token)) throw Error('Missing Team Board member scope.');
  const authorization = peer ? 'Bearer ' + peer.token : await (startup ??= ensureService().finally(()=>{startup=null;}));
  const timeout = payload.name === 'wait_for_board' ? (boardWaitTimeout(payload.arguments?.timeoutSec)+10)*1000
    : payload.name === 'remove_worktree' ? 135000
    : ['start_team','list_models','add_member','set_member_model'].includes(payload.name) ? 50000 : 10000;
  const deadline=AbortSignal.timeout(timeout);
  const response = await fetch(origin + (peer ? '/peer' : '/tool'), {
    method: 'POST', headers: {authorization, 'Content-Type': 'application/json'},
    body: JSON.stringify(peer ? {...payload,scope:peer.scope} : payload),
    signal: cancellation?AbortSignal.any([deadline,cancellation]):deadline,
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}

function stdio() {
  const peer = process.argv.includes('--peer') ? {
    scope:{teamId:process.env.TEAM_BOARD_PEER_TEAM,member:process.env.TEAM_BOARD_PEER_MEMBER},
    token:process.env.TEAM_BOARD_PEER_TOKEN,
  } : null;
  const sendRpc = value => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...value}) + '\n');
  const calls=new Map();
  let initMeta;
  const input=createInterface({input:process.stdin});
  input.on('close',()=>{for (const controller of calls.values()) controller.abort();});
  input.on('line', async line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method==='notifications/cancelled') {
      calls.get(msg.params?.requestId)?.abort();
      return;
    }
    if (msg.id === undefined) return;
    const reply = result => sendRpc({id: msg.id, result});
    const error = (code, message) => sendRpc({id: msg.id, error: {code, message}});
    switch (msg.method) {
      case 'initialize':
        initMeta = msg.params?._meta;
        return reply({
          protocolVersion: msg.params?.protocolVersion || '2025-11-25',
          serverInfo: {name: peer ? 'hive-swarm-peer' : 'hive-swarm', version},
          capabilities: peer ? {tools: {}} : {tools: {}, resources: {}},
          instructions: peer
            ? 'Read the roster and coordinate within your saved board role and the existing turn budget.'
            : 'Start teams only when requested. For Codex Desktop, use the openInCodex parameters from start_team or open_swarm_panel to open a live Swarm beside the current chat. open_board also supports an inline MCP App. Board refresh never starts model turns.',
        });
      case 'ping': return reply({});
      case 'tools/list':
        try { return reply(peer ? await toolCall({name:'peer_tools'},peer) : {tools}); }
        catch (err) { return error(-32000,String(err.message || err).slice(0,500)); }
      case 'resources/list': return reply({resources: peer ? [] : [{uri: boardUri, name: 'Hive Swarm', mimeType: 'text/html;profile=mcp-app'}]});
      case 'resources/templates/list': return reply({resourceTemplates: []});
      case 'resources/read':
        if (peer || msg.params?.uri !== boardUri) return error(-32602, 'Unknown resource.');
        return reply({contents: [{uri: boardUri, mimeType: 'text/html;profile=mcp-app', text: html}]});
      case 'tools/call': {
        const controller=new AbortController();
        calls.set(msg.id,controller);
        try {
          const {name, arguments: args, _meta} = msg.params ?? {};
          if (!peer && !tools.some(tool => tool.name === name)) throw Error('Tool is not available in this chat.');
          const parentSessionId = !peer && name === 'start_team'
            ? extractParentSessionId(_meta, {}) ?? extractParentSessionId(initMeta, process.env)
            : undefined;
          const payload = {name, arguments: args, ...(parentSessionId ? {context: {parentSessionId}} : {})};
          const data = await toolCall(payload, peer, controller.signal);
          const summary = name === 'open_swarm_panel'
            ? data.title + '\n[' + data.openLabel + '](' + data.url + ')'
            : name==='wait_for_board'
            ? data.wokeBy+' · '+data.phase+' · #'+data.head+
              data.posts.slice(-10).map(post=>'\n#'+post.seq+' @'+post.author+' '+post.text).join('')
            : data.id
            ? data.title + '\nTeam ID: ' + data.id + '\nBoard: ' + data.url +
              '\n' + data.members.map(m => '@' + m.name + ' · ' + m.status).join('\n')
            : data.posts ? data.posts.length+' posts · #'+data.earliest+'–'+data.head : JSON.stringify(data);
          return reply({content: [{type: 'text', text: summary}], structuredContent: data});
        } catch (err) {
          if (!controller.signal.aborted) return reply({isError:true,content:[{type:'text',text:String(err.message||err).slice(0,500)}]});
        } finally {
          calls.delete(msg.id);
        }
        return;
      }
      default: return error(-32601, 'Method not found.');
    }
  });
}

if (import.meta.main) {
  if (process.argv.includes('--service')) {
    try {
      const {close} = await service();
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, close);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  } else stdio();
}
