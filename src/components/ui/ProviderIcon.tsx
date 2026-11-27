/**
 * 供应商图标组件
 * 基于 Lobe Icons + 本地资源降级
 */

import React, { useEffect, useState, useMemo } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import AzureColor from '@lobehub/icons/es/Azure/components/Color';
import AzureMono from '@lobehub/icons/es/Azure/components/Mono';
import BaichuanColor from '@lobehub/icons/es/Baichuan/components/Color';
import BailianColor from '@lobehub/icons/es/Bailian/components/Color';
import BailianMono from '@lobehub/icons/es/Bailian/components/Mono';
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color';
import DoubaoColor from '@lobehub/icons/es/Doubao/components/Color';
import DoubaoMono from '@lobehub/icons/es/Doubao/components/Mono';
import FalColor from '@lobehub/icons/es/Fal/components/Color';
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color';
import GeminiMono from '@lobehub/icons/es/Gemini/components/Mono';
import GrokMono from '@lobehub/icons/es/Grok/components/Mono';
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono';
import HuggingFaceColor from '@lobehub/icons/es/HuggingFace/components/Color';
import HunyuanColor from '@lobehub/icons/es/Hunyuan/components/Color';
import HunyuanMono from '@lobehub/icons/es/Hunyuan/components/Mono';
import InternLMColor from '@lobehub/icons/es/InternLM/components/Color';
import KimiColor from '@lobehub/icons/es/Kimi/components/Color';
import KimiMono from '@lobehub/icons/es/Kimi/components/Mono';
import KlingColor from '@lobehub/icons/es/Kling/components/Color';
import KlingMono from '@lobehub/icons/es/Kling/components/Mono';
import KwaipilotColor from '@lobehub/icons/es/Kwaipilot/components/Color';
import KwaipilotMono from '@lobehub/icons/es/Kwaipilot/components/Mono';
import LumaColor from '@lobehub/icons/es/Luma/components/Color';
import MetaColor from '@lobehub/icons/es/Meta/components/Color';
import MinimaxColor from '@lobehub/icons/es/Minimax/components/Color';
import MistralColor from '@lobehub/icons/es/Mistral/components/Color';
import NvidiaColor from '@lobehub/icons/es/Nvidia/components/Color';
import PerplexityColor from '@lobehub/icons/es/Perplexity/components/Color';
import ReplicateMono from '@lobehub/icons/es/Replicate/components/Mono';
import SenseNovaColor from '@lobehub/icons/es/SenseNova/components/Color';
import SenseNovaMono from '@lobehub/icons/es/SenseNova/components/Mono';
import SiliconCloudColor from '@lobehub/icons/es/SiliconCloud/components/Color';
import SiliconCloudMono from '@lobehub/icons/es/SiliconCloud/components/Mono';
import SparkColor from '@lobehub/icons/es/Spark/components/Color';
import SparkMono from '@lobehub/icons/es/Spark/components/Mono';
import StabilityColor from '@lobehub/icons/es/Stability/components/Color';
import StepfunColor from '@lobehub/icons/es/Stepfun/components/Color';
import TogetherColor from '@lobehub/icons/es/Together/components/Color';
import TogetherMono from '@lobehub/icons/es/Together/components/Mono';
import UdioColor from '@lobehub/icons/es/Udio/components/Color';
import WenxinColor from '@lobehub/icons/es/Wenxin/components/Color';
import WenxinMono from '@lobehub/icons/es/Wenxin/components/Mono';
import YiColor from '@lobehub/icons/es/Yi/components/Color';
import YiMono from '@lobehub/icons/es/Yi/components/Mono';
import ZhipuColor from '@lobehub/icons/es/Zhipu/components/Color';
import { AVATAR_BACKGROUND as ANTHROPIC_AVATAR_BACKGROUND, AVATAR_COLOR as ANTHROPIC_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as ANTHROPIC_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Anthropic/style';
import { AVATAR_BACKGROUND as BAAI_AVATAR_BACKGROUND, AVATAR_COLOR as BAAI_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as BAAI_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/BAAI/style';
import { AVATAR_BACKGROUND as FLUX_AVATAR_BACKGROUND, AVATAR_COLOR as FLUX_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as FLUX_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Flux/style';
import { AVATAR_BACKGROUND as GROK_AVATAR_BACKGROUND, AVATAR_COLOR as GROK_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as GROK_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Grok/style';
import { AVATAR_BACKGROUND as IDEOGRAM_AVATAR_BACKGROUND, AVATAR_COLOR as IDEOGRAM_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as IDEOGRAM_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Ideogram/style';
import { AVATAR_BACKGROUND as MIDJOURNEY_AVATAR_BACKGROUND, AVATAR_COLOR as MIDJOURNEY_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as MIDJOURNEY_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Midjourney/style';
import { AVATAR_BACKGROUND as OLLAMA_AVATAR_BACKGROUND, AVATAR_COLOR as OLLAMA_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as OLLAMA_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Ollama/style';
import { AVATAR_BACKGROUND as OPENAI_AVATAR_BACKGROUND, AVATAR_COLOR as OPENAI_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as OPENAI_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/OpenAI/style';
import { AVATAR_BACKGROUND as PIKA_AVATAR_BACKGROUND, AVATAR_COLOR as PIKA_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as PIKA_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Pika/style';
import { AVATAR_BACKGROUND as REPLICATE_AVATAR_BACKGROUND, AVATAR_COLOR as REPLICATE_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as REPLICATE_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Replicate/style';
import { AVATAR_BACKGROUND as RUNWAY_AVATAR_BACKGROUND, AVATAR_COLOR as RUNWAY_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as RUNWAY_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Runway/style';
import { AVATAR_BACKGROUND as SUNO_AVATAR_BACKGROUND, AVATAR_COLOR as SUNO_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as SUNO_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Suno/style';
import { AVATAR_BACKGROUND as XIAOMI_MIMO_AVATAR_BACKGROUND, AVATAR_COLOR as XIAOMI_MIMO_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as XIAOMI_MIMO_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/XiaomiMiMo/style';
import { AVATAR_BACKGROUND as KIMI_AVATAR_BACKGROUND, AVATAR_COLOR as KIMI_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as KIMI_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Kimi/style';
import { AVATAR_BACKGROUND as ZHIPU_AVATAR_BACKGROUND, AVATAR_COLOR as ZHIPU_AVATAR_COLOR, AVATAR_ICON_MULTIPLE as ZHIPU_AVATAR_ICON_MULTIPLE } from '@lobehub/icons/es/Zhipu/style';
import { getProviderInfo, type ProviderBrand } from '../../utils/providerIconEngine';
import { lobeIconData } from '../../utils/lobeIconData';

export interface ProviderIconProps {
  modelId: string;
  size?: number;
  showName?: boolean;
  namePosition?: 'right' | 'bottom';
  className?: string;
  style?: React.CSSProperties;
  fallbackIcon?: React.ReactNode;
  onClick?: () => void;
  showTooltip?: boolean;
  variant?: 'mono' | 'color';
  /**
   * - `default`: 彩色模式下为需要底板的品牌（如 OpenAI/Kimi/智谱）自动包裹品牌色圆底
   * - `glyph`: 无底板裸字形，面向当前亮/暗主题表面自适应对比度（不硬编码纯白/纯黑主体）
   * - `plate-glyph`: 外部已使用 `getProviderBadgeChromeStyle` 铺设品牌底板时的内嵌字形
   */
  renderMode?: 'default' | 'glyph' | 'plate-glyph';
}

const KIMI_BRAND_DOT_HEX = '#1783FF';

/**
 * Kimi 无底板自适应双色字形：
 * `@lobehub/icons` 的 `Kimi/Color` 为黑底硬编码了 `fill="#fff"`，在亮色背景上会隐形；
 * 无底板场景保留品牌蓝点，字母 K 跟随 `currentColor` 适配亮暗色主题。
 */
const KimiAdaptiveGlyph: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <svg
    aria-hidden="true"
    height={size}
    width={size}
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    style={{ flex: 'none', lineHeight: 1, ...style }}
  >
    <path
      d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"
      fill={KIMI_BRAND_DOT_HEX}
    />
    <path
      d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"
      fill="currentColor"
    />
  </svg>
);

const GLYPH_COLOR_LOBE_COMPONENTS: Partial<Record<ProviderBrand, React.ComponentType<any>>> = {
  moonshot: KimiAdaptiveGlyph,
  zhipu: ZhipuColor,
};

export const isGenericProviderIconPath = (iconPath?: string | null): boolean =>
  Boolean(iconPath?.includes('/icons/providers/generic.svg'));

const UnknownFallbackGlyph: React.FC<{ size: number }> = ({ size }) => (
  <Sparkle
    aria-hidden="true"
    size={size}
    strokeWidth={2.1}
    style={{
      color: 'hsl(var(--muted-foreground))',
      flexShrink: 0,
      opacity: 0.82,
    }}
/>
);

const COLOR_LOBE_COMPONENTS: Partial<Record<ProviderBrand, React.ComponentType<any>>> = {
  google: GeminiColor,
  meta: MetaColor,
  mistral: MistralColor,
  microsoft: AzureColor,
  nvidia: NvidiaColor,
  deepseek: DeepSeekColor,
  qwen: BailianColor,
  alibaba: BailianColor,
  bytedance: DoubaoColor,
  tencent: HunyuanColor,
  kuaishou: KlingColor,
  baidu: WenxinColor,
  xfyun: SparkColor,
  senseTime: SenseNovaColor,
  minimax: MinimaxColor,
  '01ai': YiColor,
  baichuan: BaichuanColor,
  stepfun: StepfunColor,
  internlm: InternLMColor,
  kwaipilot: KwaipilotColor,
  stability: StabilityColor,
  luma: LumaColor,
  fal: FalColor,
  udio: UdioColor,
  siliconflow: SiliconCloudColor,
  huggingface: HuggingFaceColor,
  together: TogetherColor,
  perplexity: PerplexityColor,
};

const AVATAR_LIKE_STYLES: Partial<Record<ProviderBrand, {
  background: string;
  color: string;
  iconMultiple: number;
  iconComponent?: React.ComponentType<any>;
  withContrastRing?: boolean;
}>> = {
  openai: {
    background: OPENAI_AVATAR_BACKGROUND,
    color: OPENAI_AVATAR_COLOR,
    iconMultiple: OPENAI_AVATAR_ICON_MULTIPLE,
  },
  anthropic: {
    background: ANTHROPIC_AVATAR_BACKGROUND,
    color: ANTHROPIC_AVATAR_COLOR,
    iconMultiple: ANTHROPIC_AVATAR_ICON_MULTIPLE,
  },
  xai: {
    background: GROK_AVATAR_BACKGROUND,
    color: GROK_AVATAR_COLOR,
    iconMultiple: GROK_AVATAR_ICON_MULTIPLE,
  },
  mimo: {
    background: XIAOMI_MIMO_AVATAR_BACKGROUND,
    color: XIAOMI_MIMO_AVATAR_COLOR,
    iconMultiple: XIAOMI_MIMO_AVATAR_ICON_MULTIPLE,
  },
  baai: {
    background: BAAI_AVATAR_BACKGROUND,
    color: BAAI_AVATAR_COLOR,
    iconMultiple: BAAI_AVATAR_ICON_MULTIPLE,
  },
  midjourney: {
    background: MIDJOURNEY_AVATAR_BACKGROUND,
    color: MIDJOURNEY_AVATAR_COLOR,
    iconMultiple: MIDJOURNEY_AVATAR_ICON_MULTIPLE,
  },
  runway: {
    background: RUNWAY_AVATAR_BACKGROUND,
    color: RUNWAY_AVATAR_COLOR,
    iconMultiple: RUNWAY_AVATAR_ICON_MULTIPLE,
  },
  pika: {
    background: PIKA_AVATAR_BACKGROUND,
    color: PIKA_AVATAR_COLOR,
    iconMultiple: PIKA_AVATAR_ICON_MULTIPLE,
  },
  flux: {
    background: FLUX_AVATAR_BACKGROUND,
    color: FLUX_AVATAR_COLOR,
    iconMultiple: FLUX_AVATAR_ICON_MULTIPLE,
  },
  ideogram: {
    background: IDEOGRAM_AVATAR_BACKGROUND,
    color: IDEOGRAM_AVATAR_COLOR,
    iconMultiple: IDEOGRAM_AVATAR_ICON_MULTIPLE,
  },
  replicate: {
    background: REPLICATE_AVATAR_BACKGROUND,
    color: REPLICATE_AVATAR_COLOR,
    iconMultiple: REPLICATE_AVATAR_ICON_MULTIPLE,
  },
  suno: {
    background: SUNO_AVATAR_BACKGROUND,
    color: SUNO_AVATAR_COLOR,
    iconMultiple: SUNO_AVATAR_ICON_MULTIPLE,
  },
  ollama: {
    background: OLLAMA_AVATAR_BACKGROUND,
    color: OLLAMA_AVATAR_COLOR,
    iconMultiple: OLLAMA_AVATAR_ICON_MULTIPLE,
  },
  moonshot: {
    background: KIMI_AVATAR_BACKGROUND,
    color: KIMI_AVATAR_COLOR,
    iconComponent: KimiColor,
    iconMultiple: KIMI_AVATAR_ICON_MULTIPLE,
    withContrastRing: true,
  },
  zhipu: {
    background: ZHIPU_AVATAR_BACKGROUND,
    color: ZHIPU_AVATAR_COLOR,
    iconMultiple: ZHIPU_AVATAR_ICON_MULTIPLE,
    withContrastRing: true,
  },
};

const MONO_LOBE_COMPONENTS: Partial<Record<ProviderBrand, React.ComponentType<any>>> = {
  google: GeminiMono,
  xai: GrokMono,
  opencode: OpenCodeMono,
  microsoft: AzureMono,
  qwen: BailianMono,
  alibaba: BailianMono,
  bytedance: DoubaoMono,
  tencent: HunyuanMono,
  moonshot: KimiMono,
  kuaishou: KlingMono,
  baidu: WenxinMono,
  xfyun: SparkMono,
  senseTime: SenseNovaMono,
  '01ai': YiMono,
  kwaipilot: KwaipilotMono,
  replicate: ReplicateMono,
  siliconflow: SiliconCloudMono,
  together: TogetherMono,
};

export const getProviderBadgeChromeStyle = (modelId: string): React.CSSProperties => {
  const providerInfo = getProviderInfo(modelId);
  const avatarLikeStyle = AVATAR_LIKE_STYLES[providerInfo.brand];

  if (avatarLikeStyle) {
    return {
      background: avatarLikeStyle.background,
      border: '1px solid hsl(var(--border) / 0.72)',
      boxShadow: avatarLikeStyle.withContrastRing ? '0 0 0 1px hsl(var(--border) / 0.36) inset' : undefined,
    };
  }

  return {
    background: 'hsl(var(--background))',
    border: '1px solid hsl(var(--border) / 0.72)',
  };
};

const LobeSvgIcon: React.FC<{ brand: ProviderBrand; size: number; style?: React.CSSProperties }> = ({ brand, size, style }) => {
  const MonoComponent = MONO_LOBE_COMPONENTS[brand];
  if (MonoComponent) {
    return <MonoComponent size={size} aria-hidden="true" style={style} />;
  }

  const data = lobeIconData[brand];
  if (!data) return null;

  return (
    <svg
      height={size}
      width={size}
      viewBox={data.v}
      xmlns="http://www.w3.org/2000/svg"
      style={{ flex: 'none', lineHeight: 1, ...style }}
    >
      {data.p.map((d, i) => (
        <path key={i} d={d} fill={data.f[i] || data.f[0] || 'currentColor'} />
      ))}
    </svg>
  );
};

export const ProviderIcon: React.FC<ProviderIconProps> = ({
  modelId,
  size = 24,
  showName = false,
  namePosition = 'right',
  className = '',
  style = {},
  fallbackIcon,
  onClick,
  showTooltip = true,
  variant = 'mono',
  renderMode = 'default',
}) => {
  const providerInfo = getProviderInfo(modelId);
  const hasIcon = !!providerInfo.iconPath;
  const hasLobeMonoIcon = !!MONO_LOBE_COMPONENTS[providerInfo.brand] || !!lobeIconData[providerInfo.brand];
  const useColorIcon = variant === 'color';
  const [iconLoadFailed, setIconLoadFailed] = useState(false);

  useEffect(() => {
    setIconLoadFailed(false);
  }, [providerInfo.brand, providerInfo.iconPath]);

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: namePosition === 'right' ? 'center' : 'flex-start',
    flexDirection: namePosition === 'right' ? 'row' : 'column',
    gap: namePosition === 'right' ? '8px' : '4px',
    cursor: onClick ? 'pointer' : 'default',
    ...style,
  };

  const iconElement = useMemo(() => {
    if (useColorIcon) {
      if (renderMode === 'plate-glyph') {
        const ColorComponent = COLOR_LOBE_COMPONENTS[providerInfo.brand];
        if (ColorComponent) {
          return <ColorComponent size={size} aria-hidden="true" />;
        }

        const avatarLikeStyle = AVATAR_LIKE_STYLES[providerInfo.brand];
        if (avatarLikeStyle) {
          const AvatarLikeIcon = avatarLikeStyle.iconComponent;
          const glyphStyle = { transform: `scale(${avatarLikeStyle.iconMultiple})` };

          if (AvatarLikeIcon) {
            return <AvatarLikeIcon size={size} aria-hidden="true" style={glyphStyle} />;
          }

          return (
            <LobeSvgIcon
              brand={providerInfo.brand}
              size={size}
              style={{
                color: avatarLikeStyle.color,
                ...glyphStyle,
              }}
            />
          );
        }
      }

      if (renderMode === 'glyph') {
        const ColorComponent = COLOR_LOBE_COMPONENTS[providerInfo.brand];
        if (ColorComponent) {
          return <ColorComponent size={size} aria-hidden="true" />;
        }

        const AdaptiveGlyphComponent = GLYPH_COLOR_LOBE_COMPONENTS[providerInfo.brand];
        if (AdaptiveGlyphComponent) {
          return <AdaptiveGlyphComponent size={size} aria-hidden="true" />;
        }

        if (AVATAR_LIKE_STYLES[providerInfo.brand]) {
          return <LobeSvgIcon brand={providerInfo.brand} size={size} />;
        }
      }

      const ColorComponent = COLOR_LOBE_COMPONENTS[providerInfo.brand];
      if (ColorComponent) {
        return <ColorComponent size={size} aria-hidden="true" />;
      }

      const avatarLikeStyle = AVATAR_LIKE_STYLES[providerInfo.brand];
      if (avatarLikeStyle) {
        const AvatarLikeIcon = avatarLikeStyle.iconComponent;
        return (
          <span
            aria-hidden="true"
            style={{
              alignItems: 'center',
              background: avatarLikeStyle.background,
              borderRadius: '50%',
              boxShadow: avatarLikeStyle.withContrastRing ? '0 0 0 1px hsl(var(--border))' : undefined,
              color: avatarLikeStyle.color,
              display: 'inline-flex',
              flex: 'none',
              height: size,
              justifyContent: 'center',
              width: size,
            }}
          >
            {AvatarLikeIcon ? (
              <AvatarLikeIcon
                size={size}
                aria-hidden="true"
                style={{ transform: `scale(${avatarLikeStyle.iconMultiple})` }}
/>
            ) : (
              <LobeSvgIcon
                brand={providerInfo.brand}
                size={size}
                style={{ transform: `scale(${avatarLikeStyle.iconMultiple})` }}
/>
            )}
          </span>
        );
      }
    }

    if (hasLobeMonoIcon) {
      return <LobeSvgIcon brand={providerInfo.brand} size={size} />;
    }

    // 降级到本地 SVG 图标
    if (hasIcon && !iconLoadFailed) {
      return (
        <img
          src={providerInfo.iconPath}
          alt={providerInfo.displayName}
          style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
          onError={() => {
            console.warn(`Failed to load provider icon: ${providerInfo.iconPath}`);
            setIconLoadFailed(true);
          }}
/>
      );
    }

    return fallbackIcon || <UnknownFallbackGlyph size={size} />;
  }, [renderMode, useColorIcon, hasLobeMonoIcon, providerInfo.brand, hasIcon, iconLoadFailed, providerInfo.iconPath, providerInfo.displayName, size, fallbackIcon]);

  return (
    <div
      className={className}
      style={containerStyle}
      onClick={onClick}
      title={showTooltip ? providerInfo.displayName : undefined}
    >
      {iconElement}
      {showName && (
        <span
          style={{
            fontSize: size * 0.6,
            color: 'hsl(var(--foreground))',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {providerInfo.displayName}
        </span>
      )}
    </div>
  );
};

export interface ProviderIconBadgeProps extends Omit<ProviderIconProps, 'showName' | 'namePosition'> {
  backgroundColor?: string;
  borderColor?: string;
}

export const ProviderIconBadge: React.FC<ProviderIconBadgeProps> = ({
  modelId, size = 32, className = '', style = {},
  backgroundColor = 'transparent', borderColor = 'hsl(var(--border))',
  onClick, showTooltip = true, fallbackIcon,
}) => {
  const providerInfo = getProviderInfo(modelId);
  return (
    <div
      className={className}
      style={{
        width: size, height: size, borderRadius: '50%',
        backgroundColor, border: `1px solid ${borderColor}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: size * 0.15, boxSizing: 'border-box',
        cursor: onClick ? 'pointer' : 'default', flexShrink: 0, ...style,
      }}
      onClick={onClick}
      title={showTooltip ? providerInfo.displayName : undefined}
    >
      <ProviderIcon modelId={modelId} size={size * 0.7} showTooltip={false} fallbackIcon={fallbackIcon} />
    </div>
  );
};

export interface ProviderIconListProps {
  modelIds: string[];
  size?: number;
  maxDisplay?: number;
  gap?: number;
  overlap?: boolean;
  className?: string;
}

export const ProviderIconList: React.FC<ProviderIconListProps> = ({
  modelIds, size = 24, maxDisplay, gap = 4, overlap = false, className = '',
}) => {
  const displayIds = maxDisplay ? modelIds.slice(0, maxDisplay) : modelIds;
  const remainingCount = maxDisplay && modelIds.length > maxDisplay ? modelIds.length - maxDisplay : 0;

  const uniqueProviders = new Map<string, string>();
  for (const id of displayIds) {
    const info = getProviderInfo(id);
    if (!uniqueProviders.has(info.brand)) {
      uniqueProviders.set(info.brand, id);
    }
  }

  const overlapOffset = overlap ? -size * 0.3 : gap;

  return (
    <div className={className} style={{ display: 'flex', alignItems: 'center', gap: overlap ? 0 : gap }}>
      {Array.from(uniqueProviders.values()).map((modelId, index) => (
        <div key={modelId} style={{ marginLeft: index > 0 && overlap ? overlapOffset : 0, zIndex: displayIds.length - index }}>
          <ProviderIconBadge modelId={modelId} size={size} backgroundColor="hsl(var(--background))" />
        </div>
      ))}
      {remainingCount > 0 && (
        <div style={{
          width: size, height: size, borderRadius: '50%',
          backgroundColor: 'hsl(var(--muted))', border: '1px solid hsl(var(--border))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: size * 0.4, color: 'hsl(var(--muted-foreground))', fontWeight: 'bold',
          marginLeft: overlap ? overlapOffset : 0,
        }}>
          +{remainingCount}
        </div>
      )}
    </div>
  );
};
