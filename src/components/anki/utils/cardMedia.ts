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

const CACHE_LIMIT = 64;
const cache = new Map<string, Promise<string | null>>();

export function mediaBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function loadMediaDataUrl(path: string): Promise<string | null> {
  const cached = cache.get(path);
  if (cached) return cached;
  const pending = invoke<string>('read_anki_media', { path })
    .then((url) => (typeof url === 'string' && url.startsWith('data:') ? url : null))
    .catch(() => null);
  cache.set(path, pending);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}

/** 文件名 → data URL；只加载导入媒体目录里的文件，读不到的静默跳过。 */
export function useCardMediaMap(paths: readonly string[] | undefined): Map<string, string> {
  const [media, setMedia] = useState<Map<string, string>>(() => new Map());
  const key = (paths ?? []).filter((path) => /[\\/]anki_media[\\/]/.test(path)).join('\n');
  useEffect(() => {
    const local = key ? key.split('\n') : [];
    if (local.length === 0) {
      setMedia((current) => (current.size === 0 ? current : new Map()));
      return undefined;
    }
    let cancelled = false;
    void Promise.all(local.map(async (path) => [mediaBasename(path), await loadMediaDataUrl(path)] as const))
      .then((entries) => {
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const [name, url] of entries) {
          if (url) next.set(name, url);
        }
        setMedia(next);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return media;
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
}

/**
 * 替换 `src="name"` 为 data URL；`[sound:name]` 变成 `<audio>`（读不到文件时退回 ♪ 徽标）。
 */
export function injectCardMedia(
  html: string,
  media: Map<string, string>,
  options: InjectCardMediaOptions = {},
): string {
  let out = html.replace(
    /(\ssrc\s*=\s*)(["'])([^"']+)\2/gi,
    (whole, prefix: string, quote: string, value: string) => {
      if (/^(data:|blob:|https?:|asset:)/i.test(value.trim())) return whole;
      const url = media.get(mediaBasename(decodeName(value)));
      return url ? `${prefix}${quote}${url}${quote}` : whole;
    },
  );
  out = out.replace(SOUND_TAG, (_whole, raw: string) => {
    const name = decodeName(raw);
    const url = media.get(mediaBasename(name));
    const safeName = escapeAttr(name);
    if (!url) {
      return `<span class="anki-sound" role="img" aria-label="audio" data-sound-file="${safeName}">`
        + `<span class="anki-sound-icon" aria-hidden="true">&#9834;</span>`
        + `<span class="anki-sound-name">${safeName}</span></span>`;
    }
    const autoplay = options.noAutoplay?.has(name) ? '0' : '1';
    return `<audio class="anki-audio" controls preload="auto" src="${url}" data-sound-file="${safeName}" data-autoplay="${autoplay}"></audio>`;
  });
  return out;
}

/** 卡面里有需要点按的元素（提示折叠、音频、链接、模板脚本）时才放开 iframe 指针事件。 */
export function isInteractiveCardHtml(html: string): boolean {
  return /<(details|audio|video|a\s|input|select|button|textarea)\b|\sonclick\s*=|<script\b/i.test(html);
}

/** 字段内容是否是 HTML（外部 Anki 牌组的字段通常带 <b>/<br>/<img> 等标签）。 */
export function looksLikeHtml(text: string): boolean {
  return /<\/?(?:[a-z][a-z0-9]*)\b[^>]*>/i.test(text) || /\[sound:[^\]]+\]/i.test(text);
}

/**
 * 卡面辅助脚本（沙箱内执行，无同源权限）：
 * - 依次自动播放 data-autoplay="1" 的音频（被浏览器拦截时静默）；
 * - 收到 `sdp-replay-audio` 消息时从头重播；
 * - 点击非交互区域时通知宿主 `sdp-click`（宿主据此翻面）。
 */
export const CARD_FACE_HELPER_SCRIPT = `<script>(function(){
  var audios = Array.prototype.slice.call(document.querySelectorAll('audio.anki-audio'));
  function stopAll(){ audios.forEach(function(a){ try { a.pause(); } catch (e) {} }); }
  function playFrom(list, i){
    if (i >= list.length) return;
    var a = list[i];
    a.onended = function(){ playFrom(list, i + 1); };
    try { a.currentTime = 0; var p = a.play(); if (p && p.catch) p.catch(function(){}); } catch (e) {}
  }
  var auto = audios.filter(function(a){ return a.getAttribute('data-autoplay') === '1'; });
  if (auto.length) playFrom(auto, 0);
  window.addEventListener('message', function(event){
    if (event.data && event.data.type === 'sdp-replay-audio') { stopAll(); playFrom(audios, 0); }
  });
  document.addEventListener('click', function(event){
    var target = event.target;
    if (target && target.closest && target.closest('a,button,summary,details,audio,video,input,select,textarea,label,[onclick]')) return;
    try { parent.postMessage({ type: 'sdp-click' }, '*'); } catch (e) {}
  });
})();</script>`;

/** 向当前页面里的卡面 iframe 广播「重播音频」。 */
export function replayCardAudio(root: ParentNode = document): void {
  root.querySelectorAll('iframe').forEach((frame) => {
    try {
      frame.contentWindow?.postMessage({ type: 'sdp-replay-audio' }, '*');
    } catch {
      /* frame already detached */
    }
  });
}
