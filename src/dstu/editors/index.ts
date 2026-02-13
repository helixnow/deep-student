/**
 * DSTU 编辑器包装组件统一导出
 *
 * 这些组件将现有的编辑器/查看器包装为符合 DSTU EditorProps 接口的组件。
 * 当前实现为占位组件，等待 VFS 后端完成后将连接到实际组件。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

// 笔记编辑器
export { NoteEditorWrapper } from './NoteEditorWrapper';

// PDF 查看器（教材）
export { PDFViewerWrapper } from './PDFViewerWrapper';

// 题目集编辑器
export { ExamEditorWrapper } from './ExamEditorWrapper';

// 翻译查看器
export { TranslationViewerWrapper } from './TranslationViewerWrapper';

// 作文编辑器
export { EssayEditorWrapper } from './EssayEditorWrapper';

// 图片查看器
export { ImageViewerWrapper } from './ImageViewerWrapper';

// 通用文件查看器
export { FileViewerWrapper } from './FileViewerWrapper';

// 知识导图编辑器
export { MindMapEditorWrapper } from './MindMapEditorWrapper';
