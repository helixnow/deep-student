/**
 * 笔记 / 导图窗口会零星用到几个大命名空间里的单条文案（内置 MCP 服务器名、选区工具条的
 * 「添加到聊天」等）。为一两条文案下载整个命名空间（上百 KB）不值得，这里只补这几条。
 */
import { tr } from '../../../lang';

const STRINGS: Array<[ns: string, key: string, zh: string, en: string]> = [
  ['settings', 'mcp_server_list.builtinServerName', '内置工具', 'Built-in Tools'],
  ['chatV2', 'selectionToolbar.addToChat', '添加到聊天', 'Add to chat'],
  // 内容区错误边界的兜底文案（渲染时就求值，平时不显示）
  ['learningHub', 'contextMenu.untitledNote', '无标题笔记', 'Untitled Note'],
  ['learningHub', 'resourceType.note', '笔记', 'Notes'],
  ['learningHub', 'resourceType.mindmap', '思维导图', 'Mind Maps'],
  ['learningHub', 'error.appContentCrashed', '{{resource}} 应用加载失败，请重试', '{{resource}} app failed to load. Please retry.'],
];

export async function patchSettingsStrings(): Promise<void> {
  const { default: i18n } = await import('@/i18n');
  for (const [ns, key, zh, en] of STRINGS) {
    if (!i18n.exists(`${ns}:${key}`)) i18n.addResource(i18n.language, ns, key, tr(zh, en));
  }
}
