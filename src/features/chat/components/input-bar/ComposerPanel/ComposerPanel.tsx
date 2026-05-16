/**
 * ComposerPanel - 输入栏弹出层内部结构骨架（primitives）
 *
 * 这一组组件不负责浮层定位（那是 ComposerPanelOverlay 的职责），而是统一所有
 * 「composer panel」内容的视觉与交互骨架：Header / Search / Section / Row /
 * SelectionIndicator / Empty / Loading / Footer。所有面板（模型 / 生图 / 技能 /
 * MCP / 对话控制）共享相同的间距、圆角、强调色与无障碍语义。
 *
 * 强调色 token 链（和 ComposerToolButton active、ModelPicker 行选中保持一致）:
 *   选中态  : --button-primary-border / --button-primary-surface / --button-primary-foreground
 *   hover  : --menu-shell-row-hover (= --interactive-hover)
 *   focus  : --composer-panel-focus-border (= --button-primary-border)
 *
 * 业界参考:
 *   - ChatGPT model picker / Linear command palette / Cursor @mention
 *   - "tinted chip + filled glyph" 范式：低对比的强调色块 + 强对比的标记符号
 *
 * 为什么不直接复用 AppMenu / DropdownMenu？
 *   composer panel 通常包含搜索、双栏、多分组、底部 sticky 操作，比菜单语义更
 *   接近一个轻量 dialog；AppMenu 那一套钩子（focus 管理、roving tab）反而是
 *   阻碍。这里只共享视觉骨架。
 */
import * as React from 'react';
import {
  CaretDown,
  CaretRight,
  Check,
  CircleNotch,
  MagnifyingGlass,
  X,
  type Icon,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';

// ============================================================================
// Root —— 通用 flex 容器，统一上下间距
// ============================================================================

export interface ComposerPanelRootProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 是否充满父容器高度（heightMode='available' 的面板需要） */
  fillHeight?: boolean;
}

const Root = React.forwardRef<HTMLDivElement, ComposerPanelRootProps>(
  ({ className, fillHeight, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex min-h-0 flex-col gap-3',
        fillHeight && 'h-full',
        className
      )}
      {...props}
    />
  )
);
Root.displayName = 'ComposerPanel.Root';

// ============================================================================
// Header —— icon + 标题 + 副标题 + 右侧操作 + 关闭
// ============================================================================

export interface ComposerPanelHeaderProps {
  icon?: Icon;
  iconNode?: React.ReactNode;
  title: React.ReactNode;
  /** 副标题/补充说明，紧跟标题后以 · 分隔显示 */
  subtitle?: React.ReactNode;
  /** 数量徽章（同 ComposerToolButton 的 badge 视觉） */
  count?: number;
  /** 右侧自定义操作（刷新 / 设置 / 模式开关等） */
  actions?: React.ReactNode;
  /** 关闭回调；不传不显示关闭按钮 */
  onClose?: () => void;
  closeAriaLabel?: string;
  className?: string;
}

const Header: React.FC<ComposerPanelHeaderProps> = ({
  icon: IconComponent,
  iconNode,
  title,
  subtitle,
  count,
  actions,
  onClose,
  closeAriaLabel = 'Close',
  className,
}) => {
  const showCount = typeof count === 'number' && count > 0;
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {iconNode ?? (IconComponent ? (
          <IconComponent
            size={16}
            weight="bold"
            className="shrink-0 text-[color:var(--composer-panel-foreground)]"
            aria-hidden="true"
          />
        ) : null)}
        <span className="shrink-0 text-[13px] font-semibold text-[color:var(--composer-panel-foreground)]">
          {title}
        </span>
        {showCount ? (
          <span
            className={cn(
              'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1',
              'border border-[color:var(--button-primary-border)]',
              'bg-[color:var(--button-primary-surface)]',
              'text-[10px] font-semibold leading-none tabular-nums',
              'text-[color:var(--button-primary-foreground)]'
            )}
            aria-hidden="true"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
        {subtitle != null && subtitle !== '' ? (
          <span className="truncate text-[11.5px] text-[color:var(--composer-panel-muted-foreground)]">
            · {subtitle}
          </span>
        ) : null}
      </div>
      {(actions || onClose) && (
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {onClose ? (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={onClose}
              aria-label={closeAriaLabel}
              title={closeAriaLabel}
            >
              <X size={16} />
            </NotionButton>
          ) : null}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Search —— 放大镜 + Input + 可选清除按钮
// ============================================================================

export interface ComposerPanelSearchProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
  /** 末尾插入的自定义节点（如 fuzzy 切换） */
  endAdornment?: React.ReactNode;
}

const Search: React.FC<ComposerPanelSearchProps> = ({
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
  className,
  inputClassName,
  endAdornment,
}) => {
  const showClear = !!value && !disabled;
  return (
    <div className={cn('relative shrink-0', className)}>
      <MagnifyingGlass
        size={12}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--composer-panel-muted-foreground)]"
        aria-hidden="true"
      />
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel ?? placeholder}
        className={cn(
          'h-8 w-full pl-7 text-xs',
          'border-[color:var(--composer-panel-control-border)] bg-[color:var(--composer-panel-control-surface)]',
          'placeholder:text-[color:var(--composer-panel-placeholder)]',
          'focus-visible:border-[color:var(--composer-panel-focus-border)]',
          showClear || endAdornment ? 'pr-8' : 'pr-2',
          inputClassName
        )}
      />
      {(showClear || endAdornment) && (
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {showClear ? (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => onChange('')}
              aria-label="Clear search"
              className="!h-5 !w-5"
            >
              <X size={12} />
            </NotionButton>
          ) : null}
          {endAdornment}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Section —— 可折叠分组（vendor / 类别 / 状态分组）
// ============================================================================

export interface ComposerPanelSectionProps {
  /** 分组 ID（可选，便于受控折叠） */
  id?: string;
  /** 分组标题；undefined 时不渲染 heading 直接渲染内容 */
  label?: React.ReactNode;
  /** 总数量（显示在 label 后） */
  count?: number;
  /** 已选数量（>0 时显示强调色徽章） */
  selectedCount?: number;
  /** 是否可折叠 */
  collapsible?: boolean;
  /** 受控折叠状态 */
  collapsed?: boolean;
  /** 折叠状态变化 */
  onToggleCollapsed?: () => void;
  /** 右侧自定义操作 */
  trailing?: React.ReactNode;
  /** 内容内边距（默认 pl-1） */
  bodyClassName?: string;
  className?: string;
  children?: React.ReactNode;
}

const Section: React.FC<ComposerPanelSectionProps> = ({
  label,
  count,
  selectedCount,
  collapsible,
  collapsed,
  onToggleCollapsed,
  trailing,
  bodyClassName,
  className,
  children,
}) => {
  const showHeading = label !== undefined;
  const isCollapsed = collapsible ? !!collapsed : false;

  return (
    <div className={cn('space-y-0.5', className)}>
      {showHeading && (
        <div
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
            collapsible && 'cursor-pointer hover:bg-[color:var(--menu-shell-row-hover)]'
          )}
          {...(collapsible
            ? {
                role: 'button',
                tabIndex: 0,
                onClick: onToggleCollapsed,
                onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onToggleCollapsed?.();
                  }
                },
                'aria-expanded': !isCollapsed,
              }
            : {})}
        >
          {collapsible ? (
            isCollapsed ? (
              <CaretRight
                size={14}
                className="shrink-0 text-[color:var(--composer-panel-muted-foreground)]"
                aria-hidden="true"
              />
            ) : (
              <CaretDown
                size={14}
                className="shrink-0 text-[color:var(--composer-panel-muted-foreground)]"
                aria-hidden="true"
              />
            )
          ) : null}
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.04em] text-[color:var(--composer-panel-muted-foreground)]">
            {label}
          </span>
          {typeof count === 'number' ? (
            <span className="text-[11px] tabular-nums text-[color:var(--composer-panel-muted-foreground)] opacity-60">
              {count}
            </span>
          ) : null}
          {typeof selectedCount === 'number' && selectedCount > 0 ? (
            <span
              className={cn(
                'ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1',
                'border border-[color:var(--button-primary-border)]',
                'bg-[color:var(--button-primary-surface)]',
                'text-[9px] font-semibold tabular-nums',
                'text-[color:var(--button-primary-foreground)]'
              )}
              aria-hidden="true"
            >
              {selectedCount > 99 ? '99+' : selectedCount}
            </span>
          ) : null}
          {trailing ? <span className="ml-auto flex items-center">{trailing}</span> : null}
        </div>
      )}
      {(!collapsible || !isCollapsed) && (
        <div className={cn('space-y-0.5 pl-1', bodyClassName)}>{children}</div>
      )}
    </div>
  );
};

// ============================================================================
// SelectionIndicator —— 单选 ✓ / 多选 □ 两态共用强调色 token
// ============================================================================

export interface ComposerPanelSelectionIndicatorProps {
  variant: 'single' | 'multi';
  selected: boolean;
  /** 仅 multi 用于显示半选/锁定态（如 MCP 内置服务器） */
  locked?: boolean;
  className?: string;
}

const SelectionIndicator: React.FC<ComposerPanelSelectionIndicatorProps> = ({
  variant,
  selected,
  locked,
  className,
}) => {
  if (variant === 'single') {
    return (
      <span
        className={cn(
          'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
          selected
            ? 'text-[color:var(--button-primary-foreground)]'
            : 'text-transparent',
          className
        )}
        aria-hidden="true"
      >
        {selected ? <Check size={14} weight="bold" /> : null}
      </span>
    );
  }
  // multi
  return (
    <span
      className={cn(
        'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold transition-colors',
        selected
          ? 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)]'
          : 'border-[color:var(--composer-panel-control-border)] text-transparent',
        locked && 'opacity-70',
        className
      )}
      aria-hidden="true"
    >
      {selected ? <Check size={12} weight="bold" /> : null}
    </span>
  );
};

// ============================================================================
// Row —— 列表项；选中态走 --button-primary-* tinted chip
// ============================================================================

export type ComposerPanelRowDensity = 'cozy' | 'compact';

export interface ComposerPanelRowProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  selected?: boolean;
  /** 选中指示器（左侧） */
  leading?: React.ReactNode;
  /** 主内容（默认会承担 flex-1） */
  children: React.ReactNode;
  /** 行尾节点（hover 后才显的次级动作请自行用 group-hover/opacity） */
  trailing?: React.ReactNode;
  /** 密度：cozy 默认 (列表)，compact 用于极紧凑列（mention 弹层） */
  density?: ComposerPanelRowDensity;
  /** 选中时的强度：tinted (默认) / soft (仅左侧豆条) */
  selectedAccent?: 'tinted' | 'soft';
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}

const Row = React.forwardRef<HTMLButtonElement, ComposerPanelRowProps>(
  (
    {
      selected,
      leading,
      children,
      trailing,
      density = 'cozy',
      selectedAccent = 'tinted',
      className,
      disabled,
      ...rest
    },
    ref
  ) => {
    const tinted = selectedAccent === 'tinted';
    return (
      // eslint-disable-next-line ds-components/no-native-button -- Row 是 ComposerPanel 的低层 primitive，需要直接控制 token 化的强调色 className，使用 NotionButton 会被其内置 variant 覆盖
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-pressed={selected || undefined}
        className={cn(
          'group relative flex w-full items-start gap-2 text-left transition-colors outline-none',
          'rounded-[var(--menu-shell-row-radius)] border border-transparent',
          density === 'cozy'
            ? 'px-[var(--menu-shell-row-padding-x)] py-[var(--menu-shell-row-padding-y)]'
            : 'px-2 py-1.5',
          // 默认 hover
          !selected && 'hover:bg-[color:var(--menu-shell-row-hover)]',
          // 选中态——tinted: 三层强调色；soft: 仅淡背景
          selected && tinted && [
            'border-[color:var(--button-primary-border)]',
            'bg-[color:var(--button-primary-surface)]',
            'text-[color:var(--button-primary-foreground)]',
            'hover:bg-[color:var(--button-primary-hover)]',
          ],
          selected && !tinted && [
            'bg-[color:var(--menu-shell-row-active)]',
          ],
          // focus
          'focus-visible:ring-2 focus-visible:ring-[color:var(--composer-panel-focus-border)] focus-visible:ring-offset-0',
          // disabled
          disabled && 'cursor-not-allowed opacity-60',
          className
        )}
        {...rest}
      >
        {selected && !tinted ? (
          <span
            className="pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full bg-[color:var(--button-primary-foreground)]"
            aria-hidden="true"
          />
        ) : null}
        {leading}
        <span className="min-w-0 flex-1">{children}</span>
        {trailing}
      </button>
    );
  }
);
Row.displayName = 'ComposerPanel.Row';

// ============================================================================
// Empty / Loading
// ============================================================================

export interface ComposerPanelEmptyProps {
  icon?: Icon;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

const Empty: React.FC<ComposerPanelEmptyProps> = ({
  icon: IconComponent,
  title,
  description,
  action,
  className,
}) => (
  <div
    className={cn(
      'flex flex-col items-center justify-center gap-2 px-3 py-8 text-center',
      'rounded-[var(--menu-shell-row-radius)] border border-dashed border-[color:var(--composer-panel-control-border)]',
      'bg-[color:var(--composer-panel-muted-surface)]',
      className
    )}
  >
    {IconComponent ? (
      <IconComponent
        size={22}
        className="text-[color:var(--composer-panel-muted-foreground)] opacity-70"
        aria-hidden="true"
      />
    ) : null}
    {title ? (
      <div className="text-sm font-medium text-[color:var(--composer-panel-foreground)]">
        {title}
      </div>
    ) : null}
    {description ? (
      <p className="text-xs leading-5 text-[color:var(--composer-panel-muted-foreground)]">
        {description}
      </p>
    ) : null}
    {action ? <div className="mt-1">{action}</div> : null}
  </div>
);

export interface ComposerPanelLoadingProps {
  label?: React.ReactNode;
  className?: string;
}

const Loading: React.FC<ComposerPanelLoadingProps> = ({ label, className }) => (
  <div
    className={cn(
      'flex items-center justify-center gap-2 px-3 py-6 text-xs text-[color:var(--composer-panel-muted-foreground)]',
      className
    )}
    role="status"
  >
    <CircleNotch size={14} className="animate-spin" aria-hidden="true" />
    {label ? <span>{label}</span> : null}
  </div>
);

// ============================================================================
// Footer —— sticky 底栏（提交 / 取消 / 帮助文案）
// ============================================================================

export interface ComposerPanelFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 添加上分隔线（适合放在滚动区下方） */
  divided?: boolean;
}

const Footer: React.FC<ComposerPanelFooterProps> = ({
  className,
  divided,
  ...props
}) => (
  <div
    className={cn(
      'shrink-0',
      divided && 'border-t border-[color:var(--composer-panel-control-border)] pt-2',
      'flex items-center justify-end gap-2',
      className
    )}
    {...props}
  />
);

// ============================================================================
// Compound export
// ============================================================================

/**
 * 复合组件命名空间。使用方式：
 *
 *   <ComposerPanel.Root>
 *     <ComposerPanel.Header icon={Wrench} title="MCP" subtitle="选择启用的工具" onClose={onClose} />
 *     <ComposerPanel.Search value={q} onChange={setQ} placeholder="搜索..." />
 *     <CustomScrollArea> ... </CustomScrollArea>
 *     <ComposerPanel.Footer divided>...</ComposerPanel.Footer>
 *   </ComposerPanel.Root>
 */
export const ComposerPanel = {
  Root,
  Header,
  Search,
  Section,
  Row,
  SelectionIndicator,
  Empty,
  Loading,
  Footer,
};

export default ComposerPanel;
