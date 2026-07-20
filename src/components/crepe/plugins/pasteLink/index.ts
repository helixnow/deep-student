/**
 * 粘贴 URL 智能链接（简洁风格）
 *
 * 使用：`crepe.editor.use(pasteLinkPlugin())`（须在 create 前；见 docs/revamp/05-paste-link.md）
 */

export { pasteLinkPlugin, pasteLinkKey, handlePasteUrl, createPasteLinkProsePluginForTest } from './pasteLinkPlugin';
export { isSinglePasteUrl, normalizePasteHref } from './isSinglePasteUrl';
export { applyPasteUrlLink, shouldSkipPasteLinkContext } from './applyPasteUrlLink';
