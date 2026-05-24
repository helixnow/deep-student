import { type CSSProperties, type ReactNode, useId } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  Desktop,
  Moon,
  Sun,
} from "@phosphor-icons/react";

import { useAppSettings } from "@/components/settings/AppSettingsProvider";
import { useTheme } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { aboutContent } from "@/lib/about-content";
import {
  DEFAULT_APP_SETTINGS,
  FONT_SIZE_SCALE_RANGE,
  INTERFACE_SCALE_RANGE,
  SIDEBAR_GLASS_INTENSITY_RANGE,
  TITLEBAR_TOP_INSET_RANGE,
  type AppFontFamily,
  type AppLanguage,
  type CopyImageMode,
  type CopyMessageMode,
  type CopyThinkingMode,
  type CopyToolsMode,
} from "@/lib/app-settings";
import { detectDesktopPlatform } from "@/lib/app-shell";
import { getVisibleSettingsPanelSections } from "@/lib/settings-panel";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { SettingsDemoPanel } from "./SettingsDemoPanel";
import { SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME } from "./settings-actions";
import { SETTINGS_SWITCH_CONTROL_CLASS_NAME } from "./settings-control-styles";
import { SETTINGS_SURFACE_INPUT_CLASS_NAME } from "./settings-input-styles";

type SettingsPanelProps = {
  activeTab: string;
  onSelectTab?: (tabId: string) => void;
};

type SettingsRowProps = {
  title: string;
  description: string;
  control: ReactNode;
  controlClassName?: string;
};

type SettingsSwitchRowProps = {
  title: string;
  description: string;
  ariaLabel: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  controlSurfaceClassName?: string;
};

type SettingsMetaRowProps = {
  title: string;
  value: string;
  description?: string;
  action?: ReactNode;
};

type SettingsSectionProps = {
  panelSurfaceClassName: string;
  title?: string;
  description?: string;
  children: ReactNode;
};

type SettingBlockProps = {
  title: string;
  description: string;
  currentValue?: string;
  controls: ReactNode;
  footer?: ReactNode;
};

type ChoiceChipProps = {
  label: string;
  selected: boolean;
  onClick: () => void;
  className?: string;
};

type ShortcutItem = {
  label: string;
  keys?: string[];
};

type ShortcutGroup = {
  title: string;
  items: ShortcutItem[];
};

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "导航",
    items: [
      { label: "跳转到智能对话", keys: ["⌘", "1"] },
      { label: "跳转到技能管理" },
      { label: "跳转到制卡任务", keys: ["⌘", "⇧", "6"] },
      { label: "跳转到学习中心", keys: ["⌘", "⇧", "7"] },
      { label: "跳转到模板库" },
      { label: "跳转到 PDF 阅读器" },
      { label: "跳转到仪表盘", keys: ["⌘", "5"] },
      { label: "跳转到数据管理", keys: ["⌘", "E"] },
      { label: "跳转到设置", keys: ["⌘", ","] },
      { label: "后退", keys: ["⌘", "["] },
      { label: "前进", keys: ["⌘", "]"] },
      { label: "返回首页", keys: ["⌘", "⇧", "H"] },
    ],
  },
  {
    title: "对话",
    items: [
      { label: "新建对话", keys: ["⌘", "N"] },
      { label: "新建题目分析", keys: ["⌘", "⇧", "A"] },
      { label: "保存对话", keys: ["⌘", "S"] },
      { label: "停止生成", keys: ["⌘", "."] },
      { label: "重新生成", keys: ["⌘", "R"] },
      { label: "清空对话" },
      { label: "复制最后回复", keys: ["⌘", "⇧", "C"] },
      { label: "分享对话" },
      { label: "导出对话" },
      { label: "导入对话" },
      { label: "切换 RAG 模式", keys: ["⌘", "⇧", "R"] },
      { label: "切换图谱模式", keys: ["⌘", "⇧", "G"] },
      { label: "切换联网搜索", keys: ["⌘", "⇧", "W"] },
      { label: "切换 MCP 工具" },
      { label: "切换学习模式" },
      { label: "选择 AI 模型" },
      { label: "模型参数设置" },
      { label: "上传图片", keys: ["⌘", "⇧", "I"] },
      { label: "上传文件" },
      { label: "语音输入" },
      { label: "切换历史侧边栏", keys: ["⌘", "\\"] },
      { label: "切换功能面板", keys: ["⌘", "⇧", "\\"] },
      { label: "查看对话历史" },
      { label: "收藏当前对话" },
      { label: "AI 续写", keys: ["⌘", "J"] },
      { label: "快速提示词", keys: ["⌘", "/"] },
      { label: "编辑历史消息" },
      { label: "分支对话" },
    ],
  },
  {
    title: "全局",
    items: [
      { label: "打开命令面板", keys: ["⌘", "K"] },
      { label: "全局搜索", keys: ["⌘", "P"] },
      { label: "快捷键设置" },
      { label: "刷新应用", keys: ["⌘", "⌥", "R"] },
      { label: "全屏切换", keys: ["F11"] },
      { label: "放大", keys: ["⌘", "="] },
      { label: "缩小", keys: ["⌘", "-"] },
      { label: "重置缩放", keys: ["⌘", "0"] },
      { label: "切换主题", keys: ["⌘", "⇧", "T"] },
      { label: "亮色主题" },
      { label: "暗色主题" },
      { label: "跟随系统主题" },
      { label: "切换通知" },
      { label: "静音" },
      { label: "检查网络连接" },
      { label: "立即同步" },
      { label: "复制当前链接" },
      { label: "从剪贴板粘贴" },
      { label: "帮助文档", keys: ["F1"] },
      { label: "关于应用" },
      { label: "更新日志" },
      { label: "报告问题" },
      { label: "导出所有数据" },
      { label: "导入数据" },
      { label: "锁定应用", keys: ["⌘", "L"] },
      { label: "显示加载状态" },
    ],
  },
  {
    title: "笔记",
    items: [
      { label: "新建笔记", keys: ["⌘", "N"] },
      { label: "新建文件夹", keys: ["⌘", "⇧", "N"] },
      { label: "搜索笔记", keys: ["⌘", "⇧", "F"] },
      { label: "保存笔记", keys: ["⌘", "S"] },
      { label: "切换侧边栏", keys: ["⌘", "\\"] },
      { label: "切换大纲面板", keys: ["⌘", "⇧", "O"] },
      { label: "导出当前笔记" },
      { label: "导出全部笔记" },
      { label: "AI 续写", keys: ["⌘", "J"] },
      { label: "插入公式", keys: ["⌘", "M"] },
      { label: "插入表格", keys: ["⌘", "⇧", "E"] },
      { label: "插入代码块", keys: ["⌘", "⇧", "C"] },
      { label: "插入链接" },
      { label: "插入图片" },
    ],
  },
  {
    title: "学习",
    items: [
      { label: "打开翻译工具", keys: ["⌘", "T"] },
      { label: "翻译选中文本" },
      { label: "切换语言对" },
      { label: "打开作文批改" },
      { label: "开始批改", keys: ["⌘", "G"] },
      { label: "获取改进建议" },
      { label: "查看学习进度" },
      { label: "设置每日目标" },
      { label: "学习统计" },
      { label: "学习日历" },
      { label: "标记已掌握" },
      { label: "安排复习" },
      { label: "开始复习", keys: ["⌘", "⇧", "V"] },
      { label: "暂停复习" },
      { label: "下一项", keys: ["Space"] },
      { label: "显示答案" },
      { label: "朗读内容" },
      { label: "专注阅读模式" },
      { label: "快速笔记", keys: ["⌘", "⇧", "L"] },
      { label: "高亮标记" },
      { label: "查看成就" },
      { label: "查看连续学习" },
      { label: "导出学习报告" },
      { label: "学习历史" },
    ],
  },
  {
    title: "设置",
    items: [
      { label: "打开设置" },
      { label: "切换主题" },
      { label: "切换语言" },
      { label: "配置 API" },
      { label: "备份数据" },
      { label: "恢复数据" },
      { label: "云同步" },
    ],
  },
];

const languageOptions: Array<{ value: AppLanguage; label: string }> = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
];

const fontOptions: Array<{ value: AppFontFamily; label: string }> = [
  { value: "system", label: "系统默认" },
  { value: "sans", label: "无衬线" },
  { value: "serif", label: "衬线" },
  { value: "mono", label: "等宽" },
];

const imageCopyOptions: Array<{ value: CopyImageMode; label: string }> = [
  { value: "ignore", label: "不复制" },
  { value: "placeholder", label: "占位符（含尺寸）" },
  { value: "original", label: "原始引用" },
];

const toolsCopyOptions: Array<{ value: CopyToolsMode; label: string }> = [
  { value: "ignore", label: "不复制" },
  { value: "summary", label: "摘要（名称+数量）" },
  { value: "full", label: "完整 JSON" },
];

const messageCopyOptions: Array<{ value: CopyMessageMode; label: string }> = [
  { value: "summary", label: "摘要" },
  { value: "full", label: "完整文本" },
];

const thinkingCopyOptions: Array<{ value: CopyThinkingMode; label: string }> = [
  { value: "remove", label: "移除" },
  { value: "keep", label: "保留" },
];

const settingsPageMeta: Record<string, { title: string; description: string }> = {
  general: {
    title: "通用",
    description: "管理语言、缩放与字体，让日常使用保持稳定一致。",
  },
  appearance: {
    title: "外观",
    description: "调整主题、窗口材质与界面观感，保持跨平台的克制质感。",
  },
  models: {
    title: "模型",
    description: "配置模型服务、分配策略与 OCR 引擎，明确当前能力入口。",
  },
  tools: {
    title: "工具",
    description: "整理记忆、隐私与快捷键等工具能力，方便长期维护。",
  },
  advanced: {
    title: "高级",
    description: "处理开发调试与数据治理等高风险选项，避免误操作。",
  },
  demo: {
    title: "组件 Demo",
    description: "集中查看当前设计语言的组件状态、反馈模式与交互基线。",
  },
  about: {
    title: "关于",
    description: "查看版本、协作信息与外部链接，快速确认当前发行状态。",
  },
};

const coreConversationModel = {
  title: "对话模型（解答 + 对话）",
  description: "用于题目解答和对话交互，可以选择任意类型的模型。",
  provider: "SiliconFlow",
  modelId: "deepseek-ai/DeepSeek-V3.2",
  vendor: "DeepSeek",
} as const;

const enhancedModelAssignments = [
  {
    title: "Anki 制卡模型（卡片生成）",
    description: "用于 Anki 卡片生成功能，根据学习内容智能生成问答卡片。",
    provider: "SiliconFlow",
    modelId: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    vendor: "通义千问",
  },
  {
    title: "题库 AI 批改模型（评判 + 解析）",
    description: "用于题库中的 AI 评判与 AI 解析。若未配置，将回退使用“对话模型”。",
    provider: "SiliconFlow",
    modelId: "deepseek-ai/DeepSeek-V3.2",
    vendor: "DeepSeek",
  },
  {
    title: "标题/标签生成模型",
    description: "用于生成聊天标题与智能标签提取，建议使用理解能力强且速度快的模型。若不设置，将默认使用对话模型。",
    provider: "SiliconFlow",
    modelId: "inclusionAI/Ling-mini-2.0",
    vendor: "蚂蚁百灵",
  },
  {
    title: "翻译专用模型（文本翻译）",
    description: "专门用于文本翻译功能，建议使用理解和语言转换能力强的模型。如果未选择，将使用“对话模型”。",
    provider: "SiliconFlow",
    modelId: "tencent/Hunyuan-MT-7B",
    vendor: "腾讯",
  },
  {
    title: "记忆决策模型",
    description: "用于智能写入记忆时判断去重/更新/追加，建议使用快速轻量的模型。若不设置，将默认使用功能增强模型。",
    provider: "SiliconFlow",
    modelId: "inclusionAI/Ling-mini-2.0",
    vendor: "蚂蚁百灵",
  },
] as const;

const ragAssignments = [
  {
    title: "重排序模型（RAG 优化，可选）",
    description: "用于对 RAG 检索结果进行重排序，提高相关性（可选配置）。",
    provider: "SiliconFlow",
    modelId: "BAAI/bge-reranker-v2-m3",
    vendor: "智源研究院",
  },
] as const;

const embeddingDimensions = [
  {
    dimension: "1024",
    providerModel: "SiliconFlow - BAAI/bge-m3",
    dataset: "vfs_emb_text_1024",
    count: "34",
    dataType: "文本",
    status: "正常",
  },
] as const;

const ocrEngines = [
  {
    priority: 1,
    label: "SiliconFlow - PaddleOCR-VL-1.5",
    badges: ["免费", "坐标定位", "主引擎"] as const,
    description: "百度开源 OCR 视觉语言模型 1.5 版，支持 109 种语言，精度 94.5%，完全免费。",
  },
  {
    priority: 2,
    label: "SiliconFlow - PaddleOCR-VL",
    badges: ["免费", "坐标定位"] as const,
    description: "百度开源 OCR 视觉语言模型旧版，支持坐标输出，完全免费，作为 1.5 版的备用。",
  },
  {
    priority: 3,
    label: "SiliconFlow - DeepSeek-OCR",
    badges: ["坐标定位"] as const,
    description: "专业 OCR 模型，支持 Grounding 坐标输出，适合题目集识别。",
  },
  {
    priority: 4,
    label: "SiliconFlow - GLM-4.6V",
    badges: ["坐标定位"] as const,
    description: "智谱 106B MoE 多模态模型，支持 bbox_2d 坐标输出，题目集导入优先引擎。",
  },
  {
    priority: 5,
    label: "SiliconFlow - Qwen3-VL-8B",
    modelId: "Qwen/Qwen3-VL-8B-Instruct",
    badges: [] as const,
    description: "作为补充多模态备用引擎参与自动熔断重试。",
  },
  {
    priority: 6,
    label: "系统 OCR (macOS Vision)",
    badges: ["免费", "离线"] as const,
    description: "调用操作系统内置 OCR 引擎，免费离线，无需 API Key。",
  },
] as const;

const configCheckItems = [
  "对话模型",
  "Anki 制卡模型",
  "题库 AI 批改模型",
  "RAG 重排序模型",
  "标题/标签生成模型",
  "OCR 引擎",
] as const;

const settingsContentColumnStyle = {
  maxWidth: "var(--workspace-max-width)",
} satisfies CSSProperties;

function SettingsRow({ title, description, control, controlClassName }: SettingsRowProps) {
  return (
    <div className="flex flex-col gap-3 px-5 py-3.5 md:flex-row md:items-center md:justify-between md:gap-6 md:px-6">
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <div className={cn("shrink-0 md:pl-4", controlClassName)}>{control}</div>
    </div>
  );
}

function SettingsSwitchRow({
  title,
  description,
  ariaLabel,
  checked,
  onCheckedChange,
  controlSurfaceClassName,
}: SettingsSwitchRowProps) {
  const switchId = useId();

  return (
    <div
      data-slot="settings-switch-row"
      className="flex min-h-[var(--touch-target-size)] flex-col gap-3 px-5 py-3.5 md:flex-row md:items-center md:justify-between md:gap-6 md:px-6"
    >
      <label
        htmlFor={switchId}
        className="flex min-h-[var(--touch-target-size)] min-w-0 flex-1 cursor-pointer flex-col justify-center space-y-1.5"
      >
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="max-w-xl text-sm leading-6 text-muted-foreground">{description}</span>
      </label>
      <div className="shrink-0 md:pl-4">
        <div className={cn(SETTINGS_SWITCH_CONTROL_CLASS_NAME, controlSurfaceClassName)}>
          <Switch
            id={switchId}
            aria-label={ariaLabel}
            checked={checked}
            onCheckedChange={onCheckedChange}
          />
        </div>
      </div>
    </div>
  );
}

function SettingsMetaRow({ title, value, description, action }: SettingsMetaRowProps) {
  return (
    <div className="flex flex-col gap-2.5 px-5 py-3.5 md:px-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{title}</p>
        {value ? <p className="text-sm font-medium text-foreground">{value}</p> : null}
      </div>
      {description ? <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

function SettingsSection({ panelSurfaceClassName, title, description, children }: SettingsSectionProps) {
  return (
    <section data-slot="settings-section-group" className="space-y-3">
      {title ? (
        <div className="space-y-1 px-1">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      <div className={cn("overflow-hidden rounded-2xl", panelSurfaceClassName)}>
        <div className="divide-y divide-black/6 dark:divide-white/8">{children}</div>
      </div>
    </section>
  );
}

const SETTINGS_VALUE_PILL_CLASS_NAME =
  "inline-flex items-center rounded-full border border-border/60 bg-background/90 px-3 py-1 text-xs font-medium text-muted-foreground";

const SETTINGS_EMBEDDED_PANEL_CLASS_NAME =
  "rounded-xl border border-border/70 bg-background/92 p-4";

const SETTINGS_EMBEDDED_PANEL_SOFT_CLASS_NAME =
  "rounded-xl border border-border/70 bg-background/88 p-4";

const SETTINGS_EMBEDDED_TILE_CLASS_NAME =
  "rounded-xl border border-border/60 bg-secondary/78 px-4 py-3 text-sm text-muted-foreground";

const SETTINGS_STATUS_CARD_CLASS_NAME =
  "flex items-center gap-3 rounded-xl border border-border/70 bg-[color:var(--shell-panel)] px-4 py-4";

function SettingBlock({ title, description, currentValue, controls, footer }: SettingBlockProps) {
  return (
    <div className="px-5 py-3.5 md:px-6">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {currentValue ? (
            <span className={SETTINGS_VALUE_PILL_CLASS_NAME}>
              {currentValue}
            </span>
          ) : null}
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <div className="mt-3.5">{controls}</div>
      {footer ? <div className="mt-3.5">{footer}</div> : null}
    </div>
  );
}

function ChoiceChip({ label, selected, onClick, className }: ChoiceChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "min-h-11 rounded-2xl border px-4.5 py-2 text-sm font-medium transition-colors duration-150",
        selected
          ? "bg-interactive-selected text-foreground border border-border/70 hover:bg-interactive-selected"
          : "bg-background/92 text-foreground border border-border/70 hover:bg-interactive-hover",
        className,
      )}
    >
      {label}
    </button>
  );
}

function ShortcutKey({ value }: { value: string }) {
  return (
    <span className="inline-flex min-w-9 items-center justify-center rounded-xl border border-border/60 bg-background/92 px-3 py-2 text-sm font-semibold text-foreground shadow-sm shadow-black/5">
      {value}
    </span>
  );
}

function ShortcutValue({ keys }: { keys?: string[] }) {
  if (!keys?.length) {
    return (
      <span className={SETTINGS_VALUE_PILL_CLASS_NAME}>
        无
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {keys.map((key) => (
        <ShortcutKey key={`${keys.join("-")}-${key}`} value={key} />
      ))}
    </div>
  );
}

function FilterControls<T extends string>({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className={SETTINGS_EMBEDDED_PANEL_SOFT_CLASS_NAME}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <div className="mt-3 flex flex-wrap gap-2.5">
        {options.map((option) => (
          <ChoiceChip
            key={option.value}
            label={option.label}
            selected={value === option.value}
            onClick={() => onChange(option.value)}
            className="min-w-[8.5rem] justify-center"
          />
        ))}
      </div>
    </div>
  );
}

function DataFlowCard({ title, description }: { title: string; description: string }) {
  return (
    <div className={SETTINGS_EMBEDDED_PANEL_CLASS_NAME}>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">{description}</p>
    </div>
  );
}

function ModelAssignmentCard({
  title,
  description,
  provider,
  modelId,
  vendor,
}: (typeof enhancedModelAssignments)[number] | typeof coreConversationModel | (typeof ragAssignments)[number]) {
  return (
    <div className={SETTINGS_EMBEDDED_PANEL_CLASS_NAME}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <span className="inline-flex items-center rounded-full bg-primary/12 px-2.5 py-1 text-[11px] font-semibold text-primary dark:bg-primary/20">
          {vendor}
        </span>
      </div>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">{description}</p>
      <div className="mt-4 space-y-2 rounded-2xl border border-border/60 bg-secondary/78 px-4 py-3">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{provider}</p>
        <p className="break-all text-sm font-medium text-foreground">{modelId}</p>
      </div>
    </div>
  );
}

function OcrEngineCard({
  priority,
  label,
  modelId,
  badges,
  description,
}: {
  priority: number;
  label: string;
  modelId?: string;
  badges: readonly string[];
  description: string;
}) {
  return (
    <div className={SETTINGS_EMBEDDED_PANEL_CLASS_NAME}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary/12 text-sm font-semibold text-primary dark:bg-primary/20">
          {priority}
        </span>
        <p className="text-sm font-semibold text-foreground">{label}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {badges.map((badge) => (
          <span
            key={badge}
            className="inline-flex items-center rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
          >
            {badge}
          </span>
        ))}
      </div>
      {modelId ? <p className="mt-3 break-all text-sm text-foreground">{modelId}</p> : null}
      <p className="mt-3 text-sm leading-7 text-muted-foreground">{description}</p>
    </div>
  );
}

const SETTINGS_PREVIEW_DIALOG_CLASS_NAME =
  "max-h-[calc(100dvh-var(--layout-safe-area-top)-var(--layout-safe-area-bottom)-1.5rem)] w-[min(92vw,52rem)] overflow-y-auto rounded-2xl border border-border/70 bg-background/98 p-0 shadow-lg shadow-black/10";

const SETTINGS_PREVIEW_DIALOG_NARROW_CLASS_NAME =
  "max-h-[calc(100dvh-var(--layout-safe-area-top)-var(--layout-safe-area-bottom)-1.5rem)] w-[min(92vw,48rem)] overflow-y-auto rounded-2xl border border-border/70 bg-background/98 p-0 shadow-lg shadow-black/10";

const SETTINGS_PREVIEW_CARD_CLASS_NAME =
  "rounded-2xl border border-border/70 bg-background/94 p-5 shadow-sm shadow-black/5";

const SETTINGS_PREVIEW_TILE_CLASS_NAME = "rounded-2xl border border-border/60 bg-secondary/78 px-4 py-3 text-sm text-muted-foreground";

function DebugPanelPreview() {
  return (
    <DialogContent className={SETTINGS_PREVIEW_DIALOG_CLASS_NAME}>
      <div className="overflow-hidden rounded-2xl">
        <div className="border-b border-black/6 px-4 py-4 sm:px-6 sm:py-5 dark:border-white/8">
          <DialogHeader className="space-y-2">
            <DialogTitle className="text-xl sm:text-2xl">统一调试面板</DialogTitle>
            <DialogDescription>
              用于调试全局流式会话与事件，聚合会话状态、网络事件和工具调用摘要。
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="grid gap-4 bg-secondary/54 px-4 py-4 sm:px-6 sm:py-6 md:grid-cols-[1.2fr_0.8fr]">
          <div className={SETTINGS_PREVIEW_CARD_CLASS_NAME}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">全局流式会话</p>
              <span className="rounded-full bg-primary/12 px-3 py-1 text-xs font-semibold text-primary dark:bg-primary/20">
                stream#4821
              </span>
            </div>
            <div className="space-y-3">
              {[
                "12:02:18 onChunk - 收到 3 个 delta 片段",
                "12:02:19 onToolStart - web.search_query",
                "12:02:21 onToolResult - 2 条主源命中",
                "12:02:24 onComplete - 已拼接最终响应",
              ].map((item) => (
                <div
                  key={item}
                  className={SETTINGS_PREVIEW_TILE_CLASS_NAME}
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className={SETTINGS_PREVIEW_CARD_CLASS_NAME}>
              <p className="text-sm font-semibold text-foreground">事件概览</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[
                  ["请求数", "14"],
                  ["工具调用", "6"],
                  ["平均延迟", "482 ms"],
                  ["错误", "0"],
                ].map(([label, value]) => (
                  <div key={label} className={SETTINGS_EMBEDDED_TILE_CLASS_NAME}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className={SETTINGS_PREVIEW_CARD_CLASS_NAME}>
              <p className="text-sm font-semibold text-foreground">当前焦点</p>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                支持查看请求体、事件时间线、工具摘要以及模型切换历史，用于排查全局流式会话异常。
              </p>
            </div>
          </div>
        </div>
        <DialogFooter className="border-t border-black/6 px-4 py-4 sm:px-6 dark:border-white/8">
          <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
            导出调试快照
          </Button>
          <Button>固定到右侧</Button>
        </DialogFooter>
      </div>
    </DialogContent>
  );
}

function PrivacyAgreementPreview() {
  return (
    <DialogContent className={SETTINGS_PREVIEW_DIALOG_NARROW_CLASS_NAME}>
      <div className="overflow-hidden rounded-2xl">
        <div className="border-b border-black/6 px-4 py-4 sm:px-6 sm:py-5 dark:border-white/8">
          <DialogHeader className="space-y-2">
            <DialogTitle className="text-xl sm:text-2xl">首次安装协议预览</DialogTitle>
            <DialogDescription>
              打开首次安装时显示的用户协议与隐私政策弹窗，用于预览效果。
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="space-y-4 bg-secondary/56 px-4 py-4 sm:px-6 sm:py-6">
          <div className={SETTINGS_PREVIEW_CARD_CLASS_NAME}>
            <p className="text-sm font-semibold text-foreground">用户协议</p>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              使用本应用即表示您同意本地保存对话、笔记与设置，并在启用 AI 功能时向您配置的 LLM API 服务商发送必要的请求数据。
            </p>
          </div>
          <div className={SETTINGS_PREVIEW_CARD_CLASS_NAME}>
            <p className="text-sm font-semibold text-foreground">隐私政策</p>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              本地数据保留在您的设备上；如果您启用云同步或匿名错误报告，对应数据会发送至您配置的同步服务或错误报告服务。您可以随时前往数据治理导出、备份或删除数据。
            </p>
          </div>
        </div>
        <DialogFooter className="border-t border-black/6 px-4 py-4 sm:px-6 dark:border-white/8">
          <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
            关闭预览
          </Button>
          <Button>模拟首次安装流程</Button>
        </DialogFooter>
      </div>
    </DialogContent>
  );
}

function ModelServicePanel({ panelSurfaceClassName }: { panelSurfaceClassName: string }) {
  return (
    <SettingsSection panelSurfaceClassName={panelSurfaceClassName}>
      <SettingBlock
        title="模型服务配置"
        description="集中展示当前启用的 SiliconFlow 模型服务、OCR 引擎优先级与配置健康状态，方便在开始接入真实后端前先核对默认方案。"
        controls={
          <div className="grid gap-3 md:grid-cols-3">
            <DataFlowCard title="首选服务商" description="SiliconFlow - 统一承载对话、增强能力、RAG 重排与 OCR 引擎。" />
            <DataFlowCard title="VLM 深度推理" description="关闭可显著降低 OCR / 题目集导入延迟。" />
            <DataFlowCard title="已启用 OCR 引擎" description="6 个引擎按优先级自动熔断重试。" />
          </div>
        }
        footer={
          <p className="text-sm leading-7 text-muted-foreground">
            当前仓库仍是设置界面演示实现，因此这里先固化默认模型与引擎编排，后续接真实 API 时可直接复用同一份信息架构。
          </p>
        }
      />

      <SettingBlock
        title="嵌入维度管理"
        description="管理知识库中不同维度向量数据与嵌入模型的映射关系。"
        currentValue="维度数 1 / 总数据量 34"
        controls={
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <DataFlowCard title="维度数" description="1" />
              <DataFlowCard title="总数据量" description="34" />
              <DataFlowCard title="文本" description="1" />
            </div>
            <div data-slot="embedding-dimensions-cards" className="grid gap-3 lg:hidden">
              {embeddingDimensions.map((item) => (
                <div
                  key={`${item.dimension}-${item.dataset}-compact`}
                  className={SETTINGS_EMBEDDED_PANEL_SOFT_CLASS_NAME}
                >
                  <dl className="grid gap-3 text-sm">
                    {[
                      ["维度", item.dimension],
                      ["关联模型", item.providerModel],
                      ["数据集", item.dataset],
                      ["数据量", String(item.count)],
                      ["类型", item.dataType],
                      ["状态", item.status],
                    ].map(([label, value]) => (
                      <div key={`${item.dimension}-${label}`} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className={cn("min-w-0 break-words text-foreground", label === "状态" && "font-medium text-primary")}>
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
            <div
              data-slot="embedding-dimensions-table"
              className="hidden overflow-hidden rounded-3xl border border-border/70 bg-background/90 shadow-sm shadow-black/5 lg:block"
            >
              <div className="grid grid-cols-[0.8fr_1.5fr_1.2fr_0.7fr_0.7fr_0.8fr] gap-3 border-b border-black/6 px-4 py-3 text-xs font-semibold text-muted-foreground dark:border-white/8">
                <span>维度</span>
                <span>关联模型</span>
                <span>数据集</span>
                <span>数据量</span>
                <span>类型</span>
                <span>状态</span>
              </div>
              {embeddingDimensions.map((item) => (
                <div
                  key={`${item.dimension}-${item.dataset}`}
                  className="grid grid-cols-[0.8fr_1.5fr_1.2fr_0.7fr_0.7fr_0.8fr] gap-3 px-4 py-4 text-sm text-foreground"
                >
                  <span>{item.dimension}</span>
                  <span>{item.providerModel}</span>
                  <span>{item.dataset}</span>
                  <span>{item.count}</span>
                  <span>{item.dataType}</span>
                  <span className="font-medium text-primary">{item.status}</span>
                </div>
              ))}
            </div>
          </div>
        }
      />

      <SettingBlock
        title="SiliconFlowOCR 引擎"
        description="按优先级从上到下尝试，引擎故障时自动熔断到下一个。可添加任意多模态模型作为备用引擎。"
        currentValue="已启用 6 个引擎，支持自动熔断重试"
        controls={
          <div className="space-y-4">
            <div className="grid gap-3 xl:grid-cols-2">
              {ocrEngines.map((engine) => (
                <OcrEngineCard key={`${engine.priority}-${engine.label}`} {...engine} />
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-3">
                <Button disabled variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                  引擎对比测试（预览）
                </Button>
                <Button disabled variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                  + 添加引擎（预览）
                </Button>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                引擎对比和新增入口会在真实引擎配置页接入后开放，当前先保持只读预览。
              </p>
            </div>
          </div>
        }
      />

      <SettingBlock
        title="配置状态检查"
        description="用于快速确认当前演示方案已填入关键能力入口；状态为静态展示，不代表实时探活结果。"
        controls={
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {configCheckItems.map((item) => (
              <div
                key={item}
                className={SETTINGS_STATUS_CARD_CLASS_NAME}
              >
                <span className="inline-flex items-center justify-center rounded-full bg-primary/12 p-2 text-primary dark:bg-primary/20">
                  <CheckCircle size={18} weight="fill" />
                </span>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">{item}</p>
                  <p className="text-xs text-muted-foreground">演示配置已填入，可继续接入真实服务状态。</p>
                </div>
              </div>
            ))}
          </div>
        }
      />
    </SettingsSection>
  );
}

function ModelAssignPanel({ panelSurfaceClassName }: { panelSurfaceClassName: string }) {
  return (
    <SettingsSection panelSurfaceClassName={panelSurfaceClassName}>
      <SettingBlock
        title="模型分配 / 基础核心模型"
        description="对话入口统一使用一套主模型，作为题目解答、自由对话和未显式分配功能的默认回退。"
        currentValue={`${coreConversationModel.vendor} / ${coreConversationModel.provider}`}
        controls={
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <ModelAssignmentCard {...coreConversationModel} />
          </div>
        }
      />

      <SettingBlock
        title="功能增强模型"
        description="针对制卡、批改、标题标签、翻译与记忆决策等子任务做独立模型分配，在速度、成本与理解能力之间取得更稳妥的平衡。"
        controls={
          <div className="grid gap-3 xl:grid-cols-2">
            {enhancedModelAssignments.map((item) => (
              <ModelAssignmentCard key={item.title} {...item} />
            ))}
          </div>
        }
      />

      <SettingBlock
        title="RAG 与知识库"
        description="为知识库检索链补充重排序模型，并与现有 1024 维嵌入映射保持一致，减少高相关内容被误排到后面的情况。"
        controls={
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {ragAssignments.map((item) => (
                <ModelAssignmentCard key={item.title} {...item} />
              ))}
            </div>
            <div className={SETTINGS_EMBEDDED_PANEL_CLASS_NAME}>
              <p className="text-sm font-semibold text-foreground">嵌入维度映射</p>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                当前知识库维度绑定为 1024，对应 SiliconFlow - BAAI/bge-m3，数据集为 vfs_emb_text_1024，共 34 条文本向量。
              </p>
            </div>
          </div>
        }
      />
    </SettingsSection>
  );
}

function DataGovernancePanel({ panelSurfaceClassName }: { panelSurfaceClassName: string }) {
  return (
    <SettingsSection panelSurfaceClassName={panelSurfaceClassName}>
      <SettingBlock
        title="导出与备份"
        description="将对话记录、笔记、卡片与设置导出为可迁移的本地文件。"
        controls={
          <div className="flex flex-wrap gap-3">
            <Button>导出全部数据</Button>
            <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
              创建本地备份
            </Button>
          </div>
        }
      />
      <SettingBlock
        title="清理与删除"
        description="按需清理缓存、删除本地索引，或执行不可恢复的数据删除操作。"
        controls={
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
              清理请求缓存
            </Button>
            <Button variant="outline" className="rounded-xl border border-destructive/20 text-destructive hover:bg-destructive/10">
              删除全部本地数据
            </Button>
          </div>
        }
        footer={
          <p className="text-sm leading-7 text-muted-foreground">
            为了避免误操作，正式版本可在这里加入二次确认、备份提示与删除前检查。
          </p>
        }
      />
    </SettingsSection>
  );
}

export function SettingsPanel({ activeTab, onSelectTab }: SettingsPanelProps) {
  const { preference, setThemePreference, setWindowBackgroundPreference, windowBackgroundPreference } =
    useTheme();
  const {
    resetFontFamily,
    resetFontSizeScale,
    resetInterfaceScale,
    settings,
    toggleLogType,
    updateSetting,
  } = useAppSettings();
  const visibleSections = getVisibleSettingsPanelSections(activeTab);
  const panelSurfaceClassName = "bg-[color:var(--shell-panel-strong)] border border-border/70";
  const controlSurfaceClassName = "bg-background/98 border border-border/70";
  const currentLanguageLabel =
    settings.language === "zh-CN" ? "当前: 中文" : "Current: English";
  const currentScaleLabel = `当前缩放：${settings.interfaceScale}%`;
  const currentFontLabel =
    settings.fontFamily === "system"
      ? "当前字体：系统默认"
      : settings.fontFamily === "sans"
        ? "当前字体：无衬线"
        : settings.fontFamily === "serif"
          ? "当前字体：衬线"
          : "当前字体：等宽";
  const currentFontSizeLabel = `当前字号：${settings.fontSizeScale}%`;
  const currentSidebarGlassIntensityLabel = `${settings.sidebarGlassIntensity}%`;
  const currentTitlebarInsetLabel = `${settings.titlebarTopInset} px`;
  const isMacPlatform =
    typeof navigator !== "undefined" &&
    detectDesktopPlatform({
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    }) === "macos";
  const currentPageMeta = settingsPageMeta[activeTab] ?? {
    title: "设置",
    description: "按当前分类查看和调整应用偏好。",
  };

  return (
    <div
      data-slot="settings-content-column"
      className="mx-auto flex w-full flex-col gap-6 pb-20"
      style={settingsContentColumnStyle}
    >
      <header data-slot="settings-page-header" className="space-y-1.5 px-1">
        <h1 className="text-xl font-semibold text-foreground">{currentPageMeta.title}</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {currentPageMeta.description}
        </p>
      </header>

      {visibleSections.includes("general") ? (
        <SettingsSection panelSurfaceClassName={panelSurfaceClassName}>
          <SettingBlock
            title="语言设置"
            description="切换设置页和系统文案的显示语言。"
            currentValue={currentLanguageLabel}
            controls={
              <div className="relative w-full max-w-xs lg:w-56">
                <select
                  aria-label="语言设置"
                  value={settings.language}
                  onChange={(event) => updateSetting("language", event.currentTarget.value as AppLanguage)}
                  className={cn(
                    SETTINGS_SURFACE_INPUT_CLASS_NAME,
                    "w-full appearance-none border border-border/70 bg-background/98 pr-11 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] transition-[background-color,border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {languageOptions.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
                <CaretDown
                  aria-hidden="true"
                  size={16}
                  weight="bold"
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            }
          />

          <SettingBlock
            title="全局界面缩放（实验）"
            description="调节整套界面的显示比例，适合高分屏或投屏场景。"
            currentValue={currentScaleLabel}
            controls={
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={SETTINGS_VALUE_PILL_CLASS_NAME}>
                    {settings.interfaceScale}%
                  </span>
                  <Button
                    variant="outline"
                    className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                    onClick={resetInterfaceScale}
                  >
                    恢复 100%
                  </Button>
                </div>
                <input
                  aria-label="全局界面缩放"
                  type="range"
                  min={INTERFACE_SCALE_RANGE.min}
                  max={INTERFACE_SCALE_RANGE.max}
                  step={INTERFACE_SCALE_RANGE.step}
                  value={settings.interfaceScale}
                  onChange={(event) =>
                    updateSetting("interfaceScale", Number(event.currentTarget.value))
                  }
                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-background accent-primary"
                />
              </div>
            }
          />

          <SettingBlock
            title="全局字体"
            description="切换应用默认字体，统一阅读节奏。"
            currentValue={currentFontLabel}
            controls={
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2.5">
                  {fontOptions.map((option) => (
                    <ChoiceChip
                      key={option.value}
                      label={option.label}
                      selected={settings.fontFamily === option.value}
                      onClick={() => updateSetting("fontFamily", option.value)}
                    />
                  ))}
                </div>
                <Button
                  variant="outline"
                  className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                  onClick={resetFontFamily}
                >
                  恢复默认
                </Button>
              </div>
            }
          />

          <SettingBlock
            title="字体大小"
            description="按百分比提升或缩小基础字号，让阅读密度更符合当前设备。"
            currentValue={currentFontSizeLabel}
            controls={
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={SETTINGS_VALUE_PILL_CLASS_NAME}>
                    {settings.fontSizeScale}%
                  </span>
                  <Button
                    variant="outline"
                    className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                    onClick={resetFontSizeScale}
                  >
                    恢复默认
                  </Button>
                </div>
                <input
                  aria-label="字体大小"
                  type="range"
                  min={FONT_SIZE_SCALE_RANGE.min}
                  max={FONT_SIZE_SCALE_RANGE.max}
                  step={FONT_SIZE_SCALE_RANGE.step}
                  value={settings.fontSizeScale}
                  onChange={(event) => updateSetting("fontSizeScale", Number(event.currentTarget.value))}
                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-background accent-primary"
                />
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {visibleSections.includes("model-service") ? (
        <ModelServicePanel panelSurfaceClassName={panelSurfaceClassName} />
      ) : null}

      {visibleSections.includes("model-assign") ? (
        <ModelAssignPanel panelSurfaceClassName={panelSurfaceClassName} />
      ) : null}

      {visibleSections.includes("appearance") ? (
        <>
          <SettingsSection panelSurfaceClassName={panelSurfaceClassName}>
            <SettingsRow
              title="外观 / 主题"
              description="使用浅色、深色，或匹配系统设置"
              control={
                <Tabs value={preference} onValueChange={(value) => setThemePreference(value as ThemePreference)}>
                  <TabsList
                    className={cn(
                      "grid h-auto w-full grid-cols-3 rounded-2xl px-1 py-1 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.035)] lg:inline-flex lg:h-11 lg:w-auto dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]",
                      controlSurfaceClassName,
                    )}
                  >
                    <TabsTrigger value="light" className="min-h-[var(--touch-target-size)] gap-2 rounded-xl px-3 text-sm font-medium lg:min-h-9 lg:px-4.5">
                      <Sun size={20} weight="regular" />
                      浅色
                    </TabsTrigger>
                    <TabsTrigger value="dark" className="min-h-[var(--touch-target-size)] gap-2 rounded-xl px-3 text-sm font-medium lg:min-h-9 lg:px-4.5">
                      <Moon size={20} weight="regular" />
                      深色
                    </TabsTrigger>
                    <TabsTrigger value="system" className="min-h-[var(--touch-target-size)] gap-2 rounded-xl px-3 text-sm font-medium lg:min-h-9 lg:px-4.5">
                      <Desktop size={20} weight="regular" />
                      系统默认
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              }
            />

            {isMacPlatform ? (
              <SettingsSwitchRow
                title="macOS 原生字体平滑"
                description="macOS 下优先跟随系统默认字体平滑策略，不再全局强制 antialiased。关闭后回退为兼容旧版观感的灰度平滑。"
                ariaLabel="切换 macOS 原生字体平滑"
                checked={settings.macosNativeFontSmoothing}
                onCheckedChange={(checked) => updateSetting("macosNativeFontSmoothing", checked)}
                controlSurfaceClassName={controlSurfaceClassName}
              />
            ) : null}

            <SettingsSwitchRow
              title="毛玻璃侧边栏"
              description="开启后使用系统毛玻璃侧边栏（Windows 为系统材质）；关闭后使用纯色侧边栏。系统减少透明度或材质不可用时会自动回退。"
              ariaLabel="切换毛玻璃侧边栏"
              checked={windowBackgroundPreference === "translucent"}
              onCheckedChange={(checked) =>
                setWindowBackgroundPreference(checked ? "translucent" : "opaque")
              }
              controlSurfaceClassName={controlSurfaceClassName}
            />

            <SettingsRow
              title="侧边栏毛玻璃强度"
              description="开启后生效；数值越高，毛玻璃越明显。"
              controlClassName="w-full md:w-[19rem]"
              control={
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={SETTINGS_VALUE_PILL_CLASS_NAME}>
                      {currentSidebarGlassIntensityLabel}
                    </span>
                    <Button
                      variant="outline"
                      className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                      onClick={() =>
                        updateSetting(
                          "sidebarGlassIntensity",
                          DEFAULT_APP_SETTINGS.sidebarGlassIntensity,
                        )
                      }
                    >
                      恢复 100%
                    </Button>
                  </div>
                  <input
                    aria-label="侧边栏毛玻璃强度"
                    type="range"
                    disabled={windowBackgroundPreference !== "translucent"}
                    min={SIDEBAR_GLASS_INTENSITY_RANGE.min}
                    max={SIDEBAR_GLASS_INTENSITY_RANGE.max}
                    step={SIDEBAR_GLASS_INTENSITY_RANGE.step}
                    value={settings.sidebarGlassIntensity}
                    onChange={(event) =>
                      updateSetting("sidebarGlassIntensity", Number(event.currentTarget.value))
                    }
                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-background accent-primary"
                  />
                </div>
              }
            />

            <SettingBlock
              title="当前主题预览"
              description="用真实语义 token 预览侧栏、阅读面板和主行动色，确认主题是稳定材质加克制重点色，而不是整页染色。"
              controls={
                <div
                  data-slot="settings-theme-preview"
                  className="overflow-hidden rounded-2xl border border-border/70 bg-[color:var(--shell-backdrop)] p-3 shadow-sm shadow-black/5"
                >
                  <div className="grid min-h-36 gap-3 md:grid-cols-[7.5rem_minmax(0,1fr)]">
                    <aside
                      data-slot="settings-theme-preview-sidebar"
                      className="rounded-xl border border-border/60 bg-sidebar px-3 py-3 text-sidebar-foreground"
                    >
                      <div className="mb-4 h-2 w-14 rounded-full bg-sidebar-muted/45" />
                      <div className="space-y-2">
                        <div className="h-7 rounded-lg bg-interactive-selected" />
                        <div className="h-7 rounded-lg bg-interactive-hover" />
                        <div className="h-7 rounded-lg bg-transparent ring-1 ring-inset ring-border/55" />
                      </div>
                    </aside>
                    <section
                      data-slot="settings-theme-preview-panel"
                      className="flex min-w-0 flex-col justify-between rounded-xl border border-border/60 bg-[color:var(--shell-panel-strong)] px-4 py-4"
                    >
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="h-2.5 w-24 rounded-full bg-foreground/72" />
                          <div className="h-7 w-16 rounded-full bg-secondary" />
                        </div>
                        <div className="space-y-2">
                          <div className="h-2 w-full max-w-72 rounded-full bg-muted-foreground/26" />
                          <div className="h-2 w-4/5 max-w-60 rounded-full bg-muted-foreground/18" />
                        </div>
                      </div>
                      <div className="mt-5 flex items-center justify-between gap-3">
                        <div className="h-8 flex-1 rounded-xl border border-border/60 bg-background/88" />
                        <div
                          data-slot="settings-theme-preview-action"
                          className="h-8 w-24 rounded-xl bg-primary shadow-sm shadow-black/10"
                        />
                      </div>
                    </section>
                  </div>
                </div>
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {visibleSections.includes("developer") ? (
        <SettingsSection
          panelSurfaceClassName={panelSurfaceClassName}
          title="开发与调试"
          description="调试能力保持原样，只压缩到更连续的桌面设置节奏。"
        >
          <SettingBlock
            title="顶部栏顶部边距高度"
            description="调整 content-header virtual-titlebar 的顶部边距高度。常用于安卓环境下为状态栏预留空间。单位为 px，设置为 0 表示无边距。"
            currentValue={currentTitlebarInsetLabel}
            controls={
              <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_auto] sm:items-center">
                <div className="relative">
                  <Input
                    aria-label="顶部栏顶部边距高度"
                    type="number"
                    min={TITLEBAR_TOP_INSET_RANGE.min}
                    max={TITLEBAR_TOP_INSET_RANGE.max}
                    step={TITLEBAR_TOP_INSET_RANGE.step}
                    value={settings.titlebarTopInset}
                    onChange={(event) =>
                      updateSetting(
                        "titlebarTopInset",
                        Math.max(
                          TITLEBAR_TOP_INSET_RANGE.min,
                          Math.min(
                            TITLEBAR_TOP_INSET_RANGE.max,
                            Number(event.currentTarget.value || 0),
                          ),
                        ),
                      )
                    }
                    className={cn(SETTINGS_SURFACE_INPUT_CLASS_NAME, "pr-12")}
                  />
                  <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    px
                  </span>
                </div>
                <Button
                  variant="outline"
                  className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                  onClick={() => updateSetting("titlebarTopInset", 0)}
                >
                  重置为 0
                </Button>
              </div>
            }
          />

          <SettingsSwitchRow
            title="调试日志"
            description="开启后将输出详细的调试日志到控制台"
            ariaLabel="调试日志"
            checked={settings.debugLoggingEnabled}
            onCheckedChange={(checked) => updateSetting("debugLoggingEnabled", checked)}
            controlSurfaceClassName={controlSurfaceClassName}
          />

          <SettingBlock
            title="打开统一调试面板"
            description="用于调试全局流式会话与事件"
            controls={
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                    打开统一调试面板
                  </Button>
                </DialogTrigger>
                <DebugPanelPreview />
              </Dialog>
            }
          />

          <SettingBlock
            title="日志类型"
            description="选择要启用的日志类型"
            controls={
              <div className="flex flex-wrap gap-2.5">
                <ChoiceChip
                  label="后端"
                  selected={settings.logTypes.includes("backend")}
                  onClick={() => toggleLogType("backend")}
                />
              </div>
            }
          />

          <SettingBlock
            title="打开日志文件夹"
            description="快速定位本地日志与请求快照的保存目录。"
            controls={
              <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                打开日志文件夹
              </Button>
            }
          />

          <SettingBlock
            title="预览隐私协议"
            description="打开首次安装时显示的用户协议与隐私政策弹窗，用于预览效果。"
            controls={
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                    打开预览
                  </Button>
                </DialogTrigger>
                <PrivacyAgreementPreview />
              </Dialog>
            }
          />

          <SettingsSwitchRow
            title="显示消息请求体"
            description="开启后，Chat V2 中每条助手消息下方将显示完整的 API 请求体，便于调试。"
            ariaLabel="显示消息请求体"
            checked={settings.showMessageRequestBody}
            onCheckedChange={(checked) => updateSetting("showMessageRequestBody", checked)}
            controlSurfaceClassName={controlSurfaceClassName}
          />

          <SettingBlock
            title="复制内容过滤"
            description="控制“复制请求体”时各部分的处理方式。"
            controls={
              <div className="grid gap-3 xl:grid-cols-2">
                <FilterControls
                  title="图片"
                  value={settings.imageCopyMode}
                  options={imageCopyOptions}
                  onChange={(value) => updateSetting("imageCopyMode", value)}
                />
                <FilterControls
                  title="Tools"
                  value={settings.toolsCopyMode}
                  options={toolsCopyOptions}
                  onChange={(value) => updateSetting("toolsCopyMode", value)}
                />
                <FilterControls
                  title="消息内容"
                  value={settings.messageCopyMode}
                  options={messageCopyOptions}
                  onChange={(value) => updateSetting("messageCopyMode", value)}
                />
                <FilterControls
                  title="Thinking"
                  value={settings.thinkingCopyMode}
                  options={thinkingCopyOptions}
                  onChange={(value) => updateSetting("thinkingCopyMode", value)}
                />
              </div>
            }
          />

          <SettingsSwitchRow
            title="持久化调试日志"
            description="开启后，每次 LLM 请求的完整请求体（含图片、工具等）将以 JSON 文件保存到数据目录，不受过滤级别影响。"
            ariaLabel="持久化调试日志"
            checked={settings.persistDebugLogs}
            onCheckedChange={(checked) => updateSetting("persistDebugLogs", checked)}
            controlSurfaceClassName={controlSurfaceClassName}
          />
        </SettingsSection>
      ) : null}

      {visibleSections.includes("memory") ? (
        <SettingsSection
          panelSurfaceClassName={panelSurfaceClassName}
          title="记忆"
          description="先对齐分组层级，再保留现有配置项。"
        >
          <SettingBlock
            title="记忆系统"
            description="用于沉淀用户偏好、长期事实与常用上下文。"
            controls={
              <div className={SETTINGS_EMBEDDED_PANEL_CLASS_NAME}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-2 rounded-full bg-primary/12 px-3 py-1 text-sm font-semibold text-primary dark:bg-primary/20">
                    <CheckCircle size={16} weight="fill" />
                    ✓ 记忆系统已配置
                  </span>
                </div>
              </div>
            }
          />

          <SettingBlock
            title="记忆根文件夹"
            description="指定所有 AI 记忆文件的根目录。"
            controls={
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center">
                <Input
                  aria-label="记忆根文件夹"
                  value={settings.memoryRootFolder}
                  onChange={(event) => updateSetting("memoryRootFolder", event.currentTarget.value)}
                  placeholder="记忆"
                  className={SETTINGS_SURFACE_INPUT_CLASS_NAME}
                />
                <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                  记忆
                </Button>
                <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                  新建文件夹
                </Button>
              </div>
            }
          />

          <SettingsSwitchRow
            title="自动创建子文件夹"
            description="写入记忆时，自动按分类路径创建子文件夹"
            ariaLabel="自动创建子文件夹"
            checked={settings.autoCreateMemoryFolders}
            onCheckedChange={(checked) => updateSetting("autoCreateMemoryFolders", checked)}
            controlSurfaceClassName={controlSurfaceClassName}
          />

          <SettingBlock
            title="默认分类"
            description="未指定分类时记忆存入的默认子文件夹"
            controls={
              <Input
                aria-label="默认分类"
                value={settings.defaultMemoryCategory}
                onChange={(event) => updateSetting("defaultMemoryCategory", event.currentTarget.value)}
                placeholder="通用"
                className={SETTINGS_SURFACE_INPUT_CLASS_NAME}
              />
            }
          />

          <SettingsSwitchRow
            title="隐私模式"
            description="开启后，记忆写入与检索会跳过外部 LLM 的改写/重排，以降低敏感信息外发风险。"
            ariaLabel="隐私模式"
            checked={settings.memoryPrivacyMode}
            onCheckedChange={(checked) => updateSetting("memoryPrivacyMode", checked)}
            controlSurfaceClassName={controlSurfaceClassName}
          />
        </SettingsSection>
      ) : null}

      {visibleSections.includes("privacy") ? (
        <SettingsSection
          panelSurfaceClassName={panelSurfaceClassName}
          title="隐私与数据"
          description="统一放在一组里，方便理解数据边界与治理入口。"
        >
          <SettingsSwitchRow
            title="匿名错误报告"
            description="允许发送匿名崩溃报告以帮助改善软件质量"
            ariaLabel="匿名错误报告"
            checked={settings.anonymousCrashReports}
            onCheckedChange={(checked) => updateSetting("anonymousCrashReports", checked)}
            controlSurfaceClassName={controlSurfaceClassName}
          />

          <SettingBlock
            title="数据流向说明"
            description="帮助用户快速理解本地数据、AI 请求与可选同步能力之间的边界。"
            controls={
              <div className="grid gap-3 xl:grid-cols-2">
                <DataFlowCard
                  title="本地数据"
                  description="对话记录、笔记、文件、卡片、设置等 - 存储在您的设备上"
                />
                <DataFlowCard
                  title="AI 请求数据"
                  description="使用 AI 功能时，对话内容发送至您配置的 LLM API 服务商"
                />
                <DataFlowCard
                  title="同步数据（可选）"
                  description="如启用云同步，数据发送至您配置的 WebDAV/S3 服务"
                />
                <DataFlowCard
                  title="错误报告（可选）"
                  description="如启用，匿名崩溃信息发送至错误报告服务"
                />
                <DataFlowCard
                  title="跨境传输提示"
                  description="配置境外 API 时，对话数据将跨境传输；使用境内 API（DeepSeek、通义千问等）则数据在境内处理"
                />
              </div>
            }
          />

          <SettingBlock
            title="管理我的数据"
            description="导出、备份或删除您的所有数据"
            controls={
              <Button
                icon={ArrowSquareOut}
                variant="outline"
                className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                onClick={() => onSelectTab?.("advanced")}
              >
                前往数据治理
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      {visibleSections.includes("shortcuts") ? (
        <section className="space-y-4">
          <div className="space-y-1.5 px-1">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">快捷键</h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              汇总导航、对话、笔记、学习与设置场景下的默认快捷键，方便在桌面端快速查阅与后续扩展。
            </p>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {shortcutGroups.map((group) => (
              <div key={group.title} className={cn("overflow-hidden rounded-2xl", panelSurfaceClassName)}>
                <div className="flex items-center justify-between gap-3 border-b border-black/6 px-5 py-4 dark:border-white/8 md:px-6">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{group.title}</h3>
                    <p className="text-sm text-muted-foreground">{group.items.length} 项操作</p>
                  </div>
                </div>

                <div className="divide-y divide-black/6 dark:divide-white/8">
                  {group.items.map((item) => (
                    <div
                      key={`${group.title}-${item.label}`}
                      className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:justify-between md:px-6"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground">{item.label}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 md:justify-end">
                        <ShortcutValue keys={item.keys} />
                        <Button
                          variant="outline"
                          size="sm"
                          className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                        >
                          编辑
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {visibleSections.includes("data-governance") ? (
        <DataGovernancePanel panelSurfaceClassName={panelSurfaceClassName} />
      ) : null}

      {visibleSections.includes("about") ? (
        <>
          <section className="space-y-4">
            <div className="flex flex-col gap-4 px-1 md:flex-row md:items-end md:justify-between">
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold tracking-tight text-foreground">{aboutContent.name}</h2>
                <p className="text-sm leading-6 text-muted-foreground">{aboutContent.release}</p>
              </div>
              <Button variant="outline" className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}>
                {aboutContent.primaryActionLabel}
              </Button>
            </div>

            <div className={cn("overflow-hidden rounded-2xl", panelSurfaceClassName)}>
              <div className="divide-y divide-black/6 dark:divide-white/8">
                {aboutContent.developmentRows.map((row) => (
                  <SettingsMetaRow
                    key={row.label}
                    title={row.label}
                    value={row.value}
                    description={"description" in row ? row.description : undefined}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className={cn("overflow-hidden rounded-2xl", panelSurfaceClassName)}>
              <div className="divide-y divide-black/6 dark:divide-white/8">
                {aboutContent.details.map((row) => (
                  <SettingsMetaRow key={row.label} title={row.label} value={row.value} />
                ))}
                <SettingsMetaRow
                  title={aboutContent.linksTitle}
                  value=""
                  action={
                    <div className="flex flex-wrap gap-3">
                      {aboutContent.linkLabels.map((label) => (
                        <Button
                          key={label}
                          variant="outline"
                          icon={ArrowSquareOut}
                          className={SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  }
                />
                <SettingsMetaRow
                  title={aboutContent.partner.title}
                  value={aboutContent.partner.name}
                  description={aboutContent.partner.description}
                />
              </div>
            </div>
          </section>
        </>
      ) : null}

      {visibleSections.includes("demo") ? <SettingsDemoPanel /> : null}
    </div>
  );
}
