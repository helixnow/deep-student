/**
 * Chat V2 - 插件导出
 *
 * 导入此文件会自动注册所有内置插件
 */

// 导入即注册（自执行）
import './blocks';
import './modes';
import './events';
import { installOfficialChatUiPluginWhenReady } from './official';

// 主窗口的 UI 内核就绪后，由官方聊天 UI 插件经内核认领上面这些内置条目（见 official.ts）
installOfficialChatUiPluginWhenReady();

// 重导出
export { OFFICIAL_CHAT_UI_PLUGIN_ID, officialChatUiPlugin, installOfficialChatUiPlugin } from './official';
export * from './blocks';
export * from './modes';
export * from './events';
