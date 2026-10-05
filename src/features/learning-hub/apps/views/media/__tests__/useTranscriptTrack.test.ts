import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '../mediaTranscriptApi';
import { useTranscriptTrack } from '../useTranscriptTrack';

/** jsdom 没有 TextTrack / HTMLTrackElement.track：用最小可观察替身 */
class FakeTextTrack extends EventTarget {
  kind: string;
  mode: TextTrackMode = 'disabled';
  cues = { getCueById: () => null };
  addCue = vi.fn();
  removeCue = vi.fn();
  constructor(kind = 'subtitles') {
    super();
    this.kind = kind;
  }
}

class FakeTextTrackList extends EventTarget {
  private tracks: FakeTextTrack[] = [];
  get length() {
    return this.tracks.length;
  }
  add(track: FakeTextTrack) {
    this.tracks.push(track);
  }
  [Symbol.iterator]() {
    return this.tracks[Symbol.iterator]();
  }
}

function mountVideoWithTrack() {
  const video = document.createElement('video');
  const list = new FakeTextTrackList();
  Object.defineProperty(video, 'textTracks', { value: list });
  const trackEl = document.createElement('track');
  const textTrack = new FakeTextTrack();
  Object.defineProperty(trackEl, 'track', { value: textTrack });
  let readyState = 0;
  Object.defineProperty(trackEl, 'readyState', { get: () => readyState });
  list.add(textTrack);
  video.appendChild(trackEl);
  document.body.appendChild(video);
  const markLoaded = () => {
    readyState = 2;
    trackEl.dispatchEvent(new Event('load'));
  };
  return { video, list, trackEl, textTrack, markLoaded };
}

const segments: TranscriptSegment[] = [
  { idx: 0, startMs: 0, endMs: 900, text: 'hello', status: 'done' },
];

// jsdom 未实现 createObjectURL / revokeObjectURL
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:track');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  document.body.innerHTML = '';
});

function renderTrack() {
  const hook = renderHook(() => useTranscriptTrack(segments, true));
  expect(hook.result.current.trackSrc).toBe('blob:track');
  return hook;
}

describe('useTranscriptTrack caption mode', () => {
  it('sets the mode on attach (no `default` needed) and follows the toggle', () => {
    const { result } = renderTrack();
    const { trackEl, textTrack } = mountVideoWithTrack();
    act(() => result.current.trackRef(trackEl));
    expect(textTrack.mode).toBe('showing');

    act(() => result.current.toggleCaptions());
    expect(result.current.captionsOn).toBe(false);
    expect(textTrack.mode).toBe('hidden');
  });

  it('re-hides the track when the browser resets it to showing while captions are off', () => {
    const { result } = renderTrack();
    const { video, list, trackEl, textTrack, markLoaded } = mountVideoWithTrack();
    act(() => result.current.trackRef(trackEl));
    act(() => result.current.toggleCaptions());
    expect(textTrack.mode).toBe('hidden');

    // 轨道（重新）加载后浏览器自动选轨
    textTrack.mode = 'showing';
    act(() => markLoaded());
    expect(textTrack.mode).toBe('hidden');

    // textTracks change / addtrack
    textTrack.mode = 'showing';
    list.dispatchEvent(new Event('change'));
    expect(textTrack.mode).toBe('hidden');
    textTrack.mode = 'showing';
    list.dispatchEvent(new Event('addtrack'));
    expect(textTrack.mode).toBe('hidden');

    // seek + play（WKWebView 复现路径）/ loadedmetadata
    for (const type of ['seeked', 'play', 'loadedmetadata']) {
      textTrack.mode = 'showing';
      video.dispatchEvent(new Event(type));
      expect(textTrack.mode).toBe('hidden');
    }
    expect(result.current.captionsOn).toBe(false);
  });

  it('keeps the track showing on the same events while captions are on', () => {
    const { result } = renderTrack();
    const { list, trackEl, textTrack } = mountVideoWithTrack();
    act(() => result.current.trackRef(trackEl));
    textTrack.mode = 'disabled';
    list.dispatchEvent(new Event('change'));
    expect(textTrack.mode).toBe('showing');
  });

  it('hides other subtitle tracks on the video when captions are off', () => {
    const { result } = renderTrack();
    const { list, trackEl } = mountVideoWithTrack();
    const stray = new FakeTextTrack('captions');
    stray.mode = 'showing';
    list.add(stray);
    const metadata = new FakeTextTrack('metadata');
    metadata.mode = 'hidden';
    list.add(metadata);
    act(() => result.current.trackRef(trackEl));
    act(() => result.current.toggleCaptions());
    expect(stray.mode).toBe('hidden');
    expect(metadata.mode).toBe('hidden');
  });

  it('applies the mode to a remounted <track> and ignores the stale element', () => {
    const { result } = renderTrack();
    const first = mountVideoWithTrack();
    act(() => result.current.trackRef(first.trackEl));
    act(() => result.current.toggleCaptions());

    // stream→blob 回退：<video>/<track> 整体重挂
    const second = mountVideoWithTrack();
    act(() => {
      result.current.trackRef(null);
      result.current.trackRef(second.trackEl);
    });
    expect(second.textTrack.mode).toBe('hidden');

    // 旧元素上的事件不再驱动（已解绑），新元素上的重置仍被纠正
    first.textTrack.mode = 'showing';
    first.list.dispatchEvent(new Event('change'));
    expect(first.textTrack.mode).toBe('showing');
    second.textTrack.mode = 'showing';
    second.list.dispatchEvent(new Event('change'));
    expect(second.textTrack.mode).toBe('hidden');

    act(() => result.current.toggleCaptions());
    expect(second.textTrack.mode).toBe('showing');
  });

  it('detaches listeners when the track unmounts', () => {
    const { result } = renderTrack();
    const { list, trackEl, textTrack } = mountVideoWithTrack();
    act(() => result.current.trackRef(trackEl));
    act(() => result.current.trackRef(null));
    textTrack.mode = 'disabled';
    list.dispatchEvent(new Event('change'));
    expect(textTrack.mode).toBe('disabled');
  });
});
