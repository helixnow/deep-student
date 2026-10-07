/**
 * 几条零散文案属于整包很大的命名空间：MCP 内置服务器名（settings）、导图根节点占位
 * （mindmap）、「新建学习笔记…」菜单与对话框（notes）。只补这几条键，免得为它们下整个命名空间。
 */
import { demoLang, tr } from '../../../lang';

const LEARNING_CREATE_ZH = {
  "title": "新建学习笔记",
  "name": "笔记标题",
  "course": "所属课程",
  "template": "新建模板",
  "blank": "空白笔记",
  "default": "课程默认：{{title}}",
  "hint": "课程默认仅在选择后应用，已填写的属性优先保留。",
  "submit": "创建笔记",
  "cancel": "取消新建",
  "retry_props": "重试保存属性",
  "open_partial": "打开已创建笔记",
  "props_failed": "笔记正文已创建，属性尚未保存：{{error}}",
  "invalid_title": "请输入有效的笔记标题。",
  "menu": "新建学习笔记…"
};

const LEARNING_CREATE_EN = {
  "title": "New learning note",
  "name": "Note title",
  "course": "Course",
  "template": "Template for new note",
  "blank": "Blank note",
  "default": "Course default: {{title}}",
  "hint": "The course default is applied only when selected. Properties you have entered take priority.",
  "submit": "Create note",
  "cancel": "Cancel creation",
  "retry_props": "Retry saving properties",
  "open_partial": "Open created note",
  "props_failed": "The note content was created, but its properties have not been saved: {{error}}",
  "invalid_title": "Enter a valid note title.",
  "menu": "New learning note…"
};

export async function patchLibraryI18n(): Promise<void> {
  const { default: i18n } = await import('@/i18n');
  i18n.addResourceBundle(demoLang, 'settings', { mcp_server_list: { builtinServerName: tr('内置工具', 'Built-in Tools') } }, true, false);
  i18n.addResourceBundle(demoLang, 'notes', { learning: { create: demoLang === 'en-US' ? LEARNING_CREATE_EN : LEARNING_CREATE_ZH } }, true, false);
  i18n.addResourceBundle(demoLang, 'mindmap', { placeholder: { root: tr('中心主题', 'Central Topic') } }, true, false);
}
