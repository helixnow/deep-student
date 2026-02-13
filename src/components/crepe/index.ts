/**
 * Crepe 编辑器模块导出
 */

export { CrepeEditor, default } from './CrepeEditor';
export { useCrepeEditor } from './useCrepeEditor';
export type { CrepeEditorApi, CrepeEditorProps, ImageUploadConfig } from './types';
export type { UseCrepeEditorOptions, UseCrepeEditorReturn } from './useCrepeEditor';
export { createImageUploader, createImageBlockConfig, fileToBase64 } from './features/imageUpload';
export { createMermaidObserver, renderMermaidDiagram, scanAndRenderMermaidBlocks } from './features/mermaidPreview';
export { applyCrepePlugins, defaultPluginOptions } from './plugins';
export type { CrepePluginsOptions } from './plugins';
