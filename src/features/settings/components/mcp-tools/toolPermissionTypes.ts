import type { ToolCapability, ToolSensitivityLevel } from '../toolPermissionModel';

// ============================================================================
// 工具权限管理
// ============================================================================

export type SensitivityLevel = ToolSensitivityLevel;

export interface RuntimeRootEntry {
  id: string;
  kind: string;
  path: string;
  access: 'read_only' | 'read_write' | string;
  label: string;
  description?: string;
  session_scoped?: boolean;
  configured?: boolean;
}

export interface ToolOverrideEntry {
  toolName: string;
  displayName: string;
  level: SensitivityLevel;
}

export const TOOL_CAPABILITIES: ToolCapability[] = [
  'files', 'web', 'knowledge', 'learning', 'automation', 'data', 'communication', 'other',
];

/** 敏感等级的颜色和标签配置 */
export const SENSITIVITY_CONFIG: Record<SensitivityLevel, {
  badge: string;
  dot: string;
}> = {
  low: {
    badge: 'bg-success/10 text-success',
    dot: 'bg-success',
  },
  medium: {
    badge: 'bg-warning/10 text-warning',
    dot: 'bg-warning',
  },
  high: {
    badge: 'bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  },
};
