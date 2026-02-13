import React from 'react';
import CommonTooltip from './CommonTooltip';

/**
 * CommonTooltip 使用示例
 * 
 * 这个文件展示了如何在项目中使用通用Tooltip组件
 */

export const TooltipExamples: React.FC = () => {
  return (
    <div style={{ padding: '100px', display: 'flex', flexDirection: 'column', gap: '40px' }}>
      <h2>CommonTooltip 使用示例</h2>

      {/* 基础用法 */}
      <section>
        <h3>1. 基础用法</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip content="这是一个简单的提示">
            <button className="px-4 py-2 bg-blue-500 text-white rounded">
              鼠标悬停查看提示
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 不同位置 */}
      <section>
        <h3>2. 不同位置</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
          <CommonTooltip content="顶部提示" position="top">
            <button className="px-4 py-2 bg-gray-500 text-white rounded">
              顶部
            </button>
          </CommonTooltip>

          <CommonTooltip content="底部提示" position="bottom">
            <button className="px-4 py-2 bg-gray-500 text-white rounded">
              底部
            </button>
          </CommonTooltip>

          <CommonTooltip content="左侧提示" position="left">
            <button className="px-4 py-2 bg-gray-500 text-white rounded">
              左侧
            </button>
          </CommonTooltip>

          <CommonTooltip content="右侧提示" position="right">
            <button className="px-4 py-2 bg-gray-500 text-white rounded">
              右侧
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 不同主题 */}
      <section>
        <h3>3. 不同主题</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip content="深色主题（默认）" theme="dark">
            <button className="px-4 py-2 bg-purple-500 text-white rounded">
              深色主题
            </button>
          </CommonTooltip>

          <CommonTooltip content="浅色主题" theme="light">
            <button className="px-4 py-2 bg-purple-500 text-white rounded">
              浅色主题
            </button>
          </CommonTooltip>

          <CommonTooltip content="自动主题（跟随系统）" theme="auto">
            <button className="px-4 py-2 bg-purple-500 text-white rounded">
              自动主题
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 无箭头 */}
      <section>
        <h3>4. 无箭头样式</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip content="没有箭头的提示" showArrow={false}>
            <button className="px-4 py-2 bg-green-500 text-white rounded">
              无箭头提示
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 延迟显示 */}
      <section>
        <h3>5. 延迟显示</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip content="立即显示（0ms）" delay={0}>
            <button className="px-4 py-2 bg-orange-500 text-white rounded">
              立即显示
            </button>
          </CommonTooltip>

          <CommonTooltip content="500ms后显示" delay={500}>
            <button className="px-4 py-2 bg-orange-500 text-white rounded">
              延迟500ms
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 长文本 */}
      <section>
        <h3>6. 长文本提示</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip 
            content="这是一段很长的提示文本，用于展示Tooltip组件如何处理较长的内容。系统会自动换行并限制最大宽度，确保内容的可读性。如果内容超过最大高度，还会出现滚动条。"
            maxWidth={250}
          >
            <button className="px-4 py-2 bg-red-500 text-white rounded">
              长文本提示
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 富文本内容 */}
      <section>
        <h3>7. 富文本内容</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip 
            content={
              <div>
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>快捷键</div>
                <div>Ctrl + S: 保存</div>
                <div>Ctrl + Z: 撤销</div>
                <div>Ctrl + Y: 重做</div>
              </div>
            }
          >
            <button className="px-4 py-2 bg-indigo-500 text-white rounded">
              查看快捷键
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 禁用状态 */}
      <section>
        <h3>8. 禁用状态</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip content="这个提示不会显示" disabled>
            <button className="px-4 py-2 bg-gray-400 text-white rounded cursor-not-allowed">
              已禁用（无提示）
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 图标按钮 */}
      <section>
        <h3>9. 在图标按钮上使用</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip content="编辑" position="top">
            <button className="w-10 h-10 flex items-center justify-center bg-blue-500 text-white rounded-full">
              ✏️
            </button>
          </CommonTooltip>

          <CommonTooltip content="删除" position="top">
            <button className="w-10 h-10 flex items-center justify-center bg-red-500 text-white rounded-full">
              🗑️
            </button>
          </CommonTooltip>

          <CommonTooltip content="设置" position="top">
            <button className="w-10 h-10 flex items-center justify-center bg-gray-500 text-white rounded-full">
              ⚙️
            </button>
          </CommonTooltip>
        </div>
      </section>

      {/* 在文本上使用 */}
      <section>
        <h3>10. 在文本上使用</h3>
        <div>
          <p>
            这是一段文本，其中包含一些需要解释的
            <CommonTooltip content="这是一个专业术语的解释">
              <span style={{ textDecoration: 'underline', cursor: 'help', color: 'blue' }}>
                专业术语
              </span>
            </CommonTooltip>
            ，鼠标悬停可以查看详细说明。
          </p>
        </div>
      </section>

      {/* 自定义样式 */}
      <section>
        <h3>11. 自定义样式</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <CommonTooltip 
            content="自定义样式的提示" 
            className="custom-tooltip-class"
            maxWidth={200}
          >
            <button className="px-4 py-2 bg-pink-500 text-white rounded">
              自定义样式
            </button>
          </CommonTooltip>
        </div>
      </section>
    </div>
  );
};

export default TooltipExamples;

