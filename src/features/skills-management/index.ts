/**
 * skills-management feature 公共出口。
 *
 * 在历史 `components/skills-management` 实现之上增加面向学习者的分类过滤与排序层：
 * - `SkillsManagementPage`：默认展示「学习精选」，支持切换「全部技能 / 系统与扩展」；
 * - `SkillsList`：默认按学习工作流权重排序并支持 `audienceCategory` 过滤；
 * - `skillCategories`：导出分类判定与排序纯函数，供列表与测试直接复用。
 */

export { SkillsManagementPage } from './SkillsManagementPage';
export type { SkillsManagementPageProps } from './SkillsManagementPage';

export { SkillsList } from './SkillsList';
export type { SkillsListProps } from './SkillsList';

export {
  CURATED_LEARNING_SKILL_ORDER,
  SYSTEM_AND_EXTENSION_SKILL_IDS,
  classifySkillAudience,
  getLearnerSkillSortRank,
  sortSkillsForLearner,
  filterAndSortSkillsForLearner,
} from './skillCategories';
export type {
  SkillAudienceCategory,
  ResolvedSkillCategory,
  ClassifySkillInput,
} from './skillCategories';

export {
  SkillsSidebar,
  SkillEditorModal,
  SkillDeleteConfirm,
} from '@/components/skills-management';

export type {
  SkillEditorModalProps,
  SkillFormData,
  SkillDeleteConfirmProps,
} from '@/components/skills-management';
