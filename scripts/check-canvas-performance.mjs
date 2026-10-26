// Local synthetic acceptance fixture. Build client first; no real generation or remote media.
// Requires Playwright, Chrome/Chromium and ffmpeg. Optional CANVAS_PLAYWRIGHT_MODULE (require base file),
// CANVAS_CHROME, CANVAS_FFMPEG, CANVAS_CPU_RATE and CANVAS_P95_LIMIT_MS.
// Run: node scripts/check-canvas-performance.mjs [label]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require = createRequire(process.env.CANVAS_PLAYWRIGHT_MODULE || import.meta.url);
const {chromium} = require('playwright');
const root = path.resolve(process.env.CANVAS_CLIENT_DIST || 'client/dist');
let photo, thumbnail, video;
let requests = {media:0, poll:0, video:0, bytes:0};
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://localhost'), p = url.pathname;
  if (p.startsWith('/uploads/fixture-') && (p.includes('photo') || url.searchParams.has('preview'))) {const body=url.searchParams.has('preview')?thumbnail:photo;requests.media++;requests.bytes+=body.length;res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'max-age=3600'});res.end(body);return;}
  if (p.startsWith('/api/video/play')) {requests.video++;requests.media++;requests.bytes+=video.length;res.writeHead(200,{'Content-Type':'video/webm','Cache-Control':'max-age=3600'});res.end(video);return;}
  if (p.startsWith('/api/')) {
    let data = p.endsWith('/models') ? [{id:'test-video',name:'测试视频',available:true,rates:{'720p':1},allowedSeconds:[5]}] : {};
    if (/\/contents\/\d+/.test(p)) {requests.poll++;data={status:'processing',metadata:{progress:35}};}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
  }
  const candidate=path.resolve(root,'.'+p);
  const file=candidate.startsWith(root+path.sep)&&fs.existsSync(candidate)&&fs.statSync(candidate).isFile()?candidate:path.join(root,'index.html');
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');
  res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CANVAS_CHROME?{executablePath:process.env.CANVAS_CHROME}:{})});
const report={label:process.argv[2]||'current',cpuRate:Number(process.env.CANVAS_CPU_RATE||4),cases:[]};
try {
  const assets=await browser.newPage();
  await assets.goto(origin);
  const generated=await assets.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
    const ctx=canvas.getContext('2d');
    const gradient=ctx.createLinearGradient(0,0,1920,1080);gradient.addColorStop(0,'#35596d');gradient.addColorStop(1,'#ebca8a');ctx.fillStyle=gradient;ctx.fillRect(0,0,1920,1080);
    for(let i=0;i<3000;i++){ctx.fillStyle=`hsl(${i%360} 40% 55%)`;ctx.fillRect((i*137)%1920,(i*73)%1080,8,8);}
    const photo=canvas.toDataURL('image/jpeg',.85).split(',')[1];
    const small=document.createElement('canvas');small.width=640;small.height=360;small.getContext('2d').drawImage(canvas,0,0,640,360);const thumbnail=small.toDataURL('image/jpeg',.78).split(',')[1];
    return {photo,thumbnail};
  });
  photo=Buffer.from(generated.photo,'base64');thumbnail=Buffer.from(generated.thumbnail,'base64');
  // A deterministic playable clip (captureStream can emit header-only files in headless Windows).
  video=execFileSync(process.env.CANVAS_FFMPEG || 'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=10','-t','1','-c:v','libvpx','-deadline','realtime','-f','webm','pipe:1'],{maxBuffer:4*1024*1024,windowsHide:true});await assets.close();
  for(const config of [{name:'daily',nodes:200,links:1,media:false},{name:'dense',nodes:1000,links:5,media:false},{name:'mixed',nodes:200,links:1,media:true}]) {
    requests={media:0,poll:0,video:0,bytes:0};
    const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/app/canvas');await page.getByLabel('无限画布编辑区').waitFor();
    await page.evaluate(async config=>{
      const nodes=Array.from({length:config.nodes},(_,i)=>({id:'node-'+i,kind:i===0?'text':config.media&&i%5===1?'image':'video',title:'节点'+i,text:i===0?'分镜描述'.repeat(5000):'',width:300,height:270,x:i%20*340,y:Math.floor(i/20)*310,...(config.media&&i%5===1?{src:'/uploads/fixture-photo-'+i+'.jpg'}:config.media&&i%10===2?{src:'/uploads/fixture-video-'+i+'.webm'}:config.media&&i%10===3?{job:{status:'running',contentId:1000+i,requestId:'fixture-'+i,message:'测试后台任务',progress:35}}:{})}));
      const edges=[];for(let i=1;i<nodes.length;i++)for(let j=1;j<=config.links&&i-j>=0;j++)edges.push({id:'edge-'+i+'-'+j,from:'node-'+(i-j),to:'node-'+i});
      const doc={id:'fixture',title:'性能验收画布',nodes,edges,view:{x:80,y:180,zoom:.3},updatedAt:Date.now()};
      const workspace={version:2,activeId:doc.id,projects:[doc],cloudPending:false};
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('creative-infinite-canvas',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      await new Promise((resolve,reject)=>{const tx=db.transaction('boards','readwrite');tx.objectStore('boards').put(workspace,'guest:workspace-v2');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    },config);
    await page.reload();await page.getByRole('article',{name:'节点0',exact:true}).waitFor();await page.waitForTimeout(1000);
    const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate:report.cpuRate});
    await page.evaluate(()=>{window.fixtureLongTasks=[];new PerformanceObserver(list=>window.fixtureLongTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});});
    const samples=[];
    for(const operation of ['pan','drag','zoom']) for(let run=0;run<2;run++) {
      const before=await cdp.send('Performance.getMetrics');
      const timing=await page.evaluate(async operation=>{
        const stage=document.querySelector('.studio-stage'),card=document.querySelector('.studio-node'),rect=stage.getBoundingClientRect();
        const capture=Element.prototype.setPointerCapture;Element.prototype.setPointerCapture=()=>{};
        const fire=(type,x,y)=> (type==='pointerdown'&&operation==='drag'?card:stage).dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:123,button:operation==='pan'?1:0,buttons:type==='pointerup'?0:operation==='pan'?4:1,clientX:rect.left+x,clientY:rect.top+y}));
        const frames=[];let previous=performance.now();
        if(operation!=='zoom')fire('pointerdown',500,300);
        for(let i=0;i<60;i++) {
          await new Promise(requestAnimationFrame);const now=performance.now();frames.push(now-previous);previous=now;
          if(operation==='zoom')stage.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:i<30?-3:3,clientX:rect.left+500,clientY:rect.top+300}));
          else for(let j=0;j<4;j++)fire('pointermove',500+(i*4+j)%80,300+(i*4+j)%20);
        }
        if(operation!=='zoom'){fire('pointermove',500,300);fire('pointerup',500,300);}
        Element.prototype.setPointerCapture=capture;
        await new Promise(requestAnimationFrame);
        frames.sort((a,b)=>a-b);return {p50:frames[30],p95:frames[57],over50:frames.filter(n=>n>50).length};
      },operation);
      const after=await cdp.send('Performance.getMetrics'),metric=(m,k)=>m.metrics.find(x=>x.name===k).value;
      samples.push({operation,run,...timing,scriptMs:1000*(metric(after,'ScriptDuration')-metric(before,'ScriptDuration')),layoutMs:1000*(metric(after,'LayoutDuration')-metric(before,'LayoutDuration'))});
    }
    // Confirm real pointer movement and durability, independently of synthetic timings.
    const card=page.getByRole('article',{name:'节点0',exact:true});
    const prior=await card.evaluate(e=>({x:parseFloat(e.style.left),y:parseFloat(e.style.top)}));
    const grip=await card.locator('.studio-node-grip').boundingBox();
    await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await page.mouse.down();await page.mouse.move(grip.x+grip.width/2+30,grip.y+grip.height/2+15,{steps:10});await page.mouse.up();
    const moved=await card.evaluate(e=>({x:parseFloat(e.style.left),y:parseFloat(e.style.top)}));
    if(Math.abs(moved.x-prior.x-100)>2||Math.abs(moved.y-prior.y-50)>2)throw new Error(config.name+': final drag position lost '+JSON.stringify({prior,moved,grip}));
    const input=card.getByLabel('卡片文字');const start=performance.now();await input.focus();await input.press('End');await input.pressSequentially('保存检查ABCDEFGHIJKLMNOPQRSTUVWXYZ');const typingMs=performance.now()-start;
    const text=await input.inputValue();await page.waitForTimeout(1200);
    const stats=await page.evaluate(()=>({longTasks:window.fixtureLongTasks,domNodes:document.getElementsByTagName('*').length,visibleNodes:document.querySelectorAll('.studio-node').length,paths:document.querySelectorAll('.studio-connections path').length}));
    const passiveRequests={...requests};
    let videoPlayback;
    if(config.media) {
      videoPlayback=await page.locator('.studio-media video').first().evaluate(async player=>{await player.play();return !player.paused;});
      if(!videoPlayback)throw new Error('Video playback failed');
    }
    await page.screenshot({path:`data/canvas-acceptance-${report.label}-${config.name}.png`});
    await page.reload();await page.getByRole('article',{name:'节点0',exact:true}).waitFor();
    const restored=page.getByRole('article',{name:'节点0',exact:true});
    if(await restored.getByLabel('卡片文字').inputValue()!==text)throw new Error(config.name+': text not saved');
    if(JSON.stringify(await restored.evaluate(e=>({x:parseFloat(e.style.left),y:parseFloat(e.style.top)})))!==JSON.stringify(moved))throw new Error(config.name+': movement not saved');
    if(errors.length)throw new Error(errors.join('\n'));
    const result={...config,samples,typingMs,...stats,requests:passiveRequests,videoPlayback,durable:true};report.cases.push(result);console.log(JSON.stringify(result));await context.close();
  }
  const output=process.env.CANVAS_PERF_OUTPUT||`data/canvas-acceptance-${report.label}.json`;fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));console.log('Report: '+output);
  const limit=Number(process.env.CANVAS_P95_LIMIT_MS);
  if(limit>0 && report.cases.some(c=>c.samples.some(s=>s.p95>limit)))throw new Error(`Frame p95 exceeded ${limit}ms; see ${output}`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
