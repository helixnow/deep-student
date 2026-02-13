import { getToolDisplayNameKey } from '@/mcp/builtinMcpServer';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

const ZH_TOKEN_MAP: Record<string, string> = {
  tools: '',
  tool: '工具',
  template: '模板',
  fork: '复制',
  get: '获取',
  create: '创建',
  update: '更新',
  list: '列表',
  read: '读取',
  write: '写入',
  delete: '删除',
  search: '搜索',
  add: '添加',
  set: '设置',
  replace: '替换',
  submit: '提交',
  answer: '答案',
  question: '题目',
  questions: '题目',
  qbank: '题库',
  memory: '记忆',
  resource: '资源',
  resources: '资源',
  web: '网络',
  fetch: '抓取',
  knowledge: '知识',
  extract: '提取',
  internalize: '内化',
  workspace: '工作区',
  query: '查询',
  send: '发送',
  context: '上下文',
  document: '文档',
  documents: '文档',
  load: '加载',
  skills: '技能',
  multimodal: '多模态',
  rag: '知识库',
  unified: '统一',
  todo: '待办',
  init: '初始化',
  stats: '统计',
  next: '下一',
  batch: '批量',
  import: '导入',
  export: '导出',
  mindmap: '知识导图',
  edit: '编辑',
  nodes: '节点',
  node: '节点',
  folder: '文件夹',
  move: '移动',
  rename: '重命名',
  save: '保存',
  open: '打开',
  close: '关闭',
  copy: '复制',
  paste: '粘贴',
  remove: '移除',
  analyze: '分析',
  generate: '生成',
  convert: '转换',
  upload: '上传',
  download: '下载',
  preview: '预览',
  parse: '解析',
  check: '检查',
  review: '回顾',
  summarize: '总结',
  translate: '翻译',
  explain: '讲解',
  practice: '练习',
  grading: '评分',
  grade: '评分',
  card: '卡片',
  cards: '卡片',
  anki: 'Anki',
  chat: '对话',
  title: '标题',
  tag: '标签',
  tags: '标签',
  file: '文件',
  files: '文件',
  image: '图片',
  images: '图片',
  ocr: 'OCR',
  content: '内容',
  note: '笔记',
  notes: '笔记',
  ask: '提问',
  user: '用户',
};

/**
 * 将工具注册名（如 tools.template_fork）转换为可读名称（如 Tools / Template Fork）。
 */
export function humanizeToolName(toolName: string): string {
  if (!toolName) return toolName;

  const normalized = toolName
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '');

  const segments = normalized
    .split(/[.:/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) return toolName;

  const prettySegments = segments.map((segment) => {
    const withWordBoundaries = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return withWordBoundaries
      .split(/[_-\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  });

  return prettySegments.join(' / ');
}

/**
 * 中文环境兜底：尽量把注册名映射成中文可读短语。
 */
export function humanizeToolNameZh(toolName: string): string {
  if (!toolName) return toolName;

  const normalized = toolName
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '');

  const segments = normalized
    .split(/[.:/]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment !== 'tools');

  if (segments.length === 0) return toolName;

  const localizedSegments = segments.map((segment) => {
    const withWordBoundaries = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    const words = withWordBoundaries
      .split(/[_-\s]+/)
      .map((word) => word.trim())
      .filter(Boolean);

    const translated = words
      .map((word) => {
        const lower = word.toLowerCase();
        return ZH_TOKEN_MAP[lower] ?? word;
      })
      .filter(Boolean)
      .join('');

    return translated || segment;
  });

  return localizedSegments.join(' / ');
}

function resolveToolDisplayNameKey(toolName: string): string | undefined {
  if (toolName.startsWith('tools.')) {
    return toolName;
  }
  return getToolDisplayNameKey(toolName);
}

function isChineseLocale(t: TranslateFn): boolean {
  const i18n = (t as TranslateFn & { i18n?: { resolvedLanguage?: string; language?: string } }).i18n;
  const lang = i18n?.resolvedLanguage || i18n?.language || '';
  return lang.toLowerCase().startsWith('zh');
}

/**
 * 统一解析工具可读名称：优先 i18n，其次对注册名做可读化转换。
 */
export function getReadableToolName(toolName: string, t: TranslateFn): string {
  const displayNameKey = resolveToolDisplayNameKey(toolName);
  if (displayNameKey) {
    const translated = t(displayNameKey, { ns: 'mcp', defaultValue: '' });
    if (translated) {
      return translated;
    }
  }

  if (isChineseLocale(t)) {
    return humanizeToolNameZh(toolName);
  }

  return humanizeToolName(toolName);
}
