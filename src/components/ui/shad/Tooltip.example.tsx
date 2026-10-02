import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';

/**
 * Tooltip 使用示例（统一后的唯一实现：@/components/ui/shad/Tooltip）
 *
 * 旧的 CommonTooltip 已退化为迁移适配层，不再作为示例目标。
 */

const sampleButton =
  'px-4 py-2 rounded text-white bg-gray-500 hover:bg-gray-600';

export const TooltipExamples: React.FC = () => {
  return (
    <div style={{ padding: '100px', display: 'flex', flexDirection: 'column', gap: '40px' }}>
      <h2>Tooltip 使用示例</h2>

      {/* 基础用法 */}
      <section>
        <h3>1. 基础用法</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={sampleButton}>鼠标悬停查看提示</button>
          </TooltipTrigger>
          <TooltipContent>这是一个简单的提示</TooltipContent>
        </Tooltip>
      </section>

      {/* 不同方向 */}
      <section>
        <h3>2. 不同方向（空间不足时自动翻转）</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
          {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
            <Tooltip key={side}>
              <TooltipTrigger asChild>
                <button type="button" className={sampleButton}>{side}</button>
              </TooltipTrigger>
              <TooltipContent side={side}>{side} 提示</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </section>

      {/* 快捷键角标 */}
      <section>
        <h3>3. 快捷键角标</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={sampleButton}>单个键位</button>
            </TooltipTrigger>
            <TooltipContent shortcut="⌘K">命令面板</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={sampleButton}>多键位</button>
            </TooltipTrigger>
            <TooltipContent shortcut={['⌘', 'K']}>命令面板</TooltipContent>
          </Tooltip>
        </div>
      </section>

      {/* 箭头与主题 */}
      <section>
        <h3>4. 箭头与主题</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={sampleButton}>无箭头</button>
            </TooltipTrigger>
            <TooltipContent arrow={false}>没有箭头的提示</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={sampleButton}>浅色气泡</button>
            </TooltipTrigger>
            <TooltipContent theme="light">浅色主题</TooltipContent>
          </Tooltip>
        </div>
      </section>

      {/* 延迟与限宽 */}
      <section>
        <h3>5. 延迟与限宽</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button type="button" className={sampleButton}>立即显示</button>
            </TooltipTrigger>
            <TooltipContent>delayDuration=0，立即显示</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={sampleButton}>长文本</button>
            </TooltipTrigger>
            <TooltipContent maxWidth={250}>
              这是一段很长的提示文本，用于展示 Tooltip 如何处理较长的内容。系统会自动换行并限制最大宽度，
              超过高度上限后内容区可滚动。
            </TooltipContent>
          </Tooltip>
        </div>
      </section>

      {/* 富文本内容 */}
      <section>
        <h3>6. 富文本内容</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={sampleButton}>查看快捷键</button>
          </TooltipTrigger>
          <TooltipContent side="bottom" shortcut="⌘S">
            保存当前编辑
          </TooltipContent>
        </Tooltip>
      </section>

      {/* 禁用按钮：包一层 span 让悬停事件可达 */}
      <section>
        <h3>7. 禁用按钮（包一层 span）</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button type="button" disabled className="px-4 py-2 rounded bg-gray-400 text-white">
                已禁用
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>请先完成上一步操作</TooltipContent>
        </Tooltip>
      </section>

      {/* 单例禁用 */}
      <section>
        <h3>8. 单例禁用</h3>
        <Tooltip disabled>
          <TooltipTrigger asChild>
            <button type="button" className={sampleButton}>无提示</button>
          </TooltipTrigger>
          <TooltipContent>这个提示不会显示</TooltipContent>
        </Tooltip>
      </section>

      {/* 图标按钮：aria-label + TooltipContent 各司其职 */}
      <section>
        <h3>9. 图标按钮</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          {[
            { glyph: '✏️', label: '编辑' },
            { glyph: '🗑️', label: '删除' },
            { glyph: '⚙️', label: '设置' },
          ].map(({ glyph, label }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={label}
                  className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-500 text-white"
                >
                  {glyph}
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </section>

      {/* 行内术语解释 */}
      <section>
        <h3>10. 行内术语解释</h3>
        <p>
          这是一段文本，其中包含一些需要解释的
          <Tooltip>
            <TooltipTrigger asChild>
              <span style={{ textDecoration: 'underline', cursor: 'help', color: 'blue' }}>
                专业术语
              </span>
            </TooltipTrigger>
            <TooltipContent>这是一个专业术语的解释</TooltipContent>
          </Tooltip>
          ，鼠标悬停可以查看详细说明。
        </p>
      </section>
    </div>
  );
};

export default TooltipExamples;