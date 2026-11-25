/**
 * 卡面媒体：把 APKG 导入落盘的图片 / 音频注入沙箱卡面。
 *
 * 卡面跑在 sandbox iframe 里，CSP 只放行 data:/blob:/https: 资源，字段里的
 * `src="name.png"` 与 `[sound:name.mp3]` 无法直接加载本地文件。这里按文件名
 * 把 `card.images`（导入时记录的绝对路径）读成 data URL 再替换进 HTML；
 * 音频改成可播放的 `<audio>`，并注入一段小脚本负责自动播放、R 键重播和
 * 「点空白处翻面」的消息转发。
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const CACHE_LIMIT = 256;
const cache = new Map<string, Promise<string | null>>();

/** 1x1 透明 GIF 占位图：防止未解析的本地相对 src 进入 iframe srcdoc 触发 img-src CSP 违规。 */
export const TRANSPARENT_PIXEL_DATA_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const REMOTE_OR_DATA_SCHEME_RE = /^(?:data:|blob:|https?:|asset:)/i;
const SANDBOX_SAFE_MEDIA_SRC_RE = /^(?:data:|blob:|https:)/i;
const AUDIO_MEDIA_EXT_RE = /\.(?:mp3|ogg|oga|opus|wav|m4a|aac|flac|webm)(?:$|[?#])/i;
const VIDEO_MEDIA_EXT_RE = /\.(?:mp4)(?:$|[?#])/i;
const SUPPORTED_MEDIA_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|mp3|ogg|oga|opus|wav|m4a|aac|flac|webm|mp4)(?:$|[?#])/i;

export function clearCardMediaCache(): void {
  cache.clear();
}

export function isAudioMediaRef(ref: string): boolean {
  return AUDIO_MEDIA_EXT_RE.test(ref.trim());
}

export function isVideoMediaRef(ref: string): boolean {
  return VIDEO_MEDIA_EXT_RE.test(ref.trim());
}

export function isAnkiMediaRef(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed || REMOTE_OR_DATA_SCHEME_RE.test(trimmed)) return false;
  if (/[\\/]anki_media[\\/]/i.test(trimmed)) return true;
  if (/^anki-media:\/\//i.test(trimmed)) return true;
  return !/[\\/:]/.test(trimmed) && SUPPORTED_MEDIA_EXT_RE.test(trimmed);
}

export function mediaBasename(path: string): string {
  const cleaned = path.trim().replace(/^anki-media:\/\/\/?/i, '').split(/[?#]/)[0] ?? path;
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] ?? cleaned;
}

function loadMediaDataUrlOnce(path: string): Promise<string | null> {
  const cached = cache.get(path);
  if (cached) return cached;
  const pending = invoke<string>('read_anki_media', { path })
    .then((url) => {
      if (typeof url === 'string' && url.startsWith('data:')) return url;
      cache.delete(path);
      return null;
    })
    .catch(() => {
      cache.delete(path);
      return null;
    });
  cache.set(path, pending);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}

async function loadMediaDataUrl(path: string): Promise<string | null> {
  const direct = await loadMediaDataUrlOnce(path);
  if (direct) return direct;
  // WebUI / relocated data-dir fallback: if stored absolute path came from another machine or slot,
  // retry with the safe bare filename inside the active anki_media directory.
  const base = mediaBasename(decodeName(path));
  if (base && base !== path.trim() && !/[\\/:]/.test(base) && base !== '.' && base !== '..') {
    return loadMediaDataUrlOnce(base);
  }
  return null;
}

/**
 * 提取 HTML/卡面文本里引用的本地图片与音频文件名（供 read_anki_media 兜底解析）。
 */
export function extractInlineMediaNames(html: string): string[] {
  if (!html) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || REMOTE_OR_DATA_SCHEME_RE.test(trimmed)) return;
    const base = mediaBasename(decodeName(trimmed));
    if (!base || base === '.' || base === '..' || /[\\/:]/.test(base)) return;
    const key = base.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(base);
  };
  for (const match of html.matchAll(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi)) {
    push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  for (const match of html.matchAll(SOUND_TAG)) {
    push(match[1] ?? '');
  }
  return names;
}

/** 按文件名查已加载的 data URL（支持 URI 解码与大小写不敏感兜底）。 */
export function lookupCardMedia(media: ReadonlyMap<string, string>, rawRef: string): string | undefined {
  if (media.size === 0) return undefined;
  const trimmed = rawRef.trim();
  if (!trimmed) return undefined;
  const decoded = decodeName(trimmed);
  const directBase = mediaBasename(trimmed);
  const decodedBase = mediaBasename(decoded);
  const hit = media.get(decodedBase) ?? media.get(directBase);
  if (hit) return hit;
  const targetLower = decodedBase.toLowerCase();
  for (const [name, url] of media.entries()) {
    if (name.toLowerCase() === targetLower) return url;
  }
  return undefined;
}

export interface CardMediaState {
  media: Map<string, string>;
  loading: boolean;
}

/** 文件名 → data URL + 加载态；支持 card.images 路径与卡面内联文件名经 read_anki_media 解析，读不到的静默跳过。 */
export function useCardMediaState(
  paths: readonly string[] | undefined,
  inlineNames?: readonly string[],
  retryNonce = 0,
): CardMediaState {
  const candidates: string[] = [];
  const seenNames = new Set<string>();
  for (const path of paths ?? []) {
    if (!isAnkiMediaRef(path)) continue;
    const base = mediaBasename(decodeName(path));
    if (!base) continue;
    const lower = base.toLowerCase();
    if (seenNames.has(lower)) continue;
    seenNames.add(lower);
    candidates.push(path);
  }
  for (const rawName of inlineNames ?? []) {
    const base = mediaBasename(decodeName(rawName));
    if (!base || base === '.' || base === '..' || /[\\/:]/.test(base)) continue;
    const lower = base.toLowerCase();
    if (seenNames.has(lower)) continue;
    seenNames.add(lower);
    candidates.push(base);
  }
  const key = candidates.join('\n');
  const requestKey = `${retryNonce}\u0000${key}`;
  const [state, setState] = useState<{ requestKey: string; media: Map<string, string> }>(() => ({
    requestKey: key ? '' : requestKey,
    media: new Map(),
  }));

  useEffect(() => {
    const local = key ? key.split('\n') : [];
    if (local.length === 0) {
      setState((current) =>
        current.requestKey === requestKey && current.media.size === 0
          ? current
          : { requestKey, media: new Map() },
      );
      return undefined;
    }
    let cancelled = false;
    void Promise.all(
      local.map(async (path) => [mediaBasename(decodeName(path)), await loadMediaDataUrl(path)] as const),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const [name, url] of entries) {
        if (url) next.set(name, url);
      }
      setState({ requestKey, media: next });
    });
    return () => {
      cancelled = true;
    };
  }, [key, requestKey]);

  const loading = Boolean(key) && state.requestKey !== requestKey;
  return { media: state.media, loading };
}

/** 文件名 → data URL；支持 card.images 路径与卡面内联文件名经 read_anki_media 解析，读不到的静默跳过。 */
export function useCardMediaMap(
  paths: readonly string[] | undefined,
  inlineNames?: readonly string[],
): Map<string, string> {
  return useCardMediaState(paths, inlineNames).media;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw.trim();
  }
}

const SOUND_TAG = /\[sound:([^\]]+)\]/gi;

/** 字段 / 模板 HTML 里引用到的音频文件名。 */
export function soundNames(html: string): Set<string> {
  const names = new Set<string>();
  for (const match of html.matchAll(SOUND_TAG)) names.add(decodeName(match[1]));
  return names;
}

export interface InjectCardMediaOptions {
  /** 不自动播放的音频（背面里属于正面的部分，同 Anki 不重放 {{FrontSide}} 音频） */
  noAutoplay?: Set<string>;
  /** 本地媒体是否仍在异步加载中（用于展示明确的音频加载态，而非静态文件名徽标） */
  mediaLoading?: boolean;
}

/**
 * 替换 `src="name"` / `src=name` 为 data URL；未解析的本地相对引用绝不裸出到 srcdoc，
 * 一律替换为透明 1×1 data URL 占位 + `data-anki-media-pending="1"` 以满足严格 CSP（零控制台报错）。
 * `[sound:name]` 变成可点击播放按钮 + `<audio>`（加载中/缺失时展示明确的可交互加载/重试按钮）。
 */
export function injectCardMedia(
  html: string,
  media: Map<string, string>,
  options: InjectCardMediaOptions = {},
): string {
  let out = html.replace(
    /<(img|audio|video|source)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
    (tagMatch, rawTag: string, attrs: string) => {
      const tag = rawTag.toLowerCase();
      let touched = false;
      const nextAttrs = attrs.replace(
        /(\ssrc\s*=\s*)(?:(["'])([^"']*)\2|([^\s"'=<>`]+))/gi,
        (whole, prefix: string, quote: string | undefined, quotedVal: string | undefined, unquotedVal: string | undefined) => {
          const value = quotedVal ?? unquotedVal ?? '';
          const trimmed = value.trim();
          if (trimmed && SANDBOX_SAFE_MEDIA_SRC_RE.test(trimmed)) return whole;
          touched = true;
          const url = trimmed ? lookupCardMedia(media, trimmed) : undefined;
          const q = quote ?? '"';
          if (url) {
            return `${prefix}${q}${url}${q}`;
          }
          const refAttr = trimmed ? ` data-anki-media-ref="${escapeAttr(trimmed)}"` : '';
          if (tag === 'img') {
            return `${prefix}"${TRANSPARENT_PIXEL_DATA_URL}" data-anki-media-pending="1"${refAttr}`;
          }
          return ` data-anki-media-pending="1"${refAttr}`;
        },
      );
      return touched ? `<${rawTag}${nextAttrs}>` : tagMatch;
    },
  );
  out = out.replace(SOUND_TAG, (_whole, raw: string) => {
    const name = decodeName(raw);
    const url = lookupCardMedia(media, name);
    const safeName = escapeAttr(name);
    if (!url) {
      if (options.mediaLoading) {
        return `<button type="button" class="anki-sound anki-sound-btn" data-sound-file="${safeName}" data-sound-state="loading" aria-busy="true" aria-label="Loading audio ${safeName}" title="${safeName}" disabled>`
          + `<span class="anki-sound-icon" aria-hidden="true">&#9654;</span>`
          + `<span class="anki-sound-label">Loading&#8230;</span></button>`;
      }
      return `<button type="button" class="anki-sound anki-sound-btn" data-sound-file="${safeName}" data-sound-state="unavailable" aria-label="Play audio ${safeName}" title="${safeName}">`
        + `<span class="anki-sound-icon" aria-hidden="true">&#9654;</span>`
        + `<span class="anki-sound-name">${safeName}</span></button>`;
    }
    const autoplay = options.noAutoplay?.has(name) ? '0' : '1';
    return `<span class="anki-sound-player" data-sound-file="${safeName}">`
      + `<button type="button" class="anki-sound-play" data-sound-file="${safeName}" data-sound-state="ready" aria-label="Play audio ${safeName}" title="${safeName}">`
      + `<span class="anki-sound-icon" aria-hidden="true">&#9654;</span></button>`
      + `<audio class="anki-audio" controls preload="auto" src="${url}" data-sound-file="${safeName}" data-autoplay="${autoplay}"></audio>`
      + `</span>`;
  });
  return out;
}

/** 卡面里有需要点按的元素（提示折叠、音频、图片放大、链接、模板脚本）时才放开 iframe 指针事件。 */
export function isInteractiveCardHtml(html: string): boolean {
  return /<(details|audio|video|img|a\s|input|select|button|textarea)\b|\sonclick\s*=|<script\b/i.test(html);
}

/** 字段内容是否是 HTML（外部 Anki 牌组的字段通常带 <b>/<br>/<img> 等标签）。 */
export function looksLikeHtml(text: string): boolean {
  return /<\/?(?:[a-z][a-z0-9]*)\b[^>]*>/i.test(text) || /\[sound:[^\]]+\]/i.test(text);
}

/**
 * 卡面辅助脚本（沙箱内执行，无同源权限）：
 * - 依次自动播放 data-autoplay="1" 的音频（被浏览器拦截时静默）；
 * - 支持显式点击 `.anki-sound-play` 按钮播放/暂停音频，以及 `.anki-sound-btn` 重试通知；
 * - 收到 `sdp-replay-audio` 消息时从头重播；
 * - 点击已加载的 `<img>` 时阻止翻面并通知宿主 `sdp-image-click` 打开全分辨率缩放灯箱；
 * - 点击非交互区域时通知宿主 `sdp-click`（宿主据此翻面）；
 * - 文档自身滚不动时把滚轮转发给宿主 `sdp-wheel`（见下）。
 * 脚本内容的 SHA-256 须与宿主 CSP 白名单同步；cspContract 测试按实际渲染文本校验。
 */
export const CARD_FACE_HELPER_SCRIPT = `<script>(function(){
  var audios = Array.prototype.slice.call(document.querySelectorAll('audio.anki-audio'));
  function syncBtn(a, playing){
    var p = a && a.closest ? a.closest('.anki-sound-player') : null;
    var btn = p ? p.querySelector('button.anki-sound-play') : null;
    if (!btn) return;
    btn.setAttribute('data-playing', playing ? '1' : '0');
    var icon = btn.querySelector('.anki-sound-icon');
    if (icon) icon.textContent = playing ? '\\u23F8' : '\\u25B6';
  }
  audios.forEach(function(a){
    a.addEventListener('play', function(){ syncBtn(a, true); });
    a.addEventListener('pause', function(){ syncBtn(a, false); });
    a.addEventListener('ended', function(){ syncBtn(a, false); });
  });
  function stopAll(){ audios.forEach(function(a){ try { a.pause(); } catch (e) {} }); }
  function playFrom(list, i){
    if (i >= list.length) return;
    var a = list[i];
    a.onended = function(){ syncBtn(a, false); playFrom(list, i + 1); };
    try { a.currentTime = 0; var p = a.play(); if (p && p.catch) p.catch(function(){}); } catch (e) {}
  }
  var auto = audios.filter(function(a){ return a.getAttribute('data-autoplay') === '1'; });
  if (auto.length) playFrom(auto, 0);
  window.addEventListener('message', function(event){
    if (event.data && event.data.type === 'sdp-replay-audio') { stopAll(); playFrom(audios, 0); }
  });
  document.addEventListener('click', function(event){
    var target = event.target;
    var playBtn = target && target.closest ? target.closest('button.anki-sound-play') : null;
    if (playBtn) {
      event.preventDefault();
      event.stopPropagation();
      var player = playBtn.closest('.anki-sound-player');
      var audio = player ? player.querySelector('audio.anki-audio') : null;
      if (audio) {
        if (!audio.paused && !audio.ended) {
          try { audio.pause(); } catch (e) {}
        } else {
          stopAll();
          try {
            if (audio.ended) audio.currentTime = 0;
            var p = audio.play();
            if (p && p.catch) p.catch(function(){});
          } catch (e) {}
        }
      }
      return;
    }
    var soundBtn = target && target.closest ? target.closest('button.anki-sound-btn') : null;
    if (soundBtn) {
      event.preventDefault();
      event.stopPropagation();
      try { parent.postMessage({ type: 'sdp-sound-click', soundFile: soundBtn.getAttribute('data-sound-file') || '' }, '*'); } catch (e) {}
      return;
    }
    var img = target && target.closest ? target.closest('img') : null;
    if (img && (!img.closest || !img.closest('a,button'))) {
      var pending = img.getAttribute('data-anki-media-pending') === '1';
      var src = img.currentSrc || img.getAttribute('src') || '';
      if (!pending && src) {
        event.preventDefault();
        event.stopPropagation();
        try { parent.postMessage({ type: 'sdp-image-click', src: src, alt: img.getAttribute('alt') || '' }, '*'); } catch (e) {}
        return;
      }
    }
    if (target && target.closest && target.closest('a,button,summary,details,audio,video,input,select,textarea,label,[onclick]')) return;
    try { parent.postMessage({ type: 'sdp-click' }, '*'); } catch (e) {}
  });
  function canScroll(el, dy){
    if (!el) return false;
    var max = el.scrollHeight - el.clientHeight;
    if (max <= 1) return false;
    return dy > 0 ? el.scrollTop < max - 1 : el.scrollTop > 1;
  }
  window.addEventListener('wheel', function(event){
    var dy = event.deltaY || 0;
    if (!dy) return;
    // 复习舞台把 iframe 高度设成内容高度，文档自身滚不动，而 WebKit 不会把 iframe
    // 里的滚轮链回宿主卡片的统一 viewport（宿主因此收不到滚轮，长卡面只能拖滚动条）。
    // 这里把「文档自己滚不动」的滚轮转发给宿主；文档还能滚时保持原生滚动，避免双滚。
    if (canScroll(document.body, dy) || canScroll(document.documentElement, dy)) return;
    try { parent.postMessage({ type: 'sdp-wheel', deltaY: dy, deltaMode: event.deltaMode || 0 }, '*'); } catch (e) {}
  }, { passive: true });
})();</script>`;

/** 向当前页面里的卡面 iframe 与直出音频广播「重播音频」。 */
export function replayCardAudio(root: ParentNode = document): void {
  root.querySelectorAll('iframe').forEach((frame) => {
    try {
      frame.contentWindow?.postMessage({ type: 'sdp-replay-audio' }, '*');
    } catch {
      /* frame already detached */
    }
  });
  const audios = Array.from(root.querySelectorAll<HTMLAudioElement>('audio.anki-audio'));
  if (audios.length === 0) return;
  audios.forEach((audio) => {
    try { audio.pause(); } catch { /* ignore */ }
  });
  const playAt = (index: number) => {
    if (index >= audios.length) return;
    const audio = audios[index];
    audio.onended = () => playAt(index + 1);
    try {
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* autoplay blocked or unsupported in test DOM */
    }
  };
  playAt(0);
}
