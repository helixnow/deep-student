/**
 * Chat V2 - Skills 组件导出
 *
 * 提供技能相关 UI 组件的统一入口
 */

// ActiveSkillBadge - 激活状态徽章
export {
  ActiveSkillBadge,
  ActiveSkillBadgeCompact,
  NoActiveSkillButton,
} from './ActiveSkillBadge';
export type { ActiveSkillBadgeProps, NoActiveSkillProps } from './ActiveSkillBadge';

// BoundSkillChipsBar - 对话输入栏已绑定技能芯片条
export { BoundSkillChipsBar } from './BoundSkillChipsBar';
export type { BoundSkillChipsBarProps } from './BoundSkillChipsBar';

// SkillSelector - 技能选择面板
export { SkillSelector } from './SkillSelector';
export type { SkillSelectorProps } from './SkillSelector';
