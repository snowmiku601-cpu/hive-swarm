(() => {
  'use strict';

  function isPost(event) {
    return event.kind === 'brief' || event.kind === 'message' ||
      (!event.kind && event.author !== 'system');
  }

  function project(posts, members, cursor, {hideInactive=false,expandBroadcast=false}={}) {
    const names = new Map([['coordinator',{name:'coordinator',role:'coordinator',status:'waiting'}]]);
    for (const member of members) names.set(member.name,member);
    const seen = new Set();
    const counts = new Map();
    const links = new Map();
    let broadcasts = 0;
    function addName(name) {
      if (!names.has(name)) names.set(name,{name,status:'observer'});
      seen.add(name);
    }
    for (const event of posts) {
      if (event.seq > cursor || !isPost(event)) continue;
      const {author,targets=[]} = event;
      addName(author);
      const outgoing = counts.get(author) ?? {posts:0,mentions:0,broadcasts:0,lastSeq:0};
      outgoing.posts++;
      outgoing.lastSeq=event.seq;
      counts.set(author,outgoing);
      const all = event.broadcast ?? /(?:^|[^a-z0-9_])@all(?![a-z0-9_-])/i.test(event.text ?? '');
      if (all) {
        outgoing.broadcasts++;
        broadcasts++;
      }
      for (const to of new Set(targets)) {
        if (to === author) continue;
        addName(to);
        if (all && !expandBroadcast) continue;
        const key=author+'>'+to;
        const link=links.get(key) ?? {from:author,to,count:0,direct:0,broadcast:0,lastSeq:0};
        link.count++;
        if (all) link.broadcast++; else link.direct++;
        link.lastSeq=event.seq;
        outgoing.mentions++;
        links.set(key,link);
      }
    }
    return {
      nodes:[...names.values()].filter(node => !hideInactive || seen.has(node.name))
        .map(node => ({...node,...counts.get(node.name)})),
      links:[...links.values()],broadcasts,
    };
  }

  function layout(nodes,width,height) {
    const result=new Map();
    if (nodes.length>11) {
      const columns=Math.max(2,Math.floor(width/112));
      const rows=Math.ceil(nodes.length/columns);
      const rowHeight=height/(rows+1);
      const columnWidth=width/(columns+1);
      nodes.forEach((node,index) => {
        const row=Math.floor(index/columns);
        result.set(node.name,{x:columnWidth*(1+index%columns)+(row%2 ? columnWidth*0.24 : 0),
          y:rowHeight*(row+1)});
      });
      return result;
    }
    const center=nodes.find(node=>node.role==='coordinator') ?? nodes[0];
    if (!center) return result;
    const outer=nodes.filter(node=>node!==center);
    result.set(center.name,{x:width/2,y:height/2});
    outer.forEach((node,index)=>{
      const angle=-Math.PI/2+index*Math.PI*2/outer.length;
      const radiusX=Math.max(40,Math.min(width*0.38,(width-92)/2));
      result.set(node.name,{x:width/2+Math.cos(angle)*radiusX,y:height/2+Math.sin(angle)*(height-100)/2});
    });
    return result;
  }

  function drawGrid(ctx,width,height,color) {
    const r=22;
    const h=Math.sqrt(3)*r;
    ctx.strokeStyle=color;
    ctx.lineWidth=0.8;
    ctx.beginPath();
    for (let col=-1;col<width/(r*1.5)+1;col++) {
      for (let row=-1;row<height/h+1;row++) {
        const x=col*1.5*r;
        const y=row*h+((col%2)*h/2);
        for (let side=0;side<6;side++) {
          const angle=side*Math.PI/3;
          const px=x+r*Math.cos(angle),py=y+r*Math.sin(angle);
          if (side===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();
  }

  function draw(canvas,projection,points,focus,highlight,color) {
    const width=canvas.clientWidth;
    const height=canvas.clientHeight;
    if (!width || !height) return;
    const scale=Math.min(devicePixelRatio || 1,2);
    const pixelsWide=Math.round(width*scale),pixelsHigh=Math.round(height*scale);
    if (canvas.width!==pixelsWide || canvas.height!==pixelsHigh) {
      canvas.width=pixelsWide;
      canvas.height=pixelsHigh;
    }
    const ctx=canvas.getContext('2d');
    ctx.setTransform(scale,0,0,scale,0,0);
    ctx.clearRect(0,0,width,height);
    drawGrid(ctx,width,height,color.grid);
    ctx.font='600 10px ui-monospace, monospace';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    for (const link of projection.links) {
      const start=points.get(link.from),end=points.get(link.to);
      if (!start || !end) continue;
      const dx=end.x-start.x,dy=end.y-start.y;
      const distance=Math.hypot(dx,dy);
      if (distance<48) continue;
      const ux=dx/distance,uy=dy/distance;
      const a={x:start.x+ux*24,y:start.y+uy*24};
      const b={x:end.x-ux*29,y:end.y-uy*29};
      const bend=Math.min(28,8+distance*0.065);
      const c={x:(a.x+b.x)/2-uy*bend,y:(a.y+b.y)/2+ux*bend};
      const pulse=link.lastSeq===highlight;
      const related=!focus || link.from===focus || link.to===focus;
      const stroke=pulse && related ? color.accent : color.link;
      ctx.globalAlpha=related ? (pulse ? 1 : 0.68) : 0.16;
      ctx.strokeStyle=ctx.fillStyle=stroke;
      ctx.lineWidth=Math.min(4,0.9+Math.sqrt(link.count)*0.65);
      ctx.setLineDash(link.direct ? [] : [4,4]);
      ctx.beginPath();
      ctx.moveTo(a.x,a.y);
      ctx.quadraticCurveTo(c.x,c.y,b.x,b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const angle=Math.atan2(b.y-c.y,b.x-c.x);
      ctx.beginPath();
      ctx.moveTo(b.x,b.y);
      for (const wing of [-0.48,0.48]) ctx.lineTo(b.x-7*Math.cos(angle+wing),b.y-7*Math.sin(angle+wing));
      ctx.closePath();
      ctx.fill();
      if (related && (link.count>1 || pulse || focus)) {
        const x=(a.x+2*c.x+b.x)/4,y=(a.y+2*c.y+b.y)/4;
        ctx.globalAlpha=0.98;
        ctx.fillStyle=color.paper;
        ctx.fillRect(x-9,y-7,18,14);
        ctx.fillStyle=pulse ? color.accent : color.text;
        ctx.fillText(String(link.count),x,y+0.25);
      }
    }
    ctx.globalAlpha=1;
  }

  globalThis.HiveGraph=Object.freeze({isPost,project,layout,draw});
})();
