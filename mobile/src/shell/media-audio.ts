const SAMPLE_RATE = 16_000;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_FRAMES = 20 * 60 * SAMPLE_RATE;

/** Web Audio decodes and resamples the container; ASR consumes 16 kHz signed mono PCM. */
export async function decodeMobileAudio(bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new Error('音视频文件为空');
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error('移动端转写支持最大 32 MiB 的文件，请先分割音视频');
  if (typeof OfflineAudioContext !== 'function') throw new Error('当前 WebView 不支持音频解码，请更新系统 WebView');

  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    // decodeAudioData detaches its input; this copy is sized to the view, not the underlying buffer.
    decoded = await context.decodeAudioData(new Uint8Array(bytes).buffer);
  } catch {
    throw new Error('当前设备无法解码此文件的音轨，请先转换为 MP3 或 WAV');
  }
  if (decoded.length === 0 || decoded.numberOfChannels === 0) throw new Error('音视频文件中没有可转写的音轨');
  if (decoded.length > MAX_FRAMES) throw new Error('移动端转写每次支持最多 20 分钟，请先分割音视频');

  const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
  const pcm = new Int16Array(decoded.length);
  for (let i = 0; i < pcm.length; i++) {
    let mixed = 0;
    for (const channel of channels) mixed += channel[i] ?? 0;
    const clamped = Math.max(-1, Math.min(1, mixed / channels.length));
    pcm[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return {
    pcm,
    // Web Audio reports the resampled rate here, not the container's original rate.
    source_rate: decoded.sampleRate,
    source_channels: decoded.numberOfChannels,
    duration_ms: Math.round(decoded.length * 1000 / decoded.sampleRate),
  };
}
