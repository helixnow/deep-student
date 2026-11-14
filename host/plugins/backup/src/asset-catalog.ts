/** `AssetType::all()` 的顺序与显示信息（assets.rs:113-219）。 */
export const catalog = [
  ['images', '图片', 0], ['notes_assets', '笔记附件', 0], ['documents', '文档', 0],
  ['vfs_blobs', 'VFS 存储', 0], ['subjects', '学科资源', 0], ['workspaces', '工作空间', 0],
  ['audio', '音频', 1], ['videos', '视频', 1], ['textbooks', '教材', 0], ['pdf_ocr_sessions', 'PDF/OCR 会话文件', 0],
] as const;

export type AssetType = typeof catalog[number][0];
