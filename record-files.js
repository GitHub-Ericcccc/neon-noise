/* MIT licensed; see LICENSE. Local persistence and portable exports; no network. */
(function(root) {
  'use strict';
  const VERSION='v1.1.0';
  function openStore(indexedDB=root.indexedDB) {
    return new Promise((resolve,reject)=>{
      if(!indexedDB)return reject(Error('当前浏览器不支持本地 IndexedDB 存储'));
      const request=indexedDB.open('neon-noise-records',1);
      request.onupgradeneeded=()=>{request.result.createObjectStore('sessions',{keyPath:'id'});request.result.createObjectStore('chunks',{keyPath:['sessionId','index']});};
      request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('存储被另一个页面阻塞，请关闭其他本工具页面'));
      request.onsuccess=()=>resolve(new Store(request.result));
    });
  }
  class Store {
    constructor(db){this.db=db;}
    transaction(names,action,mode='readwrite') {
      return new Promise((resolve,reject)=>{const tx=this.db.transaction(names,mode);let value;try{value=action(tx);}catch(e){tx.abort();reject(e);return;}tx.oncomplete=()=>resolve(typeof value==='function'?value():value);tx.onabort=()=>reject(tx.error||Error('本地存储事务中止'));tx.onerror=()=>{};});
    }
    save(session){return this.transaction(['sessions'],tx=>tx.objectStore('sessions').put(session));}
    chunk(sessionId,index,blob){return this.transaction(['chunks'],tx=>tx.objectStore('chunks').put({sessionId,index,blob}));}
    list(){return this.transaction(['sessions'],tx=>{const r=tx.objectStore('sessions').getAll();return ()=>r.result;},'readonly');}
    chunks(id){return this.transaction(['chunks'],tx=>{const r=tx.objectStore('chunks').getAll(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]));return ()=>r.result.map(x=>x.blob);},'readonly');}
    async remove(session) {
      if(!session.exportConfirmed)throw Error('请先核对导出文件并确认已保存');
      return this.transaction(['sessions','chunks'],tx=>{tx.objectStore('sessions').delete(session.id);tx.objectStore('chunks').delete(IDBKeyRange.bound([session.id,0],[session.id,Number.MAX_SAFE_INTEGER]));});
    }
  }
  const escapeHtml = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const csvCell = value => '"'+String(value??'').replace(/"/g,'""')+'"';
  function csv(session) {
    const fields=['id','segment','type','startMs','endMs','durationMs','peakDbfs','rmsDbfs','backgroundDbfs','incrementDb','intervalSeconds','startedAt'];
    const rows=session.events.map((event,i)=>({...event,intervalSeconds:i&&session.events[i-1].segment===event.segment?(event.startMs-session.events[i-1].startMs)/1000:null,startedAt:new Date(Date.parse(session.startedAt)+event.startMs).toISOString()}));
    return '\ufeff'+[fields.map(csvCell).join(','),...rows.map(row=>fields.map(key=>csvCell(row[key])).join(','))].join('\r\n');
  }
  function report(session,audioName,summary,license) {
    const e=escapeHtml;
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>疑似低频撞击记录</title><style>body{max-width:1000px;margin:24px auto;padding:12px;font:14px/1.6 system-ui;color:#172335}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #aaa;padding:5px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}audio{width:100%}@media print{audio,button{display:none}tr{break-inside:avoid}}</style><h1>低频记录报告</h1><p>会话 ${e(session.id)}；开始 ${e(session.startedAt)}；结束 ${e(session.endedAt)}；时长 ${(session.elapsedMs/1000).toFixed(1)} 秒。</p><p>候选 ${summary.candidateCount} 次；持续增强 ${summary.sustainedCount} 次。结束原因：${e(session.stopReason)}。</p><audio id="audio" controls src="${e(audioName)}"></audio><table><thead><tr><th>ID／类型</th><th>开始秒</th><th>持续秒</th><th>滤波峰值 dBFS</th><th>滤波 RMS dBFS</th><th>背景 dBFS</th><th>增量 dB</th></tr></thead><tbody>${session.events.map(x=>`<tr><td><button data-time="${Math.max(0,x.startMs/1000-.5)}">${x.id} ${e(x.type)}</button></td><td>${(x.startMs/1000).toFixed(3)}</td><td>${(x.durationMs/1000).toFixed(3)}</td><td>${x.peakDbfs.toFixed(2)}</td><td>${x.rmsDbfs.toFixed(2)}</td><td>${x.backgroundDbfs.toFixed(2)}</td><td>${x.incrementDb.toFixed(2)}</td></tr>`).join('')}</tbody></table><h2>间隔与疑似步行序列</h2><pre>${e(JSON.stringify({intervals:summary.intervals,sequences:summary.sequences},null,2))}</pre><h2>中断／恢复</h2><pre>${e(JSON.stringify(session.interruptions,null,2))}</pre><h2>设置与采集元数据</h2><pre>${e(JSON.stringify({settings:session.settings,metadata:session.metadata,timeBasis:session.timeBasis,segments:session.segments},null,2))}</pre><details><summary>MIT License</summary><pre>${e(license)}</pre></details><script>document.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{const a=document.getElementById('audio');a.currentTime=Number(b.dataset.time);a.play().catch(()=>{});});</script></html>`;
  }
  const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
  function header(size,values){const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);for(const [offset,value,width] of values)width===2?view.setUint16(offset,value,true):view.setUint32(offset,value,true);return bytes;}
  // Stored ZIP, UTF-8 filenames, fixed 1980 date; bounded to <4GiB. No third-party runtime.
  function zip(files) {
    const parts=[],central=[];let offset=0,centralSize=0;
    for(const [name,data] of files) {
      const n=new TextEncoder().encode(name),crc=crc32(data);
      if(data.length>0xffffffff||offset>0xffffffff)throw Error('导出文件过大');
      const local=header(30,[[0,0x04034b50,4],[4,20,2],[6,0x800,2],[12,33,2],[14,crc,4],[18,data.length,4],[22,data.length,4],[26,n.length,2]]);
      const entry=header(46,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x800,2],[14,33,2],[16,crc,4],[20,data.length,4],[24,data.length,4],[28,n.length,2],[42,offset,4]]);
      parts.push(local,n,data);central.push(entry,n);offset+=local.length+n.length+data.length;centralSize+=46+n.length;
    }
    return new Blob([...parts,...central,header(22,[[0,0x06054b50,4],[8,files.length,2],[10,files.length,2],[12,centralSize,4],[16,offset,4]])],{type:'application/zip'});
  }
  async function hash(bytes){return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
  async function buildExport(session,audio,license,core=root.ImpactCore) {
    const encoder=new TextEncoder(),ext=session.audioExtension||'bin',name='recording.'+ext;
    const summary=core.summarize(session.events,session.elapsedMs,session.segments);
    const files=[[name,new Uint8Array(await audio.arrayBuffer())],['events.csv',encoder.encode(csv(session))],['session.json',encoder.encode(JSON.stringify({...session,summary},null,2))],['report.html',encoder.encode(report(session,name,summary,license))],['LICENSE',encoder.encode(license)]];
    const entries=[];for(const [path,bytes] of files)entries.push({path,bytes:bytes.length,sha256:await hash(bytes)});
    files.push(['manifest.json',encoder.encode(JSON.stringify({version:VERSION,sessionId:session.id,algorithm:'SHA-256',entries},null,2))]);
    return {blob:zip(files),manifest:entries,filename:'neon-noise-'+session.id+'.zip'};
  }
  function chooseMime(Recorder) {
    if(!Recorder||typeof Recorder.isTypeSupported!=='function')throw Error('当前浏览器不支持 MediaRecorder 录音，请升级 Safari');
    for(const [mime,extension] of [['audio/mp4','m4a'],['audio/webm;codecs=opus','webm'],['audio/webm','webm'],['audio/ogg;codecs=opus','ogg']])if(Recorder.isTypeSupported(mime))return {mime,extension};
    throw Error('当前浏览器没有可用的录音编码格式');
  }
  const api={VERSION,openStore,Store,escapeHtml,csv,report,zip,crc32,hash,buildExport,chooseMime};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RecordFiles=api;
})(globalThis);
