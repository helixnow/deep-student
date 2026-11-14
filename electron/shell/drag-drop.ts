/**
 * 外部文件拖放消息的校验（SEC-E10）。
 *
 * drop 会把路径加入 fs / asset 作用域（tauri manager/window.rs），消息却来自渲染进程：正常只有隔离世界的 preload
 * 能发（页面拿不到 transport，JS 构造的 `File` 也取不到磁盘路径），这里是渲染进程被攻破时的纵深防御。
 * main 只在窗口开启 `dragDropEnabled`、消息来自顶层 frame（子 frame 不运行 preload）时接受；路径必须是真实存在的
 * 本平台绝对路径，数量有上限。被拒的路径既不加作用域，也不发给页面。
 */
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** 一次拖放的路径上限；超过时整条消息作废（Tauri 的路径来自系统拖放，没有这种消息）。 */
export const MAX_DROPPED_PATHS = 10_000;
/** Windows 长路径上限（UTF-16 码元）；POSIX 的 PATH_MAX 更小，超长路径 stat 本来也会失败。 */
export const MAX_DROPPED_PATH_LENGTH = 32_767;

const PHASES = new Set(['enter', 'over', 'drop', 'leave']);

export type DragDropPhase = 'enter' | 'over' | 'drop' | 'leave';

export interface DroppedPath {
  path: string;
  directory: boolean;
}

export type DragDropCheck =
  | { accept: false; reason: string }
  | { accept: true; phase: DragDropPhase; position: { x: number; y: number } | undefined; paths: DroppedPath[]; rejected: unknown[] };

export interface DragDropContext {
  /** 窗口配置 `dragDropEnabled`。 */
  dragDropEnabled: boolean;
  /** 消息来自顶层 frame（`event.senderFrame.parent === null`）。 */
  topFrame: boolean;
  platform: NodeJS.Platform;
  /** 测试注入；返回 undefined 表示路径不存在或不可访问。 */
  stat?: (path: string) => { isDirectory(): boolean } | undefined;
}

const defaultStat = (path: string) => {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function checkDragDrop(message: { phase?: unknown; paths?: unknown; position?: unknown }, context: DragDropContext): DragDropCheck {
  if (!context.dragDropEnabled) return { accept: false, reason: 'drag and drop is disabled for this window' };
  if (!context.topFrame) return { accept: false, reason: 'not sent by the top-level frame' };
  const { phase } = message;
  if (typeof phase !== 'string' || !PHASES.has(phase)) return { accept: false, reason: `unknown phase ${JSON.stringify(phase)}` };
  let position: { x: number; y: number } | undefined;
  if (message.position !== undefined) {
    const { x, y } = (message.position ?? {}) as { x?: unknown; y?: unknown };
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return { accept: false, reason: 'malformed position' };
    position = { x, y };
  }
  const paths: DroppedPath[] = [];
  const rejected: unknown[] = [];
  if (phase === 'enter' || phase === 'drop') {
    const raw = message.paths ?? [];
    if (!Array.isArray(raw)) return { accept: false, reason: 'paths is not an array' };
    if (raw.length > MAX_DROPPED_PATHS) return { accept: false, reason: `${raw.length} paths exceed the limit of ${MAX_DROPPED_PATHS}` };
    // Windows：`\foo` 也算 isAbsolute（相对当前盘符），系统拖放给的总是盘符或 UNC 开头的完整路径。
    const isAbsolute = context.platform === 'win32'
      ? (path: string) => win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(path)
      : posix.isAbsolute;
    const stat = context.stat ?? defaultStat;
    for (const path of raw) {
      const info = typeof path === 'string' && path.length <= MAX_DROPPED_PATH_LENGTH && !path.includes('\0') && isAbsolute(path)
        ? stat(path)
        : undefined;
      if (info === undefined) rejected.push(path);
      else paths.push({ path, directory: info.isDirectory() });
    }
  }
  return { accept: true, phase: phase as DragDropPhase, position, paths, rejected };
}
