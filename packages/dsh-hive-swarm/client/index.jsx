import {createController,createSurfaceStore,readExactTeam} from './controller.mjs';
import {BeeIcon,DockSurface,FullSurface} from './views.jsx';
import {SwarmToolResult} from './tool-result.jsx';

export const name='dsh-hive-swarm';
export const inject=['slots','connection','layout','sidebarRightTabs'];
const REGISTRATIONS=Symbol.for('hive-swarm.native-client.registrations');
const registrations=globalThis[REGISTRATIONS]??=new WeakMap();
const TOOL_RESULTS=['hive_swarm_open_swarm_panel','hive_swarm_start_team'];

export function apply(ctx) {
  const slots=ctx.slots;
  if(registrations.has(slots))return;
  if(typeof slots?.inject!=='function'||typeof slots?.register!=='function'||typeof ctx.sidebarRightTabs?.register!=='function'||typeof ctx.layout?.selectPanel!=='function') {
    ctx.logger?.warn?.('Hive Swarm needs DSH right-tab, slot and layout capabilities. Enable them and reload the bundle.');return;
  }
  ctx.effect(()=>{
    if(registrations.has(slots))return()=>{};
    const surfaces=createSurfaceStore((sessionId,teamId,workspace)=>createController({connection:ctx.connection,sessionId,teamId,workspace,
      openSession:id=>{
        const workspace=ctx.uiWorkspace;
        if(typeof workspace?.openSession!=='function')throw Error('Enable the DSH workspace capability to open a worker session.');
        return workspace.openSession(id);
      }}));
    const disposers=[];const identity={};let navigation=null;registrations.set(slots,identity);
    function dispose() {
      navigation?.abort();
      for(const release of disposers.splice(0).reverse())release?.();
      surfaces.dispose();if(registrations.get(slots)===identity)registrations.delete(slots);
    }
    function select(controller) {
      const previous=surfaces.getSnapshot();surfaces.select(controller);
      try{ctx.layout.selectPanel(name);}catch(error){surfaces.select(previous);throw error;}
    }
    function expand(controller) {
      navigation?.abort();
      try{select(controller);}catch(error){controller.setError(error);}
    }
    async function openSwarm(parentSessionId,teamId,callerSignal) {
      if(!parentSessionId||registrations.get(slots)!==identity)throw Error('The original DSH session is unavailable.');
      navigation?.abort();const request=new AbortController();navigation=request;
      let signal;
      try {
        const layoutSignal=ctx.layout.beginNavigation?.();
        signal=AbortSignal.any([request.signal,callerSignal,...layoutSignal?[layoutSignal]:[]]);
        const team=await readExactTeam(ctx.connection,teamId,signal);
        signal.throwIfAborted();
        select(surfaces.forSession(parentSessionId,team.id,team.cwd));
      } catch(error) {
        if(!signal?.aborted)throw error;
      } finally {
        if(navigation===request)navigation=null;
      }
    }
    try {
      disposers.push(ctx.sidebarRightTabs.register({id:name,kind:'hive-swarm',title:()=> 'Swarm',patterns:['hive-swarm://team/**'],
        guide:[{id:'open',order:900,title:()=> 'Swarm',icon:BeeIcon}]}));
      disposers.push(slots.inject('sidebar.right.pane.tab',()=>slots.register({name:'sidebar.right.pane.tab',key:name,
        inject:sessionId=>({parentSessionId:sessionId,controllerForTeam:(teamId,workspace)=>surfaces.forSession(sessionId,teamId,workspace),onExpand:expand})},DockSurface)));
      disposers.push(slots.inject('sidebar.panellist',()=>slots.register({name:'sidebar.panellist',id:name,order:30,label:()=> 'Hive Swarm'},BeeIcon)));
      disposers.push(slots.inject('main',()=>slots.register({name:'main',key:name,inject:()=>({surfaces})},FullSurface)));
      for(const key of TOOL_RESULTS)disposers.push(slots.inject('tool.call.toolview',()=>slots.register({
        name:'tool.call.toolview',key,inject:sessionId=>({openSwarm:(teamId,signal)=>openSwarm(sessionId,teamId,signal)}),
      },SwarmToolResult)));
      // Reconnect only invalidates active read feeds. It never retries a command.
      const generation=ctx.connection?.generation;
      if(typeof generation?.subscribe==='function')disposers.push(generation.subscribe(()=>{
        if(generation.getSnapshot()!==undefined)surfaces.reconnect();
      }));
      else if(typeof ctx.on==='function')disposers.push(ctx.on('connection/reset',()=>surfaces.reconnect()));
    } catch(error) {
      dispose();ctx.logger?.warn?.('Hive Swarm could not register its native UI: '+error.message);return()=>{};
    }
    return dispose;
  },'hive-swarm: native launcher and views');
}
