/**
 * Media Studio playback guard helpers:
 * 1) Normalize raw custom-protocol media URLs (filestream:// / bilistream:// / asset://)
 *    to WebUI HTTP Range endpoints when running inside the browser WebUI shell.
 * 2) Convert HTMLMediaElement MediaError codes, empty/unreachable sources, and .play()
 *    rejections into clear, actionable user-facing error messages (never silent no-op).
 * 3) Detect taps on pre-metadata disabled Play buttons in both synthetic tests and real
 *    browsers where pointer-events: none falls through to the enabled parent container.
 */
import { getErrorMessage } from '@/utils/errorUtils';

export type MediaTranslateFn = (key: string, options?: Record<string, unknown>) => string;

const CUSTOM_PROTOCOL_RE = /^(filestream|bilistream|asset):\/\/(?:localhost\/)?(.*)$/i;

function resolveText(
  t: MediaTranslateFn | undefined,
  key: string,
  defaultValue: string,
  vars?: Record<string, unknown>,
): string {
  if (!t) {
    if (!vars) return defaultValue;
    return defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) =>
      vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '',
    );
  }
  return t(key, { defaultValue, ...vars });
}

/**
 * In WebUI browser shells, raw Electron/Tauri custom protocol URLs (filestream://,
 * bilistream://, asset://) cannot be loaded directly by <audio>/<video> elements.
 * Rewrite them to the WebUI HTTP 206 Range endpoint `/api/protocol/<scheme>/<path>`
 * while keeping http(s), blob, data, relative URLs, and native shell URLs intact.
 */
export function resolvePlayableMediaUrl(
  rawSrc: string,
  options: { isWebUi?: boolean; origin?: string } = {},
): string {
  const trimmed = rawSrc.trim();
  if (!trimmed || !options.isWebUi) return trimmed;
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('/')
  ) {
    return trimmed;
  }

  const match = CUSTOM_PROTOCOL_RE.exec(trimmed);
  if (!match) return trimmed;

  const scheme = match[1].toLowerCase();
  const rest = match[2] ?? '';
  const queryIdx = rest.indexOf('?');
  const rawPath = queryIdx >= 0 ? rest.slice(0, queryIdx) : rest;
  const rawQuery = queryIdx >= 0 ? rest.slice(queryIdx) : '';
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }
  const encodedPath = encodeURIComponent(decodedPath);
  const origin =
    options.origin ??
    (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
      ? window.location.origin
      : '');
  return `${origin}/api/protocol/${encodeURIComponent(scheme)}/${encodedPath}${rawQuery}`;
}

export interface MediaPlaybackErrorInput {
  mediaError?: Pick<MediaError, 'code' | 'message'> | null;
  error?: unknown;
  networkState?: number;
  hasSrc?: boolean;
}

/**
 * Build a non-empty, human-readable playback error reason for HTMLMediaElement failures
 * and rejected `.play()` promises (including browsers where MediaError.message is empty).
 */
export function describeMediaPlaybackError(
  input: MediaPlaybackErrorInput,
  t?: MediaTranslateFn,
): string {
  if (input.hasSrc === false) {
    return resolveText(
      t,
      'mediaStudio:study.errorMissingSource',
      '未找到可播放的音视频地址，请返回资源库重试',
    );
  }

  const mediaErr = input.mediaError;
  if (mediaErr) {
    const detail = typeof mediaErr.message === 'string' ? mediaErr.message.trim() : '';
    let base: string;
    switch (mediaErr.code) {
      case 1:
        base = resolveText(t, 'mediaStudio:study.errorAborted', '音视频加载被中断');
        break;
      case 2:
        base = resolveText(t, 'mediaStudio:study.errorNetwork', '网络或本地媒体流读取失败');
        break;
      case 3:
        base = resolveText(
          t,
          'mediaStudio:study.errorDecode',
          '音视频解码失败（文件可能损坏或编码不兼容）',
        );
        break;
      case 4:
        base = resolveText(
          t,
          'mediaStudio:study.errorUnsupported',
          '当前浏览器不支持此音视频格式或媒体源不可用',
        );
        break;
      default:
        base = resolveText(t, 'mediaStudio:study.loadFailed', '无法打开这个音视频');
        break;
    }
    return detail && !base.includes(detail) ? `${base}（${detail}）` : base;
  }

  if (input.error !== undefined && input.error !== null) {
    const errName = (input.error as DOMException | null)?.name;
    const msg = getErrorMessage(input.error).trim();
    if (errName === 'NotSupportedError') {
      const base = resolveText(
        t,
        'mediaStudio:study.errorUnsupported',
        '当前浏览器不支持此音视频格式或媒体源不可用',
      );
      return msg && !base.includes(msg) ? `${base}（${msg}）` : base;
    }
    if (errName === 'NotAllowedError') {
      const base = resolveText(
        t,
        'mediaStudio:study.errorNotAllowed',
        '浏览器阻止了媒体播放，请再次点击播放按钮或检查静音权限',
      );
      return msg && !base.includes(msg) ? `${base}（${msg}）` : base;
    }
    if (msg) return msg;
  }

  if (input.networkState === 3) {
    return resolveText(
      t,
      'mediaStudio:study.errorUnsupported',
      '当前浏览器不支持此音视频格式或媒体源不可用',
    );
  }

  return resolveText(t, 'mediaStudio:study.loadFailed', '无法打开这个音视频');
}

const PLAY_BUTTON_ARIA_RE = /播放|play/i;

function isDisabledPlayButton(el: Element | null): el is HTMLButtonElement {
  if (!(el instanceof HTMLButtonElement) || !el.hasAttribute('disabled')) return false;
  const aria = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
  return PLAY_BUTTON_ARIA_RE.test(aria);
}

/**
 * Detect whether a click/tap targets a disabled Play button — supporting both direct
 * synthetic events (jsdom/Testing Library) and real-browser clicks that fall through
 * `pointer-events: none` onto the parent container at the button's bounding rect.
 */
export function findHitDisabledPlayButton(
  container: HTMLElement,
  event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>,
): HTMLButtonElement | null {
  const target = event.target;
  if (target instanceof Element) {
    const direct = target.closest('button');
    if (isDisabledPlayButton(direct)) return direct;
  }

  const { clientX, clientY } = event;
  if (typeof clientX !== 'number' || typeof clientY !== 'number' || (clientX === 0 && clientY === 0)) {
    return null;
  }

  const buttons = container.querySelectorAll('button[disabled]');
  for (const btn of buttons) {
    if (!isDisabledPlayButton(btn)) continue;
    const rect = btn.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return btn;
    }
  }
  return null;
}
