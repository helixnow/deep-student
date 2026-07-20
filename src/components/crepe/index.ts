/**
 * Crepe 编辑器模块导出
 *
 * 已废弃的 useCrepeEditor Hook 不再对外导出（生产请用 <CrepeEditor>）；
 * createAgentInsertTransaction 仍由 ./useCrepeEditor 内部提供给组件与测试。
 */

export { CrepeEditor, default } from './CrepeEditor';
export type { CrepeEditorApi, CrepeEditorProps, ImageUploadConfig } from './types';
export { createImageUploader, createImageBlockConfig, fileToBase64 } from './features/imageUpload';
export { createMermaidObserver, renderMermaidDiagram, scanAndRenderMermaidBlocks } from './features/mermaidPreview';
export { applyCrepePlugins, defaultPluginOptions } from './plugins';
export type { CrepePluginsOptions } from './plugins';
