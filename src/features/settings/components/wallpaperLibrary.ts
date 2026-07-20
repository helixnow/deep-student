/**
 * 壁纸库数据层
 * ---------------------------------------------------------------------------
 * 托管目录 = appDataDir/workbench-wallpapers/，目录内容即壁纸库清单（无独立 manifest）。
 * 与旧版 customWallpaperImport 的差异：导入不再清理其他文件（多张共存），
 * 删除是显式操作且校验路径必须位于托管目录内（文件名还须通过托管命名/扩展名
 * 白名单，天然挡掉 `..`、子路径与非图片条目）。
 */
import { appDataDir, join } from '@tauri-apps/api/path';
import { copyFile, mkdir, readDir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';

import { extractFileExtension, fileManager } from '@/utils/fileManager';

export const CUSTOM_WALLPAPER_DIRECTORY = 'workbench-wallpapers';
export const CUSTOM_WALLPAPER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const;
/** 壁纸库容量上限（防止托管目录无限膨胀） */
export const CUSTOM_WALLPAPER_LIBRARY_LIMIT = 24;

/**
 * 降采样目标长边的下限/上限（物理像素）。
 * 下限 2560 保证低分屏用户导入后仍有余量应对外接高分屏；
 * 上限 4096 是常见 GPU 纹理安全尺寸，超过它对壁纸场景已无视觉收益，
 * 反而让 WebView 解码/blur 合成的开销随像素数线性膨胀。
 */
export const WALLPAPER_MAX_EDGE_FLOOR = 2560;
export const WALLPAPER_MAX_EDGE_CEIL = 4096;
/** 屏幕物理分辨率之上再留 1.5 倍余量，避免轻微超出就触发有损重编码 */
export const WALLPAPER_MAX_EDGE_MARGIN = 1.5;
/** 重编码质量（webp/jpeg 共用）：0.9 在壁纸场景下肉眼基本无损且体积可控 */
const WALLPAPER_REENCODE_QUALITY = 0.9;

export interface CustomWallpaperEntry {
  /** 托管目录内的绝对路径（可直接作为 WallpaperConfig.value） */
  path: string;
  /** 文件名（wallpaper-<uuid>.<ext>） */
  fileName: string;
}

export type WallpaperLibraryImportResult =
  | { status: 'cancelled' }
  | { status: 'success'; entry: CustomWallpaperEntry }
  | { status: 'limit-exceeded'; limit: number }
  | { status: 'error'; error: unknown };

async function resolveManagedDirectory(): Promise<string> {
  return join(await appDataDir(), CUSTOM_WALLPAPER_DIRECTORY);
}

function createManagedFileName(extension: string): string {
  return `wallpaper-${crypto.randomUUID()}.${extension}`;
}

function isManagedFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  const extension = extractFileExtension(name);
  return (CUSTOM_WALLPAPER_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * 计算降采样目标尺寸（纯函数，便于单测）。
 * 只在长边超过 maxEdge 时等比缩小；不超限时原样返回，避免无谓的重采样。
 */
export function computeTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  maxEdge: number,
): { width: number; height: number; shouldResize: boolean } {
  // 非法输入（0/负数/NaN）一律视为"不缩放"，由调用方退回原样复制
  if (!Number.isFinite(srcWidth) || !Number.isFinite(srcHeight) || srcWidth <= 0 || srcHeight <= 0 || !Number.isFinite(maxEdge) || maxEdge <= 0) {
    return { width: srcWidth, height: srcHeight, shouldResize: false };
  }
  const longEdge = Math.max(srcWidth, srcHeight);
  if (longEdge <= maxEdge) {
    return { width: srcWidth, height: srcHeight, shouldResize: false };
  }
  const scale = maxEdge / longEdge;
  return {
    // 至少 1px，防止极端长条图（如 1x100000）短边被舍入成 0 导致 canvas 报错
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
    shouldResize: true,
  };
}

/**
 * 决定某扩展名是否走"降采样/重编码"路径（纯函数，便于单测）。
 * - gif 可能是动图，canvas 重编码会丢帧，永远原样复制；
 * - bmp 无压缩、体积巨大，即使尺寸不超限也强制转 webp/jpeg；
 * - 其余格式仅在尺寸超限时重编码，避免无谓的质量损失。
 */
export function shouldReencodeWallpaper(extension: string, exceedsLimit: boolean): boolean {
  if (extension === 'gif') return false;
  if (extension === 'bmp') return true;
  return exceedsLimit;
}

/**
 * 计算当前环境的降采样长边上限（物理像素）：
 * max(屏宽, 屏高) * devicePixelRatio * 1.5 余量，再夹到 [2560, 4096]。
 * 参数可注入，便于在无 window 的测试环境中验证夹取逻辑。
 */
export function resolveWallpaperMaxEdge(env?: {
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
}): number {
  const screenWidth = env?.screenWidth ?? (typeof screen !== 'undefined' ? screen.width : 0);
  const screenHeight = env?.screenHeight ?? (typeof screen !== 'undefined' ? screen.height : 0);
  const dpr =
    env?.devicePixelRatio ??
    (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1);
  const raw = Math.max(screenWidth, screenHeight) * Math.max(dpr, 1) * WALLPAPER_MAX_EDGE_MARGIN;
  return Math.round(Math.min(WALLPAPER_MAX_EDGE_CEIL, Math.max(WALLPAPER_MAX_EDGE_FLOOR, raw)));
}

/** 把解码后的位图缩放绘制到 canvas 并重编码；不支持 webp 编码时退回 jpeg */
async function encodeBitmapToBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<{ blob: Blob; extension: 'webp' | 'jpg' } | null> {
  let drawTarget: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') {
    drawTarget = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    drawTarget = canvas;
  } else {
    return null;
  }
  const context = drawTarget.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!context) return null;
  // 高质量重采样，缩小比例较大时能明显减少摩尔纹
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);

  const encode = async (type: string): Promise<Blob | null> => {
    try {
      if ('convertToBlob' in drawTarget) {
        return await drawTarget.convertToBlob({ type, quality: WALLPAPER_REENCODE_QUALITY });
      }
      return await new Promise<Blob | null>((resolve) => {
        (drawTarget as HTMLCanvasElement).toBlob(resolve, type, WALLPAPER_REENCODE_QUALITY);
      });
    } catch {
      return null;
    }
  };

  // 平台不支持 webp 编码时，toBlob/convertToBlob 会静默退回 png（type 不匹配）
  // 或直接失败，此时改用 jpeg 兜底
  const webpBlob = await encode('image/webp');
  if (webpBlob && webpBlob.type === 'image/webp') {
    return { blob: webpBlob, extension: 'webp' };
  }
  const jpegBlob = await encode('image/jpeg');
  if (jpegBlob && jpegBlob.type === 'image/jpeg') {
    return { blob: jpegBlob, extension: 'jpg' };
  }
  return null;
}

/**
 * 尝试对源图片做降采样 + 重编码后写入托管目录。
 * 返回 null 表示应退回"原样 copyFile"路径（不满足条件、环境不支持或任一步失败），
 * 绝不向上抛异常——降采样只是优化，失败不能导致导入失败。
 */
async function tryImportDownsampled(
  sourcePath: string,
  extension: string,
  managedDirectory: string,
): Promise<CustomWallpaperEntry | null> {
  // gif 动图必须原样保留；vitest（jsdom/node）等环境没有 createImageBitmap，直接跳过
  if (extension === 'gif' || typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    const bytes = await readFile(sourcePath);
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const maxEdge = resolveWallpaperMaxEdge();
    const target = computeTargetDimensions(bitmap.width, bitmap.height, maxEdge);
    if (!shouldReencodeWallpaper(extension, target.shouldResize)) return null;

    const encoded = await encodeBitmapToBlob(bitmap, target.width, target.height);
    if (!encoded) return null;
    const fileName = createManagedFileName(encoded.extension);
    const stagedPath = await join(managedDirectory, fileName);
    await writeFile(stagedPath, new Uint8Array(await encoded.blob.arrayBuffer()));
    return { path: stagedPath, fileName };
  } catch (error) {
    console.warn('[wallpaperLibrary] downsample failed, falling back to raw copy:', error);
    return null;
  } finally {
    bitmap?.close();
  }
}

/** 列出壁纸库全部条目；目录不存在时返回空数组 */
export async function listCustomWallpapers(): Promise<CustomWallpaperEntry[]> {
  const managedDirectory = await resolveManagedDirectory();
  let entries;
  try {
    entries = await readDir(managedDirectory);
  } catch {
    return [];
  }
  const result: CustomWallpaperEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.name || !isManagedFileName(entry.name)) continue;
    result.push({ path: await join(managedDirectory, entry.name), fileName: entry.name });
  }
  return result;
}

/** 弹系统选择器导入一张图片到壁纸库（复制，不动源文件，不清理既有库存） */
export async function importWallpaperToLibrary(options?: {
  pickerTitle?: string;
}): Promise<WallpaperLibraryImportResult> {
  let selectedSource: string;
  try {
    const selected = await fileManager.pickSingleFile({
      title: options?.pickerTitle,
      directory: false,
      multiple: false,
      filters: [{ name: 'Images', extensions: [...CUSTOM_WALLPAPER_EXTENSIONS] }],
    });
    if (!selected) return { status: 'cancelled' };
    selectedSource = selected;
  } catch (error) {
    return { status: 'error', error };
  }

  const extension = extractFileExtension(selectedSource);
  if (!(CUSTOM_WALLPAPER_EXTENSIONS as readonly string[]).includes(extension)) {
    return { status: 'error', error: new Error('Unsupported wallpaper image type') };
  }

  try {
    const existing = await listCustomWallpapers();
    if (existing.length >= CUSTOM_WALLPAPER_LIBRARY_LIMIT) {
      return { status: 'limit-exceeded', limit: CUSTOM_WALLPAPER_LIBRARY_LIMIT };
    }
    const managedDirectory = await resolveManagedDirectory();
    await mkdir(managedDirectory, { recursive: true });
    // 优先尝试降采样 + 重编码（超大图会拖垮 WebView 的解码与全屏 blur 合成）；
    // 不满足条件或任一步失败时退回原样复制，导入本身不受影响
    const downsampled = await tryImportDownsampled(selectedSource, extension, managedDirectory);
    if (downsampled) {
      return { status: 'success', entry: downsampled };
    }
    const fileName = createManagedFileName(extension);
    const stagedPath = await join(managedDirectory, fileName);
    await copyFile(selectedSource, stagedPath);
    return { status: 'success', entry: { path: stagedPath, fileName } };
  } catch (error) {
    return { status: 'error', error };
  }
}

/** 删除库中一张壁纸；仅接受托管目录内的路径 */
export async function removeCustomWallpaper(path: string): Promise<void> {
  const managedDirectory = await resolveManagedDirectory();
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = normalize(managedDirectory);
  const target = normalize(path);
  // 前缀校验 + 文件名白名单：拒绝目录外路径、子路径、`.`/`..`（否则
  // `<dir>/..` 会通过纯前缀检查并删掉父目录）以及非图片扩展名条目。
  const fileName = target.startsWith(`${dir}/`) ? target.slice(dir.length + 1) : '';
  if (!isManagedFileName(fileName)) {
    throw new Error('Refusing to remove a file outside the managed wallpaper directory');
  }
  await remove(path);
}
