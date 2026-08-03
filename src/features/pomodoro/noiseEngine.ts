/**
 * 环境音引擎（Web Audio 合成，零资源文件）
 *
 * 支持四种噪音色彩，全部程序化生成、无限循环、无需网络：
 * - brown：棕噪音，低频厚重，最接近「海浪/风声」，专注首选
 * - pink：粉噪音，能量按倍频均匀，柔和的「雨幕」感
 * - white：白噪音，全频均匀，经典「电视雪花」
 * - rain：棕噪音 + 低通滤波 + 慢速幅度起伏，模拟「窗外雨声」
 *
 * 工程细节：
 * - AudioContext 全程复用一个实例（反复 new/close 在 WebKit 有实例数上限，
 *   且会造成可听的启动爆音）；完全停止后 suspend 省电，再次播放 resume。
 * - 音量变化 / 启停 / 换音色全部走 setTargetAtTime 平滑斜坡，无爆音：
 *   启动 ~400ms 淡入，停止 ~250ms 淡出后再 stop 源节点，换音色为等长交叉淡变。
 * - 循环无缝：噪音缓冲的尾部与头部做等功率交叉淡化，消除 2s 循环点的
 *   台阶跳变（棕噪音积分器状态在首尾不连续，原实现每 2 秒一声轻「咔」）。
 *
 * 应用级单例：跨沉浸模式/面板共享播放状态。
 */

export type NoiseType = 'brown' | 'pink' | 'white' | 'rain';

export const NOISE_TYPES: NoiseType[] = ['brown', 'pink', 'white', 'rain'];

/** 启动淡入时长（秒） */
const FADE_IN_S = 0.4;
/** 停止/切换淡出时长（秒） */
const FADE_OUT_S = 0.25;
/** 循环无缝化的首尾交叠时长（秒），见 createBuffer 尾注 */
const LOOP_OVERLAP_S = 0.05;
const loopOverlapSamples = (sampleRate: number, bufferSize: number) =>
  Math.min(Math.floor(sampleRate * LOOP_OVERLAP_S), Math.floor(bufferSize / 4));
/** setTargetAtTime 的时间常数（约 3 倍到达 95%） */
const tc = (seconds: number) => seconds / 3;

/** 一条完整的播放链（源 → [滤波] → 增益）；换音色时新旧两条链交叉淡变 */
interface NoiseChain {
  source: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode | null;
  lfo: OscillatorNode | null;
  lfoGain: GainNode | null;
}

class NoiseEngine {
  private ctx: AudioContext | null = null;
  private chain: NoiseChain | null = null;
  private _playing = false;
  private _type: NoiseType = 'brown';
  private _volume = 0.12;
  /** 音色 → 噪音缓冲缓存（同一 ctx 生命周期内复用，切换零生成延迟） */
  private bufferCache = new Map<NoiseType, AudioBuffer>();
  private suspendTimer: number | null = null;

  get playing() {
    return this._playing;
  }

  get type() {
    return this._type;
  }

  get volume() {
    return this._volume;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.bufferCache.clear();
    }
    if (this.suspendTimer != null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** 构建一条播放链并以淡入进场 */
  private buildChain(ctx: AudioContext, type: NoiseType, volume: number): NoiseChain {
    let buffer = this.bufferCache.get(type);
    if (!buffer) {
      buffer = this.createBuffer(ctx, type);
      this.bufferCache.set(type, buffer);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // 尾部 overlap 段只作为交叠素材混进头部，循环体在其之前结束（见 createBuffer）
    source.loopEnd =
      (buffer.length - loopOverlapSamples(ctx.sampleRate, buffer.length)) / ctx.sampleRate;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.setTargetAtTime(volume, now, tc(FADE_IN_S));

    let filter: BiquadFilterNode | null = null;
    let lfo: OscillatorNode | null = null;
    let lfoGain: GainNode | null = null;

    let tail: AudioNode = source;
    if (type === 'rain') {
      // 低通滤波让高频「沙沙」变成「哗哗」，LFO 制造远近起伏
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      tail.connect(filter);
      tail = filter;

      lfo = ctx.createOscillator();
      lfo.frequency.value = 0.08;
      lfoGain = ctx.createGain();
      lfoGain.gain.value = volume * 0.25;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      lfo.start();
    }

    tail.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    return { source, gain, filter, lfo, lfoGain };
  }

  /** 当前链淡出后拆除（异步收尾，不阻塞新链） */
  private teardownChain(ctx: AudioContext, chain: NoiseChain) {
    const now = ctx.currentTime;
    chain.gain.gain.cancelScheduledValues(now);
    chain.gain.gain.setTargetAtTime(0.0001, now, tc(FADE_OUT_S));
    if (chain.lfoGain) {
      chain.lfoGain.gain.setTargetAtTime(0, now, tc(FADE_OUT_S));
    }
    const stopAt = now + FADE_OUT_S + 0.1;
    try {
      chain.source.stop(stopAt);
      chain.lfo?.stop(stopAt);
    } catch {
      /* already stopped */
    }
    // 源结束后断开整条链，节点交给 GC
    chain.source.onended = () => {
      try {
        chain.source.disconnect();
        chain.filter?.disconnect();
        chain.lfo?.disconnect();
        chain.lfoGain?.disconnect();
        chain.gain.disconnect();
      } catch {
        /* ignore */
      }
    };
  }

  start(type: NoiseType = this._type, volume = this._volume) {
    if (this._playing && type === this._type) {
      this.setVolume(volume);
      return;
    }
    try {
      const ctx = this.ensureContext();
      const old = this.chain;
      this._type = type;
      this._volume = volume;
      this.chain = this.buildChain(ctx, type, volume);
      this._playing = true;
      // 旧链（换音色场景）与新链交叉淡变
      if (old) this.teardownChain(ctx, old);
    } catch (e) {
      console.error('[NoiseEngine] Failed to start:', e);
    }
  }

  stop() {
    if (!this.ctx || !this.chain) {
      this._playing = false;
      return;
    }
    try {
      this.teardownChain(this.ctx, this.chain);
    } catch {
      /* ignore */
    }
    this.chain = null;
    this._playing = false;
    // 淡出完成后挂起上下文省电（保留实例与缓冲缓存，再次播放秒起）
    if (this.suspendTimer != null) window.clearTimeout(this.suspendTimer);
    this.suspendTimer = window.setTimeout(() => {
      this.suspendTimer = null;
      if (!this._playing && this.ctx && this.ctx.state === 'running') {
        void this.ctx.suspend().catch(() => {});
      }
    }, (FADE_OUT_S + 0.3) * 1000);
  }

  setVolume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.chain) {
      const now = this.ctx.currentTime;
      // 平滑斜坡（~60ms 落定），拖动音量滑杆不再有台阶噪声
      this.chain.gain.gain.cancelScheduledValues(now);
      this.chain.gain.gain.setTargetAtTime(this._volume, now, 0.02);
      if (this.chain.lfoGain) {
        this.chain.lfoGain.gain.setTargetAtTime(this._volume * 0.25, now, 0.02);
      }
    }
  }

  /** 切换噪音类型；播放中则交叉淡变到新音色 */
  setType(type: NoiseType) {
    if (type === this._type) return;
    if (this._playing) {
      this.start(type, this._volume);
    } else {
      this._type = type;
    }
  }

  private createBuffer(ctx: AudioContext, type: NoiseType): AudioBuffer {
    const bufferSize = 2 * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    switch (type) {
      case 'white': {
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * 0.5;
        }
        break;
      }
      case 'pink': {
        // Voss-McCartney 近似（Paul Kellet 滤波器版）
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          b6 = white * 0.115926;
        }
        break;
      }
      case 'brown':
      case 'rain':
      default: {
        let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          data[i] = (lastOut + 0.02 * white) / 1.02;
          lastOut = data[i];
          data[i] *= 3.5;
        }
        break;
      }
    }

    // 循环无缝（overlap-add）：把尾部 50ms 淡出叠进头部 50ms 淡入，
    // 并配合 source.loopEnd 把循环体截止在交叠段之前——
    // 循环点「…尾部(淡出)+头部(淡入)…」连续衔接，消除每 2 秒一声的轻「咔」
    //（棕/粉噪音的滤波器状态在首尾天然不连续）。
    const fadeLen = loopOverlapSamples(ctx.sampleRate, bufferSize);
    for (let i = 0; i < fadeLen; i++) {
      const t = i / fadeLen;
      const tailIdx = bufferSize - fadeLen + i;
      // 等功率曲线（sin/cos）避免交叠段能量凹陷
      const fadeIn = Math.sin((t * Math.PI) / 2);
      const fadeOut = Math.cos((t * Math.PI) / 2);
      data[i] = data[i] * fadeIn + data[tailIdx] * fadeOut;
    }

    return buffer;
  }
}

/** 应用级单例 */
export const noiseEngine = new NoiseEngine();
