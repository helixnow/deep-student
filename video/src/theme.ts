/**
 * 主应用设计 token 的转写（默认 palette）。来源：
 * src/styles/shadcn-variables.css、src/styles/theme-colors.css、
 * src/features/workbench/styles/workbench.tokens.css、hero.html。
 */
export type Tokens = {
  dark: boolean;
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedFg: string;
  accent: string;
  border: string;
  input: string;
  nav: string;
  primary: string;
  primaryFg: string;
  info: string;
  success: string;
  warning: string;
  destructive: string;
  selected: string;
  shadowSoft: string;
  shadowPanel: string;
  shadowFloating: string;
};

export const light: Tokens = {
  dark: false,
  background: 'hsl(0 0% 100%)',
  foreground: 'hsl(220 9% 18%)',
  card: 'hsl(0 0% 99%)',
  muted: 'hsl(0 0% 94%)',
  mutedFg: 'hsl(220 6% 42%)',
  accent: 'hsl(0 0% 93%)',
  border: 'hsl(0 0% 88%)',
  input: 'hsl(0 0% 95%)',
  nav: 'hsl(0 0% 95%)',
  primary: 'hsl(215 72% 42%)',
  primaryFg: 'hsl(0 0% 100%)',
  info: 'hsl(217 70% 50%)',
  success: 'hsl(152 60% 36%)',
  warning: 'hsl(38 70% 45%)',
  destructive: 'hsl(0 65% 51%)',
  selected: 'hsl(220 9% 18% / 0.1)',
  shadowSoft: '0 12px 24px hsl(220 20% 10% / 0.06)',
  shadowPanel: '0 16px 32px hsl(220 20% 10% / 0.08)',
  shadowFloating: '0 18px 36px hsl(0 0% 0% / 0.08)',
};

export const dark: Tokens = {
  dark: true,
  background: 'hsl(0 0% 9%)',
  foreground: 'hsl(0 0% 96%)',
  card: 'hsl(0 0% 12%)',
  muted: 'hsl(0 0% 14%)',
  mutedFg: 'hsl(0 0% 60%)',
  accent: 'hsl(0 0% 15%)',
  border: 'hsl(0 0% 18%)',
  input: 'hsl(0 0% 14%)',
  nav: 'hsl(0 0% 12%)',
  primary: 'hsl(214 64% 72%)',
  primaryFg: 'hsl(220 30% 10%)',
  info: 'hsl(217 65% 55%)',
  success: 'hsl(152 55% 42%)',
  warning: 'hsl(38 65% 50%)',
  destructive: 'hsl(0 65% 55%)',
  selected: 'hsl(0 0% 96% / 0.1)',
  shadowSoft: '0 12px 24px hsl(0 0% 0% / 0.32)',
  shadowPanel: '0 16px 32px hsl(0 0% 0% / 0.4)',
  shadowFloating: '0 18px 36px hsl(0 0% 0% / 0.54)',
};

export const brand = {
  paper: 'hsl(0 0% 97%)',
  ink: 'hsl(220 12% 16%)',
  ink2: 'hsl(220 8% 38%)',
  ink3: 'hsl(220 6% 56%)',
  hairline: 'hsl(220 8% 84%)',
  accent: 'hsl(215 72% 40%)',
  pupil: 'hsl(215 72% 42%)',
  nightBlue: 'hsl(214 64% 72%)',
  gridLine: 'hsl(220 12% 16% / 0.055)',
  sea: 'hsl(217 45% 9%)',
  night: 'hsl(0 0% 9%)',
  mist: '#DBDFE2',
  sky: '#EFF3F4',
  green: 'hsl(152 62% 36%)',
  greenDark: 'hsl(152 56% 52%)',
  rose100: '#ffe4e6',
  rose700: '#be123c',
  rose900a: 'rgba(136, 19, 55, 0.4)',
  rose300: '#fda4af',
  emerald100: '#d1fae5',
  emerald900a: 'rgba(6, 78, 59, 0.3)',
} as const;

export const font = {
  ui: '"PingFang SC", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Microsoft YaHei", sans-serif',
  /** 主应用正文实际生效的字体栈（:lang(zh) → --font-family-cn，表单元素 inherit）：西文走系统字体，中文回落苹方 */
  sys: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  /** 字幕与片尾：西文、数字走系统 SF（按字符回退，汉字仍落到苹方）；界面里的字体栈不动 */
  super: 'BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  display: '"SF Pro Display", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif',
  serif: '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", serif',
  mono: '"SF Mono", ui-monospace, Menlo, monospace',
} as const;

export const TRAFFIC = {
  close: '#ff5f57',
  min: '#febc2e',
  zoom: '#28c840',
} as const;
