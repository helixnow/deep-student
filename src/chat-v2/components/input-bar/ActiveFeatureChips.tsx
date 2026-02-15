/**
 * ActiveFeatureChips - 激活功能标签组件
 * 
 * 在输入框上方显示当前激活的功能，用户可以快速查看和关闭。
 * 上下文标签设计
 */

import React from 'react';
import { X, Brain, Layers, Network, BookOpen, GraduationCap, Wrench, Globe, CreditCard, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';

// ============================================================================
// 类型定义
// ============================================================================

export interface ActiveFeature {
  /** 功能唯一标识 */
  id: string;
  /** 显示标签 */
  label: string;
  /** 图标 */
  icon: React.ReactNode;
  /** 关闭回调 */
  onClose: () => void;
  /** 主题色（可选） */
  color?: 'default' | 'purple' | 'blue' | 'green' | 'orange';
}

export interface ActiveFeatureChipsProps {
  /** 激活的功能列表 */
  features: ActiveFeature[];
  /** 是否禁用（流式生成时） */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 颜色映射
// ============================================================================

const colorClasses: Record<string, string> = {
  default: 'bg-muted/80 text-foreground hover:bg-muted',
  purple: 'bg-muted/80 text-purple-600 hover:bg-muted dark:text-purple-400',
  blue: 'bg-muted/80 text-blue-600 hover:bg-muted dark:text-blue-400',
  green: 'bg-muted/80 text-emerald-600 hover:bg-muted dark:text-emerald-400',
  orange: 'bg-muted/80 text-orange-600 hover:bg-muted dark:text-orange-400',
};

// ============================================================================
// 单个 Chip 组件
// ============================================================================

interface FeatureChipProps {
  feature: ActiveFeature;
  disabled?: boolean;
}

const FeatureChip: React.FC<FeatureChipProps> = ({ feature, disabled }) => {
  const colorClass = colorClasses[feature.color || 'default'];
  
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors',
        colorClass,
        disabled && 'opacity-60 pointer-events-none'
      )}
    >
      <span className="flex-shrink-0 w-3.5 h-3.5 flex items-center justify-center">
        {feature.icon}
      </span>
      <span className="truncate max-w-[120px]">{feature.label}</span>
      <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); feature.onClose(); }} disabled={disabled} className="!w-4 !h-4 !p-0 hover:bg-foreground/10" aria-label={`Close ${feature.label}`}>
        <X size={10} strokeWidth={2.5} />
      </NotionButton>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ActiveFeatureChips: React.FC<ActiveFeatureChipsProps> = ({
  features,
  disabled = false,
  className,
}) => {
  if (features.length === 0) return null;

  return (
    <div
      className={cn(
        'flex flex-wrap gap-1.5 mb-2 animate-in fade-in slide-in-from-bottom-1 duration-200',
        className
      )}
    >
      {features.map((feature) => (
        <FeatureChip key={feature.id} feature={feature} disabled={disabled} />
      ))}
    </div>
  );
};

// ============================================================================
// 辅助 Hook：构建激活功能列表
// ============================================================================

export interface UseActiveFeatureChipsOptions {
  // 推理模式
  enableThinking?: boolean;
  onToggleThinking?: () => void;
  // 知识库
  ragEnabled?: boolean;
  onToggleRag?: () => void;
  // 知识图谱
  graphEnabled?: boolean;
  onToggleGraph?: () => void;
  // 教材
  textbookOpen?: boolean;
  onTextbookToggle?: () => void;
  // MCP 工具
  mcpEnabled?: boolean;
  onToggleMcp?: () => void;
  // 🔧 MCP 选中状态（用于显示激活 Chip）
  selectedMcpServerCount?: number;
  // 网络搜索
  searchEnabled?: boolean;
  onToggleSearch?: () => void;
  // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除开关
  // 技能（多选模式）
  activeSkillIds?: string[];
  onDeactivateSkill?: (skillId: string) => void;
}

export function useActiveFeatureChips(options: UseActiveFeatureChipsOptions): ActiveFeature[] {
  const { t } = useTranslation(['chatV2', 'analysis', 'textbook', 'skills']);
  
  const features: ActiveFeature[] = [];

  // 推理模式
  if (options.enableThinking && options.onToggleThinking) {
    features.push({
      id: 'thinking',
      label: t('chatV2:inputBar.thinking'),
      icon: <Brain size={14} />,
      onClose: options.onToggleThinking,
      color: 'purple',
    });
  }

  // 知识库
  if (options.ragEnabled && options.onToggleRag) {
    features.push({
      id: 'rag',
      label: t('analysis:input_bar.rag.title'),
      icon: <Layers size={14} />,
      onClose: options.onToggleRag,
      color: 'blue',
    });
  }

  // 知识图谱
  if (options.graphEnabled && options.onToggleGraph) {
    features.push({
      id: 'graph',
      label: t('analysis:input_bar.graph.title'),
      icon: <Network size={14} />,
      onClose: options.onToggleGraph,
      color: 'blue',
    });
  }

  // 教材
  if (options.textbookOpen && options.onTextbookToggle) {
    features.push({
      id: 'textbook',
      label: t('textbook:panel.title'),
      icon: <BookOpen size={14} />,
      onClose: options.onTextbookToggle,
      color: 'green',
    });
  }

  // MCP 工具 - 🔧 根据选中的服务器数量显示
  const mcpServerCount = options.selectedMcpServerCount ?? 0;
  if (mcpServerCount > 0 && options.onToggleMcp) {
    features.push({
      id: 'mcp',
      label: mcpServerCount === 1 
        ? t('analysis:input_bar.mcp.title')
        : `${t('analysis:input_bar.mcp.title')} (${mcpServerCount})`,
      icon: <Wrench size={14} />,
      onClose: options.onToggleMcp,
      color: 'orange',
    });
  }

  // 网络搜索
  if (options.searchEnabled && options.onToggleSearch) {
    features.push({
      id: 'search',
      label: t('analysis:input_bar.search_engine.title'),
      icon: <Globe size={14} />,
      onClose: options.onToggleSearch,
      color: 'blue',
    });
  }

  // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，始终可用，移除激活芯片

  // 技能（多选模式：每个激活的技能都显示一个 Chip）
  // 注意：技能 Chips 已通过 ContextRefChips 显示，这里不再重复显示

  return features;
}

export default ActiveFeatureChips;
