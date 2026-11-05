'use strict';

// Microphone capture: converts the mic to 16 kHz mono 16-bit PCM in an
// AudioWorklet and hands ~100 ms chunks to the main process.
(function () {
  const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0; this.sum = 0; this.count = 0;
    this.out = new Int16Array(1600); this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const chs = input.length, len = input[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < chs; c++) v += input[c][i];
      this.sum += v / chs; this.count++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let s = this.sum / this.count; this.sum = 0; this.count = 0;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.out[this.n++] = s < 0 ? s * 32768 : s * 32767;
        if (this.n === this.out.length) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(1600); this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

  async function getStream(deviceId) {
    const audio = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      if (audio.deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        delete audio.deviceId; // saved device was unplugged: use the default one
        return navigator.mediaDevices.getUserMedia({ audio, video: false });
      }
      throw err;
    }
  }

  function scriptProcessorFallback(ctx, src, onPcm) {
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / 16000;
    let pos = 0;
    let sum = 0;
    let count = 0;
    let out = new Int16Array(1600);
    let n = 0;
    sp.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < ch.length; i++) {
        sum += ch[i];
        count++;
        pos += 1;
        if (pos >= ratio) {
          pos -= ratio;
          let s = sum / count;
          sum = 0;
          count = 0;
          s = Math.max(-1, Math.min(1, s));
          out[n++] = s < 0 ? s * 32768 : s * 32767;
          if (n === out.length) {
            onPcm(out.buffer);
            out = new Int16Array(1600);
            n = 0;
          }
        }
      }
    };
    src.connect(sp);
    return sp;
  }

  async function start(deviceId, onPcm) {
    const stream = await getStream(deviceId);
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    let node;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => onPcm(e.data);
      src.connect(node);
    } catch {
      node = scriptProcessorFallback(ctx, src, onPcm);
    }
    node.connect(mute);
    if (ctx.state === 'suspended') await ctx.resume();
    const track = stream.getAudioTracks()[0];
    return {
      label: track ? track.label : '',
      stop() {
        try {
          src.disconnect();
          node.disconnect();
        } catch {}
        for (const t of stream.getTracks()) t.stop();
        ctx.close().catch(() => {});
      },
    };
  }

  window.MicCapture = { start };
})();
