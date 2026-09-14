/* MIT licensed; see LICENSE. No audio is sent to the speakers. */
import './impact-core.js';
class ImpactEnergyProcessor extends AudioWorkletProcessor {
  constructor(options) {super();this.settings=options.processorOptions.settings;this.channel=new globalThis.ImpactCore.EnergyChannel(sampleRate,this.settings);this.enabled=true;this.port.onmessage=e=>{if(e.data.type==='reset')this.channel=new globalThis.ImpactCore.EnergyChannel(sampleRate,this.settings);if(e.data.type==='enabled')this.enabled=e.data.enabled;};}
  process(inputs,outputs) {
    for(const output of outputs)for(const channel of output)channel.fill(0);
    const channels=inputs[0];
    if(this.enabled&&channels?.length) {
      const mono=new Float32Array(channels[0].length);
      for(const channel of channels)for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/channels.length;
      for(const frame of this.channel.process(mono,currentFrame+mono.length))this.port.postMessage(frame);
    }
    return true;
  }
}
registerProcessor('impact-energy',ImpactEnergyProcessor);
