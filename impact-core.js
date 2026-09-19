/* MIT licensed; see LICENSE. Pure signal processing and experimental event rules. */
(function(root) {
  'use strict';
  const DEFAULTS = Object.freeze({mainLow:35,mainHigh:120,auxLow:20,auxHigh:250,focusLow:50,focusHigh:75,windowMs:80,hopMs:20,warmupMs:5000,backgroundMs:10000,triggerDb:6,riseDb:3,endDb:3,endHoldMs:150,mergeMs:250,sustainedMs:2000,maxMs:600000});
  const db = power => 10*Math.log10(Math.max(1e-16,power));
  const median = values => {const a=values.slice().sort((a,b)=>a-b);return a.length ? (a[(a.length-1)>>1]+a[a.length>>1])/2 : -160;};
  function validateSettings(input) {
    const s={...DEFAULTS,...input};
    for(const key of Object.keys(DEFAULTS)) if(!Number.isFinite(s[key])) throw Error('参数必须为有限数值');
    for(const [lo,hi] of [['mainLow','mainHigh'],['auxLow','auxHigh'],['focusLow','focusHigh']]) if(s[lo]<10||s[hi]>1000||s[hi]<=s[lo]) throw Error('频带须在10～1000Hz内且下限小于上限');
    if(s.triggerDb<1||s.triggerDb>30||s.riseDb<0.5||s.riseDb>20||s.endDb<0||s.endDb>=s.triggerDb) throw Error('触发阈值须高于结束阈值');
    if(s.windowMs<40||s.windowMs>200||s.hopMs<10||s.hopMs>s.windowMs||s.warmupMs<1000||s.backgroundMs<s.warmupMs||s.endHoldMs<40||s.mergeMs<0||s.mergeMs>1000||s.sustainedMs<500||s.maxMs!==600000) throw Error('时间参数超出允许范围');
    return s;
  }
  class Biquad {
    constructor(rate,hz,type) {
      const w=2*Math.PI*hz/rate,c=Math.cos(w),a=Math.sin(w)/(2*Math.SQRT1_2),a0=1+a;
      const b=type==='high' ? [(1+c)/2,-(1+c),(1+c)/2] : [(1-c)/2,1-c,(1-c)/2];
      [this.b0,this.b1,this.b2]=b.map(x=>x/a0);this.a1=-2*c/a0;this.a2=(1-a)/a0;this.z1=this.z2=0;
    }
    next(x) {const y=this.b0*x+this.z1;this.z1=this.b1*x-this.a1*y+this.z2;this.z2=this.b2*x-this.a2*y;return y;}
  }
  class EnergyChannel {
    constructor(rate,settings={}) {
      this.s=validateSettings(settings); this.rate=rate;this.n=Math.round(rate*this.s.windowMs/1000);this.hop=Math.round(rate*this.s.hopMs/1000);this.count=0;this.pos=0;
      this.bands=[['main',this.s.mainLow,this.s.mainHigh],['aux',this.s.auxLow,this.s.auxHigh],['focus',this.s.focusLow,this.s.focusHigh]].map(([name,lo,hi])=>({name,hp:new Biquad(rate,lo,'high'),lp:new Biquad(rate,hi,'low'),ring:new Float64Array(this.n),sum:0}));
    }
    process(samples,endFrame) {
      const out=[];
      for(let i=0;i<samples.length;i++) {
        for(const b of this.bands) {const y=b.lp.next(b.hp.next(samples[i]));b.sum+=y*y-b.ring[this.pos]*b.ring[this.pos];b.ring[this.pos]=y;}
        this.pos=(this.pos+1)%this.n;this.count++;
        if(this.count>=this.n&&this.count%this.hop===0) {
          const frame={timeMs:(endFrame-samples.length+i+1)/this.rate*1000};
          for(const b of this.bands) {frame[b.name+'Db']=db(b.sum/this.n);if(b.name==='main') {let peak=0;for(const v of b.ring)peak=Math.max(peak,Math.abs(v));frame.mainPeakDb=db(peak*peak);}}
          out.push(frame);
        }
      }return out;
    }
  }
  class Detector {
    constructor(settings={}) {this.s=validateSettings(settings);this.events=[];this.segment=0;this.reset(0);}
    reset(timeMs) {this.segment++;this.learnUntil=timeMs+this.s.warmupMs;this.background=[];this.recent=[];this.active=null;this.lastTime=timeMs;this.backgroundDb=-160;}
    finish() {
      const a=this.active;if(!a)return null;
      const event={id:this.events.length+1,segment:this.segment,startMs:a.startMs,endMs:a.lastHighMs,durationMs:Math.max(this.s.hopMs,a.lastHighMs-a.startMs),type:a.lastHighMs-a.startMs>=this.s.sustainedMs?'sustained':'impact',peakDbfs:a.peakDb,rmsDbfs:db(a.power/a.frames),backgroundDbfs:a.backgroundDb,incrementDb:a.maxDb-a.backgroundDb};
      this.events.push(event);this.active=null;return event;
    }
    interrupt(timeMs) {const event=this.finish();this.reset(timeMs);return event;}
    push(f) {
      if(!Number.isFinite(f.timeMs)||!Number.isFinite(f.mainDb))throw Error('无效能量帧');
      if(f.timeMs<this.lastTime)throw Error('能量时间必须单调');
      this.lastTime=f.timeMs;
      this.background=this.background.filter(x=>f.timeMs-x.timeMs<=this.s.backgroundMs);
      this.recent=this.recent.filter(x=>f.timeMs-x.timeMs<=this.s.windowMs+this.s.hopMs);
      const prior=this.recent.find(x=>f.timeMs-x.timeMs>=this.s.windowMs-this.s.hopMs);
      const rise=prior?f.mainDb-prior.mainDb:0;this.recent.push(f);
      if(!this.active&&this.background.length)this.backgroundDb=median(this.background.map(x=>x.mainDb));
      const delta=f.mainDb-this.backgroundDb,learning=f.timeMs<this.learnUntil;
      let event=null;
      if(!learning&&!this.active&&delta>=this.s.triggerDb&&rise>=this.s.riseDb) this.active={startMs:f.timeMs,lastHighMs:f.timeMs,lowAt:null,maxDb:f.mainDb,peakDb:f.mainPeakDb??f.mainDb,backgroundDb:this.backgroundDb,power:0,frames:0};
      if(this.active) {
        const a=this.active;
        if(delta>=this.s.endDb) {a.lastHighMs=f.timeMs;a.lowAt=null;} else if(a.lowAt===null)a.lowAt=f.timeMs;
        a.maxDb=Math.max(a.maxDb,f.mainDb);a.peakDb=Math.max(a.peakDb,f.mainPeakDb??f.mainDb);a.power+=10**(f.mainDb/10);a.frames++;
        if(a.lowAt!==null&&f.timeMs-a.lowAt>=this.s.endHoldMs+this.s.mergeMs)event=this.finish();
      } else if(learning||delta<this.s.triggerDb) this.background.push(f);
      return {event,learning,backgroundDb:this.backgroundDb,incrementDb:delta,active:!!this.active};
    }
  }
  function summarize(events,timeMs,segments=[]) {
    const impacts=events.filter(e=>e.type==='impact'),last=impacts.at(-1),intervals=[];
    for(let i=1;i<impacts.length;i++) if(impacts[i].segment===impacts[i-1].segment)intervals.push({fromId:impacts[i-1].id,toId:impacts[i].id,seconds:(impacts[i].startMs-impacts[i-1].startMs)/1000});
    const sequences=[];let group=[];
    function flush(){if(group.length>=4){const gaps=group.slice(1).map((e,i)=>(e.startMs-group[i].startMs)/1000),mean=gaps.reduce((a,b)=>a+b,0)/gaps.length,cv=Math.sqrt(gaps.reduce((a,b)=>a+(b-mean)**2,0)/gaps.length)/mean;if(cv<=.25)sequences.push({eventIds:group.map(e=>e.id),intervalsSeconds:gaps,coefficientOfVariation:cv,cadencePerMinute:60/median(gaps)});}group=[];}
    for(const e of impacts){const p=group.at(-1),gap=p?(e.startMs-p.startMs)/1000:0;if(p&&(e.segment!==p.segment||gap<.25||gap>2))flush();group.push(e);}flush();
    const recent=impacts.filter(e=>e.startMs>=timeMs-60000),windowStart=Math.max(0,timeMs-60000);
    const observedMs=segments.length?segments.reduce((total,s)=>total+Math.max(0,Math.min(timeMs,s.endMs??timeMs)-Math.max(windowStart,s.startMs)),0):Math.min(timeMs,60000);
    return {candidateCount:impacts.length,sustainedCount:events.length-impacts.length,lastEvent:last??null,intervals,sequences,recentCount:recent.length,observedSeconds:observedMs/1000,lastIntervalSeconds:intervals.at(-1)?.seconds??null};
  }
  const api={DEFAULTS,validateSettings,EnergyChannel,Detector,summarize,median,db};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ImpactCore=api;
})(globalThis);
