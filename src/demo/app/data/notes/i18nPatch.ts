/**
 * 导图 / 笔记窗口启动时会求值一条「设置」命名空间里的文案（内置 MCP 服务器名，界面上不显示）。
 * 为它下载整个 settings 命名空间（150KB）不值得，只补这一条。
 */
import { tr } from '../../../lang';

export async function patchSettingsStrings(): Promise<void> {
  const { default: i18n } = await import('@/i18n');
  i18n.addResource(i18n.language, 'settings', 'mcp_server_list.builtinServerName', tr('内置工具', 'Built-in Tools'));
}
