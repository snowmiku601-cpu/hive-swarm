import {mkdirSync,realpathSync,readFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {NativeRunner} from './runner.mjs';
import {createNativeAccess} from './native.mjs';
import {ownerActions,registerRoutes} from './routes.mjs';

export const name='dsh-hive-swarm';
export const inject=['connection','typertGateway','sessionController','sessions','agents','workspaceRegistry','tools','skills','profileContext'];
const hosts=new WeakMap();
const fields={
  start_team:['cwd','task','title','members','coordinator','model','effort','concurrency','turnLimit'],
  list_teams:[],list_models:[],board_status:['teamId'],board_history:['teamId','after','limit','channel'],
  read_board:['teamId','after','limit','channel','mentionsOnly'],open_swarm_panel:['teamId'],
  post_message:['teamId','text','channel'],pause_team:['teamId'],resume_team:['teamId','extraTurns'],
  set_team_title:['teamId','title'],manage_channel:['teamId','op','channel','member','topic'],
  add_member:['teamId','member','replaces','fork'],retire_member:['teamId','member'],
  set_member_model:['teamId','member','model','effort','resume'],remove_worktree:['teamId','member','force'],
  read_journal:['teamId','member'],wait_for_board:['teamId','since','timeoutSec','channel','mentionsOnly'],
  set_turn_outcome:['turn','state','message','notify','waitFor'],
};
const parameter=key=>['turn','extraTurns','after','limit','concurrency','turnLimit','since','timeoutSec'].includes(key)?{type:'number'}:
  key==='state'?{type:'string',enum:['done','waiting']}:
  ['coordinator','resume','force','mentionsOnly'].includes(key)?{type:'boolean'}:
  ['members','notify','waitFor'].includes(key)?{type:'array',items:{type:key==='members'?'object':'string'}}:
  key==='member'?{anyOf:[{type:'string'},{type:'object'}]}:{type:'string'};
function plain(value){return value&&typeof value==='object'&&!Array.isArray(value);}
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
    const native=nativeFactory(ctx,{ownsSession:id=>Boolean(store.findSession(id)),coordinationTools:[...ownerActions,'set_turn_outcome'].map(action=>'hive_swarm_'+action)});runner=new NativeRunner({native,store});
    const workspaceAllowed=(cwd,context={})=>{
      if(context.parentWorkspace&&!same(cwd,context.parentWorkspace))return false;
      return ctx.workspaceRegistry.list().some(workspace=>same(workspace.path,cwd));
    };
    application=coreFactory({dataDirectory,runner,host:'deepseek-harness',workspaceAllowed});
    await runner.reconcile(application.board);
    releaseRoutes=registerRoutes({connection:ctx.connection,application});
    if(typeof ctx.skills?.register!=='function')throw Error('Native DSH skills are required for /hive-swarm.');
    releases.push(ctx.skills.register({name:'hive-swarm',description:'Coordinate user-requested native worker teams with the Swarm panel.',
      source:'bundled',provider:name,invocation:{modelInvocable:true,userInvocable:true},
      content:readFileSync(new URL('./skills/hive-swarm/SKILL.md',import.meta.url),'utf8')}));
    for(const action of [...ownerActions,'set_turn_outcome']) {
      const tool={name:'hive_swarm_'+action,description:action==='start_team'?
        'Start a native Hive Swarm only when the user asks. Use this chat as coordinator; do not create a second coordinator.':
        action==='set_turn_outcome'?'Submit this owned worker turn result and conclude the turn.':'Hive Swarm: '+action.replaceAll('_',' ')+'.',
        parameters:Object.fromEntries(fields[action].map(key=>[key,parameter(key)])),
        output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
          ...['start_team','open_swarm_panel'].includes(action)?{presentationMeta:(_args,value)=>navigation(value)}:{}},
        async execute(args,exec) {
          checkFields(action,args);exec.signal.throwIfAborted();const agent=exec.agent;
          if(!native.isCurrentAgent(agent))throw Error('A trusted current native Agent is required.');
          const owned=store.findSession(agent.id);const actor=runner.actorForSession(agent.id);
          if(owned&&!actor)throw Error('This owned worker session has no active Hive turn.');
          const context={signal:exec.signal,...actor?{actor}:{parentWorkspace:agent.session?.header?.cwd},
            ...exec.callId?{requestId:String(exec.callId)}:{}};
          if(action==='set_turn_outcome') {
            if(!actor||args.turn!==actor.turn)throw Error('The outcome must match this owned active turn.');
            const value=await application.command(action,args,context);
            await runner.setOutcome(agent.id,actor.turn,args);exec.concludeTurn();return value;
          }
          if(!actor&&action==='start_team'&&!same(args.cwd,context.parentWorkspace))throw Error('Use the current native chat workspace.');
          const value=await application.command(actor&&action==='post_message'?'post_to_board':action,args,context);
          return action==='start_team'?{...value,navigation:{kind:'hive-swarm',teamId:value.id}}:value;
        }};
      releases.push(ctx.tools.register(tool,{when:({agent})=>native.isCurrentAgent(agent)&&(!store.findSession(agent.id)||Boolean(runner.actorForSession(agent.id)))}));
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
