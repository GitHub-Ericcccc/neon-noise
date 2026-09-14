// Synthetic validation only; no claim of real-world recognition accuracy.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const core=require('../impact-core.js'),files=require('../record-files.js');
const root=path.join(__dirname,'..');
for(const name of ['impact-core.js','record-files.js','record-logging.js'])new vm.Script(fs.readFileSync(path.join(root,name),'utf8'));
const workletSource=fs.readFileSync(path.join(root,'impact-worklet.js'),'utf8');
new vm.Script(workletSource.replace("import './impact-core.js';",''));
function frame(time,level=-80){return {timeMs:time,mainDb:level,mainPeakDb:level+3,auxDb:level,focusDb:level};}
function feed(detector,to,level=-80,from=detector.lastTime+20){for(let t=from;t<=to;t+=20)detector.push(frame(t,typeof level==='function'?level(t):level));}
function pulses(times){const d=new core.Detector();feed(d,5000);for(const t of times){feed(d,t-20);feed(d,t+80,-55,t);feed(d,t+600);}d.finish();return d;}
const silence=new core.Detector();feed(silence,12000);assert.equal(silence.events.length,0);
const ramp=new core.Detector();feed(ramp,20000,t=>-80+t/2000);assert.equal(ramp.events.length,0);
const warmup=new core.Detector();feed(warmup,1000);feed(warmup,1100,-35);feed(warmup,4500);assert.equal(warmup.events.length,0);
const repeated=pulses([6000,7000,8000,9000]);assert.equal(repeated.events.length,4);
const summary=core.summarize(repeated.events,10000);assert.equal(summary.candidateCount,4);assert.equal(summary.sequences.length,1);assert.equal(summary.sequences[0].cadencePerMinute,60);
const ring=new core.Detector();feed(ring,5000);feed(ring,6100);feed(ring,6180,-50);feed(ring,6300);feed(ring,6400,-60);feed(ring,7200);assert.equal(ring.events.length,1);
const sustained=new core.Detector();feed(sustained,6000);feed(sustained,9000,-45);feed(sustained,9800);assert.equal(sustained.events.length,1);assert.equal(sustained.events[0].type,'sustained');assert.equal(core.summarize(sustained.events,9800).candidateCount,0);
const interrupted=pulses([6000,7000]);interrupted.interrupt(8000);feed(interrupted,13500);feed(interrupted,14080,-55);feed(interrupted,15000);assert.equal(core.summarize(interrupted.events,15000).intervals.length,1);assert.equal(core.summarize(interrupted.events,15000).sequences.length,0);
assert.throws(()=>core.validateSettings({endDb:7}));assert.throws(()=>core.validateSettings({mainHigh:20}));assert.throws(()=>core.validateSettings({maxMs:601000}));

function pcm(duration,signal) {
 const rate=48000,channel=new core.EnergyChannel(rate),detector=new core.Detector(),frames=[];
 for(let offset=0;offset<duration*rate;offset+=128){const n=Math.min(128,duration*rate-offset),data=Float32Array.from({length:n},(_,i)=>signal((offset+i)/rate));for(const f of channel.process(data,offset+n)){frames.push(f);detector.push(f);}}
 detector.finish();return {frames,events:detector.events};
}
const mains=pcm(7,t=>.003*Math.sin(2*Math.PI*50*t));assert.equal(mains.events.length,0);
const high=pcm(8,t=>(t>6&&t<6.08?.01:0)*Math.sin(2*Math.PI*1500*t)+.0002*Math.sin(2*Math.PI*50*t));assert.equal(high.events.length,0);
const low=pcm(9,t=>.0002*Math.sin(2*Math.PI*50*t)+(t>=6&&t<6.08?.02*Math.exp(-(t-6)/.02)*Math.sin(2*Math.PI*60*(t-6)):0));assert.equal(low.events.length,1);assert.equal(low.events[0].type,'impact');
assert.ok(low.frames.find(f=>f.timeMs>6050&&f.timeMs<6100).focusDb>-80);

// Actual worklet process: zero output and sample-clock timestamps.
let Processor;const posted=[];
class FakeProcessor{constructor(){this.port={postMessage:f=>posted.push(f)};}}
const ws={ImpactCore:core,sampleRate:48000,currentFrame:0,AudioWorkletProcessor:FakeProcessor,registerProcessor:(_,cls)=>Processor=cls,Float32Array};ws.globalThis=ws;
vm.runInNewContext(workletSource.replace("import './impact-core.js';",''),ws);
const processor=new Processor({processorOptions:{settings:core.DEFAULTS}}),output=new Float32Array(128).fill(1);
for(let n=0;n<40;n++){ws.currentFrame=n*128;processor.process([[new Float32Array(128)]],[[output]]);}assert.ok(posted.length);assert.ok(output.every(x=>x===0));assert.equal(posted[0].timeMs,80);
processor.port.onmessage({data:{type:'enabled',enabled:false}});const postCount=posted.length;processor.process([[new Float32Array(128)]],[[output]]);assert.equal(posted.length,postCount);

async function controllerHarness() {
 let now=0,node,recorder,failChunks=false;const timers=[],saved=new Map(),persisted=[],elements=new Map(),listeners=new Map();
 class Element {
  constructor(){this.value='';this.dataset={};this.children=[];this.disabled=false;this.hidden=false;this.currentTime=0;this.clientWidth=390;this.clientHeight=160;}
  append(...items){this.children.push(...items);for(const item of items)if(item.id)elements.set(item.id,item);}
  add(option){this.append(option);} replaceChildren(...items){this.children=items;}get childElementCount(){return this.children.length;}
  querySelectorAll(){return this.children.flatMap(row=>row.children.flatMap(td=>td.children));}
  removeAttribute(name){delete this[name];}play(){return Promise.resolve();}
  getContext(){return new Proxy({},{get:(_,key)=>key==='measureText'?()=>({width:10}):()=>{}});}
  addEventListener(type,fn){this['on'+type]=fn;}
 }
 const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};get('analysisMode').value='impact';
 class Events{constructor(){this.listeners={};}addEventListener(t,fn){(this.listeners[t]||=[]).push(fn);}removeEventListener(t,fn){this.listeners[t]=(this.listeners[t]||[]).filter(x=>x!==fn);}emit(t,e={}){for(const fn of this.listeners[t]||[])fn(e);}}
 class Recorder extends Events{static isTypeSupported(m){return m==='audio/mp4';}constructor(){super();recorder=this;this.state='inactive';this.mimeType='audio/mp4';}start(){this.state='recording';queueMicrotask(()=>this.emit('start'));}stop(){this.state='inactive';this.emit('dataavailable',{data:new Blob(['fake audio'],{type:'audio/mp4'})});queueMicrotask(()=>this.emit('stop'));}}
 class Worklet {constructor(){node=this;this.port={postMessage(){},close(){}};}connect(){}disconnect(){}}
 const track=new Events();track.getSettings=()=>({sampleRate:48000,autoGainControl:false});
 const context=new Events();context.state='running';context.currentTime=0;context.sampleRate=48000;context.audioWorklet={addModule:async()=>{}};context.resume=async()=>{context.state='running';};context.createGain=()=>({gain:{value:0},connect(){},disconnect(){}});
 const storage={save:async s=>saved.set(s.id,structuredClone(s)),list:async()=>[...saved.values()],chunk:async(id,i,blob)=>{if(failChunks)throw Error('QuotaExceededError');persisted[i]=blob;},chunks:async()=>persisted,remove:async s=>saved.delete(s.id)};
 const document={hidden:false,getElementById:get,createElement:()=>new Element(),querySelector:()=>({textContent:'MIT License\nCopyright (c) 2026 Arrow36'}),addEventListener:(t,fn)=>listeners.set(t,fn)};
 const sandbox={console,document,navigator:{userAgent:'test Safari'},performance:{now:()=>now},crypto:globalThis.crypto,structuredClone,Blob,MediaRecorder:Recorder,AudioWorkletNode:Worklet,Option:class extends Element{constructor(text,value){super();this.textContent=text;this.value=value;}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout(){},setInterval:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearInterval(){},confirm:()=>true};
 let began=0,frozen=0,released=0; sandbox.window=sandbox;sandbox.ImpactCore=core;sandbox.RecordFiles={...files,openStore:async()=>storage,buildExport:(s,a,l)=>files.buildExport(s,a,l,core)};sandbox.NoiseInput={ensure:async()=>({context,stream:{getAudioTracks:()=>[track]},source:{connect(){},disconnect(){}}}),begin(){began++;},freeze(){frozen++;},release:async()=>{assert.notEqual(recorder?.state,'recording');released++;},frequencyX:()=>50,latestHistory:()=>null};sandbox.addEventListener=()=>{};
 vm.runInNewContext(fs.readFileSync(path.join(root,'record-logging.js'),'utf8'),sandbox);
 await new Promise(resolve=>setImmediate(resolve));sandbox.location={protocol:'file:'};await get('recordStart').onclick();assert.equal(recorder,undefined);assert.equal(sandbox.ImpactLogging.isRecording(),false);assert.match(get('recordStatus').textContent,/file:\/\/.*http:\/\/127/);assert.equal(get('recordStart').disabled,false);sandbox.location.protocol='http:';await get('recordStart').onclick();assert.equal(recorder.state,'recording');assert.equal(sandbox.ImpactLogging.isRecording(),true);assert.equal(get('detect-triggerDb').disabled,true);
 function energy(to,level=-80){for(now+=20;now<=to;now+=20){context.currentTime=now/1000;node.port.onmessage({data:frame(now,level)});}now=to;}
 assert.equal(get('recordPhase').textContent,'学习中');energy(6000);assert.equal(get('recordPhase').textContent,'记录中');energy(6080,-50);energy(6800);assert.match(get('recordMetrics').textContent,/候选 1 次/);
 // Switching the original analysis selector does not stop acquisition.
 for(const mode of ['mean','median','maximum','noise','impact']){get('analysisMode').value=mode;get('analysisMode').onchange();assert.notEqual(get('impactPanel').hidden,true);assert.equal(sandbox.ImpactLogging.isRecording(),true);assert.equal(recorder.state,'recording');assert.equal(get('recordStop').disabled,false);}
 document.hidden=true;listeners.get('visibilitychange')();assert.equal(get('recordPhase').textContent,'已中断');const before=get('eventRows').childElementCount;energy(7500,-45);assert.equal(get('eventRows').childElementCount,before);
 document.hidden=false;listeners.get('visibilitychange')();await new Promise(resolve=>setImmediate(resolve));energy(13000);energy(13080,-50);energy(13800);assert.match(get('recordMetrics').textContent,/候选 2 次/);assert.match(get('recordMetrics').textContent,/疑似步频 —/);
 // Fail the real chunk persistence callback, preserve in-memory audio and stop.
 failChunks=true;recorder.emit('dataavailable',{data:new Blob(['earlier'])});await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(sandbox.ImpactLogging.isRecording(),false);assert.equal(recorder.state,'inactive');assert.equal(get('recordExport').disabled,false);
 failChunks=false;const stoppedTime=get('recordTime').textContent;await get('recordExport').onclick();assert.equal(get('recordPhase').textContent,'已停止');assert.equal(get('recordTime').textContent,stoppedTime);assert.equal(get('sessionNotice').textContent,'ZIP 已就绪');assert.equal(get('recordConfirm').disabled,false);assert.equal(get('recordDelete').disabled,true);await get('recordConfirm').onclick();assert.equal(get('recordDelete').disabled,false);assert.equal(get('recordTime').textContent,stoppedTime);
 // Independent hard limit callback; no render-loop tick is required.
 await get('recordStart').onclick();now+=600000;timers.filter(t=>t.delay===600000).at(-1).fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(sandbox.ImpactLogging.isRecording(),false);assert.match(get('recordStatus').textContent,/10分钟/);
 assert.equal(began,2);assert.ok(frozen>=2);assert.ok(released>=2);
 const previousCount=saved.size;await get('recordStart').onclick();const same=recorder;await get('recordStart').onclick();assert.equal(recorder,same);await get('recordStop').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(get('recordStatus').textContent,'已停止');assert.ok(saved.size>previousCount);assert.ok(persisted.some(Boolean));
 const releasesBeforeFailure=released;const originalEnsure=sandbox.NoiseInput.ensure;sandbox.NoiseInput.ensure=async()=>{throw Error('microphone setup failed');};await get('recordStart').onclick();assert.ok(released>releasesBeforeFailure);assert.equal(get('recordStart').disabled,false);assert.equal(sandbox.ImpactLogging.isRecording(),false);sandbox.NoiseInput.ensure=originalEnsure;
 return [...saved.values()];
}

(async()=>{
 const page=fs.readFileSync(path.join(root,'index.html'),'utf8');
 assert.match(page,/value="impact" selected>楼上噪声优化检测/);assert.ok(!page.includes('使用独立记录按钮'));assert.ok(!page.includes('法律证据资格'));assert.ok(!page.includes('id="impactPanel" hidden'));
 assert.ok(page.indexOf('id="recordStart"')<page.indexOf('id="spectrum"'));assert.ok(page.indexOf('id="waterfall"')<page.indexOf('id="energyTrace"'));assert.ok(page.indexOf('id="energyTrace"')<page.indexOf('id="eventRows"'));assert.ok(page.indexOf('id="recordExport"')<page.indexOf('id="spectrum"'));assert.ok(page.indexOf('id="recordMetrics"')>page.indexOf('id="eventRows"'));assert.ok(!page.includes('id="start"'));assert.ok(!page.includes('demoMode'));
 assert.equal(files.chooseMime({isTypeSupported:m=>m==='audio/mp4'}).extension,'m4a');assert.throws(()=>files.chooseMime(null));
 assert.equal(files.crc32(new TextEncoder().encode('123456789')),0xcbf43926);
 const s={id:'synthetic-test',startedAt:'2026-09-14T00:00:00Z',endedAt:'2026-09-14T00:00:10Z',elapsedMs:10000,settings:core.DEFAULTS,events:repeated.events,segments:[],interruptions:[],metadata:{version:files.VERSION},audioExtension:'m4a',stopReason:'test',timeBasis:{}};
 const csv=files.csv(s);assert.equal(csv.split('\r\n').length,5);assert.ok(csv.includes('2026-09-14T00:00:06.000Z'));assert.ok(!csv.includes('NaN'));
 const license=fs.readFileSync(path.join(root,'LICENSE'),'utf8').replaceAll('\r\n','\n').trim();
 const out=await files.buildExport(s,new Blob(['synthetic audio']),license,core);assert.equal(out.manifest.length,5);assert.equal(out.manifest[0].sha256,await files.hash(new TextEncoder().encode('synthetic audio')));
 const bytes=new Uint8Array(await out.blob.arrayBuffer()),view=new DataView(bytes.buffer);let offset=0,names=[];
 while(view.getUint32(offset,true)===0x04034b50){const len=view.getUint32(offset+18,true),nameLen=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true);const name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+nameLen));const start=offset+30+nameLen+extra,data=bytes.slice(start,start+len);assert.equal(files.crc32(data),view.getUint32(offset+14,true));names.push(name);if(name==='report.html'){const report=new TextDecoder().decode(data);assert.ok(report.includes('Copyright (c) 2026 Arrow36'));assert.ok(!report.includes('法律证据'));assert.ok(!report.includes('不是经校准'));assert.ok(report.includes('设置与采集元数据'));}offset=start+len;}
 assert.deepEqual(names,['recording.m4a','events.csv','session.json','report.html','LICENSE','manifest.json']);assert.equal(view.getUint32(offset,true),0x02014b50);
 await assert.rejects(new files.Store({transaction(){const tx={objectStore:()=>({put(){queueMicrotask(()=>{tx.error=Error('quota');tx.onabort();});}})};return tx;}}).chunk('id',0,new Blob(['x'])),/quota/);
 await assert.rejects(new files.Store({}).remove({exportConfirmed:false}),/确认/);
 await assert.rejects(files.openStore(null),/IndexedDB/);
 const records=await controllerHarness();assert.ok(records.length>=2);
 console.log('PASS: PCM low-frequency pulse/mains/high-frequency interference, warmup/ramp/ringing/sustained/sequence/interruption, worklet zero output and sample clock, MIME, storage failure, session limit independent of rendering, local export confirmation, CSV/JSON/report/MIT, ZIP CRC and SHA-256. Synthetic tests do not establish real-world accuracy.');
})().catch(error=>{console.error(error);process.exitCode=1;});
