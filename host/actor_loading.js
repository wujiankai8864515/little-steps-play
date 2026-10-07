/* Three-layer host mirror of entry/native_actor.gd. */
(function (root, factory){
 'use strict';
 const api=factory();
 if (typeof module === 'object' && module.exports) module.exports=api;
 else if (!root.TravelHostActor) root.TravelHostActor=api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (){
 'use strict';
 const FPS=30, FRAME_COUNT=66;
 const KEYS=[[0,-12,-26],[7,-27,-32],[10,-27,-32],[14,9,-27],[15,9,-27],
  [18,-19,-31],[24,-22,-32],[28,9,-27],[29,9,-27],[32,-20,-31],[36,-24,-32],
  [40,9,-27],[41,9,-27],[44,-19,-30],[51,-15,-28],[58,-12,-26],[65,-12,-26]];
 const HITS=[14,28,40];
 const RESPONSE=[[0,0],[1,0.72],[2,1],[3,0.76],[4,0.38],[5,0.08],
  [6,-0.15],[8,-0.14],[10,0.055],[12,0]];
 const MALLET_CONTACT=[570,174], DOLL_CONTACT=[174,243];
 const ASSETS=[
  {name:'body', path:'host/assets/compact/actor_body.png', width:220, height:142, sourceWidth:441, sourceHeight:283, bytes:36824},
  {name:'prop', path:'host/assets/compact/actor_fin_mallet.png', width:76, height:86, sourceWidth:152, sourceHeight:171, bytes:8289},
  {name:'doll', path:'host/assets/compact/doll_rig.png', width:239, height:298, sourceWidth:478, sourceHeight:596, bytes:91342}
 ];
 const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
  a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
 const t=(x,y)=>[1,0,0,1,x,y], s=(x,y)=>[x,0,0,y,0,0];
 const r=degrees=>{ const angle=degrees*Math.PI/180; return [Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0]; };
 const chain=(...matrices)=>matrices.reduce(multiply);
 function tween(keys,frame,accelerate=false){
  for(let i=0;i<keys.length-1;i++){
   const a=keys[i],b=keys[i+1];
   if(frame<a[0] || frame>b[0])continue;
   let u=(frame-a[0])/(b[0]-a[0]);
   u=accelerate && HITS.includes(b[0]) ? u*u : u*u*(3-2*u);
   return a.slice(1).map((v,j)=>v+(b[j+1]-v)*u);
  }
  return keys[keys.length-1].slice(1);
 }
 const motion=frame=>tween(KEYS,frame,true);
 const spring=frame=>HITS.reduce((v,h)=>v+(frame>=h && frame<=h+12?tween(RESPONSE,frame-h)[0]:0),0);
 const point=(m,p)=>[m[0]*p[0]+m[2]*p[1]+m[4],m[1]*p[0]+m[3]*p[1]+m[5]];
 function contactWeight(frame){
  const e=HITS.map(h=>frame-h).find(e=>e>=-4 && e<4);
  if(e===undefined)return 0;
  if(e<0)return ((e+4)/4)**2;
  if(e<=1)return 1;
  const u=(e-1)/3;return 1-u*u*(3-2*u);
 }
 const propTransform=(body,m)=>chain(body,t(470+9*Math.max(0,(m[0]+5)/47),253+m[1]),r(m[0]),t(-470,-253));
 function pose(frame){
  frame=((frame%FRAME_COUNT)+FRAME_COUNT)%FRAME_COUNT;
  const m=motion(frame),bounce=spring(frame),positive=Math.max(0,bounce);
  const body=chain(t(-2+positive*0.8,780-336*0.9),s(0.9,0.9));
  let prop=propTransform(body,m);
  const doll=chain(t(452,534),s(1.5,1.5),t(80,163),
   r(4*positive+2*Math.min(0,bounce)),s(1+0.045*bounce,1-0.07*bounce),t(-80,-163),s(0.25,0.25));
  const ref=point(propTransform(body,[9,-27]),MALLET_CONTACT),target=point(doll,DOLL_CONTACT),weight=contactWeight(frame);
  prop=chain(t((target[0]-ref[0])*weight,(target[1]-ref[1])*weight),prop);
  return {body:chain(body,t(100,56)),prop:chain(prop,t(425,120)),doll:chain(doll,t(77,69))};
 }
 function impact(frame){
  const hit=HITS.find(hit=>frame>=hit && frame<=hit+3);
  if(hit===undefined)return null;
  const elapsed=frame-hit,anchor=point(pose(frame).doll,[97,174]);
  const starts=[[7,-12],[19,-2],[-3,-22]],ends=[[15,-23],[32,-7],[-2,-32]];
  return {alpha:[0.72,0.65,0.40,0.15][elapsed],lines:starts.map((p,i)=>[
   [anchor[0]+p[0]+elapsed*2,anchor[1]+p[1]-elapsed],
   [anchor[0]+ends[i][0]+elapsed*3,anchor[1]+ends[i][1]-elapsed*2]])};
 }
 function create(window, document, canvas){
  if (!canvas || !canvas.getContext) throw new Error('启动动效缺少 Canvas 2D。');
  const ctx=canvas.getContext('2d',{alpha:true});
  if (!ctx) throw new Error('当前浏览器不支持启动动效。');
  const images=new Map();
  let disposed=false, started=null, pendingImage=null, raf=null, clock=0, previous=null, lastFrame=-1, listening=false;
  const metrics={status:'idle',frame:0,frames_drawn:0,decoded_rgba_bytes:0,decode_concurrency:1,
   first_draw_ms:null,source_bytes:ASSETS.reduce((sum,a)=>sum+a.bytes,0),canvas_rgba_bytes:720*480*4};
  const now=()=>(window.performance || performance).now();
  function release(image){image.onload=null;image.onerror=null;if(image.removeAttribute)image.removeAttribute('src');}
  function cancelFrame(){if(raf!==null)window.cancelAnimationFrame(raf);raf=null;previous=null;}
  function dispose(){
   if(disposed)return;
   disposed=true;metrics.status='disposed';cancelFrame();
   if(listening){document.removeEventListener('visibilitychange',onVisibility);listening=false;}
   if(pendingImage){const pending=pendingImage;pendingImage=null;release(pending.image);pending.reject(new Error('启动动效已关闭。'));}
   for(const image of images.values())release(image);
   images.clear();canvas.width=1;canvas.height=1;
  }
  function draw(frame){
   if(disposed)return;
   const transforms=pose(frame);
   ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,720,480);
   for(const name of ['doll','body','prop']){
    const matrix=transforms[name].slice();matrix[5]-=400;
    const asset=ASSETS.find(item=>item.name===name);
    ctx.setTransform(...matrix);ctx.drawImage(images.get(name),0,0,asset.sourceWidth,asset.sourceHeight);
   }
   const effect=impact(frame);
   if(effect){
    ctx.setTransform(1,0,0,1,0,-400);
    ctx.globalAlpha=effect.alpha;ctx.strokeStyle='rgb(223,158,43)';ctx.lineWidth=3;
    for(const [start,end] of effect.lines){
     ctx.beginPath();ctx.moveTo(...start);ctx.lineTo(...end);ctx.stroke();
    }
    ctx.globalAlpha=1;
   }
   lastFrame=frame;metrics.frame=frame;metrics.frames_drawn++;
   if(metrics.first_draw_ms===null)metrics.first_draw_ms=now();
  }
  function schedule(){if(!disposed && !document.hidden && raf===null)raf=window.requestAnimationFrame(step);}
  function step(timestamp){
   raf=null;
   if(disposed || document.hidden)return;
   if(previous!==null)clock=(clock+Math.max(0,timestamp-previous))%(FRAME_COUNT/FPS*1000);
   previous=timestamp;
   const frame=Math.floor(clock*FPS/1000)%FRAME_COUNT;
   if(frame!==lastFrame)draw(frame);
   schedule();
  }
  function onVisibility(){if(disposed)return;if(document.hidden)cancelFrame();else schedule();}
  function load(asset){
   return new Promise((resolve,reject)=>{
    if(disposed){reject(new Error('启动动效已关闭。'));return;}
    const url=new URL(asset.path,document.baseURI);
    if(url.origin!==new URL(document.baseURI).origin){reject(new Error('启动动效必须与游戏同源。'));return;}
    const image=new window.Image();image.decoding='async';
    pendingImage={image,reject};
    function failed(error){if(disposed)return;release(image);pendingImage=null;reject(error);}
    image.onerror=()=>failed(new Error('启动动效图片加载失败：'+asset.name));
    image.onload=async()=>{
     try {
      if(image.decode)await image.decode();
      if(disposed)return;
      if(image.naturalWidth!==asset.width || image.naturalHeight!==asset.height)throw new Error('启动动效图片尺寸不符：'+asset.name);
      image.onload=null;image.onerror=null;pendingImage=null;
      images.set(asset.name,image);metrics.decoded_rgba_bytes+=asset.width*asset.height*4;resolve();
     } catch(error){failed(error);}
    };
    image.src=url.href;
   });
  }
  function start(){
   if(started)return started;
   if(disposed){started=Promise.reject(new Error('启动动效已关闭。'));return started;}
   started=(async()=>{
    metrics.status='loading';canvas.width=720;canvas.height=480;ctx.imageSmoothingEnabled=true;
    for(const asset of ASSETS)await load(asset);
    if(disposed)throw new Error('启动动效已关闭。');
    draw(0);metrics.status='playing';
    document.addEventListener('visibilitychange',onVisibility);listening=true;schedule();
   })().catch(error=>{dispose();throw error;});
   return started;
  }
  return Object.freeze({start,dispose,getMetrics:()=>Object.assign({},metrics)});
 }
 return Object.freeze({create,pose,motion,spring,impact,FPS,FRAME_COUNT,KEYS,HITS,RESPONSE,ASSETS});
}));
