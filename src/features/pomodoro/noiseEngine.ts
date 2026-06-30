/**
 * 环境音引擎（Web Audio 合成，零资源文件）
 *
 * 支持四种噪音色彩，全部程序化生成、无限循环、无需网络：
 * - brown：棕噪音，低频厚重，最接近「海浪/风声」，专注首选
 * - pink：粉噪音，能量按倍频均匀，柔和的「雨幕」感
 * - white：白噪音，全频均匀，经典「电视雪花」
 * - rain：棕噪音 + 低通滤波 + 慢速幅度起伏，模拟「窗外雨声」
 *
 * 应用级单例：跨沉浸模式/面板共享播放状态。
 */

export type NoiseType = 'brown' | 'pink' | 'white' | 'rain';

export const NOISE_TYPES: NoiseType[] = ['brown', 'pink', 'white', 'rain'];

class NoiseEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private noiseNode: AudioBufferSourceNode | null = null;
  private filterNode: BiquadFilterNode | null = null;
  private lfoNode: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private _playing = false;
  private _type: NoiseType = 'brown';
  private _volume = 0.12;

  get playing() {
    return this._playing;
  }

  get type() {
    return this._type;
  }

  get volume() {
    return this._volume;
  }

  start(type: NoiseType = this._type, volume = this._volume) {
    if (this._playing && type === this._type) {
      this.setVolume(volume);
      return;
    }
    this.stop();
    this._type = type;
    this._volume = volume;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const buffer = this.createBuffer(this.ctx, type);

      this.noiseNode = this.ctx.createBufferSource();
      this.noiseNode.buffer = buffer;
      this.noiseNode.loop = true;

      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = volume;

      let tail: AudioNode = this.noiseNode;

      if (type === 'rain') {
        // 低通滤波让高频「沙沙」变成「哗哗」，LFO 制造远近起伏
        this.filterNode = this.ctx.createBiquadFilter();
        this.filterNode.type = 'lowpass';
        this.filterNode.frequency.value = 900;
        tail.connect(this.filterNode);
        tail = this.filterNode;

        this.lfoNode = this.ctx.createOscillator();
        this.lfoNode.frequency.value = 0.08;
        this.lfoGain = this.ctx.createGain();
        this.lfoGain.gain.value = volume * 0.25;
        this.lfoNode.connect(this.lfoGain);
        this.lfoGain.connect(this.gainNode.gain);
        this.lfoNode.start();
      }

      tail.connect(this.gainNode);
      this.gainNode.connect(this.ctx.destination);
      this.noiseNode.start();
      this._playing = true;
    } catch (e) {
      console.error('[NoiseEngine] Failed to start:', e);
    }
  }

  stop() {
    try {
      this.noiseNode?.stop();
      this.noiseNode?.disconnect();
      this.lfoNode?.stop();
      this.lfoNode?.disconnect();
      this.lfoGain?.disconnect();
      this.filterNode?.disconnect();
      this.gainNode?.disconnect();
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.noiseNode = null;
    this.lfoNode = null;
    this.lfoGain = null;
    this.filterNode = null;
    this.gainNode = null;
    this.ctx = null;
    this._playing = false;
  }

  setVolume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.gainNode) {
      this.gainNode.gain.value = this._volume;
    }
    if (this.lfoGain) {
      this.lfoGain.gain.value = this._volume * 0.25;
    }
  }

  /** 切换噪音类型；播放中则无缝重启 */
  setType(type: NoiseType) {
    if (type === this._type) return;
    const wasPlaying = this._playing;
    this._type = type;
    if (wasPlaying) {
      this.start(type, this._volume);
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
    return buffer;
  }
}

/** 应用级单例 */
export const noiseEngine = new NoiseEngine();
