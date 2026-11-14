/**
 * `src/commands.rs:2109 get_enhanced_statistics`：
 * `dstu-storage/src/file_manager.rs:745 get_image_statistics` 的等价实现。
 *
 * 只统计 `app_data_dir/images` 目录下的普通文件（不递归），按扩展名计数；
 * 时间戳取文件修改时间（Unix 秒，纪元前按 0 处理）。Rust 用 `chrono::Utc::now()
 * .to_rfc3339()` 生成响应时间戳，这里复用 F4 的 chrono 兼容格式化。
 * 文件访问走 `ctx.files`（桌面 Node 实现、移动端 OPFS 实现）。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { FileStat, FilesService } from '../../../platform/files/api.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';

export type ImageStatisticsFiles = Pick<FilesService, 'exists' | 'readDir' | 'stat'>;

export interface ImageStatistics {
  total_files: number;
  total_size_bytes: number;
  file_types: Record<string, number>;
  oldest_file: number | null;
  newest_file: number | null;
}

export interface EnhancedStatistics {
  image_stats: ImageStatistics;
  timestamp: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust `Path::extension`：无 `.`、或只有开头一个 `.` 时为 None；`a.` 为 `Some("")`。 */
function rustExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? null : name.slice(dot + 1);
}

/** `FileManager::get_image_statistics`。 */
export async function getImageStatistics(files: ImageStatisticsFiles, imagesDir: string): Promise<ImageStatistics> {
  const stats: ImageStatistics = {
    total_files: 0,
    total_size_bytes: 0,
    file_types: {},
    oldest_file: null,
    newest_file: null,
  };

  let exists = false;
  try {
    exists = await files.exists(imagesDir);
  } catch (error) {
    throw AppError.file_system(`检查图片目录存在性失败: ${errorText(error)}`);
  }
  if (!exists) return stats;

  let entries: Awaited<ReturnType<ImageStatisticsFiles['readDir']>>;
  try {
    entries = await files.readDir(imagesDir);
  } catch (error) {
    throw AppError.file_system(`读取图片目录失败: ${errorText(error)}`);
  }

  for (const entry of entries) {
    // Rust `path.is_file()` 跟随符号链接，读取失败时返回 false，不产生错误。
    let isFile = false;
    try {
      isFile = (await files.stat(entry.path)).kind === 'file';
    } catch {
      isFile = false;
    }
    if (!isFile) continue;

    let metadata: FileStat;
    try {
      metadata = await files.stat(entry.path);
    } catch (error) {
      throw AppError.file_system(`获取文件元数据失败: ${errorText(error)}`);
    }

    stats.total_files += 1;
    stats.total_size_bytes += metadata.size;

    const extension = rustExtension(entry.name);
    if (extension !== null) {
      const key = extension.toLowerCase();
      stats.file_types[key] = (stats.file_types[key] ?? 0) + 1;
    }

    // Rust `duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()`。
    const modified = Math.max(0, Math.floor(metadata.modifiedMs / 1000));
    if (stats.oldest_file === null || modified < stats.oldest_file) {
      stats.oldest_file = modified;
    }
    if (stats.newest_file === null || modified > stats.newest_file) {
      stats.newest_file = modified;
    }
  }

  return stats;
}

/** `get_enhanced_statistics`：图片统计 + 响应时间戳。 */
export async function getEnhancedStatistics(files: ImageStatisticsFiles, imagesDir: string): Promise<EnhancedStatistics> {
  return {
    image_stats: await getImageStatistics(files, imagesDir),
    timestamp: chronoRfc3339(),
  };
}
