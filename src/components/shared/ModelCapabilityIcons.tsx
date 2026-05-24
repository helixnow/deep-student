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

  // Industry-best minimal treatment: monochrome icons differentiated by shape +
  // tooltip rather than per-capability hue. Inspired by Linear, Vercel, Cursor.
  const definitions: CapabilityDefinition[] = [
    {
      active: showTextOnly && !isMultimodal,
      icon: FileText,
      label: t('common:api_config_section.model_types.text_only', 'Text only'),
    },
    {
      active: !!isMultimodal,
      icon: ImageSquare,
      label: t('settings:api.modal.capabilities.multimodal.title', 'Multimodal model'),
    },
    {
      active: !!isReasoning,
      icon: Brain,
      label: t('settings:api.modal.capabilities.reasoning.title', 'Reasoning model'),
    },
    {
      active: !!supportsTools,
      icon: Wrench,
      label: t('settings:api.modal.capabilities.tools.title', 'Tool-calling support'),
    },
    {
      active: !!isEmbedding,
      icon: Database,
      label: t('settings:api.modal.capabilities.embedding.title', 'Embedding model'),
    },
    {
      active: !!isReranker,
      icon: MagnifyingGlass,
      label: t('settings:api.modal.capabilities.reranker.title', 'Reranker model'),
    },
    {
      active: !!isImageGeneration,
      icon: Sparkle,
      label: t('settings:api.modal.capabilities.image_generation.title', 'Image generation model'),
    },
  ];

  const activeDefinitions = definitions.filter((definition) => definition.active);
  if (activeDefinitions.length === 0) return null;

  const iconSizeClass = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const chipSizeClass = size === 'xs' ? 'h-5 w-5' : 'h-6 w-6';
  const capabilityLabel = activeDefinitions.map((definition) => definition.label).join(', ');

  return (
    <div
      className={cn('flex flex-wrap items-center gap-0.5', className)}
      aria-label={capabilityLabel}
    >
      {activeDefinitions.map(({ icon: Icon, label }) => (
        <CommonTooltip key={label} content={label} position="top">
          <span
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground',
              chipSizeClass,
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
