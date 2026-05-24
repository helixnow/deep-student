export const comboboxSuggestions = ["新增学习卡片", "整理错题本", "切换窗口模式", "打开组件示例"];

export const demoHeaderStats = [
  { label: "15 组", description: "覆盖核心控件" },
] as const;

export const demoSectionMeta = {
  stateRegression: {
    title: "状态回归检查",
    description: "把 Hover、Disabled、Error、Loading 固定在同一块，后续改按钮、输入框或反馈样式时可以直接比对。",
    className: "xl:col-span-2",
  },
  button: {
    title: "Button",
    description: "展示常用按钮层级、图标按钮和状态组合。",
  },
  input: {
    title: "Input",
    description: "单行输入可用于搜索、过滤和内联参数设置。",
  },
  textarea: {
    title: "Textarea",
    description: "适合较长说明、系统提示词或备注信息录入。",
  },
  typography: {
    title: "Typography / Font Weight",
    description: "把当前界面的字号与字重放进同一张卡片，方便检查层级、可读性和中英混排表现。",
  },
  switch: {
    title: "Switch",
    description: "适合表达开关类偏好设置，并快速反馈当前启用状态。",
  },
  selectCombobox: {
    title: "Select / Combobox Example",
    description: "示例实现：原生 Select 负责稳定选择，Combobox 预览使用 datalist 模拟模糊输入。",
  },
  dialog: {
    title: "Dialog",
    description: "适合需要聚焦完成的确认、编辑和解释任务。",
  },
  sheet: {
    title: "Sheet / Drawer",
    description: "同一个内容模型可从侧边滑出，也可从底部抽屉展开。",
  },
  tabs: {
    title: "Tabs",
    description: "在有限空间内切换同层级信息时，Tabs 仍然是最高效的方式之一。",
  },
  tooltip: {
    title: "Tooltip",
    description: "用轻量提示解释图标、术语和短暂操作反馈。",
  },
  dropdown: {
    title: "Dropdown / Menu",
    description: "适用于收纳上下文动作，避免把次级操作全部平铺在页面上。",
  },
  sidebar: {
    title: "Sidebar",
    description: "直接复用当前项目的侧边栏组件，便于检查导航结构和选中态。",
    className: "xl:col-span-2",
  },
  cardListItem: {
    title: "Card / ListItem Example",
    description: "Card 使用真实共享样式；ListItem 仍是示例行项目，用于对照连续列表的视觉节奏。",
  },
  feedback: {
    title: "Empty / Skeleton / Toast Mock",
    description: "Mock 组合：空态、骨架屏和 Toast 预览放在一起，方便快速巡检常见反馈样式。",
  },
} as const;

export const stateRegressionChecklist = [
  "Hover 填充色是否与按钮、列表项、侧边导航保持同一层级。",
  "Disabled 态的透明度是否统一，且文本仍然可读。",
  "Error 态的 ring、文字和说明是否形成同一套告警语言。",
  "Loading 态的骨架、转圈和按钮占位是否没有跳动或错位。",
] as const;

export const workspaceSelectOptions = [
  { value: "analysis", label: "Analysis" },
  { value: "knowledge", label: "Knowledge" },
  { value: "anki", label: "Anki" },
  { value: "system", label: "System" },
] as const;
