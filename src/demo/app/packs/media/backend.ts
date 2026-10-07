/**
 * 音视频演示的内存后端：库列表 / 字幕 / 播放进度 / B 站链接条目 / 分组 / 讲义流水线的模型调用。
 *
 * - 本地「转写」用定时器模拟：逐段写入字幕并发 media-processing-* 事件（与真实后端同一套事件），
 *   库页徽章与学习页字幕面板都走生产订阅链路；
 * - 讲义生成跑的是生产流水线（抽帧 → 帧说明 → 大纲 → 分节 → 落为笔记），这里只替换模型回答；
 * - 文件选择 / 扫码登录 / 导入本地文件需要桌面环境，抛「请在桌面版中使用」。
 */
import { emit } from '@tauri-apps/api/event';
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';
import {
  CHEM_LINES,
  COURSE_BVID,
  COURSE_COVER,
  COURSE_FOLDER,
  COURSE_OWNER,
  COURSE_TITLE,
  DEMO_MEDIA,
  PRESET_HANDOUT,
  PROBE_COURSE,
  P4_ID,
  type DemoMedia,
  type Line,
} from './data';
import { handoutBlocksFor, handoutOutlineFor, presetHandoutMarkdown } from './handout';

const NOW = Date.now();
const desktopOnly = (zh: string, en: string) => new Error(tr(`${zh}请在桌面版中使用。`, `${en} is available in the desktop app.`));

// ---------------------------------------------------------------- 状态

interface MediaState extends DemoMedia {
  createdAt: number;
  updatedAt: number;
  lastWatchedAt: number | null;
  /** 转写模拟：已完成段数（null = 不在转写） */
  running: { done: number; total: number; timer: number | null; queued: boolean } | null;
  bvid?: string;
  owner?: string;
  courseTitle?: string;
  pageCount?: number;
}

const folders = new Map<string, string>([[COURSE_FOLDER.id, COURSE_FOLDER.title]]);

const media = new Map<string, MediaState>(
  DEMO_MEDIA.map((m) => [
    m.id,
    {
      ...m,
      lines: [...m.lines],
      createdAt: NOW - m.createdAgo,
      updatedAt: NOW - m.createdAgo,
      lastWatchedAt: m.watchedAgo === null ? null : NOW - m.watchedAgo,
      running: null,
      ...(m.bilibili ? { bvid: COURSE_BVID, owner: COURSE_OWNER, courseTitle: COURSE_TITLE, pageCount: 5 } : {}),
    },
  ]),
);

interface DemoNote {
  id: string;
  title: string;
  content: string;
  resourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

const notes = new Map<string, DemoNote>([
  [
    PRESET_HANDOUT.id,
    {
      id: PRESET_HANDOUT.id,
      title: PRESET_HANDOUT.title,
      content: presetHandoutMarkdown(),
      resourceId: PRESET_HANDOUT.resourceId,
      createdAt: NOW - PRESET_HANDOUT.updatedAgo,
      updatedAt: NOW - PRESET_HANDOUT.updatedAgo,
    },
  ],
]);

/** 讲义配图：notes_save_asset 的相对路径 → data URL（查看讲义时用） */
export const noteAssets = new Map<string, string>();

export function getDemoNote(id: string): DemoNote | undefined {
  return notes.get(id);
}

export function getDemoMedia(id: string): DemoMedia | undefined {
  return media.get(id);
}

// ---------------------------------------------------------------- 序列化

function segmentsOf(lines: Line[], durationMs: number, count = lines.length) {
  return lines.slice(0, count).map(([start, text], idx) => {
    const next = lines[idx + 1]?.[0];
    const endSec = next !== undefined ? next : Math.min(start + 8, durationMs / 1000);
    return { idx, startMs: start * 1000, endMs: Math.max(start * 1000 + 1500, Math.min(endSec * 1000, start * 1000 + 15_000)), text, status: 'done' };
  });
}

function transcriptStatus(m: MediaState): string {
  if (m.running) return m.running.queued ? 'queued' : 'running';
  return m.source ? 'completed' : 'none';
}

function transcriptOf(m: MediaState) {
  if (m.running) {
    const { done, total } = m.running;
    return {
      status: transcriptStatus(m),
      segments: segmentsOf(CHEM_LINES, m.durationMs, done),
      progress: { stage: m.running.queued ? 'queued' : 'asr', completedSegments: done, totalSegments: total, percent: (done / total) * 100 },
      source: 'asr',
    };
  }
  if (!m.source) return { status: 'none', segments: [], progress: null };
  return { status: 'completed', segments: segmentsOf(m.lines, m.durationMs), progress: null, source: m.source };
}

function libraryItem(m: MediaState) {
  const count = m.source ? m.lines.length : m.running?.done ?? 0;
  const folderTitle = m.folderId ? folders.get(m.folderId) ?? null : null;
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    mimeType: m.mimeType,
    isLink: Boolean(m.bilibili),
    // 封面只接受 https（生产同此约束）：官网是 https，本地 http 开发服务器下退回类型图标
    coverUrl: m.bilibili ? coverUrlFor(m) : null,
    size: m.size,
    folderId: m.folderId,
    folderName: folderTitle,
    folderPath: folderTitle ? [folderTitle] : [],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    durationMs: m.durationMs,
    transcript: {
      status: transcriptStatus(m),
      completedSegments: count,
      totalSegments: m.running?.total ?? count,
      failedSegments: 0,
      source: m.running ? 'asr' : m.source,
    },
    progress: m.lastWatchedAt === null && !m.finished
      ? { lastPositionMs: 0, watchedMs: 0, finished: false }
      : { lastPositionMs: Math.round(m.positionSec * 1000), watchedMs: m.watchedMin * 60_000, finished: m.finished },
    lastWatchedAt: m.lastWatchedAt,
    handoutCount: [...notes.values()].filter((n) => n.resourceId === m.id).length,
  };
}

/** B 站封面：只接受 https（生产同此约束）——官网是 https；本地 http 开发服务器下退回类型图标 */
function coverUrlFor(m: MediaState): string | null {
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') return null;
  const cover = m.bvid === PROBE_COURSE.bvid ? PROBE_COURSE.cover : COURSE_COVER;
  return new URL(cover, window.location.href).href;
}

function node(m: MediaState) {
  return {
    id: m.id,
    sourceId: m.id,
    path: `/${m.id}`,
    name: m.name,
    type: 'file',
    size: m.size,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    metadata: { mimeType: m.mimeType },
  };
}

function noteNode(n: DemoNote) {
  return { id: n.id, sourceId: n.id, path: `/${n.id}`, name: n.title, type: 'note', createdAt: n.createdAt, updatedAt: n.updatedAt, metadata: {}, resourceHash: `demo-${n.id}` };
}

const idOf = (path: unknown) => String(path ?? '').replace(/^\/+/, '').split('/').pop() ?? '';

// ---------------------------------------------------------------- 转写模拟

function emitMedia(event: string, m: MediaState, extra: Record<string, unknown>) {
  void emit(event, { resourceId: m.id, mediaType: m.kind, ...extra });
}

function startTranscription(m: MediaState) {
  if (m.running || m.source) return;
  const total = CHEM_LINES.length;
  m.running = { done: 0, total, timer: null, queued: true };
  emitMedia('media-processing-progress', m, { stage: 'queued', completedSegments: 0, totalSegments: total, percent: 0 });
  const tick = () => {
    const run = m.running;
    if (!run) return;
    if (run.queued) {
      run.queued = false;
    } else {
      run.done += 1;
    }
    if (run.done >= run.total) {
      m.running = null;
      m.source = 'asr';
      m.lines = [...CHEM_LINES];
      m.updatedAt = Date.now();
      emitMedia('media-processing-completed', m, { stage: 'completed' });
      return;
    }
    emitMedia('media-processing-progress', m, {
      stage: 'asr',
      completedSegments: run.done,
      totalSegments: run.total,
      percent: (run.done / run.total) * 100,
    });
    run.timer = window.setTimeout(tick, 520);
  };
  m.running.timer = window.setTimeout(tick, 700);
}

function cancelTranscription(m: MediaState) {
  if (!m.running) return;
  if (m.running.timer !== null) window.clearTimeout(m.running.timer);
  const done = m.running.done;
  m.running = null;
  if (done > 0) {
    // 已完成的段保留（生产里是 partial；演示简化为保留已出段并标记完成前缀）
    m.lines = CHEM_LINES.slice(0, done);
    m.source = 'asr';
  }
  emitMedia('media-processing-error', m, { stage: 'cancelled', error: '' });
}

// ---------------------------------------------------------------- 导出字幕（浏览器下载）

function clock(ms: number, sep: ',' | '.') {
  const total = Math.floor(ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(frac, 3)}`;
}

function exportTranscript(m: MediaState, format: string, dest: string) {
  const segs = transcriptOf(m).segments as Array<{ startMs: number; endMs: number; text: string }>;
  let text: string;
  if (format === 'srt') {
    text = segs.map((s, i) => `${i + 1}\n${clock(s.startMs, ',')} --> ${clock(s.endMs, ',')}\n${s.text}\n`).join('\n');
  } else if (format === 'vtt') {
    text = `WEBVTT\n\n${segs.map((s) => `${clock(s.startMs, '.')} --> ${clock(s.endMs, '.')}\n${s.text}\n`).join('\n')}`;
  } else {
    text = segs.map((s) => `[${clock(s.startMs, '.').slice(3, 8)}] ${s.text}`).join('\n');
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = dest.split(/[\\/]/).pop() || `transcript.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- B 站

function parseBvid(input: string): string | null {
  return /BV[0-9A-Za-z]{10}/.exec(input)?.[0] ?? null;
}

function probeFor(input: string, page: number | null) {
  const text = input.trim();
  if (!text) throw JSON.stringify({ code: 'invalid-input', message: tr('请粘贴 B 站视频链接或 BV 号', 'Paste a Bilibili link or BV id') });
  const isCourse = parseBvid(text) === COURSE_BVID;
  if (isCourse) {
    const parts = DEMO_MEDIA.filter((m) => m.bilibili).map((m) => m.bilibili!);
    const selected = page ?? 1;
    const existing = [...media.values()].find((m) => m.bvid === COURSE_BVID && m.bilibili?.page === selected);
    return {
      bvid: COURSE_BVID,
      title: COURSE_TITLE,
      owner: COURSE_OWNER,
      cover: null,
      durationMs: DEMO_MEDIA.find((m) => m.bilibili?.page === selected)?.durationMs ?? 0,
      pages: parts.map((p) => ({ page: p.page, cid: p.cid, part: p.part, durationMs: DEMO_MEDIA.find((m) => m.bilibili?.page === p.page)!.durationMs })),
      page: selected,
      tracks: [{ lan: 'zh-CN', lanDoc: '中文（中国）', ai: false }, { lan: 'ai-zh', lanDoc: '中文（自动生成）', ai: true }],
      defaultLan: 'zh-CN',
      url: `https://www.bilibili.com/video/${COURSE_BVID}`,
      existingId: existing?.id ?? null,
    };
  }
  // 其余任意链接一律解析成另一门虚构课程（演示不联网）
  const selected = page ?? 1;
  const existing = [...media.values()].find((m) => m.bvid === PROBE_COURSE.bvid && m.bilibili?.page === selected);
  return {
    bvid: PROBE_COURSE.bvid,
    title: PROBE_COURSE.title,
    owner: PROBE_COURSE.owner,
    cover: null,
    durationMs: PROBE_COURSE.pages.find((p) => p.page === selected)?.durationMs ?? 0,
    pages: PROBE_COURSE.pages.map(({ page: n, cid, part, durationMs }) => ({ page: n, cid, part, durationMs })),
    page: selected,
    tracks: [{ lan: 'zh-CN', lanDoc: '中文（中国）', ai: false }],
    defaultLan: 'zh-CN',
    url: `https://www.bilibili.com/video/${PROBE_COURSE.bvid}`,
    existingId: existing?.id ?? null,
  };
}

let createdSeq = 0;
function createLink(input: string, page: number | null) {
  const probe = probeFor(input, page);
  if (probe.existingId) {
    const m = media.get(probe.existingId)!;
    m.updatedAt = Date.now();
    return { fileId: m.id, name: m.name, created: false, segments: m.lines.length, lan: 'zh-CN', lanDoc: '中文（中国）', ai: false };
  }
  const part = PROBE_COURSE.pages.find((p) => p.page === probe.page) ?? PROBE_COURSE.pages[0];
  createdSeq += 1;
  const id = `file_demo_bili_${createdSeq}`;
  const now = Date.now();
  const name = `${PROBE_COURSE.title} P${part.page} ${part.part}.bilibili`;
  media.set(id, {
    id,
    name,
    kind: 'video',
    mimeType: 'video/x-bilibili',
    src: part.src,
    size: 1024,
    durationMs: part.durationMs,
    folderId: null,
    createdAgo: 0,
    watchedAgo: null,
    positionSec: 0,
    watchedMin: 0,
    finished: false,
    source: 'import',
    lines: PROBE_COURSE.lines.map(([s, t]) => [s, part.page === 1 ? t : t.replace('这一节我们讲参数估计。', `这一节讲${part.part}。`)] as Line),
    bilibili: { page: part.page, part: part.part, cid: part.cid },
    createdAt: now,
    updatedAt: now,
    lastWatchedAt: null,
    running: null,
    bvid: PROBE_COURSE.bvid,
    owner: PROBE_COURSE.owner,
    courseTitle: PROBE_COURSE.title,
    pageCount: PROBE_COURSE.pages.length,
  });
  return { fileId: id, name, created: true, segments: PROBE_COURSE.lines.length, lan: 'zh-CN', lanDoc: '中文（中国）', ai: false };
}

function linkDescriptor(m: MediaState) {
  if (!m.bilibili || !m.bvid) throw JSON.stringify({ code: 'invalid-input', message: 'Not a Bilibili link item' });
  return {
    bvid: m.bvid,
    aid: 0,
    cid: m.bilibili.cid,
    page: m.bilibili.page,
    pageCount: m.pageCount ?? 1,
    title: m.courseTitle ?? '',
    part: m.bilibili.part,
    owner: m.owner ?? null,
    cover: null,
    durationMs: m.durationMs,
    url: `https://www.bilibili.com/video/${m.bvid}?p=${m.bilibili.page}`,
  };
}

// ---------------------------------------------------------------- 讲义模型调用

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const captionCounters = new Map<string, number>();

function resourceOfRun(requestId: unknown): MediaState | undefined {
  const id = /^handout-(.+)-[0-9a-z]+$/.exec(String(requestId ?? ''))?.[1];
  return id ? media.get(id) : undefined;
}

async function llmComplete(args: DemoArgs): Promise<string> {
  const prompt = String(args.prompt ?? '');
  const m = resourceOfRun(args.requestId) ?? media.get(P4_ID)!;
  if (prompt.includes('"sections"')) {
    await sleep(1100);
    return JSON.stringify(handoutOutlineFor(m));
  }
  if (prompt.includes('"blocks"')) {
    await sleep(700 + Math.random() * 500);
    // 配图时间只能从提示里的配图列表原样复制
    const figureTimes = [...prompt.matchAll(/^- (\d{2}:\d{2}(?::\d{2})?): /gm)].map((x) => x[1]);
    return JSON.stringify({ blocks: handoutBlocksFor(m, prompt, figureTimes) });
  }
  await sleep(500);
  return m.lines.map(([s, t]) => `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}] ${t}`).join('\n');
}

async function vlmCaption(args: DemoArgs): Promise<string> {
  await sleep(160 + Math.random() * 160);
  const key = String(args.requestId ?? '');
  const n = captionCounters.get(key) ?? 0;
  captionCounters.set(key, n + 1);
  const m = resourceOfRun(args.requestId);
  const slide = m?.slides?.[n];
  return `TYPE: TEACHING\n${slide ? slide.caption : tr('课程幻灯片：本节标题与要点', 'Lecture slide: section title and key points')}`;
}

// ---------------------------------------------------------------- 处理器

export function handleDemoMedia(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'media_library_list':
      return [...media.values()].map(libraryItem);
    case 'media_related_notes': {
      const id = String(args.resourceId ?? '');
      return [...notes.values()]
        .filter((n) => n.resourceId === id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((n) => ({ id: n.id, title: n.title, createdAt: n.createdAt, updatedAt: n.updatedAt }));
    }
    case 'media_transcript_get': {
      const m = media.get(String(args.resourceId ?? ''));
      return m ? transcriptOf(m) : { status: 'none', segments: [], progress: null };
    }
    case 'media_transcribe_estimate': {
      const m = media.get(String(args.resourceId ?? ''));
      return {
        durationMs: m?.durationMs ?? null,
        plannedSegments: m ? Math.max(1, Math.round(m.durationMs / 85_000)) : null,
        asrModel: 'FunAudioLLM/SenseVoiceSmall',
        asrConfigured: true,
        exact: false,
      };
    }
    case 'media_transcribe_start': {
      const m = media.get(String(args.resourceId ?? ''));
      if (!m) return { status: 'none', segments: [] };
      if (m.id !== 'file_demo_chem_sn' && !m.source) throw desktopOnly('转写', 'Transcription');
      startTranscription(m);
      return transcriptOf(m);
    }
    case 'media_transcribe_cancel': {
      const m = media.get(String(args.resourceId ?? ''));
      if (m) cancelTranscription(m);
      return null;
    }
    case 'media_transcript_import':
      throw desktopOnly('导入字幕文件', 'Importing subtitle files');
    case 'media_transcript_export': {
      const m = media.get(String(args.resourceId ?? ''));
      if (m) exportTranscript(m, String(args.format ?? 'srt'), String(args.dest ?? ''));
      return null;
    }
    case 'media_progress_get': {
      const m = media.get(String(args.resourceId ?? ''));
      if (!m) return null;
      return {
        lastPositionMs: Math.round(m.positionSec * 1000),
        durationMs: m.durationMs,
        watchedMs: m.watchedMin * 60_000,
        finished: m.finished,
      };
    }
    case 'media_progress_set': {
      const m = media.get(String(args.resourceId ?? ''));
      if (!m) return null;
      m.positionSec = Number(args.positionMs ?? 0) / 1000;
      m.watchedMin += Number(args.watchedDeltaMs ?? 0) / 60_000;
      m.finished = Boolean(args.finished) || m.finished;
      m.lastWatchedAt = Date.now();
      return null;
    }

    // ---------- B 站
    case 'media_bilibili_auth_status':
      return { loggedIn: false, mid: null, uname: null, face: null, vip: false, verified: true, expired: false };
    case 'media_bilibili_login_qr_start':
      throw desktopOnly('扫码登录 B 站', 'Signing in to Bilibili');
    case 'media_bilibili_login_qr_poll':
      return { state: 'expired', status: null };
    case 'media_bilibili_logout':
      return null;
    case 'media_bilibili_probe':
      return sleep(700).then(() => probeFor(String(args.input ?? ''), (args.page as number | null) ?? null));
    case 'media_bilibili_create':
      return sleep(600).then(() => createLink(String(args.input ?? ''), (args.page as number | null) ?? null));
    case 'media_bilibili_import_subtitle': {
      const m = media.get(String(args.resourceId ?? ''));
      if (!m || !m.bilibili) throw desktopOnly('给本地视频导入 B 站字幕', 'Importing Bilibili subtitles for local videos');
      return sleep(600).then(() => transcriptOf(m));
    }
    case 'media_bilibili_link_get': {
      const m = media.get(String(args.resourceId ?? ''));
      if (!m) throw JSON.stringify({ code: 'not-found', message: 'Not found' });
      return linkDescriptor(m);
    }

    // ---------- 播放地址（convertFileSrc 在包里接到资源 URL）
    case 'vfs_get_file_blob_path': {
      const m = media.get(String(args.id ?? ''));
      return m ? `demo-media/${m.id}` : null;
    }
    case 'filestream_check_access':
      return true;

    // ---------- 资源节点
    case 'dstu_get': {
      const id = idOf(args.path);
      const m = media.get(id);
      if (m) return node(m);
      const n = notes.get(id);
      return n ? noteNode(n) : null;
    }
    case 'dstu_rename': {
      const id = idOf(args.path);
      const m = media.get(id);
      if (!m) return null;
      m.name = String(args.newName ?? m.name);
      m.updatedAt = Date.now();
      return { ...node(m), resourceHash: `demo-${m.id}` };
    }
    case 'dstu_delete': {
      media.delete(idOf(args.path));
      return null;
    }
    case 'dstu_folder_create': {
      const id = `fld_demo_${folders.size + 1}`;
      const title = String(args.title ?? '');
      folders.set(id, title);
      return { id, parentId: null, title, isExpanded: true, sortOrder: folders.size, createdAt: Date.now(), updatedAt: Date.now() };
    }
    case 'dstu_folder_move_item': {
      const m = media.get(String(args.itemId ?? ''));
      if (m) m.folderId = (args.newFolderId as string | null) ?? null;
      return null;
    }
    case 'vfs_update_path_cache':
      return 0;
    case 'plugin:dialog|save': {
      const options = (args.options ?? {}) as { defaultPath?: string };
      return options.defaultPath ?? 'transcript.srt';
    }
    case 'plugin:dialog|open':
      throw desktopOnly('选择本地文件', 'Picking local files');
    case 'plugin:opener|open_url':
      return null;

    // ---------- 讲义流水线
    case 'handout_llm_complete':
      return llmComplete(args);
    case 'handout_vlm_caption':
      return vlmCaption(args);
    case 'handout_cancel':
    case 'handout_release':
      return null;
    case 'dstu_create': {
      const options = (args.options ?? {}) as { name?: string; content?: string; metadata?: Record<string, unknown> };
      const id = `note_demo_handout_${notes.size + 1}`;
      const now = Date.now();
      const note: DemoNote = { id, title: options.name ?? '讲义', content: options.content ?? '', resourceId: null, createdAt: now, updatedAt: now };
      notes.set(id, note);
      return noteNode(note);
    }
    case 'dstu_set_metadata': {
      const n = notes.get(idOf(args.path));
      const props = (args.metadata as { props?: Record<string, unknown> } | undefined)?.props ?? {};
      try {
        const origin = JSON.parse(String(props._origin ?? 'null')) as { resourceId?: string } | null;
        if (n && origin?.resourceId) n.resourceId = origin.resourceId;
      } catch {
        /* 无来源 */
      }
      return null;
    }
    case 'dstu_update': {
      const n = notes.get(idOf(args.path));
      if (!n) return null;
      n.content = String(args.content ?? n.content);
      n.updatedAt = Date.now();
      return noteNode(n);
    }
    case 'notes_save_asset': {
      const data = String(args.base64Data ?? '');
      const path = `notes_assets/${String(args.noteId ?? 'note')}/${noteAssets.size + 1}.jpg`;
      noteAssets.set(path, data);
      return { relative_path: path };
    }
    default:
      return undefined;
  }
}
