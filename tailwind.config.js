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
		// 统一断点配置（与useBreakpoint hooks保持一致）
		screens: {
			'xs': '480px',   // 大屏手机（双列布局临界点）
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
				'xs': 'var(--font-size-xs)',
				'sm': 'var(--font-size-sm)',
				'base': 'var(--font-size-base)',
				'md': 'var(--font-size-md)',
				'lg': 'var(--font-size-lg)',
				'xl': 'var(--font-size-xl)',
				'2xl': 'var(--font-size-2xl)',
				'3xl': 'var(--font-size-3xl)',
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
				info: {
					DEFAULT: 'hsl(var(--info))',
					foreground: 'hsl(var(--info-foreground))',
				},
				success: {
					DEFAULT: 'hsl(var(--success))',
					foreground: 'hsl(var(--success-foreground))',
				},
				warning: {
					DEFAULT: 'hsl(var(--warning))',
					foreground: 'hsl(var(--warning-foreground))',
				},
				danger: {
					DEFAULT: 'hsl(var(--danger))',
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
			},
			keyframes: {
				sweep: {
					'0%': { transform: 'translateX(-30%)' },
					'50%': { transform: 'translateX(100%)' },
					'100%': { transform: 'translateX(-30%)' },
				},
				dropzonePulse: {
					'0%': { transform: 'scale(0.98)', boxShadow: '0 0 0 0 hsl(var(--primary) / 0.18)' },
					'70%': { transform: 'scale(1)', boxShadow: '0 0 0 12px hsl(var(--primary) / 0)' },
					'100%': { transform: 'scale(0.98)', boxShadow: '0 0 0 0 hsl(var(--primary) / 0)' },
				},
				cardPop: {
					'0%': { transform: 'scale(0.97)', opacity: '0' },
					'60%': { transform: 'scale(1.01)', opacity: '1' },
					'100%': { transform: 'scale(1)', opacity: '1' },
				},
				marqueeY: {
					'0%': { transform: 'translateY(0)' },
					'100%': { transform: 'translateY(-50%)' },
				},
				fadeSlideUp: {
					'0%': { opacity: '0', transform: 'translateY(12px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' },
				},
				blink: {
					'0%,50%': { opacity: '1' },
					'51%,100%': { opacity: '0' },
				},
				// Radix UI Sheet动画
				'slide-in-from-left': {
					'0%': { transform: 'translateX(-100%)' },
					'100%': { transform: 'translateX(0)' },
				},
				'slide-out-to-left': {
					'0%': { transform: 'translateX(0)' },
					'100%': { transform: 'translateX(-100%)' },
				},
				'slide-in-from-right': {
					'0%': { transform: 'translateX(100%)' },
					'100%': { transform: 'translateX(0)' },
				},
				'slide-out-to-right': {
					'0%': { transform: 'translateX(0)' },
					'100%': { transform: 'translateX(100%)' },
				},
				'fade-in': {
					'0%': { opacity: '0' },
					'100%': { opacity: '1' },
				},
				'fade-out': {
					'0%': { opacity: '1' },
					'100%': { opacity: '0' },
				},
			},
			animation: {
				sweep: 'sweep 1.2s ease-in-out infinite',
				dropzonePulse: 'dropzonePulse 1.5s ease-in-out infinite',
				cardPop: 'cardPop 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
				marqueeY: 'marqueeY 6s linear infinite',
				fadeSlideUp: 'fadeSlideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
				blink: 'blink 1s steps(2, start) infinite',
				// Radix UI Sheet动画
				in: 'fade-in 200ms ease-out',
				out: 'fade-out 200ms ease-in',
			},
		},
	},
	plugins: [],
};
