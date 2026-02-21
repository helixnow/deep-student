import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { useMindMapStore } from '../../store';
import { StyleRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import { 
  Palette, 
  ChevronDown, 
  Check, 
  Type, 
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  PaintBucket 
} from 'lucide-react';

// ============================================================================
// 预设颜色（统一引用共享常量）
// ============================================================================
import { FULL_TEXT_COLORS, FULL_BG_COLORS } from '../../constants';

const PRESET_COLORS = FULL_BG_COLORS as unknown as string[];
const TEXT_COLORS = FULL_TEXT_COLORS as unknown as string[];

// ============================================================================
// 子组件：颜色选择器
// ============================================================================
const ColorPicker: React.FC<{
  colors: string[];
  value?: string;
  onChange: (color: string) => void;
  label: string;
}> = ({ colors, value, onChange, label }) => (
  <div className="space-y-2">
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
    <div className="flex flex-wrap gap-1.5">
      {colors.map((color) => (
        <NotionButton variant="ghost"
          key={color}
          className={cn(
            "w-6 h-6 rounded-full border border-border transition-all hover:scale-110 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
            color === 'transparent' && "bg-transparent bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxwYXRoIGZpbGw9IiNjY2MiIGQ9Ik0wIDBoNHY0SDB6Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTQgMGg0djRINHoiLz48cGF0aCBmaWxsPSIjY2NjIiBkPSJNNSA1aDR2NEg1eiIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDRoNHY0SDB6Ii8+PC9zdmc+')]",
            value === color && "ring-2 ring-primary ring-offset-1 border-primary"
          )}
          style={{ backgroundColor: color !== 'transparent' && color !== 'inherit' ? color : undefined }}
          onClick={() => onChange(color)}
          title={color}
        >
          {color === 'inherit' && (
            <span className="flex items-center justify-center w-full h-full text-[10px] text-muted-foreground">A</span>
          )}
        </NotionButton>
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
  const [internalOpen, setInternalOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  
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
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, setIsOpen]);

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
    <div className="space-y-4">
      {/* 全局主题 */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">{t('style.globalTheme')}</h4>
        <div className="grid grid-cols-2 gap-2">
          {themes.map(theme => (
            <NotionButton variant="ghost"
              key={theme.id}
              onClick={() => setStyleId(theme.id)}
              className={cn(
                "flex items-center justify-between px-3 py-2 rounded-md text-sm border border-transparent transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                styleId === theme.id && "bg-primary/10 text-primary border-primary/20"
              )}
            >
              {t(theme.name)}
              {styleId === theme.id && <Check className="w-3 h-3" />}
            </NotionButton>
          ))}
        </div>
      </div>

      <div className="h-px bg-border" />

      {/* 节点样式 (仅当选中节点时显示) */}
      {focusedNode ? (
        <div className="space-y-4">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary" />
            {t('style.currentNodeStyle')}
          </h4>
          
          {/* 字号 */}
          <div className="flex items-center gap-2 bg-muted/50 p-1 rounded-md w-fit">
            <Type className="w-4 h-4 text-muted-foreground ml-1" />
            <input
              type="number"
              className="w-12 h-6 text-sm bg-transparent border-none text-center focus:ring-0"
              value={focusedNode.style?.fontSize || 14}
              onChange={(e) => handleNodeStyleUpdate({ fontSize: parseInt(e.target.value) })}
            />
          </div>

          {/* B / I / U / S */}
          <div className="flex items-center gap-1">
            {[
              { key: 'bold', icon: Bold, prop: 'fontWeight' as const, val: 'bold', cur: focusedNode.style?.fontWeight },
              { key: 'italic', icon: Italic, prop: 'fontStyle' as const, val: 'italic', cur: focusedNode.style?.fontStyle },
              { key: 'underline', icon: Underline, prop: 'textDecoration' as const, val: 'underline', cur: focusedNode.style?.textDecoration },
              { key: 'strikethrough', icon: Strikethrough, prop: 'textDecoration' as const, val: 'line-through', cur: focusedNode.style?.textDecoration },
            ].map(({ key, icon: Icon, prop, val, cur }) => (
              <NotionButton variant="ghost" key={key}
                onClick={() => handleNodeStyleUpdate({ [prop]: cur === val ? undefined : val })}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  cur === val
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent text-muted-foreground"
                )}
                title={t(`contextMenu.${key}`)}
              ><Icon className="w-4 h-4" /></NotionButton>
            ))}
          </div>

          {/* H1 / H2 / H3 / T */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t('contextMenu.headingLevel')}</div>
            <div className="flex items-center gap-1">
              {([['h1', Heading1], ['h2', Heading2], ['h3', Heading3]] as const).map(([level, Icon]) => (
                <NotionButton variant="ghost" key={level}
                  onClick={() => handleNodeStyleUpdate({ headingLevel: focusedNode.style?.headingLevel === level ? undefined : level })}
                  className={cn(
                    "p-1.5 rounded-md transition-colors",
                    focusedNode.style?.headingLevel === level
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent text-muted-foreground"
                  )}
                  title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
                ><Icon className="w-4 h-4" /></NotionButton>
              ))}
              <NotionButton variant="ghost"
                onClick={() => handleNodeStyleUpdate({ headingLevel: undefined })}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  !focusedNode.style?.headingLevel
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent text-muted-foreground"
                )}
                title={t('contextMenu.normalText')}
              ><Type className="w-4 h-4" /></NotionButton>
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
        <div className="text-sm text-muted-foreground text-center py-4 bg-muted/20 rounded-lg">
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
    <div className={cn('relative', className)}>
      {trigger ? (
        <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      ) : (
        <NotionButton variant="ghost"
          ref={triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg',
            'bg-background hover:bg-accent hover:text-accent-foreground',
            'border border-input',
            'transition-all duration-200',
            'text-sm font-medium',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
            isOpen && 'bg-accent text-accent-foreground'
          )}
        >
          <Palette className="w-4 h-4 text-muted-foreground" />
          <span>{t('toolbar.style')}</span>
          <ChevronDown className={cn('w-4 h-4 transition-transform duration-200', isOpen && 'rotate-180')} />
        </NotionButton>
      )}

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-transparent md:hidden" onClick={() => setIsOpen(false)} />
          <div
            ref={panelRef}
            className={cn(
              'absolute z-50',
              getPlacementStyles(),
              'w-[280px] p-4 rounded-xl shadow-lg',
              'bg-popover border border-border text-popover-foreground',
              'animate-in fade-in-0 zoom-in-95 duration-200',
              'max-md:fixed max-md:left-4 max-md:right-4 max-md:top-auto max-md:bottom-4 max-md:w-auto'
            )}
          >
            {panelContent}
          </div>
        </>
      )}
    </div>
  );
};
