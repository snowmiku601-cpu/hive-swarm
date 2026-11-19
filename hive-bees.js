(() => {
  'use strict';
  const palette=[
    ['#efac37','#ffe18d','#bb641d'],
    ['#75baef','#cdefff','#3974bb'],
    ['#55cbb2','#b8f8df','#268c7d'],
    ['#e68db3','#ffcee2','#a24275'],
    ['#b3ce64','#e9f6a1','#6c9137'],
    ['#ad9ce8','#e3d4ff','#6d58af'],
    ['#f09a71','#ffd3b7','#af5833'],
    ['#95cbd1','#defbfa','#4a8d9d'],
    ['#d1a76a','#ffe2a9','#987044'],
  ];

  function colors(name,coordinator,tint) {
    if (coordinator) return palette[0];
    if (Number.isInteger(tint)) return palette[1+tint%(palette.length-1)];
    const hash=[...name].reduce((sum,letter)=>sum*31+letter.charCodeAt(0),0)>>>0;
    return palette[hash%palette.length];
  }

  function sprite(name,{status='working',coordinator=false,tint}={}) {
    const canvas=document.createElement('canvas');
    canvas.className='bee-pixel';
    canvas.width=20;
    canvas.height=18;
    canvas.setAttribute('aria-hidden','true');
    const [base,highlight,shade]=colors(name,coordinator,tint);
    const asleep=['waiting','quota','retired','done'].includes(status);
    canvas.dataset.pose=asleep?'sleeping':'awake';
    const ctx=canvas.getContext('2d');
    const paint=(color,rects)=>{
      ctx.fillStyle=color;
      for (const rect of rects) ctx.fillRect(...rect);
    };
    paint('#201915',[[3,2,1,3],[6,3,1,2],[5,1,2,1],[2,3,1,1],[5,5,10,8],[3,7,13,5],
      [4,12,11,2],[6,14,7,1],[16,9,2,2],[7,14,1,2],[12,14,1,2]]);
    paint('#24313d',[[7,3,6,4],[8,2,4,6],[12,3,4,4],[13,2,2,1]]);
    paint('#a9c6db',[[8,3,3,4],[12,4,3,2],[9,7,2,1]]);
    paint('#e7f2fa',[[9,3,2,2],[12,4,2,1],[8,4,1,2]]);
    paint(base,[[4,7,8,5],[5,6,6,7],[12,7,3,5],[13,12,1,1],[6,13,1,1]]);
    paint(highlight,[[5,7,3,1],[4,9,2,2],[10,7,2,1],[13,8,1,2],[5,12,2,1]]);
    paint(shade,[[6,12,7,1],[12,11,3,1],[13,12,1,1]]);
    paint('#2c221c',[[8,6,2,7],[12,7,1,6],[15,9,2,1]]);
    if (asleep) {
      paint('#201915',[[4,10,2,1]]);
      paint('#d7dcff',coordinator
        ? [[0,0,2,1],[1,1,1,1],[0,2,2,1],[15,0,4,1],[17,1,1,2],[15,3,4,1]]
        : [[1,1,3,1],[2,2,1,1],[1,3,3,1],[15,0,4,1],[17,1,1,2],[15,3,4,1]]);
    } else {
      paint('#201915',[[5,8,1,2]]);
      paint('#fff6d7',[[5,8,1,1]]);
    }
    if (coordinator) {
      paint('#6d4219',[[2,1,1,4],[8,1,1,4],[2,4,7,1]]);
      paint('#ffd86b',[[2,0,1,2],[5,0,1,3],[8,0,1,2],[3,2,5,2],[4,1,3,1]]);
      paint('#e7a52f',[[3,4,5,1],[3,3,5,1]]);
      paint('#fff3bf',[[3,2,1,1],[7,2,1,1],[5,3,1,1]]);
    }
    return canvas;
  }

  globalThis.HiveBee=Object.freeze({sprite,colors});
})();
