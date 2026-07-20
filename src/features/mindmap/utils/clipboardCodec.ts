/**
 * 思维导图剪贴板编解码器
 *
 * 复制时同时产出两种载体：
 * 1. text/plain —— 带缩进的 Markdown 列表：任务节点用 `- [ ]` / `- [x]`，
 *    备注序列化为 `> ` 前缀的缩进续行（与 pasteMarkdown 的续行解析约定一致），
 *    可直接粘贴到幕布 / Workflowy / 任意文本编辑器；
 * 2. 结构化 JSON（application/x-deep-student-mindmap）—— 保留样式 / 挖空 /
 *    完成态 / 备注 / 资源引用等全部字段，供跨导图粘贴时无损还原。
 *
 * Tauri WebView 对 navigator.clipboard.write 与自定义 MIME 的支持参差不齐
 * （WebKit 基本不支持自定义类型，Chromium 需要 `web ` 前缀），因此结构化载荷
 * 同时落一份 localStorage「侧车」，以 text/plain 的指纹（hashText）关联：
 * 粘贴时先读系统剪贴板文本，指纹对得上才使用侧车载荷。这保证系统剪贴板被
 * 其它应用覆盖后不会误用旧的结构化数据（对应 C1 粘贴优先级 bug 的根治手段）。
 */

import { nanoid } from 'nanoid';
import type { BlankRange, MindMapNode, MindMapNodeRef, NodeStyle } from '../types';
import { copyTextToClipboard, readTextFromClipboard } from '@/utils/clipboardUtils';
import { htmlOutlineToMarkdown, looksLikeMarkdownList } from './pasteMarkdown';

// ============================================================================
// 数据契约
// ============================================================================

/** 结构化剪贴板 MIME 类型（Chromium 自定义格式需要 `web ` 前缀的变体） */
export const MINDMAP_CLIPBOARD_MIME = 'application/x-deep-student-mindmap';

/** 载荷格式标识 */
export const MINDMAP_CLIPBOARD_FORMAT = 'deep-student-mindmap';

/** 载荷版本；结构不兼容时递增并在 parse 时拒绝未知版本 */
export const MINDMAP_CLIPBOARD_VERSION = 1;

/** localStorage 侧车键（跨导图实例共享，是应用内结构化粘贴的主要通道） */
const SIDECAR_STORAGE_KEY = 'deep-student:mindmap-clipboard:v1';

const MAX_CLIPBOARD_NODES = 10000;
const MAX_CLIPBOARD_DEPTH = 100;

/**
 * 结构化剪贴板载荷。
 * - `fingerprint` 与同批写入系统剪贴板的 text/plain 一一对应（hashText），
 *   粘贴时用来校验系统剪贴板是否已被其它来源覆盖；
 * - `nodes` 为顶层节点森林，已经过白名单清洗（剥离 branchColor 等运行时字段）。
 */
export interface MindMapClipboardPayload {
  format: typeof MINDMAP_CLIPBOARD_FORMAT;
  version: typeof MINDMAP_CLIPBOARD_VERSION;
  /** 写入时间戳（ms），与 store clipboard.copiedAt 对齐 */
  copiedAt: number;
  /** 对应 text/plain 的内容指纹 */
  fingerprint: string;
  nodes: MindMapNode[];
}

/** 读取系统剪贴板后的归一化结果 */
export type MindMapClipboardRead =
  | { kind: 'structured'; payload: MindMapClipboardPayload; text: string | null }
  | { kind: 'markdown'; markdown: string; text: string }
  | { kind: 'lines'; lines: string[]; text: string }
  | { kind: 'empty'; text: null };

// ============================================================================
// 指纹与序列化
// ============================================================================

/** FNV-1a 32 位哈希，输出 8 位十六进制；用于剪贴板文本指纹比对 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 将节点森林序列化为带缩进的 Markdown 列表。
 * - 任务节点（completed 为布尔值）输出 `- [ ]` / `- [x]`；
 * - 备注与正文折行输出为 `> ` 前缀的缩进续行，粘回时由
 *   markdownListToNodes 的续行规则还原为备注。
 */
export function nodesToMarkdown(nodes: MindMapNode[]): string {
  const lines: string[] = [];

  const emit = (node: MindMapNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const marker =
      typeof node.completed === 'boolean' ? (node.completed ? '- [x]' : '- [ ]') : '-';
    const [firstLine, ...restText] = (node.text ?? '').split('\n');
    lines.push(`${indent}${marker} ${firstLine}`);

    const noteLines = [...restText, ...(node.note ? node.note.split('\n') : [])];
    for (const noteLine of noteLines) {
      lines.push(`${indent}  > ${noteLine}`);
    }

    node.children?.forEach((child) => emit(child, depth + 1));
  };

  nodes.forEach((node) => emit(node, 0));
  return lines.join('\n');
}

// ============================================================================
// 节点清洗（编码与解码共用的白名单）
// ============================================================================

function sanitizeStyle(raw: unknown): NodeStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const style: NodeStyle = {};
  if (typeof source.bgColor === 'string') style.bgColor = source.bgColor;
  if (typeof source.textColor === 'string') style.textColor = source.textColor;
  if (typeof source.fontSize === 'number') style.fontSize = source.fontSize;
  if (source.fontWeight === 'normal' || source.fontWeight === 'bold') {
    style.fontWeight = source.fontWeight;
  }
  if (source.fontStyle === 'normal' || source.fontStyle === 'italic') {
    style.fontStyle = source.fontStyle;
  }
  if (
    source.textDecoration === 'none' ||
    source.textDecoration === 'underline' ||
    source.textDecoration === 'line-through'
  ) {
    style.textDecoration = source.textDecoration;
  }
  if (source.headingLevel === 'h1' || source.headingLevel === 'h2' || source.headingLevel === 'h3') {
    style.headingLevel = source.headingLevel;
  }
  if (typeof source.icon === 'string') style.icon = source.icon;
  return Object.keys(style).length > 0 ? style : undefined;
}

function sanitizeBlankedRanges(raw: unknown): BlankRange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ranges = raw.filter(
    (item): item is BlankRange =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as BlankRange).start === 'number' &&
      typeof (item as BlankRange).end === 'number',
  );
  return ranges.length > 0 ? ranges.map((r) => ({ start: r.start, end: r.end })) : undefined;
}

function sanitizeRefs(raw: unknown): MindMapNodeRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw.flatMap((item): MindMapNodeRef[] => {
    if (!item || typeof item !== 'object') return [];
    const source = item as Record<string, unknown>;
    if (typeof source.sourceId !== 'string' || typeof source.type !== 'string') return [];
    return [
      {
        sourceId: source.sourceId,
        type: source.type,
        name: typeof source.name === 'string' ? source.name : '',
        ...(typeof source.resourceHash === 'string' ? { resourceHash: source.resourceHash } : {}),
      },
    ];
  });
  return refs.length > 0 ? refs : undefined;
}

/**
 * 递归清洗单个节点：只保留文档字段（剥离 branchColor 等运行时字段），
 * 并做深度 / 节点数上限守卫，防止恶意或损坏的载荷撑爆内存。
 */
function sanitizeNode(
  raw: unknown,
  depth: number,
  counter: { count: number },
): MindMapNode | null {
  if (!raw || typeof raw !== 'object' || depth > MAX_CLIPBOARD_DEPTH) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.text !== 'string') return null;

  counter.count += 1;
  if (counter.count > MAX_CLIPBOARD_NODES) return null;

  const children = Array.isArray(source.children)
    ? source.children
        .map((child) => sanitizeNode(child, depth + 1, counter))
        .filter((child): child is MindMapNode => child !== null)
    : [];

  const node: MindMapNode = {
    id: typeof source.id === 'string' && source.id ? source.id : `node_${nanoid(10)}`,
    text: source.text,
    children,
  };
  if (typeof source.note === 'string' && source.note) node.note = source.note;
  if (typeof source.collapsed === 'boolean') node.collapsed = source.collapsed;
  if (typeof source.completed === 'boolean') node.completed = source.completed;
  const style = sanitizeStyle(source.style);
  if (style) node.style = style;
  const blankedRanges = sanitizeBlankedRanges(source.blankedRanges);
  if (blankedRanges) node.blankedRanges = blankedRanges;
  const refs = sanitizeRefs(source.refs);
  if (refs) node.refs = refs;
  return node;
}

function sanitizeForest(nodes: unknown): MindMapNode[] {
  if (!Array.isArray(nodes)) return [];
  const counter = { count: 0 };
  return nodes
    .map((node) => sanitizeNode(node, 0, counter))
    .filter((node): node is MindMapNode => node !== null);
}

// ============================================================================
// 编码 / 解码
// ============================================================================

/** 校验并归一化外来载荷；不合法返回 null */
export function parseMindMapClipboardPayload(raw: unknown): MindMapClipboardPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (source.format !== MINDMAP_CLIPBOARD_FORMAT) return null;
  if (source.version !== MINDMAP_CLIPBOARD_VERSION) return null;
  if (typeof source.fingerprint !== 'string') return null;
  const nodes = sanitizeForest(source.nodes);
  if (nodes.length === 0) return null;
  return {
    format: MINDMAP_CLIPBOARD_FORMAT,
    version: MINDMAP_CLIPBOARD_VERSION,
    copiedAt: typeof source.copiedAt === 'number' ? source.copiedAt : 0,
    fingerprint: source.fingerprint,
    nodes,
  };
}

/** 把节点森林编码为「文本 + 结构化载荷」双载体；森林为空返回 null */
export function encodeMindMapClipboard(
  nodes: MindMapNode[],
): { text: string; payload: MindMapClipboardPayload } | null {
  const sanitized = sanitizeForest(nodes);
  if (sanitized.length === 0) return null;
  const text = nodesToMarkdown(sanitized);
  return {
    text,
    payload: {
      format: MINDMAP_CLIPBOARD_FORMAT,
      version: MINDMAP_CLIPBOARD_VERSION,
      copiedAt: Date.now(),
      fingerprint: hashText(text),
      nodes: sanitized,
    },
  };
}

// ============================================================================
// localStorage 侧车
// ============================================================================

function saveSidecar(payload: MindMapClipboardPayload): void {
  try {
    localStorage.setItem(SIDECAR_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 超出配额等异常：清掉旧侧车，避免残留（指纹机制本身也能兜底）
    try {
      localStorage.removeItem(SIDECAR_STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
  }
}

function loadSidecar(): MindMapClipboardPayload | null {
  try {
    const raw = localStorage.getItem(SIDECAR_STORAGE_KEY);
    if (!raw) return null;
    return parseMindMapClipboardPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ============================================================================
// 系统剪贴板读写
// ============================================================================

/**
 * 写入系统剪贴板（text/plain + 结构化 JSON）并落侧车。
 * 返回写入的指纹与时间戳供调用方记录；森林为空返回 null。
 * 全部写入失败时不抛错（侧车仍可支撑应用内结构化粘贴）。
 */
export async function writeMindMapClipboard(
  nodes: MindMapNode[],
): Promise<{ fingerprint: string; copiedAt: number } | null> {
  const encoded = encodeMindMapClipboard(nodes);
  if (!encoded) return null;

  saveSidecar(encoded.payload);

  const json = JSON.stringify(encoded.payload);
  let wroteRich = false;
  if (typeof ClipboardItem !== 'undefined' && navigator?.clipboard?.write) {
    // Chromium 要求自定义格式带 `web ` 前缀，WebKit 两种都可能拒绝；逐个尝试
    for (const mime of [MINDMAP_CLIPBOARD_MIME, `web ${MINDMAP_CLIPBOARD_MIME}`]) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([encoded.text], { type: 'text/plain' }),
            // Blob 自身的 type 保持裸 MIME；`web ` 前缀只出现在条目键名上（Chromium 约定）
            [mime]: new Blob([json], { type: MINDMAP_CLIPBOARD_MIME }),
          }),
        ]);
        wroteRich = true;
        break;
      } catch {
        /* 该 MIME 不被支持，继续降级 */
      }
    }
  }

  if (!wroteRich) {
    try {
      await copyTextToClipboard(encoded.text);
    } catch {
      /* 权限被拒：侧车仍可支撑应用内粘贴 */
    }
  }

  return { fingerprint: encoded.payload.fingerprint, copiedAt: encoded.payload.copiedAt };
}

/** 通过 navigator.clipboard.read 尝试读取富格式（自定义 MIME / HTML / 纯文本） */
async function readRichClipboard(): Promise<{
  payload: MindMapClipboardPayload | null;
  html: string | null;
  text: string | null;
}> {
  const result: { payload: MindMapClipboardPayload | null; html: string | null; text: string | null } = {
    payload: null,
    html: null,
    text: null,
  };
  if (!navigator?.clipboard?.read) return result;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const mime of [MINDMAP_CLIPBOARD_MIME, `web ${MINDMAP_CLIPBOARD_MIME}`]) {
        if (!result.payload && item.types.includes(mime)) {
          try {
            const raw = await (await item.getType(mime)).text();
            result.payload = parseMindMapClipboardPayload(JSON.parse(raw));
          } catch {
            /* 载荷损坏：忽略，走文本路径 */
          }
        }
      }
      if (!result.html && item.types.includes('text/html')) {
        try {
          result.html = await (await item.getType('text/html')).text();
        } catch {
          /* 忽略 */
        }
      }
      if (!result.text && item.types.includes('text/plain')) {
        try {
          result.text = await (await item.getType('text/plain')).text();
        } catch {
          /* 忽略 */
        }
      }
    }
  } catch {
    /* WebView 无权限或不支持 read()：走 Tauri 插件纯文本路径 */
  }
  return result;
}

/**
 * 读取系统剪贴板并归一化为粘贴决策所需的结果，优先级：
 * 1. 自定义 MIME 结构化载荷（浏览器 / 支持富剪贴板的环境）；
 * 2. localStorage 侧车（指纹须与当前系统剪贴板文本一致，Tauri 主通道）；
 * 3. text/html 大纲结构（Word / 网页 / 幕布网页版复制）；
 * 4. Markdown 列表文本；
 * 5. 普通多行文本。
 */
export async function readMindMapClipboard(): Promise<MindMapClipboardRead> {
  const rich = await readRichClipboard();
  if (rich.payload) {
    return { kind: 'structured', payload: rich.payload, text: rich.text };
  }

  let text = rich.text;
  if (text === null) {
    try {
      text = await readTextFromClipboard();
    } catch {
      text = null;
    }
  }
  if (!text?.trim()) return { kind: 'empty', text: null };

  const sidecar = loadSidecar();
  if (sidecar && sidecar.fingerprint === hashText(text)) {
    return { kind: 'structured', payload: sidecar, text };
  }

  if (rich.html) {
    const markdown = htmlOutlineToMarkdown(rich.html);
    if (markdown) return { kind: 'markdown', markdown, text };
  }

  if (looksLikeMarkdownList(text)) {
    return { kind: 'markdown', markdown: text, text };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { kind: 'empty', text: null };
  return { kind: 'lines', lines, text };
}
