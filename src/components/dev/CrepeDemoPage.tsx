/**
 * Crepe 编辑器演示页面
 * 基于 @milkdown/crepe 的现代化 Markdown 编辑器
 */

import React, { useState, useRef } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { ArrowLeft, Copy, Check } from 'lucide-react';
import { CrepeEditor, type CrepeEditorApi } from '../crepe';
import { useMobileHeader } from '../layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

export const CrepeDemoPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const { isSmallScreen } = useBreakpoint();
  const [markdown, setMarkdown] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const editorApiRef = useRef<CrepeEditorApi | null>(null);

  // 移动端统一顶栏配置
  useMobileHeader('crepe-demo', {
    title: 'Crepe 编辑器演示',
    subtitle: '现代化 Markdown 编辑器',
    rightActions: (
      <NotionButton variant="ghost" size="sm" onClick={() => handleCopyMarkdownRef.current()}>
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      </NotionButton>
    ),
  }, [copied]);

  const handleCopyMarkdownRef = useRef<() => void>(() => {});

  const initialContent = `# Crepe 编辑器演示

这是基于 **@milkdown/crepe** 的现代化 Markdown 编辑器。

## 功能特性

- ✅ 完整的 Markdown 支持（GFM）
- ✅ 斜杠命令菜单（输入 \`/\` 试试）
- ✅ 气泡工具栏（选中文本试试）
- ✅ 表格支持
- ✅ 代码块语法高亮
- ✅ 数学公式（KaTeX）
- ✅ 图片上传
- ✅ 任务列表

## 数学公式示例

行内公式：$E = mc^2$

块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## 代码块示例

\`\`\`typescript
const greeting = (name: string) => {
  console.log(\`Hello, \${name}!\`);
};

greeting('Crepe');
\`\`\`

## 表格示例

| 功能 | 状态 |
|------|------|
| Markdown | ✅ |
| 表格 | ✅ |
| 公式 | ✅ |

## 任务列表

- [x] 迁移到 Crepe
- [x] 图片上传
- [ ] 自定义扩展
`;

  const handleCopyMarkdown = async () => {
    const md = editorApiRef.current?.getMarkdown() || markdown;
    await copyTextToClipboard(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 更新 ref 引用以便 useMobileHeader 中调用
  handleCopyMarkdownRef.current = handleCopyMarkdown;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* 桌面端顶部导航栏 */}
      {!isSmallScreen && (
        <div className="flex items-center justify-between mb-6 p-6 pb-0">
          <div className="flex items-center gap-4">
            {onBack && (
              <NotionButton variant="ghost" iconOnly size="sm" onClick={onBack}>
                <ArrowLeft className="w-5 h-5" />
              </NotionButton>
            )}
            <div>
              <h1 className="text-2xl font-bold">Crepe 编辑器演示</h1>
              <p className="text-muted-foreground">基于 @milkdown/crepe 的现代化 Markdown 编辑器</p>
            </div>
          </div>
          <NotionButton variant="ghost" size="sm" onClick={handleCopyMarkdown}>
            {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
            {copied ? '已复制' : '复制 Markdown'}
          </NotionButton>
        </div>
      )}

      <div className={`flex-1 min-h-0 flex ${isSmallScreen ? 'flex-col' : 'gap-6 px-6 pb-6'}`}>
        {/* Editor Area */}
        <div className={`flex-1 flex flex-col min-h-0 border ${isSmallScreen ? 'rounded-none' : 'rounded-xl'} overflow-hidden shadow-sm bg-card`}>
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <CrepeEditor
              defaultValue={initialContent}
              onChange={setMarkdown}
              onReady={(api) => {
                editorApiRef.current = api;
              }}
              className="min-h-[500px]"
            />
          </div>
        </div>

        {/* Markdown Preview - 仅桌面端显示 */}
        {!isSmallScreen && (
          <div className="w-1/3 min-w-[300px] flex flex-col min-h-0 border rounded-xl overflow-hidden shadow-sm bg-card">
            <div className="px-4 py-3 border-b bg-muted/30">
              <h3 className="font-medium text-sm">Markdown 源码</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">
                {markdown || initialContent}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CrepeDemoPage;
