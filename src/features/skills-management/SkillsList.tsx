/**
 * 学习者优先排序与分类过滤的 SkillsList 包装组件
 */

import React, { useMemo } from 'react';
import {
  SkillsList as BaseSkillsList,
  type SkillsListProps as BaseSkillsListProps,
} from '@/components/skills-management';
import {
  filterAndSortSkillsForLearner,
  type SkillAudienceCategory,
} from './skillCategories';

export interface SkillsListProps extends BaseSkillsListProps {
  /** 按「学习精选 / 全部 / 系统与扩展」过滤技能卡片，默认显示传入列表全部 */
  audienceCategory?: SkillAudienceCategory;
  /** 是否按学习场景优先权重排序（默认开启，避免底层工具淹没学习技能） */
  learnerFirstSort?: boolean;
}

export const SkillsList: React.FC<SkillsListProps> = ({
  skills,
  audienceCategory = 'all',
  learnerFirstSort = true,
  ...rest
}) => {
  const displaySkills = useMemo(
    () => filterAndSortSkillsForLearner(skills, audienceCategory, learnerFirstSort),
    [skills, audienceCategory, learnerFirstSort],
  );

  return <BaseSkillsList skills={displaySkills} {...rest} />;
};

export default SkillsList;
