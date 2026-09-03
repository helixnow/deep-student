import type { DsButtonSize, DsButtonVariant } from '@/components/ui/DsButton';

export type DsSampleSpec = {
  kind: 'ds';
  variant: DsButtonVariant;
  size: DsButtonSize;
  iconOnly?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
};

export type ShadSampleSpec = {
  kind: 'shad';
  variant: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  size: 'default' | 'sm' | 'lg' | 'icon';
};

export type ReplicaSampleSpec = {
  kind: 'replica';
  replica: string;
  label?: string;
};

export type WidgetSampleSpec = {
  kind: 'widget';
  widget:
    | 'segmented'
    | 'tabs-default'
    | 'tabs-bare'
    | 'send-empty'
    | 'send-ready'
    | 'stop'
    | 'rating-bar'
    | 'nav-row'
    | 'chip-close';
};

export type SampleSpec = DsSampleSpec | ShadSampleSpec | ReplicaSampleSpec | WidgetSampleSpec;

export type AuditItem = {
  id: string;
  label: string;
  spec: SampleSpec;
};

export type AuditFamily = {
  id: string;
  title: string;
  source: string;
  freq: number;
  freqLabel: string;
  note: string;
  items: AuditItem[];
};

const DS_SIZE_VARIANTS: Array<{ suffix: string; label: string; size: DsButtonSize; iconOnly?: boolean; disabled?: boolean }> = [
  { suffix: 'sm', label: 'sm 文字', size: 'sm' },
  { suffix: 'md', label: 'md 文字', size: 'md' },
  { suffix: 'lg', label: 'lg 文字', size: 'lg' },
  { suffix: 'sm-icon', label: 'sm 图标', size: 'sm', iconOnly: true },
  { suffix: 'md-icon', label: 'md 图标', size: 'md', iconOnly: true },
  { suffix: 'lg-icon', label: 'lg 图标', size: 'lg', iconOnly: true },
  { suffix: 'icon', label: 'size=icon', size: 'icon', iconOnly: true },
  { suffix: 'md-disabled', label: 'md 禁用', size: 'md', disabled: true },
];

function dsFamily(
  id: string,
  title: string,
  variant: DsButtonVariant,
  freq: number,
  freqLabel: string,
  note: string,
): AuditFamily {
  return {
    id,
    title,
    source: 'DsButton / buttonPrimitiveContract',
    freq,
    freqLabel,
    note,
    items: DS_SIZE_VARIANTS.map((row) => ({
      id: `${id}.${row.suffix}`,
      label: row.label,
      spec: {
        kind: 'ds',
        variant,
        size: row.size,
        iconOnly: row.iconOnly,
        disabled: row.disabled,
      },
    })),
  };
}

export const AUDIT_FAMILIES: AuditFamily[] = [
  dsFamily('ds-ghost', 'Ghost 透明', 'ghost', 9000, '约 9000 处 · 最多', '工具栏、取消、图标按钮的默认形态。'),
  {
    id: 'composer-send',
    title: '聊天发送 / 停止圆钮',
    source: 'InputBarUI studyUi* class，发送钮是原生 button',
    freq: 5000,
    freqLabel: '聊天页常驻',
    note: '黑底圆钮；空输入 muted；停止同形。不是 DsButton variant。',
    items: ([
      { id: 'composer-send.empty', label: '空输入（muted）', spec: { kind: 'widget', widget: 'send-empty' } },
      { id: 'composer-send.ready', label: '可发送（黑底）', spec: { kind: 'widget', widget: 'send-ready' } },
      { id: 'composer-send.stop', label: '停止生成', spec: { kind: 'widget', widget: 'stop' } },
    ]) as AuditItem[],
  },
  {
    id: 'shell-chrome',
    title: '壳层顶栏图标',
    source: 'desktop-shell-toolbar-button / shell-icon-button',
    freq: 4000,
    freqLabel: '桌面壳常驻',
    note: '顶栏、侧栏开关、窗口最小化/最大化。关闭钮另见红色 hover 族。',
    items: ([
      { id: 'shell-chrome.toolbar', label: '顶栏方钮', spec: { kind: 'replica', replica: 'shell-toolbar' } },
      { id: 'shell-chrome.accessory', label: '附属图标', spec: { kind: 'replica', replica: 'shell-accessory' } },
      { id: 'shell-chrome.circle', label: '圆形壳图标', spec: { kind: 'replica', replica: 'shell-circle' } },
      { id: 'shell-chrome.history', label: '历史后退 26px', spec: { kind: 'replica', replica: 'nav-history' } },
    ]) as AuditItem[],
  },
  dsFamily('ds-outline', 'Outline 描边', 'outline', 2500, '约 2500 处', '设置页、对话框次按钮。'),
  dsFamily('ds-primary', 'Primary 实心主按钮', 'primary', 1800, '约 1800 处', '确认 / CTA。token --button-prominent-*。'),
  {
    id: 'chips',
    title: '胶囊 Chip',
    source: 'AttachmentPreviewChips / ActiveFeatureChips / Tag',
    freq: 1500,
    freqLabel: '聊天附件与功能标签',
    note: '圆角胶囊，常带关闭小圆点。',
    items: ([
      { id: 'chips.attachment', label: '附件胶囊', spec: { kind: 'replica', replica: 'chip-attachment' } },
      { id: 'chips.feature', label: '功能标签', spec: { kind: 'replica', replica: 'chip-feature' } },
      { id: 'chips.close', label: '胶囊内关闭点', spec: { kind: 'widget', widget: 'chip-close' } },
    ]) as AuditItem[],
  },
  dsFamily('ds-default', 'Tonal 浅底（default）', 'default', 1200, '约 1200 处', 'DsButton 默认色。与 secondary / utility 几乎同漆。'),
  dsFamily('ds-danger', 'Danger 实心危险', 'danger', 800, '约 800 处', '删除确认。与 destructive 同漆。'),
  {
    id: 'pdf-ds-btn',
    title: 'PDF 工具栏 .ds-btn',
    source: 'enhanced-pdf.css .ds-btn / .ds-btn-sm',
    freq: 700,
    freqLabel: 'PDF 阅读器',
    note: '26/24px 无边框 ghost 图标。不是 DsButton。',
    items: ([
      { id: 'pdf-ds-btn.md', label: '26px', spec: { kind: 'replica', replica: 'pdf-ds-btn' } },
      { id: 'pdf-ds-btn.sm', label: '24px sm', spec: { kind: 'replica', replica: 'pdf-ds-btn-sm' } },
      { id: 'pdf-ds-btn.active', label: 'active 高亮', spec: { kind: 'replica', replica: 'pdf-ds-btn-active' } },
      { id: 'pdf-ds-btn.select', label: '下拉选择钮', spec: { kind: 'replica', replica: 'pdf-select' } },
    ]) as AuditItem[],
  },
  {
    id: 'ds-nav',
    title: 'Nav 侧栏整行',
    source: 'DsButton variant=nav',
    freq: 600,
    freqLabel: '侧栏每一行',
    note: '全宽、无边框、左对齐 rounded-2xl。尺寸轴不适用。',
    items: ([
      { id: 'ds-nav.idle', label: '默认', spec: { kind: 'widget', widget: 'nav-row' } },
      { id: 'ds-nav.icon', label: '带图标', spec: { kind: 'ds', variant: 'nav', size: 'md' } },
    ]) as AuditItem[],
  },
  {
    id: 'mm-toolbar',
    title: '思维导图工具栏',
    source: 'mindmap.css mm-* / 另一套 .ds-btn',
    freq: 600,
    freqLabel: '导图画布',
    note: '28px compact ghost；与 PDF 的 .ds-btn 同名不同形。',
    items: ([
      { id: 'mm-toolbar.ds-btn', label: 'mm .ds-btn 带文字', spec: { kind: 'replica', replica: 'mm-ds-btn' } },
      { id: 'mm-toolbar.icon', label: 'mm-toolbar-button', spec: { kind: 'replica', replica: 'mm-toolbar' } },
      { id: 'mm-toolbar.active', label: 'is-active', spec: { kind: 'replica', replica: 'mm-toolbar-active' } },
      { id: 'mm-toolbar.learning', label: 'learning 小字', spec: { kind: 'replica', replica: 'mm-learning' } },
      { id: 'mm-toolbar.view', label: 'view-switcher', spec: { kind: 'replica', replica: 'mm-view' } },
      { id: 'mm-toolbar.action-add', label: '节点 +', spec: { kind: 'replica', replica: 'mm-action-add' } },
      { id: 'mm-toolbar.action-del', label: '节点删除', spec: { kind: 'replica', replica: 'mm-action-del' } },
      { id: 'mm-toolbar.flow', label: 'React Flow 缩放', spec: { kind: 'replica', replica: 'mm-flow' } },
    ]) as AuditItem[],
  },
  {
    id: 'tabs',
    title: 'Tab 触发器',
    source: 'shad TabsTrigger / settings .tab-button',
    freq: 500,
    freqLabel: '设置与样式实验室',
    note: 'shad 是圆角块；设置页是底边标签，两套不同。',
    items: ([
      { id: 'tabs.default', label: 'shad default', spec: { kind: 'widget', widget: 'tabs-default' } },
      { id: 'tabs.bare', label: 'shad bare', spec: { kind: 'widget', widget: 'tabs-bare' } },
      { id: 'tabs.settings', label: '设置底边 tab', spec: { kind: 'replica', replica: 'settings-tab' } },
    ]) as AuditItem[],
  },
  {
    id: 'code-copy',
    title: '代码块复制',
    source: 'flowtoken-patched.css .ft-copy-button',
    freq: 400,
    freqLabel: '每段代码块',
    note: 'hover 仍是写死的 zinc，未走主题 token。',
    items: ([
      { id: 'code-copy.idle', label: '默认', spec: { kind: 'replica', replica: 'ft-copy' } },
    ]) as AuditItem[],
  },
  {
    id: 'segmented',
    title: '分段控件',
    source: 'SegmentedControl / study-shell-segmented-button',
    freq: 400,
    freqLabel: '外观设置等',
    note: '滑动指示条，不是独立 DsButton。',
    items: ([
      { id: 'segmented.default', label: 'default', spec: { kind: 'widget', widget: 'segmented' } },
    ]) as AuditItem[],
  },
  dsFamily('ds-destructive', 'Destructive（danger 别名）', 'destructive', 350, '约 350 处', '与 danger 同漆，shad 侧用这个名字。'),
  {
    id: 'dock',
    title: '工作台 Dock',
    source: 'workbench.css .wb-dock-item',
    freq: 350,
    freqLabel: '工作台模式',
    note: '44px 圆角方块，玻璃条上的 App 图标。',
    items: ([
      { id: 'dock.item', label: 'dock item', spec: { kind: 'replica', replica: 'dock-item' } },
      { id: 'dock.list', label: '窗口列表钮', spec: { kind: 'replica', replica: 'dock-list' } },
    ]) as AuditItem[],
  },
  {
    id: 'editor-toolbar',
    title: '笔记编辑器工具栏',
    source: 'CrepeEditor.css milkdown-toolbar / notes-editor-toolbar',
    freq: 300,
    freqLabel: '笔记编辑',
    note: '浮动 WYSIWYG 与块菜单。',
    items: ([
      { id: 'editor-toolbar.item', label: 'toolbar-item', spec: { kind: 'replica', replica: 'crepe-toolbar' } },
      { id: 'editor-toolbar.active', label: 'active', spec: { kind: 'replica', replica: 'crepe-toolbar-active' } },
      { id: 'editor-toolbar.block', label: '块菜单行', spec: { kind: 'replica', replica: 'crepe-block' } },
      { id: 'editor-toolbar.lightbox', label: '图片灯箱钮', spec: { kind: 'replica', replica: 'crepe-lightbox' } },
    ]) as AuditItem[],
  },
  dsFamily('ds-utility', 'Utility 浅底弱字色', 'utility', 250, '约 250 处', 'Todo / 模板为主，和 default 几乎一样。'),
  dsFamily('ds-secondary', 'Secondary（tonal 别名）', 'secondary', 220, '约 220 处', '与 default 同漆。'),
  {
    id: 'overlay-media',
    title: '媒体叠加圆钮',
    source: 'InlineImageViewer / ImagePreview className 覆盖',
    freq: 200,
    freqLabel: '图片预览',
    note: '半透明圆 + 边框阴影，叠在媒体上。',
    items: ([
      { id: 'overlay-media.float', label: '浮动玻璃圆', spec: { kind: 'replica', replica: 'overlay-float' } },
      { id: 'overlay-media.ghost', label: '透明圆', spec: { kind: 'replica', replica: 'overlay-ghost' } },
      { id: 'overlay-media.dark', label: '黑底移除点', spec: { kind: 'replica', replica: 'overlay-dark' } },
    ]) as AuditItem[],
  },
  {
    id: 'tree-row',
    title: '树 / 目录整行',
    source: 'rct-tree-item-button / EPUB TOC / notes search modes',
    freq: 200,
    freqLabel: '笔记树与 EPUB',
    note: '全宽列表行，看起来像 nav，但是私有 CSS。',
    items: ([
      { id: 'tree-row.file', label: '文件树行', spec: { kind: 'replica', replica: 'tree-row' } },
      { id: 'tree-row.selected', label: '选中行', spec: { kind: 'replica', replica: 'tree-row-selected' } },
      { id: 'tree-row.epub', label: 'EPUB 目录行', spec: { kind: 'replica', replica: 'epub-toc' } },
    ]) as AuditItem[],
  },
  {
    id: 'flashcard-rating',
    title: '闪卡四色评分',
    source: 'RatingBar + .wb-fc-rate-btn',
    freq: 150,
    freqLabel: '闪卡复习',
    note: 'Again/Hard/Good/Easy 四色描边，外加全宽显示答案。',
    items: ([
      { id: 'flashcard-rating.bar', label: '四色条', spec: { kind: 'widget', widget: 'rating-bar' } },
      { id: 'flashcard-rating.show', label: '显示答案 全宽', spec: { kind: 'ds', variant: 'primary', size: 'md', fullWidth: true } },
    ]) as AuditItem[],
  },
  {
    id: 'command-palette',
    title: '命令面板图标钮',
    source: 'command-palette.css',
    freq: 100,
    freqLabel: '命令面板',
    note: '28px ghost，active 用 primary 浅底。',
    items: ([
      { id: 'command-palette.idle', label: 'mode 默认', spec: { kind: 'replica', replica: 'cp-mode' } },
      { id: 'command-palette.active', label: 'mode active', spec: { kind: 'replica', replica: 'cp-mode-active' } },
      { id: 'command-palette.close', label: '关闭', spec: { kind: 'replica', replica: 'cp-close' } },
    ]) as AuditItem[],
  },
  {
    id: 'viewer-icon',
    title: '图片查看器工具条',
    source: 'modern-viewer-icon-button',
    freq: 90,
    freqLabel: '全屏看图',
    note: '6px 圆角 ghost，另有 primary / danger 着色。',
    items: ([
      { id: 'viewer-icon.plain', label: '默认', spec: { kind: 'replica', replica: 'viewer' } },
      { id: 'viewer-icon.primary', label: 'primary', spec: { kind: 'replica', replica: 'viewer-primary' } },
      { id: 'viewer-icon.danger', label: 'danger', spec: { kind: 'replica', replica: 'viewer-danger' } },
    ]) as AuditItem[],
  },
  dsFamily('ds-warning', 'Warning 浅底警告字', 'warning', 80, '约 80 处', '同步/冲突等，很少见。'),
  {
    id: 'window-close',
    title: '窗口关闭红 hover',
    source: '[data-shell-window-button=close]',
    freq: 70,
    freqLabel: '桌面窗控',
    note: '平时和顶栏图标一样，hover 变红。',
    items: ([
      { id: 'window-close.idle', label: '默认', spec: { kind: 'replica', replica: 'win-close' } },
      { id: 'window-close.hover', label: 'hover 预览', spec: { kind: 'replica', replica: 'win-close-hover' } },
    ]) as AuditItem[],
  },
  {
    id: 'swatch',
    title: '色点 Swatch',
    source: 'AccentPicker / 导图颜色点',
    freq: 60,
    freqLabel: '强调色与导图',
    note: '圆形色块，不是文字按钮。',
    items: ([
      { id: 'swatch.idle', label: '色点', spec: { kind: 'replica', replica: 'swatch' } },
      { id: 'swatch.selected', label: '选中', spec: { kind: 'replica', replica: 'swatch-selected' } },
    ]) as AuditItem[],
  },
  {
    id: 'ghost-danger-hover',
    title: 'Ghost → 危险 hover',
    source: 'TodoItemRow 删除图标 className 覆盖',
    freq: 50,
    freqLabel: 'Todo 行',
    note: '平时 ghost，hover 才变成危险浅底。',
    items: ([
      { id: 'ghost-danger-hover.idle', label: '默认', spec: { kind: 'replica', replica: 'ghost-danger' } },
      { id: 'ghost-danger-hover.hover', label: 'hover 预览', spec: { kind: 'replica', replica: 'ghost-danger-hover' } },
    ]) as AuditItem[],
  },
  {
    id: 'workbench-misc',
    title: '工作台杂项',
    source: 'wb-empty-tour / hud / agenda / browser / template toggle',
    freq: 45,
    freqLabel: '工作台各窗',
    note: '空桌面引导、HUD、日程、内置浏览器、模板切换。',
    items: ([
      { id: 'workbench-misc.tour-ghost', label: '引导 ghost', spec: { kind: 'replica', replica: 'tour-ghost' } },
      { id: 'workbench-misc.tour-primary', label: '引导 primary', spec: { kind: 'replica', replica: 'tour-primary' } },
      { id: 'workbench-misc.hud', label: 'HUD', spec: { kind: 'replica', replica: 'hud' } },
      { id: 'workbench-misc.agenda', label: '日程添加', spec: { kind: 'replica', replica: 'agenda-add' } },
      { id: 'workbench-misc.browser', label: '内置浏览器图标', spec: { kind: 'replica', replica: 'browser-icon' } },
      { id: 'workbench-misc.toggle', label: '模板视图切换', spec: { kind: 'replica', replica: 'tm-toggle' } },
    ]) as AuditItem[],
  },
  dsFamily('ds-shell', 'Shell 面板实底', 'shell', 40, '约 40 处', 'AgentControlCenter / TodoQuickAdd，极少。'),
  {
    id: 'quick-assistant',
    title: '速记助手',
    source: 'quick-assistant.css',
    freq: 40,
    freqLabel: '独立小窗',
    note: '25px 图标、30px 实心主钮、评分描边。',
    items: ([
      { id: 'quick-assistant.icon', label: '图标', spec: { kind: 'replica', replica: 'qa-icon' } },
      { id: 'quick-assistant.primary', label: '主按钮', spec: { kind: 'replica', replica: 'qa-primary' } },
      { id: 'quick-assistant.rating', label: '评分格', spec: { kind: 'replica', replica: 'qa-rating' } },
    ]) as AuditItem[],
  },
  {
    id: 'legacy-toolbars',
    title: '遗留工具条 CSS',
    source: 'SummaryBox / BatchOperation / MinimalTemplate / settings-secondary',
    freq: 35,
    freqLabel: '旧模块',
    note: '迁移目标外的本地 .btn 族。',
    items: ([
      { id: 'legacy-toolbars.sb-ghost', label: 'Summary ghost', spec: { kind: 'replica', replica: 'sb-ghost' } },
      { id: 'legacy-toolbars.sb-icon', label: 'Summary 图标', spec: { kind: 'replica', replica: 'sb-icon' } },
      { id: 'legacy-toolbars.batch', label: '批处理 action', spec: { kind: 'replica', replica: 'batch-action' } },
      { id: 'legacy-toolbars.batch-danger', label: '批处理危险', spec: { kind: 'replica', replica: 'batch-danger' } },
      { id: 'legacy-toolbars.tpl', label: '模板 .btn', spec: { kind: 'replica', replica: 'tpl-btn' } },
      { id: 'legacy-toolbars.settings', label: '设置 secondary', spec: { kind: 'replica', replica: 'settings-secondary' } },
    ]) as AuditItem[],
  },
  {
    id: 'card-3d',
    title: '3D 卡片圆钮',
    source: 'Card3DPreview.css .control-btn',
    freq: 30,
    freqLabel: '卡片预览',
    note: '40px 圆 + 阴影，和发送圆钮不是一套。',
    items: ([
      { id: 'card-3d.idle', label: '默认', spec: { kind: 'replica', replica: 'card3d' } },
      { id: 'card-3d.active', label: 'active', spec: { kind: 'replica', replica: 'card3d-active' } },
    ]) as AuditItem[],
  },
  {
    id: 'notes-misc',
    title: '笔记窗杂项图标',
    source: 'notes-icon-button / tabs-scroll / mobile-editor-toolbar / trash dialog',
    freq: 25,
    freqLabel: '笔记工作区',
    note: '笔记工作区内的杂项图标按钮族。',
    items: ([
      { id: 'notes-misc.icon', label: 'notes-icon-button', spec: { kind: 'replica', replica: 'notes-icon' } },
      { id: 'notes-misc.scroll', label: '标签滚动', spec: { kind: 'replica', replica: 'notes-scroll' } },
      { id: 'notes-misc.mobile', label: '移动编辑工具条', spec: { kind: 'replica', replica: 'notes-mobile' } },
      { id: 'notes-misc.trash', label: '回收站图标', spec: { kind: 'replica', replica: 'notes-trash' } },
    ]) as AuditItem[],
  },
  {
    id: 'fab-debug',
    title: '调试悬浮球',
    source: 'GlobalDebugPanel .dstu-dbg-toggle / DevMobileRecoveryFab',
    freq: 20,
    freqLabel: '仅开发态',
    note: '44px 脉冲圆，带状态点。',
    items: ([
      { id: 'fab-debug.toggle', label: '调试球', spec: { kind: 'replica', replica: 'fab' } },
      { id: 'fab-debug.inspect', label: 'inspect CTA', spec: { kind: 'replica', replica: 'dbg-inspect' } },
    ]) as AuditItem[],
  },
  dsFamily('ds-success', 'Success 浅底成功字', 'success', 10, '约 10 处', '几乎不用。'),
  {
    id: 'shad-link',
    title: 'Link 文字按钮',
    source: 'shad Button variant=link（DsButton 没有）',
    freq: 8,
    freqLabel: '遗留 shad',
    note: '下划线文字。DsButton 已排除。',
    items: ([
      { id: 'shad-link.default', label: 'link', spec: { kind: 'shad', variant: 'link', size: 'default' } },
      { id: 'shad-link.sm', label: 'link sm', spec: { kind: 'shad', variant: 'link', size: 'sm' } },
    ]) as AuditItem[],
  },
  {
    id: 'hero-glass',
    title: 'Landing 玻璃钮',
    source: 'hero.html .btn.glass',
    freq: 5,
    freqLabel: '仅落地页',
    note: 'Liquid Glass，不进 App 壳。',
    items: ([
      { id: 'hero-glass.primary', label: '墨玻璃主钮', spec: { kind: 'replica', replica: 'hero-primary' } },
      { id: 'hero-glass.ghost', label: '清玻璃次钮', spec: { kind: 'replica', replica: 'hero-ghost' } },
    ]) as AuditItem[],
  },
].sort((a, b) => b.freq - a.freq);

export function allAuditItems(families: AuditFamily[] = AUDIT_FAMILIES): AuditItem[] {
  return families.flatMap((family) => family.items);
}
