/**
 * skills-management feature 公共出口。
 *
 * 实现体目前仍位于历史路径 `components/skills-management`（约 2000 行页面 +
 * 编辑器/列表/Tap 浏览器等子组件）。为完成 feature 目录与历史目录的关系收敛，
 * 采取「转导出」而非物理搬迁（改动面最小、零行为风险）：
 * - 调用方（Workbench 窗口、legacy lazy 路由）一律从本入口引入；
 * - 后续若做物理迁移，只需改这一处的 re-export 源。
 */
export {
  SkillsManagementPage,
  SkillsSidebar,
  SkillsList,
  SkillEditorModal,
  SkillDeleteConfirm,
} from '@/components/skills-management';

export type {
  SkillEditorModalProps,
  SkillFormData,
  SkillsListProps,
  SkillDeleteConfirmProps,
} from '@/components/skills-management';
