import React, {useEffect,useRef,useState} from 'react';
import styles from './tool-result.css';

const TEAM_ID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function swarmTarget(navigation) {
  return navigation?.kind==='hive-swarm'&&typeof navigation.teamId==='string'&&TEAM_ID.test(navigation.teamId)
    ?navigation.teamId.toLowerCase():null;
}

export function SwarmToolResult({toolName,phase,block,callId,openSwarm}) {
  const request=useRef(null);
  const [interaction,setInteraction]=useState(null);
  const settled=phase==='result'&&block?.kind==='tool-result';
  const failed=settled&&block.isError;
  const target=settled&&block.isError===false?swarmTarget(block.meta?.navigation):null;
  const status=phase==='preparing'?'Preparing…':!settled?'Running…':failed?'Failed':'Completed';
  const title=toolName==='hive_swarm_start_team'?'Start Swarm':'Find Swarm team';
  const output=settled?(block.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';
  const current=interaction?.callId===callId&&interaction?.target===target?interaction:null;

  useEffect(()=>()=>{request.current?.abort();request.current=null;},[callId,target]);
  async function open() {
    if(!target||request.current)return;
    const controller=new AbortController();request.current=controller;
    setInteraction({callId,target,pending:true});
    try {
      await openSwarm(target,controller.signal);
      if(!controller.signal.aborted)setInteraction(null);
    } catch(error) {
      if(!controller.signal.aborted)setInteraction({callId,target,error:error?.message??'Try opening the team again.'});
    } finally {
      if(request.current===controller)request.current=null;
    }
  }

  return <section className="dsh-hive-tool" aria-label={title}>
    <style>{styles}</style>
    <div className="dsh-hive-tool-line">
      <strong>{title}</strong><span role="status" data-failed={failed||undefined}>{status}</span>
      {target?<button type="button" onClick={open} disabled={Boolean(current?.pending)}>Open Swarm</button>:null}
    </div>
    {failed?<p role="alert">{block.error?.reason||output.split('\n',1)[0]||'The Host could not complete this tool call.'}</p>:null}
    {output?<details><summary>Tool result</summary><pre>{output}</pre></details>:null}
    {current?.pending?<p role="status">Opening team…</p>:null}
    {current?.error?<p role="alert">Could not open Swarm: {current.error}</p>:null}
  </section>;
}
