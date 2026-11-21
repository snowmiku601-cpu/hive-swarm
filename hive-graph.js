(() => {
  'use strict';

  function isPost(event) {
    return event.kind === 'brief' || event.kind === 'message' ||
      (!event.kind && event.author !== 'system');
  }

  function elapsedSpan(posts,{live=false,now=Date.now()}={}) {
    const times=posts.map(post=>Date.parse(post.time)).filter(Number.isFinite);
    if (!times.length) return '<1m';
    const minutes=Math.max(0,Math.floor(((live?now:times.at(-1))-times[0])/60000));
    if (!minutes) return '<1m';
    if (minutes<60) return minutes+'m';
    return Math.floor(minutes/60)+'h'+(minutes%60?' '+minutes%60+'m':'');
  }

  function unmentionedNode(node) {return Boolean(node.unmentioned&&!node.mentions&&!node.broadcasts);}

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
      const {author} = event;
      const targets=[...new Set([...(event.targets??[]),...(event.coordinatorMention?['coordinator']:[])])];
      addName(author);
      const outgoing = counts.get(author) ?? {posts:0,mentions:0,broadcasts:0,unmentioned:0,lastSeq:0};
      outgoing.posts++;
      outgoing.lastSeq=event.seq;
      counts.set(author,outgoing);
      const all = event.broadcast ?? /(?:^|[^a-z0-9_])@all(?![a-z0-9_-])/i.test(event.text ?? '');
      if (all) {
        outgoing.broadcasts++;
        broadcasts++;
      }
      if (!all&&!event.coordinatorMention&&!targets.some(to=>to!==author)) outgoing.unmentioned++;
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

  function gridLayout(count,width) {return count>6||(count>3&&width<440);}
  function columns(width) {return Math.max(1,Math.floor(width/120));}
  function minimumHeight(count,width) {
    if (gridLayout(count,width)) {
      const rows=Math.ceil(count/columns(width));
      return Math.max(340,rows*124+44);
    }
    if (count>=6) return 470;
    if (count===5) return 450;
    if (count===4) return 400;
    return 0;
  }

  function layout(nodes,width,height) {
    const result=new Map();
    if (!nodes.length) return result;
    if (gridLayout(nodes.length,width)) {
      const count=columns(width);
      const rows=Math.ceil(nodes.length/count);
      const columnWidth=width/count;
      const topPad=56;
      const bottomPad=66;
      const usable=Math.max(0,height-topPad-bottomPad);
      nodes.forEach((node,index) => {
        const row=Math.floor(index/count);
        const inRow=Math.min(count,nodes.length-row*count);
        const y=rows===1?Math.max(topPad,Math.min(height-bottomPad,height/2-8)):topPad+(row/(rows-1))*usable;
        result.set(node.name,{x:columnWidth*(index%count+0.5+(count-inRow)/2),y});
      });
      return result;
    }
    const center=nodes.find(node=>node.role==='coordinator') ?? nodes[0];
    if (!center) return result;
    const outer=nodes.filter(node=>node!==center);
    const topPad=56;
    const bottomPad=66;
    const centerY=(topPad+(height-bottomPad))/2;
    const radiusY=Math.max(48,(height-topPad-bottomPad)/2);
    const sidePad=Math.min(68,Math.max(54,width*0.1));
    const radiusX=Math.max(44,Math.min(width*0.4,width/2-sidePad));
    if (!outer.length) {
      result.set(center.name,{x:width/2,y:centerY});
      return result;
    }
    if (outer.length===1) {
      const spread=Math.max(54,Math.min(radiusX*0.72,width/2-sidePad));
      result.set(center.name,{x:width/2-spread,y:centerY});
      result.set(outer[0].name,{x:width/2+spread,y:centerY});
      return result;
    }
    if (outer.length===2) {
      const topY=Math.max(topPad,centerY-radiusY*0.78);
      const bottomY=Math.min(height-bottomPad,centerY+radiusY*0.72);
      const spread=Math.max(54,Math.min(radiusX*0.85,width/2-sidePad));
      result.set(center.name,{x:width/2,y:topY});
      result.set(outer[0].name,{x:width/2-spread,y:bottomY});
      result.set(outer[1].name,{x:width/2+spread,y:bottomY});
      return result;
    }
    result.set(center.name,{x:width/2,y:centerY});
    outer.forEach((node,index)=>{
      const angle=-Math.PI/2+index*Math.PI*2/outer.length;
      result.set(node.name,{x:width/2+Math.cos(angle)*radiusX,y:centerY+Math.sin(angle)*radiusY});
    });
    return result;
  }

  function estimateNameLines(name,charsPerLine) {
    const text=String(name??'').trim();
    if (!text) return 1;
    const limit=Math.max(6,charsPerLine);
    const tokens=text.match(/[^-\s_/]+[-\s_/]*|[-\s_/]+/g) ?? [text];
    let lines=1,used=0;
    for (const token of tokens) {
      let remaining=token;
      while (remaining.length>limit) {
        if (used>0) {lines++;used=0;}
        remaining=remaining.slice(limit);
        lines++;
      }
      if (used>0 && used+remaining.length>limit) {
        lines++;
        used=remaining.length;
      } else used+=remaining.length;
    }
    return Math.max(1,lines);
  }

  function nodeBox(node,{variant='card',cardWidth,narrow=false}={}) {
    if (variant==='hex') {
      const maxLabelW=narrow?84:128;
      const raw=String(node?.name??'');
      const labelText=raw==='user'?'You':raw==='system'?'System':'@'+raw;
      const charsPerLine=Math.max(8,Math.floor((maxLabelW-12)/6.3));
      const lines=estimateNameLines(labelText,charsPerLine);
      const labelW=Math.min(maxLabelW,Math.max(38,12+labelText.length*6.3));
      const unmentioned=unmentionedNode(node??{});
      const halfW=Math.max(unmentioned?32:28,labelW/2);
      const top=unmentioned?32:(node?.broadcasts?29:24);
      const bottom=29+lines*15+4;
      return {halfW,halfH:(top+bottom)/2,offsetX:0,offsetY:(bottom-top)/2,radius:10};
    }
    const width=cardWidth??(narrow?92:112);
    const charsPerLine=Math.max(7,Math.floor((width-20)/7.4));
    const lines=estimateNameLines(node?.name??'',charsPerLine);
    const height=64+lines*16;
    return {halfW:width/2,halfH:height/2,offsetX:0,offsetY:0,radius:10};
  }

  function normalizeBox(point,box) {
    if (!box) return {cx:point.x,cy:point.y,halfW:26,halfH:26,radius:10};
    if (Number.isFinite(box.left)&&Number.isFinite(box.right)&&Number.isFinite(box.top)&&Number.isFinite(box.bottom)) {
      return {
        cx:point.x+(box.right-box.left)/2,
        cy:point.y+(box.bottom-box.top)/2,
        halfW:(box.left+box.right)/2,
        halfH:(box.top+box.bottom)/2,
        radius:Math.max(0,box.radius??8),
      };
    }
    const halfW=Number.isFinite(box.halfW)?box.halfW:(Number.isFinite(box.width)?box.width/2:26);
    const halfH=Number.isFinite(box.halfH)?box.halfH:(Number.isFinite(box.height)?box.height/2:26);
    return {
      cx:(Number.isFinite(box.cx)?box.cx:point.x+(box.offsetX??0)),
      cy:(Number.isFinite(box.cy)?box.cy:point.y+(box.offsetY??0)),
      halfW:Math.max(1,halfW),
      halfH:Math.max(1,halfH),
      radius:Math.max(0,box.radius??8),
    };
  }

  function roundedRectSignedDistance(px,py,box) {
    const r=Math.max(0,Math.min(box.radius??0,box.halfW,box.halfH));
    const qx=Math.abs(px-box.cx)-(box.halfW-r);
    const qy=Math.abs(py-box.cy)-(box.halfH-r);
    return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;
  }

  function bezierPoint(p0,c,p1,t) {
    const u=1-t;
    return {
      x:u*u*p0.x+2*u*t*c.x+t*t*p1.x,
      y:u*u*p0.y+2*u*t*c.y+t*t*p1.y,
    };
  }

  function blossomControl(p0,c,p1,u,v) {
    const a=(1-u)*(1-v);
    const b=(1-u)*v+u*(1-v);
    const d=u*v;
    return {
      x:a*p0.x+b*c.x+d*p1.x,
      y:a*p0.y+b*c.y+d*p1.y,
    };
  }

  function clipQuadratic(p0,c,p1,absFrom,absTo,marginStart,marginEnd,minLength) {
    const steps=32;
    let lastInFrom=-1;
    for (let i=0;i<=steps;i++) {
      const pt=bezierPoint(p0,c,p1,i/steps);
      if (roundedRectSignedDistance(pt.x,pt.y,absFrom)<=marginStart) lastInFrom=i;
    }
    if (lastInFrom>=steps) return null;
    let tStart=0;
    if (lastInFrom>=0) {
      let lo=lastInFrom/steps,hi=(lastInFrom+1)/steps;
      for (let iter=0;iter<22;iter++) {
        const mid=(lo+hi)/2;
        const pt=bezierPoint(p0,c,p1,mid);
        if (roundedRectSignedDistance(pt.x,pt.y,absFrom)<=marginStart) lo=mid; else hi=mid;
      }
      tStart=hi;
    }
    let firstInTo=-1;
    const scanFrom=Math.max(0,lastInFrom+1);
    for (let i=scanFrom;i<=steps;i++) {
      const pt=bezierPoint(p0,c,p1,i/steps);
      if (roundedRectSignedDistance(pt.x,pt.y,absTo)<=marginEnd) {firstInTo=i;break;}
    }
    if (firstInTo<=0) return null;
    let lo=(firstInTo-1)/steps,hi=firstInTo/steps;
    for (let iter=0;iter<22;iter++) {
      const mid=(lo+hi)/2;
      const pt=bezierPoint(p0,c,p1,mid);
      if (roundedRectSignedDistance(pt.x,pt.y,absTo)<=marginEnd) hi=mid; else lo=mid;
    }
    const tEnd=lo;
    if (tEnd<=tStart+1e-4) return null;
    const start=bezierPoint(p0,c,p1,tStart);
    const end=bezierPoint(p0,c,p1,tEnd);
    const length=Math.hypot(end.x-start.x,end.y-start.y);
    if (length<minLength) return null;
    const control=blossomControl(p0,c,p1,tStart,tEnd);
    const mid=bezierPoint(p0,c,p1,(tStart+tEnd)/2);
    const endDx=end.x-control.x,endDy=end.y-control.y;
    const startDx=control.x-start.x,startDy=control.y-start.y;
    const endAngle=Math.hypot(endDx,endDy)>1e-4?Math.atan2(endDy,endDx):Math.atan2(end.y-start.y,end.x-start.x);
    const startAngle=Math.hypot(startDx,startDy)>1e-4?Math.atan2(startDy,startDx):Math.atan2(end.y-start.y,end.x-start.x);
    const d='M'+start.x.toFixed(1)+' '+start.y.toFixed(1)+' Q'+control.x.toFixed(1)+' '+control.y.toFixed(1)+' '+end.x.toFixed(1)+' '+end.y.toFixed(1);
    return {start,control,end,mid,startAngle,endAngle,length,tStart,tEnd,d};
  }

  function curveClearance(clipped,obstacles) {
    if (!obstacles.length) return Infinity;
    let minClear=Infinity;
    for (let i=0;i<=24;i++) {
      const pt=bezierPoint(clipped.start,clipped.control,clipped.end,i/24);
      for (const box of obstacles) {
        const dist=roundedRectSignedDistance(pt.x,pt.y,box);
        if (dist<minClear) minClear=dist;
      }
    }
    for (const box of obstacles) {
      const midDist=roundedRectSignedDistance(clipped.mid.x,clipped.mid.y,box)-10;
      if (midDist<minClear) minClear=midDist;
    }
    return minClear;
  }

  function clipEdge(from,to,fromBox,toBox,{
    marginStart=6,
    marginEnd=7,
    bidirectional=false,
    bend,
    obstacles=[],
    obstacleMargin=8,
    minLength=8,
  }={}) {
    if (!from||!to) return null;
    const absFrom=normalizeBox(from,fromBox);
    const absTo=normalizeBox(to,toBox);
    const p0={x:absFrom.cx,y:absFrom.cy};
    const p1={x:absTo.cx,y:absTo.cy};
    const dx=p1.x-p0.x,dy=p1.y-p0.y;
    const distance=Math.hypot(dx,dy);
    if (distance<1) return null;
    const ux=dx/distance,uy=dy/distance;
    const nx=-uy,ny=ux;
    const absObstacles=obstacles.map(item=>item?.box?normalizeBox(item,item.box):normalizeBox(item,item));
    const candidates=[];
    if (Number.isFinite(bend)) {
      candidates.push(bend);
    } else if (bidirectional) {
      const base=Math.min(34,Math.max(18,distance*0.145));
      candidates.push(
        base,
        Math.min(54,base*1.45),
        Math.max(10,base*0.55),
        Math.min(72,distance*0.3),
        Math.max(6,base*0.3)
      );
    } else {
      const base=Math.min(20,Math.max(8,distance*0.065));
      const maxBend=Math.min(82,distance*0.34);
      candidates.push(
        base,
        -base,
        0,
        Math.min(maxBend,base*2),
        -Math.min(maxBend,base*2),
        Math.min(maxBend,base*3.2),
        -Math.min(maxBend,base*3.2),
        maxBend,
        -maxBend
      );
    }

    const attempt=(mStart,mEnd,minLen)=>{
      let best=null,bestClear=-Infinity;
      for (const offset of candidates) {
        const c={x:(p0.x+p1.x)/2+nx*offset,y:(p0.y+p1.y)/2+ny*offset};
        const clipped=clipQuadratic(p0,c,p1,absFrom,absTo,mStart,mEnd,minLen);
        if (!clipped) continue;
        const clear=curveClearance(clipped,absObstacles);
        const result={...clipped,bend:offset,clearance:clear};
        if (clear>=obstacleMargin) return result;
        if (clear>bestClear) {bestClear=clear;best=result;}
      }
      return best;
    };

    return attempt(marginStart,marginEnd,minLength) ??
      attempt(Math.min(marginStart,2),Math.min(marginEnd,3),Math.min(minLength,4));
  }

  function routeEdges(projection,points,{
    variant='card',
    boxes,
    cardWidth,
    narrow=false,
    marginStart=6,
    marginEnd=7,
    obstacleMargin=8,
    minLength=8,
  }={}) {
    const nodeBoxes=new Map();
    for (const node of projection.nodes??[]) {
      const custom=boxes?.get?.(node.name);
      nodeBoxes.set(node.name,custom ?? nodeBox(node,{variant,cardWidth,narrow}));
    }
    const keys=new Set((projection.links??[]).map(link=>link.from+'>'+link.to));
    const byKey=new Map();
    const routed=[];
    const obstaclesFor=(fromName,toName)=>{
      const list=[];
      for (const node of projection.nodes??[]) {
        if (node.name===fromName||node.name===toName) continue;
        const pt=points.get(node.name);
        if (!pt) continue;
        list.push({x:pt.x,y:pt.y,box:nodeBoxes.get(node.name)});
      }
      return list;
    };
    for (const link of projection.links??[]) {
      const start=points.get(link.from),end=points.get(link.to);
      if (!start||!end) continue;
      const fromBox=nodeBoxes.get(link.from) ?? nodeBox({name:link.from},{variant,cardWidth,narrow});
      const toBox=nodeBoxes.get(link.to) ?? nodeBox({name:link.to},{variant,cardWidth,narrow});
      const obstacles=obstaclesFor(link.from,link.to);
      const bidirectional=keys.has(link.to+'>'+link.from);
      const edge=clipEdge(start,end,fromBox,toBox,{
        marginStart,marginEnd,bidirectional,obstacles,obstacleMargin,minLength,
      });
      if (edge) {
        const entry={link,edge,bidirectional,fromBox,toBox,obstacles};
        routed.push(entry);
        byKey.set(link.from+'>'+link.to,entry);
      }
    }
    for (const entry of routed) {
      if (!entry.bidirectional || entry.edge.clearance>=Math.min(obstacleMargin,16)) continue;
      const twin=byKey.get(entry.link.to+'>'+entry.link.from);
      if (!twin || twin.edge.clearance<Math.min(obstacleMargin,16)) continue;
      const aPt=points.get(entry.link.from),bPt=points.get(entry.link.to);
      for (const innerBend of [-18,-26,-36,-48]) {
        const altInner=clipEdge(aPt,bPt,entry.fromBox,entry.toBox,{
          marginStart,marginEnd,bidirectional:true,bend:innerBend,obstacles:entry.obstacles,obstacleMargin,minLength,
        });
        if (!altInner || altInner.clearance<10) continue;
        const outerBend=Math.max(twin.edge.bend,Math.abs(innerBend)+28);
        const altOuter=clipEdge(bPt,aPt,twin.fromBox,twin.toBox,{
          marginStart,marginEnd,bidirectional:true,bend:outerBend,obstacles:twin.obstacles,obstacleMargin,minLength,
        });
        if (altOuter && altOuter.clearance>=10 && Math.hypot(altInner.mid.x-altOuter.mid.x,altInner.mid.y-altOuter.mid.y)>=12) {
          entry.edge=altInner;
          twin.edge=altOuter;
          break;
        }
      }
    }
    const placedPills=[];
    const pillClear=(pt,obstacles,minObs)=> {
      for (const item of obstacles) {
        const box=item?.box?normalizeBox(item,item.box):normalizeBox(item,item);
        if (roundedRectSignedDistance(pt.x,pt.y,box)<minObs) return false;
      }
      for (const other of placedPills) {
        if (Math.hypot(pt.x-other.x,pt.y-other.y)<26) return false;
      }
      return true;
    };
    const allBoxes=[];
    for (const node of projection.nodes??[]) {
      const pt=points.get(node.name);
      if (pt) allBoxes.push({x:pt.x,y:pt.y,box:nodeBoxes.get(node.name)});
    }
    for (const entry of routed) {
      const {edge,link}=entry;
      if (edge.length<40) continue;
      const p0=edge.start,c=edge.control,p1=edge.end;
      let chosen=edge.mid;
      if (!pillClear(chosen,allBoxes,12)) {
        for (const t of [0.38,0.62,0.32,0.68,0.44,0.56]) {
          const cand=bezierPoint(p0,c,p1,t);
          if (pillClear(cand,allBoxes,12)) {chosen=cand;break;}
        }
      }
      edge.mid=chosen;
      if (link.count>1) placedPills.push(chosen);
    }
    return routed.map(({link,edge,bidirectional})=>({link,edge,bidirectional}));
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

  function pillPath(ctx,x,y,w,h,r) {
    const radius=Math.min(r,w/2,h/2);
    const x0=x-w/2,y0=y-h/2,x1=x+w/2,y1=y+h/2;
    ctx.beginPath();
    ctx.moveTo(x0+radius,y0);
    ctx.lineTo(x1-radius,y0);
    ctx.quadraticCurveTo(x1,y0,x1,y0+radius);
    ctx.lineTo(x1,y1-radius);
    ctx.quadraticCurveTo(x1,y1,x1-radius,y1);
    ctx.lineTo(x0+radius,y1);
    ctx.quadraticCurveTo(x0,y1,x0,y1-radius);
    ctx.lineTo(x0,y0+radius);
    ctx.quadraticCurveTo(x0,y0,x0+radius,y0);
    ctx.closePath();
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
    ctx.strokeStyle=color.accent;
    ctx.lineWidth=1.4;
    ctx.setLineDash([3,3]);
    for (const node of projection.nodes) {
      const point=points.get(node.name);
      if (!point||!unmentionedNode(node)) continue;
      ctx.globalAlpha=!focus||focus===node.name?0.85:0.2;
      ctx.beginPath();
      ctx.arc(point.x,point.y,31,0,Math.PI*2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font='600 10px ui-monospace, monospace';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    const routed=routeEdges(projection,points,{
      variant:'hex',narrow:width<465,marginStart:6,marginEnd:6,obstacleMargin:width<465?14:24,
    });
    for (const {link,edge} of routed) {
      const {start:a,control:c,end:b,mid,endAngle:angle}=edge;
      const pulse=link.lastSeq===highlight;
      const related=!focus || link.from===focus || link.to===focus;
      const stroke=pulse && related ? color.accent : color.link;
      ctx.globalAlpha=related ? (pulse ? 1 : 0.78) : 0.16;
      ctx.strokeStyle=ctx.fillStyle=stroke;
      ctx.lineWidth=Math.min(3.8,1.1+Math.sqrt(link.count)*0.65);
      ctx.lineCap='round';
      ctx.setLineDash(link.direct ? [] : [4,4]);
      const shaftInset=Math.min(4.5,edge.length*0.25);
      const sx=b.x-Math.cos(angle)*shaftInset;
      const sy=b.y-Math.sin(angle)*shaftInset;
      ctx.beginPath();
      ctx.moveTo(a.x,a.y);
      ctx.quadraticCurveTo(c.x,c.y,sx,sy);
      ctx.stroke();
      ctx.setLineDash([]);
      const headLen=9;
      ctx.beginPath();
      ctx.moveTo(b.x,b.y);
      ctx.lineTo(b.x-headLen*Math.cos(angle-0.44),b.y-headLen*Math.sin(angle-0.44));
      ctx.lineTo(b.x-(headLen*0.72)*Math.cos(angle),b.y-(headLen*0.72)*Math.sin(angle));
      ctx.lineTo(b.x-headLen*Math.cos(angle+0.44),b.y-headLen*Math.sin(angle+0.44));
      ctx.closePath();
      ctx.fill();
      if (related && edge.length>=40 && (link.count>1 || pulse || focus)) {
        const label=String(link.count);
        const pillW=Math.max(20,label.length*6.5+10);
        ctx.globalAlpha=0.98;
        pillPath(ctx,mid.x,mid.y,pillW,15,7.5);
        ctx.fillStyle=color.paper;
        ctx.fill();
        ctx.lineWidth=1;
        ctx.strokeStyle=pulse ? color.accent : color.link;
        ctx.stroke();
        ctx.fillStyle=pulse ? color.accent : color.text;
        ctx.fillText(label,mid.x,mid.y+0.25);
      }
    }
    ctx.globalAlpha=1;
  }

  globalThis.HiveGraph=Object.freeze({
    isPost,project,elapsedSpan,unmentionedNode,minimumHeight,layout,
    nodeBox,roundedRectSignedDistance,clipEdge,routeEdges,draw,
  });
})();
