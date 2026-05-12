import React from 'react';
import {
  Brain,
  Database,
  FileText,
  ImageSquare,
  MagnifyingGlass,
  Sparkle,
  Wrench,
  type Icon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CommonTooltip } from './CommonTooltip';

export interface ModelCapabilityIconFlags {
  isMultimodal?: boolean;
  isReasoning?: boolean;
  isEmbedding?: boolean;
  isReranker?: boolean;
  isImageGeneration?: boolean;
  supportsTools?: boolean;
}

export interface ModelCapabilityIconsProps extends ModelCapabilityIconFlags {
  className?: string;
  chipClassName?: string;
  iconClassName?: string;
  size?: 'xs' | 'sm';
  showTextOnly?: boolean;
}

type CapabilityDefinition = {
  active: boolean;
  icon: Icon;
  label: string;
  toneClass: string;
};

export const ModelCapabilityIcons: React.FC<ModelCapabilityIconsProps> = ({
  isMultimodal,
  isReasoning,
  isEmbedding,
  isReranker,
  isImageGeneration,
  supportsTools,
  className,
  chipClassName,
  iconClassName,
  size = 'sm',
  showTextOnly = false,
}) => {
  const { t } = useTranslation(['settings', 'common']);

  const definitions: CapabilityDefinition[] = [
    {
      active: showTextOnly && !isMultimodal,
      icon: FileText,
      label: t('common:api_config_section.model_types.text_only', 'Text only'),
      toneClass: 'border-border bg-muted/50 text-muted-foreground',
    },
    {
      active: !!isMultimodal,
      icon: ImageSquare,
      label: t('settings:api.modal.capabilities.multimodal.title', 'Multimodal model'),
      toneClass: 'border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-300',
    },
    {
      active: !!isReasoning,
      icon: Brain,
      label: t('settings:api.modal.capabilities.reasoning.title', 'Reasoning model'),
      toneClass: 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    },
    {
      active: !!supportsTools,
      icon: Wrench,
      label: t('settings:api.modal.capabilities.tools.title', 'Tool-calling support'),
      toneClass: 'border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-300',
    },
    {
      active: !!isEmbedding,
      icon: Database,
      label: t('settings:api.modal.capabilities.embedding.title', 'Embedding model'),
      toneClass: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    },
    {
      active: !!isReranker,
      icon: MagnifyingGlass,
      label: t('settings:api.modal.capabilities.reranker.title', 'Reranker model'),
      toneClass: 'border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-300',
    },
    {
      active: !!isImageGeneration,
      icon: Sparkle,
      label: t('settings:api.modal.capabilities.image_generation.title', 'Image generation model'),
      toneClass: 'border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-300',
    },
  ];

  const activeDefinitions = definitions.filter((definition) => definition.active);
  if (activeDefinitions.length === 0) return null;

  const iconSizeClass = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const chipSizeClass = size === 'xs' ? 'h-5 w-5' : 'h-6 w-6';
  const capabilityLabel = activeDefinitions.map((definition) => definition.label).join(', ');

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      aria-label={capabilityLabel}
    >
      {activeDefinitions.map(({ icon: Icon, label, toneClass }) => (
        <CommonTooltip key={label} content={label} position="top">
          <span
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-md border transition-colors',
              chipSizeClass,
              toneClass,
              chipClassName
            )}
            aria-label={label}
          >
            <Icon className={cn(iconSizeClass, iconClassName)} weight="regular" aria-hidden="true" />
          </span>
        </CommonTooltip>
      ))}
    </div>
  );
};

export default ModelCapabilityIcons;
