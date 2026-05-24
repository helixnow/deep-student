import { describe, expect, it } from 'vitest';

import { detectVoiceRecordingSupport } from '../support';

describe('voice input recording support detection', () => {
  it('prefers MediaRecorder when getUserMedia and MediaRecorder are available', async () => {
    const support = await detectVoiceRecordingSupport({
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: async () => ({} as MediaStream),
      },
      mediaRecorder: {
        isTypeSupported: () => true,
      },
      audioContext: class {},
    });

    expect(support.canRecord).toBe(true);
    expect(support.recorderMode).toBe('media-recorder');
    expect(support.reasonCode).toBeNull();
  });

  it('falls back to pcm-wav recording when MediaRecorder is unavailable but Web Audio capture exists', async () => {
    const support = await detectVoiceRecordingSupport({
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: async () => ({} as MediaStream),
      },
      mediaRecorder: null,
      audioContext: class {
        createScriptProcessor() {}
        createMediaStreamSource() {}
        createAnalyser() {}
      },
    });

    expect(support.canRecord).toBe(true);
    expect(support.recorderMode).toBe('pcm-wav');
    expect(support.reasonCode).toBeNull();
  });

  it('does not advertise pcm-wav fallback when the runtime lacks script-processor capture APIs', async () => {
    const support = await detectVoiceRecordingSupport({
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: async () => ({} as MediaStream),
      },
      mediaRecorder: null,
      audioContext: class {},
    });

    expect(support.canRecord).toBe(false);
    expect(support.recorderMode).toBe('unavailable');
    expect(support.reasonCode).toBe('missing-recorder-backend');
  });

  it('surfaces a missing getUserMedia environment as unavailable', async () => {
    const support = await detectVoiceRecordingSupport({
      isSecureContext: true,
      mediaDevices: null,
      mediaRecorder: null,
      audioContext: class {},
    });

    expect(support.canRecord).toBe(false);
    expect(support.recorderMode).toBe('unavailable');
    expect(support.reasonCode).toBe('missing-get-user-media');
  });

  it('surfaces denied microphone permission distinctly from generic unsupported states', async () => {
    const support = await detectVoiceRecordingSupport({
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: async () => ({} as MediaStream),
      },
      mediaRecorder: {
        isTypeSupported: () => true,
      },
      audioContext: class {},
      permissions: {
        query: async () => ({ state: 'denied' as const }),
      },
    });

    expect(support.permissionState).toBe('denied');
    expect(support.reasonCode).toBe('permission-denied');
  });
});
