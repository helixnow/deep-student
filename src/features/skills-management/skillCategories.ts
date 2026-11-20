/**
 * 技能学习优先分类与排序权重
 *
 * 将全部内置与自定义技能清晰划分为：
 * - `learning`（学习精选）：解题辅导、闪卡制卡、间隔复习、智能笔记、课程/教材学习、论文与文献阅读等核心学生场景
 * - `system`（系统与扩展）：底层脚本编排（如 ptc-run）、代理运行时、权限配置、Office 格式处理与企业职场角色包（role-packs）等
 */

export type SkillAudienceCategory = 'learning' | 'all' | 'system';
export type ResolvedSkillCategory = 'learning' | 'system';

/**
 * 精选学习技能白名单及学习者主流程推荐权重（索引越小越靠前）。
 */
export const CURATED_LEARNING_SKILL_ORDER: readonly string[] = [
  // 1. 苏格拉底答疑、拍题错题分析与题库批改练习
  'tutor-mode',
  'deep-student',
  'exam-analysis',
  'qbank-tools',
  'essay-grading',
  // 2. 闪卡制卡与间隔记忆复习
  'chatanki',
  'card-forge-mode',
  'anki-tools',
  'review-planning',
  'fsrs-settings-tools',
  // 3. 智能笔记、思维导图、网课与教材阅读
  'canvas-note',
  'mindmap-tools',
  'course-study',
  'textbook-pdf-tools',
  'learning-resource',
  'dstu-tools',
  'document-processing',
  // 4. 论文检索、文献综述、深度调研与翻译
  'literature-review',
  'academic-search',
  'research-mode',
  'knowledge-retrieval',
  'translation-tools',
  'web-fetch',
  'index-webpage-tools',
  // 5. 学习复盘、记忆沉淀、目标计划与学习插图
  'insight-recall',
  'learning-overview-tools',
  'vfs-memory',
  'dstu-memory-orchestrator',
  'goal-tools',
  'user-todo-tools',
  'todo-tools',
  'media-tools',
  'image-generation',
  'attachment-tools',
] as const;

/**
 * 系统底层工具、连接器、办公文档流水线与企业角色包。
 */
export const SYSTEM_AND_EXTENSION_SKILL_IDS: ReadonlySet<string> = new Set([
  // 底层运行时与多工具脚本编排
  'ptc-run',
  'tool-pack',
  'subagent-worker',
  'ask-user',
  'generative-ui',
  'session-manager',
  'workbench-tools',
  // 设置、目录授权、插件工坊与自助扩展
  'settings-tools',
  'self-config-tools',
  'self-service-tools',
  'skill-installer',
  'dstu-plugin-development',
  'plugin-workshop-tools',
  'root-request-tools',
  'workspace-tools',
  'file-manager-tools',
  // 数据治理、审计、用量统计、外部连接器与定时自动化
  'data-governance-tools',
  'task-governance-tools',
  'llm-usage-tools',
  'automation-tools',
  'connector-tools',
  'browser-tools',
  // 企业岗位工作流与 Office 保真/批处理套件
  'role-packs',
  'docx-tools',
  'pptx-tools',
  'xlsx-tools',
  'office-fidelity-tools',
  'template-designer',
]);

const LEARNING_RANK_MAP = new Map<string, number>(
  CURATED_LEARNING_SKILL_ORDER.map((id, idx) => [id, idx]),
);

const SYSTEM_ID_OR_TEXT_PATTERN =
  /(?:^|[-_\s])(?:ptc|mcp|devops|docker|k8s|kubectl|terraform|shell|bash|powershell|plugin-workshop|role-packs|finance|legal|payroll|accounting|audit|governance|crm|erp)(?:$|[-_\s])|(?:财务|法务|人力|税务|薪酬|运维|部署|插件开发|脚本化工具|连接器)/i;

export interface ClassifySkillInput {
  id: string;
  name?: string;
  description?: string;
  location?: string;
  isBuiltin?: boolean;
  priority?: number;
}

export function isKnownBuiltinSkillId(skillId: string): boolean {
  return LEARNING_RANK_MAP.has(skillId) || SYSTEM_AND_EXTENSION_SKILL_IDS.has(skillId);
}

/**
 * 判断单个技能属于「学习精选」(`learning`) 还是「系统与扩展」(`system`)。
 */
export function classifySkillAudience(skill: ClassifySkillInput): ResolvedSkillCategory {
  if (LEARNING_RANK_MAP.has(skill.id)) {
    return 'learning';
  }
  if (SYSTEM_AND_EXTENSION_SKILL_IDS.has(skill.id)) {
    return 'system';
  }
  const combinedText = `${skill.id} ${skill.name ?? ''} ${skill.description ?? ''}`;
  if (SYSTEM_ID_OR_TEXT_PATTERN.test(combinedText)) {
    return 'system';
  }
  // 学生自建或从社区安装的非系统工具类技能默认归入学习精选，避免新建后找不到
  return 'learning';
}

/**
 * 计算学习者视角下的技能排序权重（数字越小越靠前）：
 * 1. 用户自建/已安装技能（global / project）优先于内置技能；
 * 2. 「学习精选」技能始终排在「系统与扩展」之前；
 * 3. 核心学习技能按学生高频工作流精选权重排序，其余按 priority 与 ID 稳定排序。
 */
export function getLearnerSkillSortRank(skill: ClassifySkillInput): number {
  const category = classifySkillAudience(skill);
  const isUserSkill = skill.isBuiltin !== true && skill.location !== 'builtin';
  const curatedIndex = LEARNING_RANK_MAP.get(skill.id);
  const metadataPriority = typeof skill.priority === 'number' ? skill.priority : 5;

  if (isUserSkill && category === 'learning') {
    return metadataPriority; // 0 ~ 10
  }
  if (category === 'learning') {
    if (curatedIndex !== undefined) {
      return 100 + curatedIndex; // 100 ~ 199
    }
    return 200 + metadataPriority; // 200 ~ 220
  }
  if (isUserSkill) {
    return 500 + metadataPriority; // 用户自建的系统/办公扩展
  }
  return 1000 + metadataPriority; // 内置底层系统/企业扩展沉底
}

/**
 * 按学习者优先顺序返回新数组（不修改原数组）。
 */
export function sortSkillsForLearner<T extends ClassifySkillInput>(skills: readonly T[]): T[] {
  return [...skills].sort((a, b) => {
    const rankDiff = getLearnerSkillSortRank(a) - getLearnerSkillSortRank(b);
    if (rankDiff !== 0) return rankDiff;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });
}

/**
 * 按场景分类筛选并以学习者优先顺序返回技能列表。
 */
export function filterAndSortSkillsForLearner<T extends ClassifySkillInput>(
  skills: readonly T[],
  category: SkillAudienceCategory = 'all',
  learnerSort = true,
): T[] {
  const filtered =
    category === 'all'
      ? [...skills]
      : skills.filter((skill) => classifySkillAudience(skill) === category);
  return learnerSort ? sortSkillsForLearner(filtered) : filtered;
}
