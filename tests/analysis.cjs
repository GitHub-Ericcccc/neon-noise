// Run with Node; no microphone, network, or third-party packages required.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('node:path').join(__dirname,'..','index.html'),'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script); // Syntax check of the actual shipped script.
const context = new Proxy({}, {get:(o,k)=> o[k] ?? (o[k]=()=>{})});
context.measureText = text => ({width:text.length*7});
context.createImageData = (w,h) => ({data:new Uint8ClampedArray(w*h*4)});
const elements = new Map();
function element() {return {value:'',style:{},classList:{toggle(){}},getContext:()=>context,getBoundingClientRect:()=>({width:800,height:300}),setAttribute(){},replaceChildren(){},append(){},addEventListener(){}};}
const sandbox = {console,performance,Float32Array,Float64Array,Uint16Array,Uint8ClampedArray,Set,Math,Number,Promise,setTimeout,clearTimeout,
  navigator:{hardwareConcurrency:8},window:{devicePixelRatio:1,matchMedia:()=>({matches:false}),addEventListener(){}},
  document:{querySelector:id=>{if(!elements.has(id)) elements.set(id,element());return elements.get(id);},getElementById:id=>{if(!elements.has(id)) elements.set(id,element());return elements.get(id);},createElement:element,createElementNS:element},requestAnimationFrame(){}};
vm.createContext(sandbox); vm.runInContext(script,sandbox);
const run=code=>vm.runInContext(code,sandbox);
run('audioContext={sampleRate:48000}; analyser={fftSize:32768,frequencyBinCount:16384}; spectrum=new Float32Array(16384).fill(-115); peakHold=new Float32Array(16384).fill(-115);');
for(const f of [20,44,100,1000,20000]) assert.ok(Math.abs(run(`xToFrequency(frequencyToX(${f},800),800)`)-f)<1e-7);
assert.equal(run('frequencyToX(20,800)'),46);
assert.equal(run('frequencyToX(20000,800)'),788);
assert.equal(run('dbToY(0,300)'),58); assert.equal(run('dbToY(-120,300)'),300);
run('spectrum[100]=-40; updatePeakHold(1000); spectrum[100]=-90; updatePeakHold(1000)');
assert.equal(run('peakHold[100]'),-44.5);
run('holdMode="hold"; updatePeakHold(1000)'); assert.equal(run('peakHold[100]'),-44.5);
run('var frames=[{data:new Float32Array(16384).fill(-40)},{data:new Float32Array(16384).fill(-60)}]');
assert.ok(Math.abs(run('buildAverageSpectrum(frames)[100]')-(-42.967086))<1e-4);
assert.equal(run('buildMaximumSpectrum(frames)[100]'),-40);
(async()=>{
 assert.equal(await run('buildPercentileSpectrum(frames,0.5).then(x=>x[100])'),-50);
 run('spectrum.fill(-110); spectrum[681]=-60;spectrum[682]=-30;spectrum[683]=-60;');
 assert.ok(Math.abs(run('findPeaks(spectrum)[0].frequency')-999.0234375)<0.01);
 assert.ok(run('buildNoiseSpectrum([{data:spectrum},{data:spectrum}]).peaks.length')>0);
 run('captureStartedAt=0; capturedElapsedMs=0; historyFrames=[]; pushWaterfallRow(0);pushWaterfallRow(10000);pushWaterfallRow(31000)');
 assert.equal(run('historyFrames.length'),2); assert.equal(run('historyFrames[0].timestamp'),10000);
 const before=run('spectrum[682]'); run('view.waterfallMinDb=-100;view.waterfallMaxDb=-20;rebuildWaterfall()');assert.equal(run('spectrum[682]'),before);
 run('var cachedRaster=historyFrames[0].raster;rebuildWaterfall()');assert.equal(run('cachedRaster===historyFrames[0].raster'),true);
 run('view.waterfallMinDb=-90;rebuildWaterfall()');assert.equal(run('cachedRaster===historyFrames[0].raster'),false);
 run('historyFrames=[];for(let n=0;n<400;n++)pushWaterfallRow(n*110)');assert.ok(run('historyFrames.length')<=274);
 run('clearHistory()');assert.equal(run('historyFrames.length'),0);assert.equal(run('showAnalysis'),false);
 let expire; sandbox.setTimeout=fn=>{expire=fn;return 1;};sandbox.clearTimeout=()=>{};
 let lateResolve, stopped=false;
 sandbox.navigator.mediaDevices={getUserMedia:()=>new Promise(resolve=>lateResolve=resolve)};
 const request=run('requestMicrophone()'); const rejection=assert.rejects(request,/超时/);expire();await rejection;
 lateResolve({getTracks:()=>[{stop:()=>stopped=true}]});await Promise.resolve();await Promise.resolve();assert.equal(stopped,true);
 run('var releaseOrder=[];audioContext={sampleRate:48000,state:"running",close:async function(){releaseOrder.push("close");this.state="closed";}};microphoneStream={getTracks:()=>[{stop:()=>releaseOrder.push("track")} ]};microphoneSource={disconnect(){}};gainNode={disconnect(){}};running=true;');
 const frozenSpectrum=run('spectrum');run('freezeCapture()');assert.equal(run('running'),false);assert.equal(run('spectrum'),frozenSpectrum);await run('releaseCapture()');assert.equal(run('releaseOrder.join(",")'),'track,close');assert.equal(run('getSampleRate()'),48000);
 const license=fs.readFileSync(require('node:path').join(__dirname,'..','LICENSE'),'utf8').trim();assert.ok(html.includes(license));
 assert.ok(html.includes('Copyright (c) 2026 Arrow36'));
 console.log('PASS: syntax, coordinate roundtrip, dB mapping, peak decay/hold, four analysis modes, peak frequency, 30-second history pruning, raster cache invalidation, clear, microphone timeout/late stream release, independent color range, embedded MIT.');
})().catch(e=>{console.error(e);process.exitCode=1;});
