/**
 * 第 20 章「AI 插件工坊与插件管理」的内存后端：
 * 展示 3 个真实学习场景的自制/社区插件（高数公式速查表、每日背词打卡、文献划词转 BibTeX），
 * 加上 5 组官方内置能力与微信 iLink Bot 渠道插件，让文档截图饱满直观。
 */
import type { DemoArgs } from '../../types';

const DEMO_PLUGINS = [
  {
    id: 'com.workshop.formula-sheet',
    origin: 'community',
    source: 'workshop',
    version: '1.2.0',
    platforms: ['desktop'],
    displayName: '高数公式速查表',
    description: '考研高数 / 线代常用积分、泰勒展开与微分中值定理速查小应用，支持按关键词秒搜并一键插入笔记。',
    author: 'AI 插件工坊',
    category: 'learning',
    trust: 'restricted',
    permissions: ['ui.views', 'clipboard.write'],
    enabled: true,
    state: 'running',
    consent: { matched: true },
    hasConfig: true,
    requiredBy: [],
    contributes: ['views'],
    agentTools: [],
  },
  {
    id: 'com.workshop.ebbinghaus-words',
    origin: 'community',
    source: 'workshop',
    version: '1.0.0',
    platforms: ['desktop'],
    displayName: '每日背词打卡',
    description: '按艾宾浩斯遗忘曲线安排每日四六级 / 考研核心词汇复习，自动统计连续坚持天数并生成周报。',
    author: 'AI 插件工坊',
    category: 'learning',
    trust: 'restricted',
    permissions: ['ui.views', 'agent.tools', 'storage.local'],
    enabled: true,
    state: 'running',
    consent: { matched: true },
    hasConfig: true,
    requiredBy: [],
    contributes: ['views', 'agent.tools'],
    agentTools: [{ name: 'log_vocab_streak', title: '记录今日背词打卡' }],
  },
  {
    id: 'com.community.bibtex-clipper',
    origin: 'community',
    source: 'package',
    version: '0.9.2',
    platforms: ['desktop'],
    displayName: '划词转 BibTeX 引用',
    description: '在 PDF 论文阅读器或笔记中选中参考文献条目，一键整理为标准 BibTeX 或 GB/T 7714 引文格式。',
    author: 'DeepStudent Community',
    category: 'resources',
    trust: 'restricted',
    permissions: ['editor.selectionToolbar'],
    enabled: true,
    state: 'running',
    consent: { matched: true },
    hasConfig: false,
    requiredBy: [],
    contributes: ['editor.selectionToolbar'],
    agentTools: [],
  },
  // 5 组官方内置能力代表项（category 与 presentation.ts 的 5 组完全一致）
  { id: 'dstu.notes', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: '双链笔记', description: 'Markdown 笔记编辑与反向链接', category: 'learning', enabled: true, state: 'running', hasConfig: false, requiredBy: [], contributes: ['views'] },
  { id: 'dstu.qbank', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: '题目集与错题本', description: 'AI 录题、9 种练习模式与自动判分', category: 'learning', enabled: true, state: 'running', hasConfig: false, requiredBy: [], contributes: ['views'] },
  { id: 'dstu.anki', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: 'Anki 制卡与同步', description: '对话式制卡、模板管理与 .apkg 导出', category: 'learning', enabled: true, state: 'running', hasConfig: false, requiredBy: [], contributes: ['views'] },
  { id: 'dstu.chat', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: '学习 Agent 对话', description: '多轮对话、生成式 UI 与分级审批', category: 'conversation', enabled: true, state: 'running', hasConfig: false, requiredBy: ['dstu.anki'], contributes: ['views'] },
  { id: 'dstu.memory', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: '长期智能记忆', description: '跨会话记忆提取与学习空间隔离', category: 'conversation', enabled: true, state: 'running', hasConfig: false, requiredBy: [], contributes: [] },
  { id: 'dstu.vfs', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: '学习资源库与索引', description: 'PDF / Word / EPUB 托管与向量检索', category: 'resources', enabled: true, state: 'running', hasConfig: false, requiredBy: ['dstu.chat'], contributes: ['views'] },
  { id: 'dstu.media', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: '音视频字幕陪学', description: '本地音视频转写与 B 站字幕导入', category: 'resources', enabled: true, state: 'running', hasConfig: false, requiredBy: [], contributes: ['views'] },
  { id: 'dstu.sync', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: 'Sync V5 云同步', description: 'WebDAV / S3 端到端加密同步与设备配对', category: 'integrations', enabled: true, state: 'running', hasConfig: false, requiredBy: [], contributes: [] },
  { id: 'dstu.mcp', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: 'MCP 工具协议', description: '连接外部工具服务器与权限管理', category: 'integrations', enabled: true, state: 'running', hasConfig: false, requiredBy: [], contributes: [] },
  { id: 'dstu.plugins', origin: 'builtin', source: 'builtin', version: '0.20.7', platforms: ['desktop', 'mobile'], displayName: 'Cordis 插件宿主', description: '插件生命周期、安全存储与事件总线', category: 'platform', enabled: true, state: 'running', hasConfig: false, requiredBy: ['dstu.chat', 'dstu.vfs'], contributes: [] },
];

const CHANNEL_PLUGINS = [
  {
    id: 'ilinkbot',
    label: '微信 iLink Bot',
    blurb: '通过官方 ClawBot / iLink 协议收发微信消息，并由本地 AI 自动回复。',
    kind: 'channel',
    state: 'stopped',
    enabled: false,
    configured: false,
    bound: false,
  },
];

export function handleDemoPlugins(cmd: string, _args: DemoArgs): unknown {
  switch (cmd) {
    case 'plugin:manager|list':
      return { revision: 'demo-plugins-1', safeMode: false, plugins: DEMO_PLUGINS };
    case 'plugin_list':
      return CHANNEL_PLUGINS;
    case 'plugin_get_status':
      return { state: 'stopped', enabled: false, configured: false, bound: false };
    case 'plugin_get_config':
      return {
        enabled: false,
        rateLimitPerMin: 10,
        modelConfigId: '',
        systemPrompt: '',
        bound: false,
        hasToken: false,
        accountId: '',
        userId: '',
        baseUrl: '',
      };
    case 'plugin:manager|config':
      return { revision: 'cfg-1', schema: null, values: {} };
    default:
      return undefined;
  }
}
