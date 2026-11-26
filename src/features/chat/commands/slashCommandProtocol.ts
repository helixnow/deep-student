/**
 * Chat V2 - Unified Slash Command Protocol & Isomorphic Parser
 *
 * Provides a UI-free, cross-channel slash command specification shared by:
 * - Desktop / Mobile / WebUI Chat Composer (`SkillSlashPopover`, `InputBarUI`, `InputBarV2`)
 * - Headless / Remote IM channels (e.g. WeChat `ilinkbot`)
 */

export type SlashCommandCategory = 'control' | 'study' | 'skill' | 'plugin';

export type SlashCommandExecutionKind =
  | 'immediate'
  | 'arg_submit'
  | 'sub_picker'
  | 'skill_prefix';

export type BuiltinSlashCommandId =
  // Common Control Commands
  | 'compact'
  | 'goal'
  | 'plan'
  | 'new'
  | 'branch'
  | 'undo'
  | 'think'
  | 'model'
  | 'mode'
  | 'web'
  | 'kb'
  | 'context'
  | 'export'
  | 'rename'
  | 'mcp'
  | 'skills'
  | 'doctor'
  | 'help'
  // DeepStudent Signature Study Commands
  | 'btw'
  | 'remember'
  | 'learn'
  | 'memory'
  | 'feynman'
  | 'tutor'
  | 'anki'
  | 'quiz'
  | 'mindmap'
  | 'handout'
  | 'grade'
  | 'today'
  | 'read'
  | 'schedule'
  | 'workshop';

export interface SlashSubcommandSpec {
  id: string;
  labelKey: string;
  descriptionKey?: string;
  keywords?: readonly string[];
  /** When true, selecting this subcommand leaves `/cmd sub ` for trailing text instead of firing immediately */
  acceptsTrailingText?: boolean;
}

export interface BuiltinSlashCommandSpec {
  id: BuiltinSlashCommandId;
  category: 'control' | 'study';
  executionKind: 'immediate' | 'arg_submit' | 'sub_picker';
  labelKey: string;
  descriptionKey: string;
  argumentHintKey?: string;
  aliases: readonly string[];
  keywords: readonly string[];
  /** Priority in empty `/` query (lower = higher up) */
  featuredOrder: number;
  /** Whether command works while assistant stream is active */
  allowDuringStream?: boolean;
  /** Whether submitting `/cmd` without arguments is valid for `arg_submit` commands */
  allowEmptySubmit?: boolean;
  /** Subcommand auto-open policy when input is `/cmd ` */
  autoOpenSubpicker?: boolean | 'when_active_goal';
  subcommands?: readonly SlashSubcommandSpec[];
}

export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandSpec[] = [
  // ============================================================================
  // 1. Common Control Commands (常用基础控制)
  // ============================================================================
  {
    id: 'goal',
    category: 'control',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.goal.label',
    descriptionKey: 'chatV2:slashCommands.goal.description',
    argumentHintKey: 'chatV2:slashCommands.goal.argHint',
    aliases: [],
    keywords: ['目标', '长任务', '自驱', '续跑', 'mubiao', 'objective'],
    featuredOrder: 1,
    allowEmptySubmit: true,
    autoOpenSubpicker: 'when_active_goal',
    subcommands: [
      {
        id: 'status',
        labelKey: 'chatV2:slashCommands.goal.sub.status',
        descriptionKey: 'chatV2:slashCommands.goal.sub.statusDesc',
        keywords: ['状态', '进度', '查看'],
      },
      {
        id: 'pause',
        labelKey: 'chatV2:slashCommands.goal.sub.pause',
        descriptionKey: 'chatV2:slashCommands.goal.sub.pauseDesc',
        keywords: ['暂停', '挂起'],
      },
      {
        id: 'resume',
        labelKey: 'chatV2:slashCommands.goal.sub.resume',
        descriptionKey: 'chatV2:slashCommands.goal.sub.resumeDesc',
        keywords: ['继续', '恢复'],
      },
      {
        id: 'clear',
        labelKey: 'chatV2:slashCommands.goal.sub.clear',
        descriptionKey: 'chatV2:slashCommands.goal.sub.clearDesc',
        keywords: ['清除', '取消', '删除'],
      },
    ],
  },
  {
    id: 'plan',
    category: 'control',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.plan.label',
    descriptionKey: 'chatV2:slashCommands.plan.description',
    argumentHintKey: 'chatV2:slashCommands.plan.argHint',
    aliases: [],
    keywords: ['计划', '规划', '方案', '先规划', 'jihua'],
    featuredOrder: 2,
    allowEmptySubmit: true,
    autoOpenSubpicker: false,
    subcommands: [
      {
        id: 'on',
        labelKey: 'chatV2:slashCommands.plan.sub.on',
        descriptionKey: 'chatV2:slashCommands.plan.sub.onDesc',
        keywords: ['开启', '打开'],
      },
      {
        id: 'off',
        labelKey: 'chatV2:slashCommands.plan.sub.off',
        descriptionKey: 'chatV2:slashCommands.plan.sub.offDesc',
        keywords: ['关闭', '退出'],
      },
    ],
  },
  {
    id: 'compact',
    category: 'control',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:inputBar.plusMenu.compactContext',
    descriptionKey: 'chatV2:slashCommands.compact.description',
    argumentHintKey: 'chatV2:slashCommands.compact.argHint',
    aliases: ['summarize'],
    keywords: ['压缩', '摘要', '精简上下文', 'yasuo'],
    featuredOrder: 3,
    allowEmptySubmit: true,
    autoOpenSubpicker: false,
    subcommands: [
      {
        id: 'undo',
        labelKey: 'chatV2:slashCommands.compact.sub.undo',
        descriptionKey: 'chatV2:slashCommands.compact.sub.undoDesc',
        keywords: ['撤销', '恢复', '回退'],
      },
    ],
  },
  {
    id: 'new',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.new.label',
    descriptionKey: 'chatV2:slashCommands.new.description',
    argumentHintKey: 'chatV2:slashCommands.new.argHint',
    aliases: ['clear', 'reset'],
    keywords: ['新建', '新对话', '清空', '重置', 'xinjian'],
    featuredOrder: 4,
  },
  {
    id: 'think',
    category: 'control',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.think.label',
    descriptionKey: 'chatV2:slashCommands.think.description',
    argumentHintKey: 'chatV2:slashCommands.think.argHint',
    aliases: ['effort'],
    keywords: ['思考', '推理', '深度', '思维链', 'sikao', 'tuili'],
    featuredOrder: 5,
    allowDuringStream: true,
    autoOpenSubpicker: true,
    subcommands: [
      { id: 'off', labelKey: 'chatV2:slashCommands.think.sub.off', keywords: ['关闭', '关'] },
      { id: 'minimal', labelKey: 'chatV2:slashCommands.think.sub.minimal', keywords: ['极速', '最低'] },
      { id: 'low', labelKey: 'chatV2:slashCommands.think.sub.low', keywords: ['低', '轻量'] },
      { id: 'medium', labelKey: 'chatV2:slashCommands.think.sub.medium', keywords: ['中', '标准'] },
      { id: 'high', labelKey: 'chatV2:slashCommands.think.sub.high', keywords: ['高', '深入'] },
      { id: 'xhigh', labelKey: 'chatV2:slashCommands.think.sub.xhigh', keywords: ['极高', '超深'] },
      { id: 'max', labelKey: 'chatV2:slashCommands.think.sub.max', keywords: ['最高', '拉满'] },
    ],
  },
  {
    id: 'mode',
    category: 'control',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.mode.label',
    descriptionKey: 'chatV2:slashCommands.mode.description',
    argumentHintKey: 'chatV2:slashCommands.mode.argHint',
    aliases: ['perm', 'permissions', 'approvals'],
    keywords: ['权限', '执行档位', '安全模式', '审批', '谨慎', '宽松', 'quanxian'],
    featuredOrder: 6,
    autoOpenSubpicker: true,
    subcommands: [
      {
        id: 'cautious',
        labelKey: 'chatV2:authority.permissionPreset.modes.cautious',
        descriptionKey: 'chatV2:authority.permissionPreset.shortHints.cautious',
        keywords: ['谨慎', '只读', '安全'],
      },
      {
        id: 'relaxed',
        labelKey: 'chatV2:authority.permissionPreset.modes.relaxed',
        descriptionKey: 'chatV2:authority.permissionPreset.shortHints.relaxed',
        keywords: ['宽松', '默认', '标准'],
      },
      {
        id: 'full_access',
        labelKey: 'chatV2:authority.permissionPreset.modes.full_access',
        descriptionKey: 'chatV2:authority.permissionPreset.shortHints.full_access',
        keywords: ['完全访问', '全自动', 'full'],
      },
      {
        id: 'danger_full_access',
        labelKey: 'chatV2:authority.permissionPreset.modes.danger_full_access',
        descriptionKey: 'chatV2:authority.permissionPreset.shortHints.danger_full_access',
        keywords: ['危险', '无限制', 'danger'],
      },
    ],
  },
  {
    id: 'model',
    category: 'control',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.model.label',
    descriptionKey: 'chatV2:slashCommands.model.description',
    argumentHintKey: 'chatV2:slashCommands.model.argHint',
    aliases: ['models'],
    keywords: ['模型', '切换模型', 'moxing'],
    featuredOrder: 7,
    autoOpenSubpicker: true,
  },
  {
    id: 'branch',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.branch.label',
    descriptionKey: 'chatV2:slashCommands.branch.description',
    argumentHintKey: 'chatV2:slashCommands.branch.argHint',
    aliases: ['fork'],
    keywords: ['分支', '分叉', '派生会话', 'fenzhi'],
    featuredOrder: 12,
  },
  {
    id: 'undo',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.undo.label',
    descriptionKey: 'chatV2:slashCommands.undo.description',
    aliases: ['rewind'],
    keywords: ['撤回', '回退', '撤销上轮', 'chehui'],
    featuredOrder: 13,
  },
  {
    id: 'web',
    category: 'control',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.web.label',
    descriptionKey: 'chatV2:slashCommands.web.description',
    aliases: ['search'],
    keywords: ['联网', '网页搜索', '外部搜索', 'lianwang', 'sousuo'],
    featuredOrder: 14,
    allowDuringStream: true,
    autoOpenSubpicker: true,
    subcommands: [
      { id: 'on', labelKey: 'chatV2:slashCommands.common.enable', keywords: ['开启', '打开', '开'] },
      { id: 'off', labelKey: 'chatV2:slashCommands.common.disable', keywords: ['关闭', '停用', '关'] },
    ],
  },
  {
    id: 'kb',
    category: 'control',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.kb.label',
    descriptionKey: 'chatV2:slashCommands.kb.description',
    aliases: ['rag'],
    keywords: ['知识库', '本地资料', '检索范围', 'zhishiku'],
    featuredOrder: 15,
    allowDuringStream: true,
    autoOpenSubpicker: true,
    subcommands: [
      { id: 'on', labelKey: 'chatV2:slashCommands.kb.sub.on', keywords: ['开启', '打开'] },
      { id: 'off', labelKey: 'chatV2:slashCommands.kb.sub.off', keywords: ['关闭', '停用'] },
      { id: 'proactive', labelKey: 'chatV2:slashCommands.kb.sub.proactive', keywords: ['主动检索', '优先本地'] },
      { id: 'scope', labelKey: 'chatV2:slashCommands.kb.sub.scope', keywords: ['范围', '选文件夹', '目录'] },
    ],
  },
  {
    id: 'context',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.context.label',
    descriptionKey: 'chatV2:slashCommands.context.description',
    aliases: ['status', 'usage', 'cost'],
    keywords: ['状态', '上下文水位', '用量', '费用', 'token', 'zhuangtai'],
    featuredOrder: 16,
    allowDuringStream: true,
  },
  {
    id: 'export',
    category: 'control',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.export.label',
    descriptionKey: 'chatV2:slashCommands.export.description',
    aliases: ['share'],
    keywords: ['导出', '保存记录', '分享', 'daochu'],
    featuredOrder: 20,
    allowDuringStream: true,
    autoOpenSubpicker: true,
    subcommands: [
      { id: 'markdown', labelKey: 'chatV2:slashCommands.export.sub.markdown', keywords: ['md', '文档'] },
      { id: 'json', labelKey: 'chatV2:slashCommands.export.sub.json', keywords: ['json', '结构化'] },
      { id: 'snapshot', labelKey: 'chatV2:slashCommands.export.sub.snapshot', keywords: ['快照', '备份', '迁移'] },
    ],
  },
  {
    id: 'rename',
    category: 'control',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.rename.label',
    descriptionKey: 'chatV2:slashCommands.rename.description',
    argumentHintKey: 'chatV2:slashCommands.rename.argHint',
    aliases: ['title'],
    keywords: ['重命名', '改标题', '改名', 'biaoti'],
    featuredOrder: 21,
    allowDuringStream: true,
  },
  {
    id: 'mcp',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.mcp.label',
    descriptionKey: 'chatV2:slashCommands.mcp.description',
    aliases: ['connectors'],
    keywords: ['连接器', '外部服务', 'lianjieqi'],
    featuredOrder: 22,
  },
  {
    id: 'skills',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.skills.label',
    descriptionKey: 'chatV2:slashCommands.skills.description',
    argumentHintKey: 'chatV2:slashCommands.skills.argHint',
    aliases: [],
    keywords: ['技能面板', '管理技能', 'jineng'],
    featuredOrder: 23,
    autoOpenSubpicker: false,
    subcommands: [
      {
        id: 'clear',
        labelKey: 'chatV2:slashCommands.skills.sub.clear',
        descriptionKey: 'chatV2:slashCommands.skills.sub.clearDesc',
        keywords: ['清空', '取消全部'],
      },
    ],
  },
  {
    id: 'doctor',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.doctor.label',
    descriptionKey: 'chatV2:slashCommands.doctor.description',
    aliases: ['check'],
    keywords: ['诊断', '自检', '体检', '排查故障', 'zhenduan'],
    featuredOrder: 24,
    allowDuringStream: true,
  },
  {
    id: 'help',
    category: 'control',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.help.label',
    descriptionKey: 'chatV2:slashCommands.help.description',
    aliases: ['commands'],
    keywords: ['帮助', '指令大全', '快捷键', '说明', 'bangzhu'],
    featuredOrder: 25,
    allowDuringStream: true,
  },

  // ============================================================================
  // 2. DeepStudent Signature Study Commands (学习工作台特色命令)
  // ============================================================================
  {
    id: 'btw',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.btw.label',
    descriptionKey: 'chatV2:slashCommands.btw.description',
    argumentHintKey: 'chatV2:slashCommands.btw.argHint',
    aliases: ['aside'],
    keywords: ['顺便问', '旁路快问', '小纸条', '查概念', '不污染上下文', 'shunbian'],
    featuredOrder: 8,
    allowDuringStream: true,
  },
  {
    id: 'remember',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.remember.label',
    descriptionKey: 'chatV2:slashCommands.remember.description',
    argumentHintKey: 'chatV2:slashCommands.remember.argHint',
    aliases: ['rule'],
    keywords: ['记住', '添加硬规则', '互动规则', '学习习惯', 'jizhu', 'guize'],
    featuredOrder: 9,
    allowDuringStream: true,
  },
  {
    id: 'learn',
    category: 'study',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.learn.label',
    descriptionKey: 'chatV2:slashCommands.learn.description',
    argumentHintKey: 'chatV2:slashCommands.learn.argHint',
    aliases: [],
    keywords: ['提炼规则', '纠偏沉淀', '总结偏好', 'xuexi'],
    featuredOrder: 10,
    allowDuringStream: true,
  },
  {
    id: 'feynman',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.feynman.label',
    descriptionKey: 'chatV2:slashCommands.feynman.description',
    argumentHintKey: 'chatV2:slashCommands.feynman.argHint',
    aliases: ['grill'],
    keywords: ['费曼', '考考我', '反向追问', '检验理解', 'feiman'],
    featuredOrder: 11,
    allowEmptySubmit: true,
  },
  {
    id: 'tutor',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.tutor.label',
    descriptionKey: 'chatV2:slashCommands.tutor.description',
    argumentHintKey: 'chatV2:slashCommands.tutor.argHint',
    aliases: ['socratic'],
    keywords: ['苏格拉底', '导师引导', '分步提示', '不直接给答案', 'daoshi'],
    featuredOrder: 17,
    allowEmptySubmit: true,
  },
  {
    id: 'anki',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.anki.label',
    descriptionKey: 'chatV2:slashCommands.anki.description',
    argumentHintKey: 'chatV2:slashCommands.anki.argHint',
    aliases: ['card', 'cards', 'flashcard'],
    keywords: ['制卡', '闪卡', '抽认卡', '记忆卡', 'fsrs', 'zhika', 'shanka'],
    featuredOrder: 18,
    allowEmptySubmit: true,
  },
  {
    id: 'quiz',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.quiz.label',
    descriptionKey: 'chatV2:slashCommands.quiz.description',
    argumentHintKey: 'chatV2:slashCommands.quiz.argHint',
    aliases: ['practice', 'exam'],
    keywords: ['出题', '测验', '刷题', '练习', '错题训练', 'chuti'],
    featuredOrder: 19,
    allowEmptySubmit: true,
  },
  {
    id: 'mindmap',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.mindmap.label',
    descriptionKey: 'chatV2:slashCommands.mindmap.description',
    argumentHintKey: 'chatV2:slashCommands.mindmap.argHint',
    aliases: ['map'],
    keywords: ['思维导图', '导图', '脑图', '知识结构', 'daotu'],
    featuredOrder: 26,
    allowEmptySubmit: true,
  },
  {
    id: 'handout',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.handout.label',
    descriptionKey: 'chatV2:slashCommands.handout.description',
    argumentHintKey: 'chatV2:slashCommands.handout.argHint',
    aliases: ['note'],
    keywords: ['讲义', '整理笔记', '网课讲义', '成稿', 'jiangyi', 'biji'],
    featuredOrder: 27,
    allowEmptySubmit: true,
  },
  {
    id: 'grade',
    category: 'study',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.grade.label',
    descriptionKey: 'chatV2:slashCommands.grade.description',
    argumentHintKey: 'chatV2:slashCommands.grade.argHint',
    aliases: ['essay'],
    keywords: ['作文批改', '润色', '评分', '雅思', '考研', '高考', 'pigai', 'zuowen'],
    featuredOrder: 28,
    autoOpenSubpicker: true,
    subcommands: [
      {
        id: 'general',
        labelKey: 'chatV2:slashCommands.grade.sub.general',
        keywords: ['通用', '综合润色'],
        acceptsTrailingText: true,
      },
      {
        id: 'kaoyan',
        labelKey: 'chatV2:slashCommands.grade.sub.kaoyan',
        keywords: ['考研英语', '大作文', '小作文'],
        acceptsTrailingText: true,
      },
      {
        id: 'ielts',
        labelKey: 'chatV2:slashCommands.grade.sub.ielts',
        keywords: ['雅思', 'task1', 'task2'],
        acceptsTrailingText: true,
      },
      {
        id: 'gaokao',
        labelKey: 'chatV2:slashCommands.grade.sub.gaokao',
        keywords: ['高考', '读后续写', '应用文'],
        acceptsTrailingText: true,
      },
    ],
  },
  {
    id: 'memory',
    category: 'study',
    executionKind: 'sub_picker',
    labelKey: 'chatV2:slashCommands.memory.label',
    descriptionKey: 'chatV2:slashCommands.memory.description',
    aliases: ['mem'],
    keywords: ['记忆内核', '学习画像', '薄弱点', '隐私模式', 'jiyi'],
    featuredOrder: 29,
    allowDuringStream: true,
    autoOpenSubpicker: true,
    subcommands: [
      {
        id: 'inspect',
        labelKey: 'chatV2:slashCommands.memory.sub.inspect',
        descriptionKey: 'chatV2:slashCommands.memory.sub.inspectDesc',
        keywords: ['预览', '查看', '快照'],
      },
      {
        id: 'privacy',
        labelKey: 'chatV2:slashCommands.memory.sub.privacy',
        descriptionKey: 'chatV2:slashCommands.memory.sub.privacyDesc',
        keywords: ['隐私', '无痕', '暂停记忆'],
      },
      {
        id: 'clean',
        labelKey: 'chatV2:slashCommands.memory.sub.clean',
        descriptionKey: 'chatV2:slashCommands.memory.sub.cleanDesc',
        keywords: ['梳理', '去重', '清理建议'],
      },
    ],
  },
  {
    id: 'today',
    category: 'study',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.today.label',
    descriptionKey: 'chatV2:slashCommands.today.description',
    aliases: ['cram', 'sprint'],
    keywords: ['今日复习', '考前冲刺', '今日计划', '待办排期', 'jinri', 'chongci'],
    featuredOrder: 30,
  },
  {
    id: 'read',
    category: 'study',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.read.label',
    descriptionKey: 'chatV2:slashCommands.read.description',
    aliases: ['reader'],
    keywords: ['边读边问', '伴读模式', '打开教材', '双栏阅读', 'bandu'],
    featuredOrder: 31,
    allowDuringStream: true,
  },
  {
    id: 'schedule',
    category: 'study',
    executionKind: 'arg_submit',
    labelKey: 'chatV2:slashCommands.schedule.label',
    descriptionKey: 'chatV2:slashCommands.schedule.description',
    argumentHintKey: 'chatV2:slashCommands.schedule.argHint',
    aliases: ['loop', 'cron'],
    keywords: ['定时任务', '周期提醒', '自动执行', 'dingshi'],
    featuredOrder: 32,
  },
  {
    id: 'workshop',
    category: 'study',
    executionKind: 'immediate',
    labelKey: 'chatV2:slashCommands.workshop.label',
    descriptionKey: 'chatV2:slashCommands.workshop.description',
    argumentHintKey: 'chatV2:slashCommands.workshop.argHint',
    aliases: ['plugin-dev'],
    keywords: ['插件工坊', '造插件', '小工具开发', 'gongfang'],
    featuredOrder: 33,
  },
];

// ============================================================================
// Lookup & Parsing Utilities
// ============================================================================

const COMMAND_BY_TOKEN = new Map<string, BuiltinSlashCommandSpec>();
for (const spec of BUILTIN_SLASH_COMMANDS) {
  COMMAND_BY_TOKEN.set(spec.id.toLowerCase(), spec);
  for (const alias of spec.aliases) {
    COMMAND_BY_TOKEN.set(alias.toLowerCase(), spec);
  }
}

export function resolveBuiltinSlashCommand(tokenWithoutSlash: string): BuiltinSlashCommandSpec | null {
  return COMMAND_BY_TOKEN.get(tokenWithoutSlash.trim().toLowerCase()) ?? null;
}

export interface ParsedBuiltinSlashInvocation {
  spec: BuiltinSlashCommandSpec;
  matchedToken: string;
  /** Everything after `/command` (trimmed) */
  rawArgs: string;
  /** First whitespace-delimited argument token (lowercased), if any */
  firstArgLower: string;
  /** Everything after firstArg, trimmed */
  restAfterFirstArg: string;
}

const LEADING_BUILTIN_INVOCATION_RE = /^\s*\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/;

/**
 * Parses a submitted composer string for a leading built-in slash command.
 * Paths like `/compact/file.txt` are naturally rejected because `/` is not in `[A-Za-z0-9_-]`.
 */
export function parseSubmittedBuiltinSlashCommand(input: string): ParsedBuiltinSlashInvocation | null {
  const match = LEADING_BUILTIN_INVOCATION_RE.exec(input);
  if (!match) return null;
  const token = match[1]!;
  const spec = resolveBuiltinSlashCommand(token);
  if (!spec) return null;

  const rawArgs = (match[2] ?? '').trim();
  if (!rawArgs) {
    return {
      spec,
      matchedToken: token.toLowerCase(),
      rawArgs: '',
      firstArgLower: '',
      restAfterFirstArg: '',
    };
  }

  const spaceIdx = rawArgs.search(/\s/);
  const firstArg = spaceIdx === -1 ? rawArgs : rawArgs.slice(0, spaceIdx);
  const restAfterFirstArg = spaceIdx === -1 ? '' : rawArgs.slice(spaceIdx + 1).trim();

  return {
    spec,
    matchedToken: token.toLowerCase(),
    rawArgs,
    firstArgLower: firstArg.toLowerCase(),
    restAfterFirstArg,
  };
}

const ZERO_MODEL_COMMANDS: ReadonlySet<BuiltinSlashCommandId> = new Set<BuiltinSlashCommandId>([
  'new',
  'branch',
  'undo',
  'think',
  'model',
  'mode',
  'web',
  'kb',
  'context',
  'export',
  'rename',
  'mcp',
  'skills',
  'doctor',
  'help',
  'remember',
  'memory',
  'read',
]);

/**
 * Determines whether a submitted built-in slash command executes purely locally
 * without requiring a configured chat LLM / API key.
 */
export function isZeroModelSlashSubmission(input: string): boolean {
  const parsed = parseSubmittedBuiltinSlashCommand(input);
  if (!parsed) return false;
  if (ZERO_MODEL_COMMANDS.has(parsed.spec.id)) return true;
  if (parsed.spec.id === 'compact' && parsed.firstArgLower === 'undo') return true;
  if (
    parsed.spec.id === 'goal'
    && (!parsed.rawArgs || ['status', 'pause', 'resume', 'clear', 'edit'].includes(parsed.firstArgLower))
  ) {
    return true;
  }
  if (
    parsed.spec.id === 'plan'
    && (!parsed.rawArgs || parsed.firstArgLower === 'on' || parsed.firstArgLower === 'off')
  ) {
    return true;
  }
  if (parsed.spec.id === 'tutor' && !parsed.rawArgs) return true;
  if (parsed.spec.id === 'workshop' && !parsed.rawArgs) return true;
  return false;
}

/**
 * Parses optional `--budget <tokens>` flag from `/goal` arguments.
 * Example: `"把第3章错题刷完 --budget 50000"` -> `{ objective: "把第3章错题刷完", tokenBudget: 50000 }`
 */
export function parseGoalCommandArgs(rawArgs: string): {
  objective: string;
  tokenBudget?: number;
} {
  let tokenBudget: number | undefined;
  const stripped = rawArgs
    .replace(/(?:^|\s)--budget(?:=|\s+)(\d+)\b/i, (_full, digits: string) => {
      const parsed = Number.parseInt(digits, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        tokenBudget = parsed;
      }
      return ' ';
    })
    .trim();

  return tokenBudget !== undefined ? { objective: stripped, tokenBudget } : { objective: stripped };
}

/**
 * Parses optional scope prefix from `/remember` arguments:
 * Supports `[math] ...`, `math: ...`, `数学：...`, `英语：...`, `作文：...`
 */
export function parseRememberRuleArgs(rawArgs: string): {
  scope: 'global' | 'subject:math' | 'subject:english' | 'mode:essay';
  instruction: string;
} {
  const trimmed = rawArgs.trim();
  const prefixMatch = /^(?:\[(global|math|english|essay|全局|数学|英语|作文|作文批改)\]|(global|math|english|essay|全局|数学|英语|作文|作文批改)\s*[:：])\s*([\s\S]+)$/i.exec(trimmed);
  if (!prefixMatch) {
    return { scope: 'global', instruction: trimmed };
  }
  const tag = (prefixMatch[1] ?? prefixMatch[2] ?? '').toLowerCase();
  const instruction = (prefixMatch[3] ?? '').trim();
  if (tag === 'math' || tag === '数学') {
    return { scope: 'subject:math', instruction };
  }
  if (tag === 'english' || tag === '英语') {
    return { scope: 'subject:english', instruction };
  }
  if (tag === 'essay' || tag === '作文' || tag === '作文批改') {
    return { scope: 'mode:essay', instruction };
  }
  return { scope: 'global', instruction };
}

/**
 * Scores a slash item against a non-empty user query (lower rank = better match, -1 = no match).
 */
export function scoreSlashMatch(params: {
  query: string;
  id: string;
  name: string;
  aliases?: readonly string[];
  keywords?: readonly string[];
}): number {
  const q = params.query.trim().toLowerCase();
  if (!q) return 0;

  const id = params.id.toLowerCase();
  const name = params.name.toLowerCase();
  const aliases = (params.aliases ?? []).map((a) => a.toLowerCase());
  const keywords = (params.keywords ?? []).map((k) => k.toLowerCase());

  if (id === q || aliases.includes(q)) return 0;
  if (id.startsWith(q) || aliases.some((a) => a.startsWith(q))) return 1;
  if (name.startsWith(q) || keywords.some((k) => k.startsWith(q))) return 2;
  if (id.includes(q) || aliases.some((a) => a.includes(q))) return 3;
  if (name.includes(q) || keywords.some((k) => k.includes(q))) return 4;
  return -1;
}

// ============================================================================
// Structured Prompt Builders for Learning Workflows
// ============================================================================

export function buildStudyWorkflowPrompt(
  kind: 'goal' | 'feynman' | 'tutor' | 'anki' | 'quiz' | 'mindmap' | 'handout' | 'grade' | 'today' | 'schedule',
  args: string,
  extra?: { tokenBudget?: number; rubric?: string },
): { skillIds: string[]; prompt: string } {
  const trimmed = args.trim();
  switch (kind) {
    case 'goal': {
      const budgetNote = extra?.tokenBudget ? `（Token 预算上限：${extra.tokenBudget}）` : '';
      return {
        skillIds: ['goal-tools'],
        prompt: `请立即调用 builtin-goal_create 为当前会话创建如下持久目标${budgetNote}，并在创建成功后立刻开始执行第一步推进：\n\n目标：${trimmed}`,
      };
    }
    case 'feynman':
      return {
        skillIds: ['tutor-mode', 'vfs-memory'],
        prompt: trimmed
          ? `【费曼反向追问模式】我想检验自己是否真正理解了「${trimmed}」。请扮演严谨的费曼考官：不要直接长篇讲解，每次只追问我 1 个关键直觉、前提条件、边界反例或易混点（共 3~5 轮）。等我回答后再指出漏洞并继续追问；结束时给出掌握度诊断，并询问是否将暴露的薄弱点记入学习画像或生成闪卡。现在请提出第 1 问。`
          : `【费曼反向追问模式】请结合我们当前对话或资料的核心概念，扮演费曼考官向我发起 3~5 轮连环追问（每次 1 问，专挑直觉盲区、前提条件与边界情况），帮我检验是否真懂，最后给出掌握度诊断。现在请提出第 1 问。`,
      };
    case 'tutor':
      return {
        skillIds: ['tutor-mode'],
        prompt: trimmed || '请开启苏格拉底导师模式：接下来的问题请通过分步提示和引导性提问带我自己想出解法，不要直接给出完整最终答案。',
      };
    case 'anki':
      return {
        skillIds: ['chatanki'],
        prompt: trimmed
          ? `请基于当前会话上下文与资料，围绕「${trimmed}」制作高质量 FSRS 复习闪卡（按「学科::主题」规范命名牌组，突出核心考点与易错辨析）。`
          : `请提炼当前会话刚刚讨论的核心知识点、公式推导与易错结论，制作一批高质量 FSRS 复习闪卡并入库。`,
      };
    case 'quiz':
      return {
        skillIds: ['qbank-tools'],
        prompt: trimmed
          ? `请围绕「${trimmed}」结合当前资料与我的薄弱点生成针对性测验练习题（附清晰解析）。`
          : `请结合当前会话内容、关联资料以及我的活跃薄弱点，出 5 道高质量针对性自测题让我练习。`,
      };
    case 'mindmap':
      return {
        skillIds: ['mindmap-tools'],
        prompt: trimmed
          ? `请围绕「${trimmed}」生成结构清晰的思维导图并写入思维导图应用，层次分明、便于背诵自测。`
          : `请将当前会话与资料的核心脉络整理生成一份结构清晰的思维导图并写入思维导图应用。`,
      };
    case 'handout':
      return {
        skillIds: ['canvas-note'],
        prompt: trimmed
          ? `请围绕「${trimmed}」将当前对话/音视频字幕/参考资料整理成一篇结构化 Markdown 学习讲义写入笔记库，保留关键公式、重点结论与原文出处/时间戳回链。`
          : `请将当前会话的核心讨论、推导过程与参考出处（含页码或音视频时间戳）系统整理成一篇结构化 Markdown 讲义并保存到笔记库。`,
      };
    case 'grade': {
      const rubricMap: Record<string, string> = {
        kaoyan: '考研英语作文评分标准',
        ielts: '雅思写作（IELTS Writing）四维评分标准',
        gaokao: '高考作文评分标准',
        general: '通用学术与表达写作标准',
      };
      const rubricLabel = rubricMap[extra?.rubric ?? 'general'] ?? extra?.rubric ?? '通用写作评分标准';
      return {
        skillIds: ['essay-grading'],
        prompt: trimmed
          ? `请按「${rubricLabel}」对以下作文进行逐维打分、原文问题批注与逐句升格润色：\n\n${trimmed}`
          : `请按「${rubricLabel}」批改我接下来提供的作文（若当前上下文或附件已有作文正文请直接开始逐维评分与批注润色）。`,
      };
    }
    case 'today':
      return {
        skillIds: ['learning-overview-tools', 'review-planning', 'user-todo-tools'],
        prompt: `请查看我今日到期的闪卡复习量、错题待清情况、待办清单与活跃薄弱点，为我生成一份清晰可执行的「今日学习冲刺排期」（分时段列出优先级最高的事项）。`,
      };
    case 'schedule':
      return {
        skillIds: ['automation-tools'],
        prompt: `请根据以下要求帮我创建一条定时自动化学习任务：\n\n${trimmed}`,
      };
  }
}
