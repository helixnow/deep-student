import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  BACK_PRIORITY,
  registerBackHandler,
} from '@/app/navigation/androidBackCoordinator';
import { useMindMapStore } from '../../store';
import { useMindMapIsActive } from '../../MindMapActiveContext';
import { StyleRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import { 
  Palette, 
  CaretDown, 
  Check, 
  TextT, 
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
} from '@phosphor-icons/react';

// ============================================================================
// 预设颜色（统一引用共享常量）
// ============================================================================
import { FULL_TEXT_COLORS, FULL_BG_COLORS } from '../../constants';
import type { IStyleTheme } from '../../registry/types';

const PRESET_COLORS = FULL_BG_COLORS as unknown as string[];
const TEXT_COLORS = FULL_TEXT_COLORS as unknown as string[];

// ============================================================================
// 子组件：主题缩略预览（画布底色 + 根节点色块 + 分支色板圆点）
// ============================================================================
const ThemeThumbnail: React.FC<{ theme: IStyleTheme }> = ({ theme }) => {
  const canvasBg = theme.canvas?.background || theme.canvasStyle?.background || 'var(--mm-bg)';
  const rootBg = theme.node?.root?.background || 'var(--mm-primary)';
  const palette = (theme.palette ?? []).slice(0, 4);
  return (
    <span
      aria-hidden
      className="inline-flex items-center gap-1 h-5 w-11 shrink-0 rounded-[4px] border border-[var(--mm-border)] px-1 overflow-hidden"
      style={{ background: canvasBg }}
    >
      <span
        className="h-2 w-3.5 shrink-0 rounded-[2px]"
        style={{ background: rootBg }}
      />
      <span className="flex items-center gap-0.5 min-w-0">
        {palette.map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: color }}
          />
        ))}
      </span>
    </span>
  );
};

// ============================================================================
// 子组件：颜色选择器
// ============================================================================
const ColorPicker: React.FC<{
  colors: string[];
  value?: string;
  onChange: (color: string) => void;
  label: string;
}> = ({ colors, value, onChange, label }) => (
  <div className="mm-style-color-section">
    <div className="mm-style-label">{label}</div>
    <div className="mm-style-swatches">
      {colors.map((color) => (
        <DsButton variant="ghost"
          key={color}
          className={cn(
            "mm-style-swatch",
            color === 'transparent' && "bg-transparent bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxwYXRoIGZpbGw9IiNjY2MiIGQ9Ik0wIDBoNHY0SDB6Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTQgMGg0djRINHoiLz48cGF0aCBmaWxsPSIjY2NjIiBkPSJNNSA1aDR2NEg1eiIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDRoNHY0SDB6Ii8+PC9zdmc+')]",
            value === color && "is-active"
          )}
          style={{ backgroundColor: color !== 'transparent' && color !== 'inherit' ? color : undefined }}
          onClick={() => onChange(color)}
          title={color}
        >
          {color === 'inherit' && (
            <span className="flex items-center justify-center w-full h-full text-[10px] text-muted-foreground">A</span>
          )}
        </DsButton>
      ))}
    </div>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================
export const StyleSettings: React.FC<{
  className?: string;
  trigger?: React.ReactNode;
  placement?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'inline';
  /** 受控模式：面板开关状态 */
  open?: boolean;
  /** 受控模式：面板开关状态变化回调 */
  onOpenChange?: (open: boolean) => void;
}> = ({ className, trigger, placement = 'bottom-right', open: controlledOpen, onOpenChange }) => {
  const { t } = useTranslation('mindmap');
  const isMindMapActive = useMindMapIsActive();
  const [internalOpen, setInternalOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  // 视口钳位：面板锚定触发按钮时的水平修正量（px）
  const [clampOffset, setClampOffset] = useState(0);
  const clampOffsetRef = useRef(0);

  // 受控/非受控模式
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const setIsOpen = React.useCallback((next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [isControlled, onOpenChange]);

  // inline 模式下始终显示面板
  const isInline = placement === 'inline';

  // Store actions
  const styleId = useMindMapStore((s) => s.styleId);
  const setStyleId = useMindMapStore((s) => s.setStyleId);
  const focusedNodeId = useMindMapStore((s) => s.focusedNodeId);
  const updateNode = useMindMapStore((s) => s.updateNode);
  const mindMapDocument = useMindMapStore((s) => s.document);

  // 获取当前选中节点
  const focusedNode = useMemo(() => {
    if (!focusedNodeId || !mindMapDocument?.root) return null;
    
    // 简单的 DFS 查找
    const findNode = (node: any): any => {
      if (node.id === focusedNodeId) return node;
      if (node.children) {
        for (const child of node.children) {
          const result = findNode(child);
          if (result) return result;
        }
      }
      return null;
    };
    
    return findNode(mindMapDocument.root);
  }, [focusedNodeId, mindMapDocument]);

  // 确保模块已初始化
  useEffect(() => {
    ensureInitialized();
  }, []);

  // 获取所有主题
  const themes = useMemo(() => {
    return StyleRegistry.getAll();
  }, []);

  // 处理样式更新
  const handleNodeStyleUpdate = (updates: any) => {
    if (!focusedNodeId) return;
    updateNode(focusedNodeId, {
      style: {
        ...focusedNode?.style,
        ...updates
      }
    });
  };

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, setIsOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setIsOpen]);

  useEffect(() => {
    if (!isOpen || isInline || !isMindMapActive) return;
    return registerBackHandler(() => {
      setIsOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isInline, isMindMapActive, isOpen, setIsOpen]);

  // 视口钳位：锚定面板贴近窗口边缘时向内平移，防止右缘/左缘被裁切
  // 用独立的 translate 属性修正，避免与 ui-zoom-fade-in 的 transform 动画互相覆盖
  useLayoutEffect(() => {
    if (!isOpen || isInline) {
      clampOffsetRef.current = 0;
      setClampOffset(0);
      return;
    }
    const measure = () => {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 8;
      // 先扣掉上一次修正量，还原面板的自然锚定位置再重新计算
      const naturalLeft = rect.left - clampOffsetRef.current;
      const naturalRight = rect.right - clampOffsetRef.current;
      let next = 0;
      if (naturalRight > window.innerWidth - margin) {
        next = window.innerWidth - margin - naturalRight;
      }
      if (naturalLeft + next < margin) {
        next = margin - naturalLeft;
      }
      if (next !== clampOffsetRef.current) {
        clampOffsetRef.current = next;
        setClampOffset(next);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isOpen, isInline]);

  const getPlacementStyles = () => {
    switch (placement) {
      case 'bottom-left': return 'top-full left-0 mt-2';
      case 'top-left': return 'bottom-full left-0 mb-2';
      case 'top-right': return 'bottom-full right-0 mb-2';
      case 'inline': return ''; // inline 模式不需要定位
      case 'bottom-right': default: return 'top-full right-0 mt-2';
    }
  };

  // 面板内容（共用）
  const panelContent = (
    <div className="mm-style-panel">
      {/* 全局主题 */}
      <div>
        <h4 className="mm-style-heading">{t('style.globalTheme')}</h4>
        <div className="mm-theme-list">
          {themes.map(theme => (
            <DsButton variant="ghost"
              key={theme.id}
              onClick={() => setStyleId(theme.id)}
              className={cn(
                "mm-theme-option",
                styleId === theme.id && "is-active"
              )}
              aria-pressed={styleId === theme.id}
            >
              <span className="inline-flex items-center gap-2 min-w-0">
                <ThemeThumbnail theme={theme} />
                <span className="truncate">{t(theme.name)}</span>
              </span>
              {styleId === theme.id && <Check className="w-3 h-3 shrink-0" />}
            </DsButton>
          ))}
        </div>
      </div>

      <div className="mm-panel-separator" />

      {/* 节点样式 (仅当选中节点时显示) */}
      {focusedNode ? (
        <div className="mm-node-style-section">
          <h4 className="mm-style-heading">
            {t('style.currentNodeStyle')}
          </h4>
          
          {/* 字号 */}
          <div className="mm-font-size-control">
            <TextT className="w-4 h-4 text-muted-foreground ml-1" />
            <input
              type="number"
              min={8}
              max={72}
              step={1}
              inputMode="numeric"
              className="mm-font-size-input"
              value={focusedNode.style?.fontSize || 14}
              onChange={(e) => {
                const value = e.currentTarget.valueAsNumber;
                if (!Number.isFinite(value)) return;
                handleNodeStyleUpdate({ fontSize: Math.min(72, Math.max(8, value)) });
              }}
            />
          </div>

          {/* B / I / U / S */}
          <div className="mm-style-button-row">
            {[
              { key: 'bold', icon: TextB, prop: 'fontWeight' as const, val: 'bold', cur: focusedNode.style?.fontWeight },
              { key: 'italic', icon: TextItalic, prop: 'fontStyle' as const, val: 'italic', cur: focusedNode.style?.fontStyle },
              { key: 'underline', icon: TextUnderline, prop: 'textDecoration' as const, val: 'underline', cur: focusedNode.style?.textDecoration },
              { key: 'strikethrough', icon: TextStrikethrough, prop: 'textDecoration' as const, val: 'line-through', cur: focusedNode.style?.textDecoration },
            ].map(({ key, icon: Icon, prop, val, cur }) => (
              <DsButton variant="ghost" key={key}
                onClick={() => handleNodeStyleUpdate({ [prop]: cur === val ? undefined : val })}
                className={cn(
                  "mm-style-icon-button",
                  cur === val
                    ? "is-active"
                    : ""
                )}
                title={t(`contextMenu.${key}`)}
              ><Icon className="w-4 h-4" /></DsButton>
            ))}
          </div>

          {/* H1 / H2 / H3 / T */}
          <div>
            <div className="mm-style-label">{t('contextMenu.headingLevel')}</div>
            <div className="mm-style-button-row">
              {([['h1', TextHOne], ['h2', TextHTwo], ['h3', TextHThree]] as const).map(([level, Icon]) => (
                <DsButton variant="ghost" key={level}
                  onClick={() => handleNodeStyleUpdate({ headingLevel: focusedNode.style?.headingLevel === level ? undefined : level })}
                  className={cn(
                    "mm-style-icon-button",
                    focusedNode.style?.headingLevel === level
                      ? "is-active"
                      : ""
                  )}
                  title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
                ><Icon className="w-4 h-4" /></DsButton>
              ))}
              <DsButton variant="ghost"
                onClick={() => handleNodeStyleUpdate({ headingLevel: undefined })}
                className={cn(
                  "mm-style-icon-button",
                  !focusedNode.style?.headingLevel
                    ? "is-active"
                    : ""
                )}
                title={t('contextMenu.normalText')}
              ><TextT className="w-4 h-4" /></DsButton>
            </div>
          </div>

          {/* 文本颜色 */}
          <ColorPicker 
            label={t('style.textColor')}
            colors={TEXT_COLORS}
            value={focusedNode.style?.textColor || 'inherit'}
            onChange={(color) => handleNodeStyleUpdate({ textColor: color })}
          />

          {/* 背景颜色 */}
          <ColorPicker 
            label={t('style.bgColor')}
            colors={PRESET_COLORS}
            value={focusedNode.style?.bgColor || 'transparent'}
            onChange={(color) => handleNodeStyleUpdate({ bgColor: color })}
          />
        </div>
      ) : (
        <div className="mm-style-empty">
          {t('style.selectNodeHint')}
        </div>
      )}
    </div>
  );

  // inline 模式：直接渲染面板内容
  if (isInline) {
    return (
      <div className={cn('p-2', className)}>
        {panelContent}
      </div>
    );
  }

  return (
    <div ref={triggerRef} className={cn('relative', className)}>
      {trigger ? (
        <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      ) : (
        <DsButton variant="ghost"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'flex items-center gap-2 px-2 h-7 rounded',
            'bg-transparent hover:bg-[var(--mm-bg-hover)]',
            'border border-transparent',
            'transition-colors duration-100',
            'text-sm text-[var(--mm-text-secondary)]',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--mm-primary)]',
            isOpen && 'bg-[var(--mm-bg-hover)] text-[var(--mm-text)]'
          )}
        >
          <Palette className="w-4 h-4 text-muted-foreground" />
          <span>{t('toolbar.style')}</span>
          <CaretDown className={cn('w-4 h-4 transition-transform duration-200', isOpen && 'rotate-180')} />
        </DsButton>
      )}

      {/* 弹出面板（桌面锚定 popover；窄屏由外壳的 inline 子屏承载，不再走底部 sheet + 遮罩） */}
      {isOpen && (
        <div
          ref={panelRef}
          className={cn(
            'absolute z-50',
            getPlacementStyles(),
            'mm-settings-popover mm-style-popover',
            'ui-zoom-fade-in'
          )}
          style={clampOffset !== 0 ? { translate: `${clampOffset}px 0` } : undefined}
          role="dialog"
          aria-label={t('style.globalTheme')}
        >
          {panelContent}
        </div>
      )}
    </div>
  );
};
