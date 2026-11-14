/**
 * VFS 解引用：移植 `chat_v2/vfs_resolver.rs`。
 *
 * 实现按职责拆分在 `src/vfs-resolver/`：模型/纯函数、PDF 与教材、题目集、
 * 笔记/作文/翻译/导图/灵感卡、图片/文档/PDF 资产读取。本文件保留原有导入路径。
 */
export * from './vfs-resolver/index.ts';
