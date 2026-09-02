export type ControlWidget =
  | 'input-text'
  | 'input-search'
  | 'input-password'
  | 'input-file'
  | 'input-disabled'
  | 'input-native'
  | 'textarea-shad'
  | 'textarea-native'
  | 'textarea-composer'
  | 'switch-off'
  | 'switch-on'
  | 'switch-sm'
  | 'switch-disabled'
  | 'switch-row'
  | 'checkbox-off'
  | 'checkbox-on'
  | 'checkbox-disabled'
  | 'segmented-default'
  | 'segmented-compact'
  | 'tabs-default'
  | 'tabs-bare'
  | 'select-shad'
  | 'select-native'
  | 'select-combobox'
  | 'select-app'
  | 'select-modern'
  | 'slider-shad'
  | 'slider-snappy'
  | 'slider-stepper'
  | 'progress-value'
  | 'progress-indet'
  | 'progress-ring'
  | 'badge-default'
  | 'badge-secondary'
  | 'badge-destructive'
  | 'badge-outline'
  | 'tag-input'
  | 'tooltip-dark'
  | 'tooltip-light'
  | 'tooltip-kbd'
  | 'tooltip-shad'
  | 'toast-success'
  | 'toast-error'
  | 'toast-info'
  | 'toast-warning'
  | 'alert-default'
  | 'alert-info'
  | 'alert-warning'
  | 'alert-destructive'
  | 'dialog-ds'
  | 'dialog-alert'
  | 'dialog-shad'
  | 'sheet-right'
  | 'menu-app'
  | 'menu-popover'
  | 'card-shad'
  | 'table-shad'
  | 'breadcrumb'
  | 'collapsible'
  | 'scroll-area'
  | 'skeleton-shimmer'
  | 'skeleton-pulse'
  | 'separator'
  | 'label'
  | 'pulse-dot'
  | 'command'
  | 'accent-dots'
  | 'kbd-tooltip'
  | 'kbd-inline';

export type ControlItem = {
  id: string;
  label: string;
  widget: ControlWidget;
};

export type ControlFamily = {
  id: string;
  title: string;
  source: string;
  freq: number;
  freqLabel: string;
  note: string;
  wide?: boolean;
  items: ControlItem[];
};

export type ControlTypeGroup = {
  id: string;
  title: string;
  note: string;
  families: ControlFamily[];
};

function family(
  id: string,
  title: string,
  source: string,
  freq: number,
  freqLabel: string,
  note: string,
  items: Array<[string, string, ControlWidget]>,
  wide = false,
): ControlFamily {
  return {
    id,
    title,
    source,
    freq,
    freqLabel,
    note,
    wide,
    items: items.map(([itemId, label, widget]) => ({ id: `${id}/${itemId}`, label, widget })),
  };
}

export const CONTROL_TYPE_GROUPS: ControlTypeGroup[] = [
  {
    id: 'input',
    title: '输入框',
    note: '单行文字。官方外壳是 inputShellClass；搜索另有 ds-search-input；聊天作曲器把边框剥掉。',
    families: [
      family(
        'shad-input',
        'shad Input（inputShell）',
        'src/components/ui/shad/Input.tsx + inputShell.ts',
        93,
        '~93 文件',
        '目标形态。圆角 --radius-shell-control，quiet focus（无 glow）。type=search 额外挂 ds-search-input。',
        [
          ['text', 'text', 'input-text'],
          ['search', 'search', 'input-search'],
          ['password', 'password', 'input-password'],
          ['file', 'file', 'input-file'],
          ['disabled', 'disabled', 'input-disabled'],
        ],
        true,
      ),
      family(
        'native-input',
        '原生 <input>',
        '散落调用，style-lab NativeInput',
        84,
        '~84 引用 / 59 文件',
        '遗留。命令面板、编辑器、部分设置仍直接写 <input>，外观不走 inputShell。',
        [['plain', '未套壳', 'input-native']],
        true,
      ),
    ],
  },
  {
    id: 'textarea',
    title: '多行文本',
    note: 'shad Textarea 与 Input 同壳；聊天输入把壳拆掉只留透明底。',
    families: [
      family(
        'shad-textarea',
        'shad Textarea',
        'src/components/ui/shad/Textarea.tsx',
        22,
        '~22 文件',
        'inputShell + min-h-[80px] resize-y。',
        [['default', '默认', 'textarea-shad']],
        true,
      ),
      family(
        'native-textarea',
        '原生 <textarea>',
        'style-lab NativeTextarea',
        17,
        '~17 引用 / 11 文件',
        '遗留。含聊天 InputBar 自己的作曲器 textarea。',
        [
          ['plain', '未套壳', 'textarea-native'],
          ['composer', '聊天作曲器（无边框）', 'textarea-composer'],
        ],
        true,
      ),
    ],
  },
  {
    id: 'switch',
    title: '开关',
    note: 'Radix Switch，尺寸在 Switch.css。设置页还有整行可点的 SwitchRow。',
    families: [
      family(
        'shad-switch',
        'shad Switch',
        'src/components/ui/shad/Switch.tsx',
        27,
        '~27 文件',
        'default 24×44；sm 16×28 用于密集列表。',
        [
          ['off', 'default 关', 'switch-off'],
          ['on', 'default 开', 'switch-on'],
          ['sm', 'sm', 'switch-sm'],
          ['disabled', '禁用', 'switch-disabled'],
        ],
      ),
      family(
        'switch-row',
        '设置 SwitchRow',
        'src/features/settings/components/settingsTabPrimitives.tsx',
        20,
        '设置页大量',
        '整行点击切换（移动设置惯例），右侧是 default Switch。',
        [['row', '标题 + 描述 + 开关', 'switch-row']],
        true,
      ),
    ],
  },
  {
    id: 'checkbox',
    title: '复选框',
    note: '单一尺寸；选中填 primary。',
    families: [
      family(
        'shad-checkbox',
        'shad Checkbox',
        'src/components/ui/shad/Checkbox.tsx',
        16,
        '~16 文件',
        'h-4 w-4，checked 时 bg-primary。',
        [
          ['off', '未选', 'checkbox-off'],
          ['on', '已选', 'checkbox-on'],
          ['disabled', '禁用', 'checkbox-disabled'],
        ],
      ),
    ],
  },
  {
    id: 'segmented',
    title: '分段控件',
    note: '按钮审计里也出现过；这里按「控件」再列一次，方便和非按钮族一起裁定。',
    families: [
      family(
        'segmented-control',
        'SegmentedControl',
        'src/components/ui/SegmentedControl.tsx',
        24,
        '~24 文件',
        'muted 底 + 滑动选中块。default / compact。',
        [
          ['default', 'default', 'segmented-default'],
          ['compact', 'compact', 'segmented-compact'],
        ],
        true,
      ),
    ],
  },
  {
    id: 'tabs',
    title: '标签页',
    note: '下划线式 Tabs，不是分段胶囊。',
    families: [
      family(
        'shad-tabs',
        'shad Tabs',
        'src/components/ui/shad/Tabs.tsx',
        11,
        '~11 文件',
        'default 有底边；bare 更轻。设置页另有私有 settings-tab（已在按钮审计）。',
        [
          ['default', 'default', 'tabs-default'],
          ['bare', 'bare', 'tabs-bare'],
        ],
        true,
      ),
    ],
  },
  {
    id: 'select',
    title: '下拉选择',
    note: '至少四套视觉：inputShell Select、Combobox 触发器、AppSelect、遗留 ModernSelect，再加原生 <select>。',
    families: [
      family(
        'shad-select',
        'shad Select',
        'src/components/ui/shad/Select.tsx',
        9,
        '~9 文件',
        'Trigger 复用 inputShell，与 Input 对齐。目标形态。',
        [['default', 'Trigger', 'select-shad']],
        true,
      ),
      family(
        'combobox',
        'Combobox',
        'src/components/ui/shad/Combobox.tsx',
        8,
        '设置/模型选择',
        'Trigger 是带边框的 ghost DsButton；点开是 DsDialog + 搜索。',
        [['trigger', '触发器', 'select-combobox']],
        true,
      ),
      family(
        'app-select',
        'AppSelect',
        'src/components/ui/app-menu/AppSelect.tsx',
        10,
        '工具栏/设置',
        '外观跟 AppMenu 走，variant: outline / ghost / default。样例是 outline。',
        [['outline', 'outline 触发器', 'select-app']],
      ),
      family(
        'modern-select',
        'ModernSelect（遗留）',
        'src/components/ModernSelect.tsx + ModernSelect.css',
        3,
        '少量',
        '2px 边框 + muted 底，和 inputShell 不是一家。',
        [['default', 'Trigger', 'select-modern']],
        true,
      ),
      family(
        'native-select',
        '原生 <select>',
        'style-lab NativeSelect',
        11,
        '~11 引用 / 9 文件',
        '遗留。系统默认外观。',
        [['plain', '未套壳', 'select-native']],
      ),
    ],
  },
  {
    id: 'slider',
    title: '滑块',
    note: '细轨 Slider、带刻度/数值框的 SnappySlider、配比步进行。',
    families: [
      family(
        'shad-slider',
        'shad Slider',
        'src/components/ui/shad/Slider.tsx',
        8,
        '~8 文件',
        'h-1.5 轨 + 12px 圆点拇指。',
        [['default', '40%', 'slider-shad']],
        true,
      ),
      family(
        'snappy-slider',
        'SnappySlider',
        'src/components/ui/SnappySlider.tsx',
        6,
        '设置参数',
        '刻度轨 + 右侧可编辑数值。',
        [['default', '带数值', 'slider-snappy']],
        true,
      ),
      family(
        'count-stepper',
        'CountStepperRow',
        'src/components/practice/CountStepperRow.tsx',
        4,
        '练习/组卷',
        '标签 + Slider + −/数字/+。',
        [['row', '配比行', 'slider-stepper']],
        true,
      ),
    ],
  },
  {
    id: 'progress',
    title: '进度',
    note: '细条 Progress 与多处私有圆环。',
    families: [
      family(
        'shad-progress',
        'shad Progress',
        'src/components/ui/shad/Progress.tsx',
        14,
        '~14 文件',
        'h-1.5 rounded-full；value=null 为不确定。',
        [
          ['value', '确定 62%', 'progress-value'],
          ['indet', '不确定', 'progress-indet'],
        ],
        true,
      ),
      family(
        'progress-ring',
        'ProgressRing',
        'todo ProgressRing / 学习中心私有环',
        6,
        '待办/索引',
        '14px SVG 环，完成切 success。',
        [['todo', '待办环 3/5', 'progress-ring']],
      ),
    ],
  },
  {
    id: 'badge',
    title: '徽章',
    note: '四个 variant，默认 secondary。',
    families: [
      family(
        'shad-badge',
        'shad Badge',
        'src/components/ui/shad/Badge.tsx',
        37,
        '~37 文件',
        '小圆角、浅底。',
        [
          ['default', 'default', 'badge-default'],
          ['secondary', 'secondary', 'badge-secondary'],
          ['destructive', 'destructive', 'badge-destructive'],
          ['outline', 'outline', 'badge-outline'],
        ],
      ),
    ],
  },
  {
    id: 'tag',
    title: '标签输入',
    note: 'chip + 内嵌 Input。chip 关闭钮已在按钮审计。',
    families: [
      family(
        'tag-input',
        'TagInput',
        'src/components/ui/shad/TagInput.tsx',
        4,
        '笔记/设置',
        'muted chip + 可输入。',
        [['filled', '已有标签', 'tag-input']],
        true,
      ),
    ],
  },
  {
    id: 'tooltip',
    title: '气泡提示',
    note: 'CommonTooltip 是目标；shad Tooltip 几乎只剩对照页。',
    families: [
      family(
        'common-tooltip',
        'CommonTooltip',
        'src/components/shared/CommonTooltip.tsx',
        355,
        '~355 引用 / 47 文件',
        '深/浅气泡 + 可选箭头 + 快捷键帽。样例是常显静态，不需要悬停。',
        [
          ['dark', 'dark', 'tooltip-dark'],
          ['light', 'light', 'tooltip-light'],
          ['kbd', '带 ⌘K', 'tooltip-kbd'],
        ],
      ),
      family(
        'shad-tooltip',
        'shad Tooltip（遗留）',
        'src/components/ui/shad/Tooltip.tsx',
        2,
        '几乎不用',
        '兼容 API。新代码应走 CommonTooltip。',
        [['legacy', '遗留气泡', 'tooltip-shad']],
      ),
    ],
  },
  {
    id: 'toast',
    title: '通知',
    note: '全局 toast，状态靠边色/图标，不是满底填充。',
    families: [
      family(
        'unified-notification',
        'UnifiedNotification',
        'src/components/UnifiedNotification.tsx',
        80,
        '全局大量 emit',
        'success / error / info / warning。样例为静态，不会自动消失。',
        [
          ['success', 'success', 'toast-success'],
          ['error', 'error', 'toast-error'],
          ['info', 'info', 'toast-info'],
          ['warning', 'warning', 'toast-warning'],
        ],
        true,
      ),
    ],
  },
  {
    id: 'alert',
    title: '页内警告',
    note: '嵌在表单/面板里的 Alert，不是 toast。',
    families: [
      family(
        'shad-alert',
        'shad Alert',
        'src/components/ui/shad/Alert.tsx',
        8,
        '设置/冲突',
        'default / info / warning / destructive，透明边、浅底。',
        [
          ['default', 'default', 'alert-default'],
          ['info', 'info', 'alert-info'],
          ['warning', 'warning', 'alert-warning'],
          ['destructive', 'destructive', 'alert-destructive'],
        ],
        true,
      ),
    ],
  },
  {
    id: 'overlay',
    title: '弹窗 / 抽屉',
    note: 'DsDialog 是目标。样例是缩略静态壳，不会盖住页面。',
    families: [
      family(
        'ds-dialog',
        'DsDialog',
        'src/components/ui/DsDialog.tsx',
        127,
        '~127 引用 / 43 文件',
        'dialog-shell token：surface / border / floating shadow。桌面居中卡；移动端底 sheet。',
        [['desktop', '桌面卡', 'dialog-ds']],
        true,
      ),
      family(
        'ds-alert',
        'DsAlertDialog',
        'src/components/ui/DsDialog.tsx',
        40,
        '确认框',
        '不可点遮罩关闭；标题+描述+取消/确认。',
        [['confirm', '确认框', 'dialog-alert']],
        true,
      ),
      family(
        'shad-dialog',
        'shad Dialog（遗留）',
        'src/components/ui/shad/Dialog.tsx',
        2,
        '~2 文件',
        '几乎只剩对照。视觉接近 DsDialog。',
        [['legacy', '遗留卡', 'dialog-shad']],
        true,
      ),
      family(
        'shad-sheet',
        'shad Sheet（遗留）',
        'src/components/ui/shad/Sheet.tsx',
        5,
        '~5 引用',
        '侧滑抽屉。侧栏已改 UnifiedSidebar。',
        [['right', '右侧', 'sheet-right']],
        true,
      ),
    ],
  },
  {
    id: 'menu',
    title: '菜单 / 弹出层',
    note: 'AppMenu 走 menu-shell token；Popover 是更轻的 popover 面。',
    families: [
      family(
        'app-menu',
        'AppMenu',
        'src/components/ui/app-menu/AppMenu.tsx',
        60,
        '工具栏/右键大量',
        '菜单壳 + 行 hover/active。样例常开静态。',
        [['panel', '下拉面板', 'menu-app']],
        true,
      ),
      family(
        'shad-popover',
        'shad Popover',
        'src/components/ui/shad/Popover.tsx',
        20,
        '选择器/附加面板',
        'rounded-lg + border-border/40 + bg-popover，无阴影。',
        [['panel', '弹出层', 'menu-popover']],
        true,
      ),
    ],
  },
  {
    id: 'card',
    title: '卡片',
    note: '内容容器，不是按钮。',
    families: [
      family(
        'shad-card',
        'shad Card',
        'src/components/ui/shad/Card.tsx',
        16,
        '~16 文件',
        '--radius-card、border-border/40、无阴影。',
        [['basic', '标题+正文', 'card-shad']],
        true,
      ),
    ],
  },
  {
    id: 'table',
    title: '表格',
    note: '行 hover 走 --interactive-hover。',
    families: [
      family(
        'shad-table',
        'shad Table',
        'src/components/ui/shad/Table.tsx',
        6,
        '列表页',
        '表头 muted、行底边。',
        [['rows', '两行', 'table-shad']],
        true,
      ),
    ],
  },
  {
    id: 'nav-chrome',
    title: '导航与折叠',
    note: '面包屑、折叠面板。',
    families: [
      family(
        'breadcrumb',
        'Breadcrumb',
        'src/components/ui/shad/Breadcrumb.tsx',
        4,
        '导图大纲等',
        'muted 文字 + CaretRight 分隔。',
        [['path', '三级路径', 'breadcrumb']],
        true,
      ),
      family(
        'collapsible',
        'Collapsible',
        'src/components/ui/shad/Collapsible.tsx',
        8,
        '设置/面板',
        '无自带视觉，靠触发器文案。',
        [['open', '展开', 'collapsible']],
        true,
      ),
    ],
  },
  {
    id: 'scroll',
    title: '滚动条',
    note: '统一 ScrollArea（OverlayScrollbars）；CustomScrollArea 是薄适配。',
    families: [
      family(
        'scroll-area',
        'ScrollArea',
        'src/components/ui/scroll-area.tsx',
        160,
        '极高频',
        '平台感知：桌面 overlay、iOS 原生。样例是矮盒子可滚。',
        [['box', '可滚区域', 'scroll-area']],
        true,
      ),
    ],
  },
  {
    id: 'feedback-misc',
    title: '反馈杂项',
    note: '骨架、分隔、标签、脉冲点、命令面板、强调色点、键帽。',
    families: [
      family(
        'skeleton',
        'Skeleton',
        'src/components/ui/shad/Skeleton.tsx',
        20,
        '加载占位',
        'shimmer（默认）/ pulse。',
        [
          ['shimmer', 'shimmer', 'skeleton-shimmer'],
          ['pulse', 'pulse', 'skeleton-pulse'],
        ],
        true,
      ),
      family(
        'separator',
        'Separator',
        'src/components/ui/shad/Separator.tsx',
        12,
        '分组线',
        'bg-border/40 细线。',
        [['line', '水平', 'separator']],
        true,
      ),
      family(
        'label',
        'Label',
        'src/components/ui/shad/Label.tsx',
        15,
        '表单标签',
        'text-sm font-medium。',
        [['basic', '字段名', 'label']],
      ),
      family(
        'pulse-dot',
        'PulseDot',
        'src/components/ui/PulseDot.tsx',
        8,
        '加载指示',
        '当前色圆点缩放脉冲。',
        [['dot', '指示点', 'pulse-dot']],
      ),
      family(
        'command',
        'Command（cmdk）',
        'src/components/ui/shad/Command.tsx',
        4,
        '命令面板内核',
        '搜索行 + 列表项。页面级命令面板还有私有壳。',
        [['panel', '输入+列表', 'command']],
        true,
      ),
      family(
        'accent-dots',
        'AccentPicker 色点',
        'src/features/settings/components/AccentPicker.tsx',
        1,
        '外观设置',
        '圆形 radio；选中外环 foreground/50。',
        [['row', '预设点', 'accent-dots']],
      ),
      family(
        'kbd',
        '快捷键帽',
        'CommonTooltip kbd + 各处 inline kbd',
        15,
        '提示/空态',
        'Tooltip 内 16px 键帽；正文里还有 muted 圆角 kbd。',
        [
          ['tooltip', 'Tooltip 键帽', 'kbd-tooltip'],
          ['inline', '正文 kbd', 'kbd-inline'],
        ],
      ),
    ],
  },
];

export function allControlItems(): ControlItem[] {
  return CONTROL_TYPE_GROUPS.flatMap((group) => group.families.flatMap((family) => family.items));
}
