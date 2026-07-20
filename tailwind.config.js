// Tailwind CSS configuration
// See https://tailwindcss.com/docs/configuration

/** @type {import('tailwindcss').Config} */
module.exports = {
	darkMode: 'class',
	content: [
		'./index.html',
		'./src/**/*.{ts,tsx,js,jsx}',
	],
	theme: {
		// 统一断点配置（断点单一来源见 src/config/breakpoints.ts，数值需与之保持一致）
		screens: {
			'xs': '480px',   // 大屏手机（双列布局临界点）——仅 Tailwind 工具类，无对应 JS hook
			'sm': '640px',   // 手机横屏/小平板
			'md': '768px',   // 平板竖屏
			'lg': '1024px',  // 平板横屏/小笔记本
			'xl': '1280px',  // 笔记本
			'2xl': '1536px', // 大屏幕
		},
		extend: {
			fontFamily: {
				sans: ['var(--font-family)'],
				cn: ['var(--font-family-cn)'],
				mono: ['var(--font-mono)'],
			},
			fontSize: {
				'2xs': 'var(--font-size-2xs)',
				'xs': 'var(--font-size-xs)',
				'sm': 'var(--font-size-sm)',
				'base': 'var(--font-size-base)',
				'md': 'var(--font-size-md)',
				'lg': 'var(--font-size-lg)',
				'xl': 'var(--font-size-xl)',
				'2xl': 'var(--font-size-2xl)',
				'3xl': 'var(--font-size-3xl)',
				// 桌面 UI 控件标准字号（13px，介于 sm 与 base 之间）
				'ui': 'var(--font-size-ui)',
				// 2026-07 mobile 基建追加：caption 层（时间戳/辅助说明），
				// 移动端最小可读字号。Token 见 src/styles/shadcn-variables.css
				'caption': 'var(--m-text-caption)',
			},
			fontWeight: {
				'normal': 'var(--font-weight-normal)',
				'medium': 'var(--font-weight-medium)',
				'semibold': 'var(--font-weight-semibold)',
				'bold': 'var(--font-weight-bold)',
			},
			lineHeight: {
				'tight': 'var(--line-height-tight)',
				'snug': 'var(--line-height-snug)',
				'normal': 'var(--line-height-normal)',
				'relaxed': 'var(--line-height-relaxed)',
			},
			letterSpacing: {
				'tight': 'var(--letter-spacing-tight)',
				'normal': 'var(--letter-spacing-normal)',
				'wide': 'var(--letter-spacing-wide)',
			},
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))',
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))',
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))',
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))',
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))',
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))',
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))',
				},
				// 语义状态色带 <alpha-value>，支持 bg-warning/10、border-danger/40 等透明度修饰符
				info: {
					DEFAULT: 'hsl(var(--info) / <alpha-value>)',
					foreground: 'hsl(var(--info-foreground))',
				},
				success: {
					DEFAULT: 'hsl(var(--success) / <alpha-value>)',
					foreground: 'hsl(var(--success-foreground))',
				},
				warning: {
					DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
					foreground: 'hsl(var(--warning-foreground))',
				},
				danger: {
					DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
					foreground: 'hsl(var(--danger-foreground))',
				},
				neutral: {
					DEFAULT: 'hsl(var(--neutral))',
					foreground: 'hsl(var(--neutral-foreground))',
				},
				brand: {
					primary: 'var(--brand-primary)',
					secondary: 'var(--brand-secondary)',
					accent: 'var(--brand-accent)',
				},
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)',
				shell: 'var(--radius-shell-panel)',
				toolbar: 'var(--radius-shell-toolbar)',
				row: 'var(--radius-shell-row)',
				control: 'var(--radius-shell-control)',
				dialog: 'var(--radius-shell-dialog)',
				// 2026-07 chat 二轮追加：pill 形按钮/胶囊（替代裸 rounded-[999px]）
				pill: '999px',
			},
			boxShadow: {
				shell: 'var(--shadow-shell-panel)',
				floating: 'var(--shadow-shell-floating)',
				pressed: 'var(--shadow-shell-pressed)',
				soft: 'var(--shadow-shell-soft)',
			},
			// 聊天线程内容区最大宽度（消息列、输入栏、空态、滚动按钮共享）
			// Token 定义见 src/styles/shadcn-variables.css `--chat-thread-max-w`
			maxWidth: {
				thread: 'var(--chat-thread-max-w)',
			},
			// z-index 阶梯（token 定义见 src/styles/theme-colors.css），供 z-modal / z-tooltip 等类使用
			zIndex: {
				dropdown: 'var(--z-dropdown)',
				sticky: 'var(--z-sticky)',
				overlay: 'var(--z-overlay)',
				modal: 'var(--z-modal)',
				popover: 'var(--z-popover)',
				toast: 'var(--z-toast)',
				tooltip: 'var(--z-tooltip)',
				debug: 'var(--z-debug)',
			},
			// 2026-07 chat 二轮追加：标准出口曲线（transitions-dev --ease-standard 的
			// Tailwind 出口），供 tsx 组件写 `transition ... ease-standard duration-150/200`
			transitionTimingFunction: {
				standard: 'cubic-bezier(0.22, 1, 0.36, 1)',
			},
			keyframes: {
				sweep: {
					'0%': { transform: 'translateX(-30%)' },
					'50%': { transform: 'translateX(100%)' },
					'100%': { transform: 'translateX(-30%)' },
				},
				// 2026-07 chat 二轮追加：共享入场 keyframes（仅 opacity / 独立 translate，
				// 与 inline transform 定位不冲突）。token 见 src/features/chat/styles/motion.css
				'chat-rise-in': {
					from: { opacity: '0', translate: '0 4px' },
					to: { opacity: '1', translate: '0 0' },
				},
				'chat-fade-in': {
					from: { opacity: '0' },
					to: { opacity: '1' },
				},
			},
			animation: {
				sweep: 'sweep 1.2s ease-in-out infinite',
				// 2026-07 chat 二轮追加：消息/卡片入场工具类。
				// 建议配合 motion-safe: 前缀使用（reduced-motion 自动跳过）
				'chat-rise-in': 'chat-rise-in var(--chat-motion-fast, 150ms) var(--chat-motion-ease, cubic-bezier(0.22, 1, 0.36, 1)) both',
				'chat-fade-in': 'chat-fade-in var(--chat-motion-base, 200ms) var(--chat-motion-ease, cubic-bezier(0.22, 1, 0.36, 1)) both',
			},
		},
	},
	plugins: [],
};
