/**
 * 压缩包清单标记契约
 *
 * 识别走语言中立的机器标记 [#archive-manifest]（首行，展示时剥除），
 * 不再依赖硬编码中文前缀；历史数据的 [压缩包清单] 前缀仅做只读兼容。
 * 标记常量必须与 Rust attachment_repo::ARCHIVE_MANIFEST_MARKER 严格对齐。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ARCHIVE_MANIFEST_MARKER,
  archiveManifestDisplayText,
  isArchiveManifestText,
} from '@/features/learning-hub/apps/views/archiveManifest';

describe('archive manifest marker', () => {
  it('recognizes the language-neutral machine marker', () => {
    expect(isArchiveManifestText(`${ARCHIVE_MANIFEST_MARKER}\n3 entries`)).toBe(true);
  });

  it('keeps read-only compatibility with the legacy Chinese prefix', () => {
    expect(isArchiveManifestText('[压缩包清单] 共 3 个条目')).toBe(true);
  });

  it('rejects unrelated placeholder/inline text', () => {
    expect(isArchiveManifestText('[文档: report.pdf]')).toBe(false);
    expect(isArchiveManifestText('plain extracted text')).toBe(false);
    expect(isArchiveManifestText(`${ARCHIVE_MANIFEST_MARKER}-lookalike`)).toBe(false);
    expect(isArchiveManifestText(`${ARCHIVE_MANIFEST_MARKER} inline text`)).toBe(false);
  });

  it('strips the marker line for display; legacy text passes through unchanged', () => {
    expect(archiveManifestDisplayText(`${ARCHIVE_MANIFEST_MARKER}\nline1\nline2`)).toBe(
      'line1\nline2',
    );
    expect(archiveManifestDisplayText(`${ARCHIVE_MANIFEST_MARKER}\r\nline1\r\nline2`)).toBe(
      'line1\r\nline2',
    );
    expect(archiveManifestDisplayText('[压缩包清单] 共 3 个条目')).toBe('[压缩包清单] 共 3 个条目');
    expect(archiveManifestDisplayText(ARCHIVE_MANIFEST_MARKER)).toBe('');
    expect(archiveManifestDisplayText(`${ARCHIVE_MANIFEST_MARKER} inline text`)).toBe(
      `${ARCHIVE_MANIFEST_MARKER} inline text`,
    );
  });

  it('stays aligned with the Rust-side marker and manifest builder', () => {
    const rust = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/vfs/repos/attachment_repo.rs'),
      'utf-8',
    );
    expect(rust).toContain(`ARCHIVE_MANIFEST_MARKER: &str = "${ARCHIVE_MANIFEST_MARKER}"`);
    // 首行必须写入机器标记（前端识别用）
    expect(rust).toContain('lines.push(ARCHIVE_MANIFEST_MARKER.to_string())');
  });
});
