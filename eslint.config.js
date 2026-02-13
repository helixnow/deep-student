import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noNativeButton from './eslint-rules/no-native-button.js';

export default tseslint.config(
  // 基础 JS 推荐配置
  js.configs.recommended,
  // TypeScript 推荐配置
  ...tseslint.configs.recommended,
  // 全局配置
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021
      }
    },
    plugins: {
      'ds-components': {
        rules: {
          'no-native-button': noNativeButton
        }
      }
    },
    rules: {
      // ============================================================
      // AGENTS.md 组件规范检查规则
      // 参见: AGENTS.md
      // ============================================================

      // 1. 禁止使用 shadcn Button - 必须使用 NotionButton
      // 2. 禁止使用 shadcn Tooltip - 必须使用 CommonTooltip
      // 3. 禁止使用 react-tooltip - 必须使用 CommonTooltip
      'no-restricted-imports': ['error', {
        paths: [
          // === Button 相关 ===
          {
            name: '@/components/ui/shad/Button',
            message: '❌ 禁止使用 shadcn Button。请使用 NotionButton (@/components/ui/NotionButton)。参见 AGENTS.md 规范。'
          },
          {
            name: '@/components/ui/button',
            importNames: ['Button'],
            message: '❌ 禁止使用 shadcn Button。请使用 NotionButton (@/components/ui/NotionButton)。参见 AGENTS.md 规范。'
          },
          
          // === Tooltip 相关 ===
          {
            name: '@/components/ui/shad/Tooltip',
            message: '❌ 禁止使用 shadcn Tooltip。请使用 CommonTooltip (@/components/shared/CommonTooltip)。参见 AGENTS.md 规范。'
          },
          {
            name: '@/components/ui/tooltip',
            importNames: ['Tooltip', 'TooltipTrigger', 'TooltipContent', 'TooltipProvider'],
            message: '❌ 禁止使用 shadcn Tooltip。请使用 CommonTooltip (@/components/shared/CommonTooltip)。参见 AGENTS.md 规范。'
          },
          
          // === react-tooltip 第三方库 ===
          {
            name: 'react-tooltip',
            message: '❌ 禁止使用 react-tooltip 第三方库。请使用 CommonTooltip (@/components/shared/CommonTooltip)。参见 AGENTS.md 规范。'
          }
        ],
        patterns: [
          // Button 模式匹配（相对路径导入）
          {
            group: ['**/shad/Button', '**/shad/Button.tsx'],
            message: '❌ 禁止使用 shadcn Button。请使用 NotionButton (@/components/ui/NotionButton)。参见 AGENTS.md 规范。'
          },
          // Tooltip 模式匹配（相对路径导入）
          {
            group: ['**/shad/Tooltip', '**/shad/Tooltip.tsx'],
            message: '❌ 禁止使用 shadcn Tooltip。请使用 CommonTooltip (@/components/shared/CommonTooltip)。参见 AGENTS.md 规范。'
          }
        ]
      }],

      // 4. 禁止使用 window.alert - 必须使用统一通知系统
      'no-alert': 'error',

      // 5. 跨模块事件监听应通过集中注册（useEventRegistry / registry）
      // 仅对新增代码做约束，历史代码逐步迁移，因此先使用 warn。
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.property.name='addEventListener'][callee.object.name=/^(window|document)$/]",
          message: '❌ 禁止直接使用 window/document.addEventListener。请使用 useEventRegistry 或集中事件 registry。'
        }
      ],

      // 6. 禁止使用原生 <button> 元素 - 必须使用 NotionButton（设为 warn 便于逐步修复）
      'ds-components/no-native-button': 'warn',

      // 禁用与 TypeScript 不兼容的规则（TypeScript 已处理）
      'no-undef': 'off',
      'no-unused-vars': 'off'
    }
  },

  // ============================================================
  // 例外配置：允许在特定目录使用受限组件
  // ============================================================
  
  // 调试面板插件目录（根据 AGENTS.md 允许使用 shadcn Button 和原生组件）
  {
    files: ['src/debug-panel/plugins/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      'ds-components/no-native-button': 'off'
    }
  },

  // 开发调试组件目录（与调试面板同等对待）
  {
    files: ['src/components/dev/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      'ds-components/no-native-button': 'off'
    }
  },

  // 事件监听白名单目录：允许底层/调试模块直接绑定原生事件
  {
    files: [
      'src/debug-panel/**/*.{ts,tsx}',
      'src/components/dev/**/*.{ts,tsx}',
      'src/chat-v2/dev/**/*.{ts,tsx}',
      'src/events/**/*.{ts,tsx}',
      'src/hooks/useEventRegistry.ts'
    ],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },

  // 示例文件和测试文件
  {
    files: [
      'src/**/*.example.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'src/**/__tests__/**/*.{ts,tsx}',
      'tests/**/*.{ts,tsx}'
    ],
    rules: {
      'ds-components/no-native-button': 'off'
    }
  },

  // shad 组件库源文件本身（定义文件需要使用原生元素）
  {
    files: [
      'src/components/ui/shad/**/*.{ts,tsx}',
      'src/promptkit/**/*.{ts,tsx}'
    ],
    rules: {
      'no-restricted-imports': 'off',
      'ds-components/no-native-button': 'off'
    }
  },

  // NotionButton、SimpleTooltip 和 CommonTooltip 组件本身
  {
    files: [
      'src/components/ui/NotionButton.tsx',
      'src/components/ui/SimpleTooltip.tsx',
      'src/components/shared/CommonTooltip.tsx'
    ],
    rules: {
      'ds-components/no-native-button': 'off'
    }
  },

  // ============================================================
  // 忽略配置文件和构建产物
  // ============================================================
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'src-tauri/**',
      '*.config.{js,ts,mjs}',
      'scripts/**',
      'eslint-rules/**',
      'e2e-tests/**',
      'mcp-servers/**'
    ]
  },
  // 禁用一些与现有代码不兼容的 TypeScript 规则（可后续逐步启用）
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
);
