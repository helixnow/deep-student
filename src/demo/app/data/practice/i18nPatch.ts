/**
 * 题目集 / 制卡演示启动时会求值几条别的命名空间里的文案（模块初始化或下拉占位），
 * 为它们下载整个 settings（150KB）/ mindmap / chat_host 命名空间不值得，只补这几条。
 */
import { tr } from '../../../lang';

export async function patchPracticeStrings(): Promise<void> {
  const { default: i18n } = await import('@/i18n');
  const add = (ns: string, key: string, zh: string, en: string) => {
    if (!i18n.exists(`${ns}:${key}`)) i18n.addResource(i18n.language, ns, key, tr(zh, en));
  };
  add('settings', 'mcp_server_list.builtinServerName', '内置工具', 'Built-in Tools');
  add('mindmap', 'placeholder.root', '中心主题', 'Central Topic');
  add('chat_host', 'model_panel.search_placeholder', '搜索名称或模型 ID…', 'Search by name or model ID...');
}
