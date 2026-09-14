/* MIT licensed; see LICENSE. Experimental local-only session controller. */
(function() {
  'use strict';
  const C=window.ImpactCore,F=window.RecordFiles,$=id=>document.getElementById(id);
  const ui={panel:$('impactPanel'),status:$('recordStatus'),start:$('recordStart'),stop:$('recordStop'),export:$('recordExport'),confirm:$('recordConfirm'),remove:$('recordDelete'),saved:$('recordSaved'),audio:$('recordAudio'),rows:$('eventRows'),metrics:$('recordMetrics'),canvas:$('energyTrace')};
  let store,session,detector,node,sink,recorder,input,origin=0,clock=0,timer,heartbeat,saveQueue=Promise.resolve(),chunks=[],bytes=0,stopping=false,exportReady=false,url,downloadUrl;
  let acquisition=false,recording=false,interrupted=false,resuming=false,lastFrameAt=0,paintAt=0,saveAt=0,workletLoaded=false,liveSession=false;
  const fields=Object.keys(C.DEFAULTS);
  const labels={mainLow:'主频带下限Hz',mainHigh:'主频带上限Hz',auxLow:'辅助下限Hz',auxHigh:'辅助上限Hz',focusLow:'重点下限Hz',focusHigh:'重点上限Hz',windowMs:'能量窗口ms',hopMs:'更新间隔ms',warmupMs:'背景学习ms',backgroundMs:'背景窗口ms',triggerDb:'触发增量dB',riseDb:'上升门槛dB',endDb:'结束增量dB',endHoldMs:'结束保持ms',mergeMs:'振铃合并ms',sustainedMs:'持续增强ms',maxMs:'会话上限ms（固定）'};
  for(const key of fields){const label=document.createElement('label'),field=document.createElement('input');label.textContent=labels[key];field.type='number';field.step='any';field.id='detect-'+key;field.value=C.DEFAULTS[key];if(key==='maxMs')field.readOnly=true;label.append(field);$('detectSettings').append(label);}
  function say(text){ui.status.textContent=text;}
  function lock(on){for(const key of fields)$('detect-'+key).disabled=on;ui.start.disabled=on;ui.stop.disabled=!on;ui.export.disabled=on||!session;ui.saved.disabled=on;ui.confirm.disabled=true;ui.remove.disabled=true;exportReady=false;}
  function settings(){return C.validateSettings(Object.fromEntries(fields.map(key=>[key,Number($('detect-'+key).value)])));}
  function elapsed(){return Math.min(600000,Math.max(0,performance.now()-clock));}
  function enqueue(action){const next=saveQueue.then(action);saveQueue=next.catch(error=>{if(session)session.persistenceError=error.message;if(recording)void stop('本地保存失败：'+error.message);else say('本地保存失败，内存中的数据仍可导出：'+error.message);});return next;}
  function snapshot(){return structuredClone(session);}
  function save(){if(session&&store)return enqueue(()=>store.save(snapshot()));}
  async function refreshSaved(){if(!store)return;const records=await store.list();ui.saved.replaceChildren(new Option('选择本地已保存会话',''));for(const s of records.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)))ui.saved.add(new Option(s.startedAt+' · '+s.events.length+'条 · '+(s.endedAt?'已结束':'中断待恢复'),s.id));}
  function sealSegment(time){const segment=session?.segments.at(-1);if(segment&&segment.endMs===null)segment.endMs=time;}
  function eventPush(event){if(event){event.wallTime=new Date(Date.parse(session.startedAt)+event.startMs).toISOString();event.playbackTimeEstimated=!!session.interruptions.length;session.events.push(event);}}
  function interrupt(reason) {
    if(!recording||interrupted)return;
    const t=elapsed();interrupted=true;node?.port.postMessage({type:'enabled',enabled:false});sealSegment(t);eventPush(detector.interrupt(t));session.interruptions.push({type:'interruption',timeMs:t,reason});session.elapsedMs=t;void save();render();say('记录中断：'+reason+'。完整音频可能有缺口；回到前台将重新学习背景。');
  }
  async function resume() {
    if(!recording||!interrupted||document.hidden||resuming)return;
    resuming=true;
    try{await input.context.resume();if(input.context.state!=='running')throw Error('音频上下文未恢复');const t=elapsed();origin=input.context.currentTime*1000-t;detector.reset(t);session.segments.push({segment:detector.segment,startMs:t,endMs:null});session.interruptions.push({type:'resume',timeMs:t,reason:'前台恢复；重新学习背景'});node.port.postMessage({type:'reset'});node.port.postMessage({type:'enabled',enabled:true});interrupted=false;lastFrameAt=performance.now();say('恢复记录，重新学习背景5秒；中断后的音频定位仅作估计。');void save();}
    catch(error){say('无法自动恢复，点击“恢复记录”重试：'+error.message);}
    finally{resuming=false;}
  }
  async function start() {
    if(acquisition||recording)return;
    if(window.location?.protocol==='file:'){say('无法开始记录：直接打开 HTML（file://）无法加载 AudioWorklet。请运行 node scripts/serve.cjs 8765，然后访问 http://127.0.0.1:8765/；手机请使用 HTTPS 测试地址。');return;}
    if(session?.persistenceError&&!session.exportConfirmed){say('上次会话未完整写入，请先导出并确认保存，避免覆盖内存中的录音。');return;}
    acquisition=true;lock(true);say('准备本地存储、麦克风与录音…');
    try {
      const s=settings(),encoding=F.chooseMime(window.MediaRecorder);
      store=store||await F.openStore();input=await window.NoiseInput.ensure();
      if(input.demo)throw Error('模拟信号不能作为录音来源，请刷新后使用麦克风');
      if(!input.context.audioWorklet||!window.AudioWorkletNode)throw Error('Safari 未开放 AudioWorklet，请升级系统并使用 HTTPS 地址');
      if(!workletLoaded){await input.context.audioWorklet.addModule('./impact-worklet.js');workletLoaded=true;}
      await input.context.resume();
      clock=performance.now();origin=input.context.currentTime*1000;detector=new C.Detector(s);chunks=[];bytes=0;saveQueue=Promise.resolve();interrupted=false;stopping=false;lastFrameAt=clock;
      session={id:new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8),startedAt:new Date().toISOString(),endedAt:null,elapsedMs:0,stopReason:null,settings:s,events:[],trace:[],interruptions:[],segments:[{segment:detector.segment,startMs:0,endMs:null}],exportConfirmed:false,audioMime:encoding.mime,audioExtension:encoding.extension,metadata:{version:F.VERSION,sampleRate:input.context.sampleRate,userAgent:navigator.userAgent,trackSettings:input.stream.getAudioTracks()[0].getSettings(),inputGainAppliedToDetector:false,filter:'second-order Butterworth high-pass then low-pass; band RMS and sample peak',eventRms:'mean power of overlapping window frames'},timeBasis:{wallClock:'Device Date; not trusted timestamp',eventClock:'performance.now elapsed from MediaRecorder start event; includes interruption gaps',audioSeek:'Estimated relative seconds; after interruptions media timestamps may differ. Verify full recording manually.'}};
      await store.save(snapshot());
      recorder=new MediaRecorder(input.stream,{mimeType:encoding.mime});
      recorder.addEventListener('dataavailable',event=>{if(!event.data.size)return;const index=chunks.length;chunks.push(event.data);bytes+=event.data.size;session.audioBytes=bytes;enqueue(()=>store.chunk(session.id,index,event.data)).catch(()=>{});if(bytes>128*1024*1024)void stop('达到128MiB录音安全上限');});
      recorder.addEventListener('error',event=>void stop('录音故障：'+(event.error?.message||'未知错误')));
      recorder.addEventListener('stop',()=>{if(recording)void stop('浏览器自行结束录音');});
      const started=new Promise((resolve,reject)=>{recorder.addEventListener('start',resolve,{once:true});recorder.addEventListener('error',reject,{once:true});});
      recorder.start(1000);await started;
      clock=performance.now();origin=input.context.currentTime*1000;session.startedAt=new Date().toISOString();
      if(recorder.mimeType)session.audioMime=recorder.mimeType;
      node=new AudioWorkletNode(input.context,'impact-energy',{processorOptions:{settings:s},numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      sink=input.context.createGain();sink.gain.value=0;input.source.connect(node);node.connect(sink);sink.connect(input.context.destination);
      node.onprocessorerror=()=>void stop('短时检测处理器故障');
      node.port.onmessage=({data})=>{
        if(!recording||interrupted)return;
        if(elapsed()>=s.maxMs){void stop('达到10分钟上限');return;}
        lastFrameAt=performance.now();const f={...data,timeMs:data.timeMs-origin};
        if(f.timeMs<0||f.timeMs<detector.lastTime)return;
        const result=detector.push(f);eventPush(result.event);
        session.trace.push({...f,backgroundDb:result.backgroundDb,incrementDb:result.incrementDb,learning:result.learning,segment:detector.segment});session.elapsedMs=elapsed();
        if(lastFrameAt-paintAt>=200){paintAt=lastFrameAt;render();say(result.learning?'记录中 · 学习背景（事件暂不计数）':'记录中 · '+(result.active?'候选低频增强':'等待候选事件'));}
        if(lastFrameAt-saveAt>=1000){saveAt=lastFrameAt;void save();}
      };
      recording=true;liveSession=true;window.NoiseInput.setRecording(true);lock(true);ui.stop.disabled=false;
      for(const track of input.stream.getAudioTracks())track.addEventListener('ended',onTrackEnd);
      input.context.addEventListener('statechange',onState);
      heartbeat=setInterval(()=>{if(elapsed()>=s.maxMs)void stop('达到10分钟上限');else if(!interrupted&&performance.now()-lastFrameAt>3000)interrupt('短时检测通道超过3秒无数据');},500);
      timer=setTimeout(()=>void stop('达到10分钟上限'),s.maxMs);void save();render();say('记录已开始 · 学习背景5秒');
      if(document.hidden)interrupt('页面处于后台');
    } catch(error) {if(recorder&&recorder.state!=='inactive'){recording=true;await stop('启动失败：'+error.message);}else{cleanup();lock(false);say('无法开始记录：'+error.message);}}
    finally{acquisition=false;}
  }
  function onTrackEnd(){void stop('麦克风音轨结束');}
  function onState(){if(!recording)return;if(input.context.state==='closed')void stop('音频上下文关闭');else if(input.context.state!=='running')interrupt('音频上下文 '+input.context.state);else if(interrupted&&!document.hidden)void resume();}
  function cleanup(){clearTimeout(timer);clearInterval(heartbeat);try{input?.source.disconnect(node);}catch{}node?.disconnect();sink?.disconnect();if(node){node.port.onmessage=null;node.port.close();}node=null;sink=null;input?.context.removeEventListener('statechange',onState);for(const t of input?.stream.getAudioTracks()||[])t.removeEventListener('ended',onTrackEnd);window.NoiseInput.setRecording(false);}
  async function stop(reason='用户结束记录') {
    if(!recording||stopping)return;stopping=true;recording=false;const t=elapsed();session.elapsedMs=t;sealSegment(t);eventPush(detector.finish());session.endedAt=new Date().toISOString();session.stopReason=reason;cleanup();say('正在保存最后的音频分块…');
    try {
      if(recorder.state!=='inactive')await new Promise(resolve=>{recorder.addEventListener('stop',resolve,{once:true});recorder.stop();});
      await saveQueue;try{await store.save(snapshot());}catch(error){session.persistenceError=error.message;}
      const audio=new Blob(chunks,{type:session.audioMime});setAudio(audio);lock(false);render();await refreshSaved();say('记录已结束：'+reason+'。请导出并核对文件；未确认前不可删除。');
    } catch(error){lock(false);render();say('保存结束时出现错误，已收到的音频仍可尝试导出：'+error.message);}
    finally{stopping=false;}
  }
  function setAudio(blob){if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(blob);ui.audio.src=url;}
  async function loadSaved(id) {
    if(!id||recording)return;
    if(session?.persistenceError&&!session.exportConfirmed){say('请先导出并确认当前内存中的录音，再切换会话。');return;}
    liveSession=false;
    try{const records=await store.list();session=records.find(x=>x.id===id);if(!session)throw Error('会话不存在');chunks=await store.chunks(id);if(!session.endedAt){session.stopReason='页面曾关闭或崩溃；恢复已保存数据';session.endedAt=new Date().toISOString();sealSegment(session.elapsedMs);session.interruptions.push({type:'unclosed-session',timeMs:session.elapsedMs,reason:session.stopReason});await store.save(snapshot());}setAudio(new Blob(chunks,{type:session.audioMime}));lock(false);render();say('已恢复本地会话。仅包含成功写入的音频分块与日志，未保存尾部可能缺失。');}catch(e){say('恢复失败：'+e.message);}
  }
  async function exportSession() {
    if(recording||!session)return;
    ui.export.disabled=true;say('正在生成 ZIP 与 SHA-256 清单…');
    try{const license=document.querySelector('.license-text').textContent.trim();const result=await F.buildExport(snapshot(),new Blob(chunks,{type:session.audioMime}),license);if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(result.blob);const link=$('recordDownload');link.href=downloadUrl;link.download=result.filename;link.hidden=false;link.textContent='下载 ZIP（'+(result.blob.size/1048576).toFixed(1)+' MiB）';exportReady=true;ui.confirm.disabled=false;say('ZIP 已准备好。点击下载后，打开文件核对音频及清单，再确认已保存。浏览器下载启动不代表文件已经保存。');}catch(error){say('导出失败：'+error.message);}finally{ui.export.disabled=false;}
  }
  async function confirmExport(){if(!exportReady||!session)return;session.exportConfirmed=true;try{await store.save(snapshot());ui.remove.disabled=false;say('已按你的确认标记导出成功，可选择删除本地会话。');}catch(e){session.exportConfirmed=false;say('确认状态保存失败：'+e.message);}}
  async function removeSession(){if(!session?.exportConfirmed||!confirm('仅删除本机此会话及录音，导出的ZIP不受影响。确认删除？'))return;try{await store.remove(session);session=null;chunks=[];if(url)URL.revokeObjectURL(url);ui.audio.removeAttribute('src');lock(false);render();await refreshSaved();say('本地会话已删除，导出文件保留。');}catch(e){say('删除失败：'+e.message);}}
  function render() {
    const s=session?C.summarize(session.events,session.elapsedMs,session.segments):null;
    ui.metrics.textContent=s?`候选 ${s.candidateCount} 次 · 持续增强 ${s.sustainedCount} 次 · 最近滤波峰值 ${s.lastEvent?.peakDbfs.toFixed(1)??'—'} dBFS · 背景增量 ${s.lastEvent?.incrementDb.toFixed(1)??'—'} dB · 间隔 ${s.lastIntervalSeconds?.toFixed(2)??'—'} 秒 · 最近60秒 ${s.recentCount} 次（有效观察 ${s.observedSeconds.toFixed(1)} 秒） · 疑似步频 ${s.sequences.at(-1)?.cadencePerMinute.toFixed(1)??'—'} 次/分 · 会话 ${(session.elapsedMs/1000).toFixed(1)} 秒`:'尚无会话';
    if(ui.rows.dataset.session!==(session?.id||'')||ui.rows.childElementCount!==(session?.events.length||0)) {
      ui.rows.dataset.session=session?.id||'';
      ui.rows.replaceChildren();for(const e of session?.events||[]) {const row=document.createElement('tr');for(const value of [e.id,e.type==='impact'?'候选撞击':'持续增强',(e.startMs/1000).toFixed(2),(e.durationMs/1000).toFixed(2),e.peakDbfs.toFixed(1),e.rmsDbfs.toFixed(1),e.incrementDb.toFixed(1)]){const td=document.createElement('td');td.textContent=value;row.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.type='button';button.textContent=recording?'结束后播放':'定位播放';button.disabled=recording;button.onclick=()=>{ui.audio.currentTime=Math.max(0,e.startMs/1000-.5);ui.audio.play().catch(err=>say('播放失败：'+err.message));if(e.playbackTimeEstimated)say('中断后的定位时间仅作估计，请结合完整音频人工核对。');};td.append(button);row.append(td);ui.rows.append(row);}
    } else for(const button of ui.rows.querySelectorAll('button')){button.disabled=recording;button.textContent=recording?'结束后播放':'定位播放';}
    const ctx=ui.canvas.getContext('2d'),w=Math.max(1,ui.canvas.clientWidth),h=160;ui.canvas.width=w;ui.canvas.height=h;ctx.fillStyle='#08101e';ctx.fillRect(0,0,w,h);
    const frames=(session?.trace||[]).filter(f=>f.timeMs>=(session.elapsedMs||0)-30000),now=session?.elapsedMs||0,min=-120,max=-20;
    for(const [field,color] of [['mainDb','#f2d85b'],['backgroundDb','#78dbe4']]) {ctx.strokeStyle=color;ctx.beginPath();let segment=null;for(const f of frames){const x=w*(1-(now-f.timeMs)/30000),y=h*(1-Math.max(0,Math.min(1,(f[field]-min)/(max-min))));if(segment!==f.segment)ctx.moveTo(x,y);else ctx.lineTo(x,y);segment=f.segment;}ctx.stroke();}
    ctx.fillStyle='#a2b0c5';ctx.font='11px system-ui';ctx.fillText('最近30秒：黄=主频带 RMS；青=背景；纵轴 −120～−20 dBFS',8,14);
    for(const e of session?.events||[])if(now-e.startMs<=30000){const x=w*(1-(now-e.startMs)/30000);ctx.strokeStyle='#ef5268';ctx.beginPath();ctx.moveTo(x,20);ctx.lineTo(x,h);ctx.stroke();}
    drawMarkers();
  }
  function drawMarkers() {
    const active=$('analysisMode').value==='impact';
    for(const id of ['impactSpectrumOverlay','impactWaterfallOverlay']) {
      const canvas=$(id);canvas.hidden=!active;if(!active)continue;const target=$(id==='impactSpectrumOverlay'?'spectrum':'waterfall'),w=target.clientWidth,h=target.clientHeight;canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');const focus=session?.settings||C.DEFAULTS;const left=window.NoiseInput.frequencyX(focus.focusLow,w),right=window.NoiseInput.frequencyX(focus.focusHigh,w);ctx.fillStyle='rgba(242,216,91,.10)';ctx.fillRect(left,0,right-left,h);
      if(id==='impactWaterfallOverlay'&&session&&liveSession){const history=window.NoiseInput.latestHistory();if(history){for(const e of session.events){const age=history.performanceMs-(clock+e.startMs);if(age>=0&&age<=30000){const y=age/30000*h;ctx.strokeStyle='#ef5268';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillStyle='#ef5268';ctx.font='10px system-ui';ctx.fillText('#'+e.id,right+2,y+10);}}}}
    }
  }
  window.ImpactLogging={isRecording:()=>recording,redraw:drawMarkers};
  ui.start.onclick=start;ui.stop.onclick=()=>void stop();ui.export.onclick=exportSession;ui.confirm.onclick=confirmExport;ui.remove.onclick=removeSession;ui.saved.onchange=()=>void loadSaved(ui.saved.value);$('recordResume').onclick=resume;
  $('analysisMode').addEventListener('change',()=>{ui.panel.hidden=$('analysisMode').value!=='impact';drawMarkers();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)interrupt('页面进入后台或锁屏');else void resume();});
  window.addEventListener('pagehide',()=>{if(recording)interrupt('页面离开；恢复时仅保留已写入数据');});
  window.addEventListener('resize',render);
  F.openStore().then(async value=>{store=value;await refreshSaved();}).catch(error=>say('本地存储不可用：'+error.message));
  render();
})();
