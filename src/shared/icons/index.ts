/**
 * Unified icon system for DeepStudent.
 * All icon imports should eventually come through this module.
 */

export { extractSizeFromClassName, stripSizeClasses } from './adapter';
export { LUCIDE_TO_PHOSPHOR_MAP } from './mapping';

// Re-export Phosphor's Icon type as the canonical icon type for the app
export type { Icon as AppIcon, IconProps as AppIconProps } from '@phosphor-icons/react';
