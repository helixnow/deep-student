/**
 * 间距档位（DEFAULT / COMPACT / SPACIOUS）统一接入点
 *
 * 三套 LayoutConfig 常量早已存在于 constants/layout.ts，但此前上层
 * 始终传 DEFAULT，档位为死配置。本模块提供档位枚举与解析函数，
 * 上层 UI（间距选择器等）只需：
 *
 *   const config = resolveSpacingConfig(tier, { measuredNodeHeights, direction });
 *   layoutEngine.calculate(root, config, direction);
 *
 * 引擎侧无需任何修改——所有引擎均已从 config 读取
 * horizontalGap / verticalGap / node 尺寸（组织图经 getSiblingGap /
 * getLevelGap 语义化读取，同样跟随档位缩放）。
 *
 * 注意：helpers 的子树尺寸缓存以 config 对象身份为键，
 * resolveSpacingConfig 每次返回新对象，切换档位自动使缓存失效。
 */

import type { LayoutConfig } from '../../types';
import {
  DEFAULT_LAYOUT_CONFIG,
  COMPACT_LAYOUT_CONFIG,
  SPACIOUS_LAYOUT_CONFIG,
} from '../../constants';

/** 间距档位标识（可持久化到文档设置/偏好） */
export type SpacingTier = 'default' | 'compact' | 'spacious';

/** 档位 → 布局配置常量 */
export const SPACING_TIER_CONFIGS: Readonly<Record<SpacingTier, LayoutConfig>> = {
  default: DEFAULT_LAYOUT_CONFIG,
  compact: COMPACT_LAYOUT_CONFIG,
  spacious: SPACIOUS_LAYOUT_CONFIG,
};

/** 全部档位（UI 列表顺序） */
export const SPACING_TIERS: readonly SpacingTier[] = ['compact', 'default', 'spacious'];

/** 归一化档位输入（未知值回退 default，容忍旧持久化数据） */
export function normalizeSpacingTier(tier: string | undefined | null): SpacingTier {
  return tier === 'compact' || tier === 'spacious' ? tier : 'default';
}

/**
 * 解析档位为可直接传入引擎的布局配置
 *
 * @param tier 间距档位（无效值回退 default）
 * @param overrides 运行时叠加字段（measuredNodeHeights、direction、
 *   compactSiblings、siblingGap/levelGap 等扩展字段）
 * @returns 新的 config 对象（每次调用新引用，保证 WeakMap 缓存正确失效）
 */
export function resolveSpacingConfig(
  tier: string | undefined | null,
  overrides?: Partial<LayoutConfig> & Record<string, unknown>
): LayoutConfig {
  return {
    ...SPACING_TIER_CONFIGS[normalizeSpacingTier(tier)],
    ...overrides,
  };
}
