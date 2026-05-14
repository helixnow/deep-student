/**
 * Accent 色选择器
 *
 * Phase 3.1 重构：原先 8 张调色板卡片 + 1 张自选卡的网格被替换为
 * 单行圆点。这里只控制强调色（--primary / --ring），不影响任何
 * 中性色、背景、边框或输入框底色。
 *
 * 设计要点：
 * - 桌面 28px（h-7），移动端 44px（h-11），满足触控目标。
 * - 选中态：外环 `ring-foreground/50`，保证任何底色下有可见对比。
 * - 自选：原生 `<input type="color">`，通过 "+" 按钮显式触发 click，
 *   隐藏使用 sr-only 样式，避免 opacity:0 叠层导致 Tab 焦点错乱。
 * - 可达性：`role="radiogroup"` + 每个按钮 `role="radio"` +
 *   `aria-checked`；屏幕阅读器朗读色名。
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  PRESET_PALETTES,
  PALETTE_PREVIEW_COLORS,
  type ThemePalette,
} from '@/hooks/useTheme';

interface AccentPickerProps {
  palette: ThemePalette;
  customColor: string;
  onSelectPreset: (palette: ThemePalette) => void;
  onSelectCustomColor: (hex: string) => void;
  className?: string;
}

/**
 * 单个圆点按钮的基础 class。触控目标在移动端保持 44px，桌面压缩到 28px。
 * 关闭 NotionButton 默认的 size/variant 样式污染，只保留 focus-visible 行为。
 */
const DOT_BASE_CLASS =
  '!p-0 !h-11 !w-11 sm:!h-7 sm:!w-7 !min-w-0 ' +
  '!rounded-full relative inline-flex items-center justify-center ' +
  'transition-[box-shadow,transform,background-color] duration-150 ease-out ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export const AccentPicker: React.FC<AccentPickerProps> = ({
  palette,
  customColor,
  onSelectPreset,
  onSelectCustomColor,
  className,
}) => {
  const { t } = useTranslation();
  const colorInputRef = React.useRef<HTMLInputElement>(null);

  const openCustomColorPicker = React.useCallback(() => {
    colorInputRef.current?.click();
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label={t('settings:theme.accent_label', '强调色')}
      className={cn('flex flex-wrap items-center gap-2', className)}
    >
      {PRESET_PALETTES.map((paletteKey) => {
        const isSelected = palette === paletteKey;
        const accentHex = PALETTE_PREVIEW_COLORS[paletteKey];
        const colorName = t(`settings:theme.accent.${paletteKey}`, paletteKey);

        return (
          <NotionButton
            key={paletteKey}
            variant="ghost"
            role="radio"
            aria-checked={isSelected}
            aria-label={colorName}
            title={colorName}
            onClick={() => onSelectPreset(paletteKey)}
            className={cn(
              DOT_BASE_CLASS,
              isSelected
                ? '!ring-2 !ring-offset-2 !ring-offset-background !ring-foreground/60 shadow-sm'
                : 'hover:!ring-1 hover:!ring-foreground/25',
            )}
            style={{ backgroundColor: accentHex }}
            data-accent-key={paletteKey}
            data-slot="accent-dot"
          />
        );
      })}

      {/* 自选色：+ 按钮触发原生颜色面板 */}
      <NotionButton
        variant="ghost"
        role="radio"
        aria-checked={palette === 'custom'}
        aria-label={t('settings:theme.accent.custom', '自选色')}
        title={t('settings:theme.accent.custom', '自选色')}
        onClick={openCustomColorPicker}
        className={cn(
          DOT_BASE_CLASS,
          'border border-dashed border-border bg-background text-muted-foreground',
          palette === 'custom'
            ? '!ring-2 !ring-offset-2 !ring-offset-background !ring-foreground/60 border-transparent'
            : 'hover:border-foreground/40 hover:text-foreground',
        )}
        data-accent-key="custom"
        data-slot="accent-dot-custom"
      >
        {palette === 'custom' ? (
          <span
            aria-hidden="true"
            className="absolute inset-1 rounded-full"
            style={{ backgroundColor: customColor }}
          />
        ) : (
          <Plus size={14} aria-hidden="true" />
        )}
      </NotionButton>

      <input
        ref={colorInputRef}
        type="color"
        value={customColor}
        onChange={(e) => onSelectCustomColor(e.target.value)}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
};

export default AccentPicker;

