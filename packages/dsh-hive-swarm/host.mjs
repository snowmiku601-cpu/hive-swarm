import {mkdirSync,realpathSync,readFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {NativeRunner} from './runner.mjs';
import {createNativeAccess} from './native.mjs';
import {ownerActions,registerRoutes} from './routes.mjs';

export const name='dsh-hive-swarm';
export const inject=['connection','typertGateway','sessionController','sessions','agents','agentPresets','llm','sandboxPolicy','fs','shell','workspaceRegistry','tools','skills','profileContext','subagents'];
const hosts=new WeakMap();
const workerVisible=new Set(['list_models','board_status','board_history','read_board','post_message','set_turn_outcome','add_member','retire_member','set_member_model','manage_channel']);
const coordinatorVisible=new Set([...workerVisible,'set_team_title','set_team_plan']);
const memberSchema={type:'object',properties:{
  name:{type:'string'},brief:{type:'string'},group:{type:['string','null']},model:{type:['string','null']},effort:{type:['string','null']},
  fallbackModel:{type:['string','null']},fallbackEffort:{type:['string','null']},writable:{type:['boolean','null']},worktree:{type:['boolean','null']},
  fork:{type:['string','null'],description:'Optional fork source: "coordinator" to branch from the parent chat (or a teammate name in add_member), or null.'},
  waitFor:{type:['array','null'],items:{type:'string'}},channels:{type:['array','null'],items:{type:'string'}},
  n:{type:['integer','null'],minimum:2,maximum:8,description:'Optional sharding count: spawns name-1..name-n as separate parallel workers in group name. Pass null or omit for a single worker.'},
  tasks:{type:['array','null'],items:{type:'string'},minItems:2,maxItems:8,description:'Optional sharding targets: spawns one parallel worker per item (name-1..name-k) in group name. Pass null or omit for a single worker; put a single worker checklist in brief.'},
},required:['name','brief'],additionalProperties:false};
const threadSchema={type:'object',properties:{
  id:{type:'string'},title:{type:'string'},goal:{type:'string'},members:{type:['array','null'],items:{type:'string'}},
},required:['id','title','goal'],additionalProperties:false};
const fields={
  start_team:['cwd','task','title','members','coordinator','model','effort','fallbackModel','fallbackEffort','threads','concurrency','turnLimit'],
  list_teams:[],list_models:[],board_status:['teamId'],board_history:['teamId','after','limit','channel'],
  read_board:['teamId','after','limit','channel','mentionsOnly'],open_swarm_panel:['teamId'],
  post_message:['teamId','text','channel'],pause_team:['teamId'],resume_team:['teamId','extraTurns'],
  resolve_recovery:['teamId','member','action'],
  set_team_title:['teamId','title'],set_team_plan:['teamId','threads'],manage_channel:['teamId','op','channel','member','topic'],
  add_member:['teamId','member','replaces','fork'],retire_member:['teamId','member'],
  set_member_model:['teamId','member','model','effort','resume'],remove_worktree:['teamId','member','force'],
  read_journal:['teamId','member'],wait_for_board:['teamId','since','timeoutSec','channel','mentionsOnly'],
  set_turn_outcome:['turn','state','message','notify','waitFor'],
};
const requiredFields={
  start_team:['cwd','task','members'],
  open_swarm_panel:['teamId'],pause_team:['teamId'],resume_team:['teamId'],wait_for_board:['teamId'],
  resolve_recovery:['teamId','member'],remove_worktree:['teamId','member'],read_journal:['teamId','member'],
  post_message:['text'],set_team_title:['title'],set_team_plan:['threads'],manage_channel:['op'],
  add_member:['member'],retire_member:['member'],set_member_model:['member','model'],
  set_turn_outcome:['turn','state','message'],
};
const descriptions={
  start_team:'Start a native Hive Swarm only when the user asks. Use this chat as coordinator; assign disjoint file ownership, peer-to-peer handoffs, and optional outcome threads or fallbackModel.',
  list_models:'List available native models and reasoning efforts, plus host-verified currentSession workspace and active model route.',
  set_turn_outcome:'Submit this owned worker turn result (state, message, notify, waitFor) and conclude the turn. Do not duplicate the same report via hive_swarm_post_message first.',
  post_message:'Post a message on the shared board. Tag @name, @group, @#channel, or @all only for members who must act.',
  read_board:'Read recent public posts on the board without waking members (limit 1–20).',
  board_history:'Page through saved board history (up to 200 posts per call).',
  board_status:'Read current team status, roster, channels, threads, and stall alerts.',
  resolve_recovery:'Resolve an unconfirmed native worker outcome after inspecting the owned session: action is "dismiss" or "retry".',
  set_team_plan:'Set or update outcome-grouped threads for the Swarm Overview.',
  set_member_model:'Switch a member model and reasoning effort (pass effort: null for model default, resume: true to wake an idle member).',
  manage_channel:'List channels or manage subscriptions (create, list, subscribe, unsubscribe, archive).',
  add_member:'Add or replace a worker, optionally inheriting a teammate or coordinator chat via fork.',
  retire_member:'Retire a named member or shard group.',
  wait_for_board:'Wait without polling for matching posts or a stopped phase (timeoutSec 1–55).',
};
const nullable=(schema,required)=>required||Array.isArray(schema.type)||schema.type==='object'?schema:
  {...schema,type:[schema.type,'null'],...schema.enum?{enum:[...schema.enum,null]}:{}};
const baseParameter=(action,key)=>key==='limit'&&action==='read_board'?{type:'integer',minimum:1,maximum:20}:
  key==='limit'&&action==='board_history'?{type:'integer',minimum:1,maximum:200}:
  key==='timeoutSec'?{type:'integer',minimum:1,maximum:55}:
  ['turn','extraTurns','after','limit','concurrency','turnLimit','since'].includes(key)?{type:'integer'}:
  key==='state'?{type:'string',enum:['done','waiting']}:
  key==='op'?{type:'string',enum:['create','list','subscribe','unsubscribe','archive']}:
  key==='action'?{type:'string',enum:['dismiss','retry']}:
  key==='effort'||key==='fallbackEffort'?{type:['string','null']}:
  ['coordinator','resume','force','mentionsOnly'].includes(key)?{type:'boolean'}:
  key==='members'?{type:'array',items:memberSchema}:
  key==='threads'?{type:'array',items:threadSchema}:
  ['notify','waitFor'].includes(key)?{type:'array',items:{type:'string'}}:
  key==='member'?(action==='add_member'?memberSchema:{type:'string'}):{type:'string'};
const parameter=(action,key)=>nullable(baseParameter(action,key),Boolean(requiredFields[action]?.includes(key)));
const keepNull=new Set(['effort','fallbackEffort']);
const emptyAsOmit=new Set(['teamId','title','group','model','fallbackModel','channel','replaces','fork','topic','member']);
function plain(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function cleanObject(obj,required=new Set()) {
  const out={};
  for(const [key,value] of Object.entries(obj)) {
    if(value===undefined)continue;
    if(value===null&&!keepNull.has(key))continue;
    if(value===''&&!required.has(key)&&emptyAsOmit.has(key))continue;
    out[key]=value;
  }
  if(!out.fallbackModel&&out.fallbackEffort===null)delete out.fallbackEffort;
  return out;
}
function normalizeArgs(action,args) {
  const out=cleanObject(args,new Set(requiredFields[action]??[]));
  if(Array.isArray(out.members))out.members=out.members.map(m=>plain(m)?cleanObject(m,new Set(['name','brief'])):m);
  if(action==='add_member'&&plain(out.member))out.member=cleanObject(out.member,new Set(['name','brief']));
  if(Array.isArray(out.threads))out.threads=out.threads.map(t=>plain(t)?cleanObject(t,new Set(['id','title','goal'])):t);
  return out;
}
function lossless(value){return JSON.parse(JSON.stringify(value??null));}
function navigation(value){const target=value?.navigation;
  return value?.host==='deepseek-harness'&&target?.kind==='hive-swarm'&&typeof target.teamId==='string'&&/^[a-f0-9-]{36}$/.test(target.teamId)?
    {navigation:{kind:'hive-swarm',teamId:target.teamId}}:null;}
function checkFields(action,args){if(!plain(args)||Object.keys(args).some(key=>!fields[action]?.includes(key)))throw Error('Invalid command fields or caller-supplied identity.');}
function canonical(path){try{return realpathSync(path)}catch{throw Error('Workspace is unavailable.')}}
export function resolveDataDirectory(ctx) {
  const directory=ctx.profileContext?.dir;
  if(typeof directory!=='string'||!isAbsolute(directory))throw Error('DSH profileContext is required for isolated Hive storage.');
  return join(resolve(directory),'.hive-swarm');
}

/** Instantiate one scoped Host. Factories keep no-model native lifecycle tests independent of npm publishing. */
export async function createHost(ctx,{dataDirectory=resolveDataDirectory(ctx),coreFactory,storeFactory,nativeFactory=createNativeAccess}={}) {
  if(!isAbsolute(dataDirectory))throw Error('Hive Swarm data directory must be absolute.');
  if(!coreFactory)coreFactory=(await import('hive-swarm/core')).createSwarmApplication;
  if(!storeFactory){const {RunStore}=await import('hive-swarm/run-store');storeFactory=file=>new RunStore(file);}
  mkdirSync(dataDirectory,{recursive:true});
  const store=storeFactory(join(dataDirectory,'runs.sqlite'));let runner,application,releaseRoutes;const releases=[];let closing;
  const closeStore=result=>{if(result?.quiescent===false){void runner.close().then(()=>store.close()).catch(()=>{});}else store.close();};
  try {
    const native=nativeFactory(ctx,{ownsSession:id=>Boolean(store.findSession(id)),coordinationTools:[...coordinatorVisible].map(action=>'hive_swarm_'+action)});runner=new NativeRunner({native,store});
    const workspaceAllowed=(cwd,context={})=>{
      if(context.parentWorkspace&&!same(cwd,context.parentWorkspace))return false;
      return ctx.workspaceRegistry.list().some(workspace=>{try{return same(workspace.path,cwd);}catch{return false;}});
    };
    application=coreFactory({dataDirectory,runner,host:'deepseek-harness',workspaceAllowed});
    await runner.reconcile(application.board);
    releaseRoutes=registerRoutes({connection:ctx.connection,application});
    if(typeof ctx.skills?.register!=='function')throw Error('Native DSH skills are required for /hive-swarm.');
    releases.push(ctx.skills.register({name:'hive-swarm',description:'Coordinate user-requested native worker teams with the Swarm panel.',
      source:'bundled',provider:name,invocation:{modelInvocable:true,userInvocable:true},
      content:readFileSync(new URL('./skills/hive-swarm/SKILL.md',import.meta.url),'utf8')}));
    for(const action of [...ownerActions,'set_turn_outcome']) {
      const tool={name:'hive_swarm_'+action,description:descriptions[action]??('Hive Swarm: '+action.replaceAll('_',' ')+'.'),
        parameters:{type:'object',properties:Object.fromEntries(fields[action].map(key=>[key,parameter(action,key)])),
          ...requiredFields[action]?.length?{required:requiredFields[action]}:{},additionalProperties:false},
        output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
          ...['start_team','open_swarm_panel'].includes(action)?{presentationMeta:(_args,value)=>navigation(value)}:{}},
        async execute(rawArgs,exec) {
          checkFields(action,rawArgs);exec.signal.throwIfAborted();const args=normalizeArgs(action,rawArgs);const agent=exec.agent;
          if(!native.isCurrentAgent(agent))throw Error('A trusted current native Agent is required.');
          const owned=store.findSession(agent.id);const actor=runner.actorForSession(agent.id);
          if(owned&&!actor)throw Error('This owned worker session has no active Hive turn.');
          const context={signal:exec.signal,...actor?{actor}:{parentWorkspace:agent.session?.header?.cwd,
            ...(action==='start_team'&&typeof agent.id==='string'&&agent.id?{parentSessionId:agent.id}:{})},
            ...exec.callId?{requestId:String(exec.callId)}:{}};
          if(action==='set_turn_outcome') {
            if(!actor||args.turn!==actor.turn)throw Error('The outcome must match this owned active turn.');
            const value=await application.command(action,args,context);
            await runner.setOutcome(agent.id,actor.turn,args);exec.concludeTurn();return lossless(value);
          }
          if(!actor&&action==='start_team'&&!same(args.cwd,context.parentWorkspace))throw Error('Use the current native chat workspace.');
          const value=await application.command(actor&&action==='post_message'?'post_to_board':action,args,context);
          if(action==='list_models'&&typeof native.sessionRoute==='function') {
            const currentSession=await native.sessionRoute(agent,exec.signal);
            return lossless(currentSession?{...value,currentSession}:value);
          }
          return lossless(action==='start_team'?{...value,navigation:{kind:'hive-swarm',teamId:value.id}}:value);
        }};
      releases.push(ctx.tools.register(tool,{when:({agent})=>{
        if(!native.isCurrentAgent(agent))return false;
        const owned=store.findSession(agent.id);
        if(!owned)return action!=='set_turn_outcome';
        const actor=runner.actorForSession(agent.id);
        if(!actor)return false;
        try{
          const role=application.board.get(actor.teamId).members.find(m=>m.name===actor.member)?.role;
          return (role==='coordinator'?coordinatorVisible:workerVisible).has(action);
        }catch{return false;}
      }}));
    }
    return {application,runner,store,
      close(){return closing??=(async()=>{await releaseRoutes?.();for(const release of releases.reverse())await release();
        const result=await application.close();closeStore(result);return result;})();}};
  } catch(error){await releaseRoutes?.();for(const release of releases.reverse())await release();const result=await application?.close();if(!application)await runner?.close();closeStore(result);throw error;}
}
function same(left,right){return typeof left==='string'&&typeof right==='string'&&canonical(left)===canonical(right);}

export async function apply(ctx,config={}) {
  if(hosts.has(ctx.connection)){await hosts.get(ctx.connection);return;}
  const loading=createHost(ctx,{dataDirectory:config.dataDirectory??resolveDataDirectory(ctx)});hosts.set(ctx.connection,loading);
  try{const host=await loading;ctx.effect(()=>async()=>{try{await host.close()}finally{hosts.delete(ctx.connection)}});}
  catch(error){hosts.delete(ctx.connection);throw error;}
}
