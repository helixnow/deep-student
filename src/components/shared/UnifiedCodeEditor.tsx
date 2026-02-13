/**
 * 统一代码编辑器组件
 *
 * 基于 CodeMirror 实现，支持：
 * - 多种语言: html, css, json, javascript
 * - 亮/暗主题自动切换（与项目主题系统统一）
 * - 统一的配置和样式
 */

import React, { useMemo, useEffect, useLayoutEffect, useState, useRef } from 'react';
import CodeMirror, { ReactCodeMirrorProps } from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { EditorView } from '@codemirror/view';
import { cn } from '../../lib/utils';

export type CodeLanguage = 'html' | 'css' | 'json' | 'javascript' | 'plain';

export interface UnifiedCodeEditorProps {
  /** 代码内容 */
  value: string;
  /** 内容变更回调 */
  onChange?: (value: string) => void;
  /** 代码语言 */
  language?: CodeLanguage;
  /** 编辑器高度 */
  height?: string;
  /** 是否只读 */
  readOnly?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 是否显示行号 */
  lineNumbers?: boolean;
  /** 是否可折叠 */
  foldGutter?: boolean;
  /** 是否高亮当前行 */
  highlightActiveLine?: boolean;
  /** 占位符文本 */
  placeholder?: string;
  /** 基础设置覆盖 */
  basicSetup?: ReactCodeMirrorProps['basicSetup'];
}

// 基础样式扩展 - 确保字体和边框与项目一致
const baseStyleExtension = EditorView.theme({
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-gutters': {
    border: 'none',
  },
});

// 亮色主题 - 使用 CSS 变量适配主题系统
const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--foreground))',
  },
  '.cm-content': {
    caretColor: 'hsl(var(--foreground))',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'hsl(var(--foreground))',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'hsl(var(--primary) / 0.3)',
  },
  '.cm-activeLine': {
    backgroundColor: 'hsl(var(--muted))',
  },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
    borderRight: '1px solid hsl(var(--border))',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'hsl(var(--border))',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '6px',
    boxShadow: '0 8px 24px hsl(var(--foreground) / 0.1)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'hsl(var(--primary))',
      color: 'hsl(var(--primary-foreground))',
    },
  },
  // 语法高亮 - GitHub 风格亮色（设计意图色，保留硬编码）
  '.cm-string': { color: '#032f62' },
  '.cm-number': { color: '#005cc5' },
  '.cm-bool': { color: '#005cc5' },
  '.cm-null': { color: '#005cc5' },
  '.cm-keyword': { color: '#d73a49' },
  '.cm-operator': { color: '#d73a49' },
  '.cm-property': { color: '#005cc5' },
  '.cm-propertyName': { color: '#005cc5' },
  '.cm-comment': { color: '#6a737d' },
  '.cm-tag': { color: '#22863a' },
  '.cm-tagName': { color: '#22863a' },
  '.cm-attribute': { color: '#6f42c1' },
  '.cm-attributeName': { color: '#6f42c1' },
  '.cm-variableName': { color: '#e36209' },
  '.cm-punctuation': { color: 'hsl(var(--foreground))' },
}, { dark: false });

// 暗色主题 - 使用 CSS 变量适配主题系统
const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--foreground))',
  },
  '.cm-content': {
    caretColor: 'hsl(var(--foreground))',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'hsl(var(--foreground))',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'hsl(var(--primary) / 0.3)',
  },
  '.cm-activeLine': {
    backgroundColor: 'hsl(var(--accent))',
  },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
    borderRight: '1px solid hsl(var(--border))',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'hsl(var(--border))',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'hsl(var(--border))',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '6px',
    boxShadow: '0 8px 24px hsl(var(--foreground) / 0.15)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'hsl(var(--primary))',
      color: 'hsl(var(--primary-foreground))',
    },
  },
  // 语法高亮 - GitHub 风格暗色（设计意图色，保留硬编码）
  '.cm-string': { color: '#a5d6ff' },
  '.cm-number': { color: '#79c0ff' },
  '.cm-bool': { color: '#79c0ff' },
  '.cm-null': { color: '#79c0ff' },
  '.cm-keyword': { color: '#ff7b72' },
  '.cm-operator': { color: '#ff7b72' },
  '.cm-property': { color: '#79c0ff' },
  '.cm-propertyName': { color: '#79c0ff' },
  '.cm-comment': { color: '#8b949e' },
  '.cm-tag': { color: '#7ee787' },
  '.cm-tagName': { color: '#7ee787' },
  '.cm-attribute': { color: '#d2a8ff' },
  '.cm-attributeName': { color: '#d2a8ff' },
  '.cm-variableName': { color: '#ffa657' },
  '.cm-punctuation': { color: 'hsl(var(--foreground))' },
}, { dark: true });

/**
 * 检测暗色模式 - 多种方式确保正确检测
 */
const detectDarkMode = (): boolean => {
  if (typeof document === 'undefined') return false;

  // 方法1: 检查 document.documentElement 的 class (最可靠)
  if (document.documentElement.classList.contains('dark')) {
    return true;
  }

  // 方法2: 检查 data-theme 属性
  const dataTheme = document.documentElement.getAttribute('data-theme');
  if (dataTheme === 'dark') {
    return true;
  }

  // 方法3: 检查 body 上的主题类
  if (document.body.classList.contains('dark-theme')) {
    return true;
  }

  // 方法4: 检查 localStorage 中的主题设置
  try {
    const savedMode = localStorage.getItem('dstu-theme-mode');
    if (savedMode === 'dark') {
      return true;
    }
    if (savedMode === 'auto') {
      // 检查系统偏好
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  } catch {
    // localStorage 不可用
  }

  return false;
};

/**
 * 统一代码编辑器组件
 */
export const UnifiedCodeEditor: React.FC<UnifiedCodeEditorProps> = ({
  value,
  onChange,
  language = 'plain',
  height = '200px',
  readOnly = false,
  className,
  lineNumbers = true,
  foldGutter = true,
  highlightActiveLine = true,
  placeholder,
  basicSetup: basicSetupOverride,
}) => {
  // 使用 ref 来跟踪当前主题，避免不必要的重渲染
  const mountedRef = useRef(false);
  const [isDarkMode, setIsDarkMode] = useState(() => detectDarkMode());

  // 使用 useLayoutEffect 确保在绘制前同步检测主题
  useLayoutEffect(() => {
    const detected = detectDarkMode();
    if (detected !== isDarkMode) {
      setIsDarkMode(detected);
    }
    mountedRef.current = true;
  }, []);

  // 监听主题变化
  useEffect(() => {
    // 使用 MutationObserver 监听 class 和 data-theme 变化
    const observer = new MutationObserver(() => {
      const newIsDark = detectDarkMode();
      setIsDarkMode(newIsDark);
    });

    // 同时监听 html 和 body 的变化
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // 也监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = () => {
      const newIsDark = detectDarkMode();
      setIsDarkMode(newIsDark);
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMediaChange);
    } else {
      mediaQuery.addListener(handleMediaChange);
    }

    return () => {
      observer.disconnect();
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      } else {
        mediaQuery.removeListener(handleMediaChange);
      }
    };
  }, []);

  // 根据语言选择扩展
  const languageExtension = useMemo(() => {
    switch (language) {
      case 'html':
        return html();
      case 'css':
        return css();
      case 'json':
      case 'javascript':
        // 项目未安装 @codemirror/lang-json，使用基础编辑功能
        return [];
      default:
        return [];
    }
  }, [language]);

  // 组合扩展 - 只包含语言和基础样式，不包含主题
  const extensions = useMemo(() => {
    const exts: any[] = [baseStyleExtension];

    // 语言扩展
    if (Array.isArray(languageExtension)) {
      exts.push(...languageExtension);
    } else {
      exts.push(languageExtension);
    }

    // 只读模式
    if (readOnly) {
      exts.push(EditorView.editable.of(false));
    }

    return exts;
  }, [languageExtension, readOnly]);

  // 基础设置
  const defaultBasicSetup = useMemo(() => ({
    lineNumbers,
    foldGutter,
    highlightActiveLine,
    dropCursor: true,
    allowMultipleSelections: true,
    indentOnInput: true,
    bracketMatching: true,
    closeBrackets: true,
    autocompletion: !readOnly,
    rectangularSelection: true,
    highlightSelectionMatches: true,
    searchKeymap: true,
  }), [lineNumbers, foldGutter, highlightActiveLine, readOnly]);

  // 选择主题 - 都使用自定义主题（浅灰/深灰风格）
  const theme = isDarkMode ? darkTheme : lightTheme;

  return (
    <div
      className={cn(
        'unified-code-editor overflow-hidden rounded-md border border-border',
        isDarkMode ? 'dark-editor' : 'light-editor',
        className
      )}
      data-editor-theme={isDarkMode ? 'dark' : 'light'}
    >
      <CodeMirror
        key={`editor-${isDarkMode ? 'dark' : 'light'}`}
        value={value}
        height={height}
        theme={theme}
        extensions={extensions}
        onChange={onChange}
        placeholder={placeholder}
        basicSetup={basicSetupOverride ?? defaultBasicSetup}
        className={cn('text-sm', isDarkMode ? 'cm-dark-mode' : 'cm-light-mode')}
        editable={!readOnly}
      />
    </div>
  );
};

export default UnifiedCodeEditor;
