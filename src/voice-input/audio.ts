import type { RecordedAudioPayload, VoiceRecorderSession } from './types';
import { detectVoiceRecordingSupport, mapGetUserMediaErrorCode } from './support';

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
];

function resolveRecordingMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }

  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }

  return PREFERRED_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function createAudioContext(): AudioContext | null {
  const runtime = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = runtime.AudioContext ?? runtime.webkitAudioContext;
  return AudioContextConstructor ? new AudioContextConstructor() : null;
}

function startLevelMeter(options: {
  audioContext: AudioContext;
  stream: MediaStream;
  onLevel: (level: number) => void;
}) {
  const analyser = options.audioContext.createAnalyser();
  analyser.fftSize = 512;
  const source = options.audioContext.createMediaStreamSource(options.stream);
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let animationFrame = 0;

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let total = 0;
    for (const value of data) {
      const normalized = (value - 128) / 128;
      total += normalized * normalized;
    }
    options.onLevel(Math.min(1, Math.sqrt(total / data.length) * 2.5));
    animationFrame = requestAnimationFrame(tick);
  };

  animationFrame = requestAnimationFrame(tick);

  return {
    source,
    stop: () => {
      cancelAnimationFrame(animationFrame);
      options.onLevel(0);
      try {
        source.disconnect();
      } catch {
        // Ignore disconnect errors on partially initialized graphs.
      }
    },
  };
}

function mergeFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeMonoPcmWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function createMediaRecorderVoiceSession(
  stream: MediaStream,
  options: { onLevel: (level: number) => void }
): Promise<VoiceRecorderSession> {
  const mimeType = resolveRecordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  let resolvedMimeType = mimeType || recorder.mimeType || '';
  const startedAt = Date.now();
  let audioContext: AudioContext | null = null;
  let meter: ReturnType<typeof startLevelMeter> | null = null;
  let isCancelled = false;

  recorder.addEventListener('dataavailable', (event) => {
    if ('data' in event && event.data?.type && !resolvedMimeType) {
      resolvedMimeType = event.data.type;
    }
    if (event.data?.size) {
      chunks.push(event.data);
    }
  });

  audioContext = createAudioContext();
  if (audioContext) {
    await audioContext.resume().catch(() => undefined);
    meter = startLevelMeter({ audioContext, stream, onLevel: options.onLevel });
  }

  recorder.start();

  const cleanup = async () => {
    meter?.stop();
    meter = null;
    stopStream(stream);
    if (audioContext) {
      await audioContext.close().catch(() => undefined);
      audioContext = null;
    }
  };

  const finalizeStop = async (): Promise<RecordedAudioPayload | null> => {
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }

    await cleanup();

    if (isCancelled) {
      return null;
    }

    const finalMimeType = resolvedMimeType.trim() || 'audio/webm';
    const blob = new Blob(chunks, { type: finalMimeType });
    if (blob.size === 0) {
      return null;
    }

    return {
      blob,
      mimeType: finalMimeType,
      durationMs: Date.now() - startedAt,
    };
  };

  return {
    stop: finalizeStop,
    cancel: async () => {
      isCancelled = true;
      await finalizeStop();
    },
  };
}

async function createPcmFallbackVoiceSession(
  stream: MediaStream,
  options: { onLevel: (level: number) => void }
): Promise<VoiceRecorderSession> {
  const audioContext = createAudioContext();
  if (!audioContext || typeof audioContext.createScriptProcessor !== 'function') {
    stopStream(stream);
    throw new Error('recording-unavailable');
  }

  await audioContext.resume().catch(() => undefined);

  const startedAt = Date.now();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const analyserData = new Uint8Array(analyser.frequencyBinCount);
  let animationFrame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(analyserData);
    let total = 0;
    for (const value of analyserData) {
      const normalized = (value - 128) / 128;
      total += normalized * normalized;
    }
    options.onLevel(Math.min(1, Math.sqrt(total / analyserData.length) * 2.5));
    animationFrame = requestAnimationFrame(tick);
  };
  animationFrame = requestAnimationFrame(tick);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;
  const samples: Float32Array[] = [];
  const sampleRate = audioContext.sampleRate;
  let isCancelled = false;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    samples.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(muteGain);
  muteGain.connect(audioContext.destination);

  const cleanup = async () => {
    processor.onaudioprocess = null;
    cancelAnimationFrame(animationFrame);
    options.onLevel(0);
    try {
      source.disconnect();
    } catch {
      // Ignore disconnect errors on partially initialized graphs.
    }
    try {
      analyser.disconnect();
    } catch {
      // Ignore disconnect errors on partially initialized graphs.
    }
    try {
      processor.disconnect();
    } catch {
      // Ignore disconnect errors on partially initialized graphs.
    }
    try {
      muteGain.disconnect();
    } catch {
      // Ignore disconnect errors on partially initialized graphs.
    }
    stopStream(stream);
    await audioContext.close().catch(() => undefined);
  };

  const finalize = async (): Promise<RecordedAudioPayload | null> => {
    await cleanup();
    if (isCancelled) {
      return null;
    }

    const mergedSamples = mergeFloat32Chunks(samples);
    if (mergedSamples.length === 0) {
      return null;
    }

    return {
      blob: encodeMonoPcmWav(mergedSamples, sampleRate),
      mimeType: 'audio/wav',
      durationMs: Date.now() - startedAt,
    };
  };

  return {
    stop: finalize,
    cancel: async () => {
      isCancelled = true;
      await finalize();
    },
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function startBrowserVoiceRecording(options: {
  onLevel: (level: number) => void;
}): Promise<VoiceRecorderSession> {
  const support = await detectVoiceRecordingSupport();
  if (!support.canRecord) {
    throw new Error(support.reasonCode ?? 'recording-unavailable');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    throw new Error(mapGetUserMediaErrorCode(error));
  }

  if (support.recorderMode === 'pcm-wav') {
    return createPcmFallbackVoiceSession(stream, options);
  }

  try {
    return await createMediaRecorderVoiceSession(stream, options);
  } catch (error) {
    const fallbackSupport = await detectVoiceRecordingSupport({ mediaRecorder: null });
    if (fallbackSupport.canRecord && fallbackSupport.recorderMode === 'pcm-wav') {
      return createPcmFallbackVoiceSession(stream, options);
    }
    stopStream(stream);
    throw error;
  }
}
