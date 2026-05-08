import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startBrowserVoiceRecording } from '../audio';

function createMockStream(): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn() }] as MediaStreamTrack[],
  } as unknown as MediaStream;
}

describe('voice input audio recording', () => {
  const originalNavigator = globalThis.navigator;
  const originalSecureContext = globalThis.isSecureContext;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalAudioContext = (globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable: true,
      value: originalSecureContext,
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: originalMediaRecorder,
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'webkitAudioContext', {
      configurable: true,
      value: originalAudioContext,
    });
  });

  it('keeps a usable mime type when MediaRecorder does not implement isTypeSupported', async () => {
    const stream = createMockStream();

    class MockMediaRecorder extends EventTarget {
      static isTypeSupported: undefined;
      state: RecordingState = 'inactive';
      mimeType = 'audio/mp4';

      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
        super();
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        const dataEvent = new Event('dataavailable') as Event & { data: Blob };
        dataEvent.data = new Blob(['audio'], { type: 'audio/mp4' });
        this.dispatchEvent(dataEvent);
        this.state = 'inactive';
        this.dispatchEvent(new Event('stop'));
      }
    }

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(stream),
        },
      },
    });
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder,
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: undefined,
    });

    const session = await startBrowserVoiceRecording({
      onLevel: vi.fn(),
    });
    const payload = await session.stop();

    expect(payload?.mimeType).toBe('audio/mp4');
    expect(payload?.blob.type).toBe('audio/mp4');
  });

  it('returns the specific missing-get-user-media reason when the runtime does not expose microphone capture', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: undefined,
    });

    await expect(
      startBrowserVoiceRecording({
        onLevel: vi.fn(),
      })
    ).rejects.toThrow('missing-get-user-media');
  });
});
