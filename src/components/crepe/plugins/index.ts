/**
 * Crepe 编辑器插件扩展
 * 集成额外的 Milkdown 插件以增强功能
 */

import type { Crepe } from '@milkdown/crepe';

// 插件导入
import { automd } from '@milkdown/plugin-automd';

// Prism 核心必须先导入，组件依赖全局 Prism 对象
import 'prismjs';

// Prism 语言支持（按需导入）
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';

/**
 * 插件配置选项
 */
export interface CrepePluginsOptions {
  /** 启用自动 Markdown 格式化（输入 **text** 自动粗体等） */
  automd?: boolean;
}

/**
 * 应用额外插件到 Crepe 实例
 * 注意：需要在 crepe.create() 之前调用
 */
export const applyCrepePlugins = (
  crepe: Crepe,
  options: CrepePluginsOptions = {}
): void => {
  const { automd: enableAutomd = true } = options;

  // 自动 Markdown 格式化
  // 输入 **text** 自动应用粗体，输入 `code` 自动应用代码等
  if (enableAutomd) {
    crepe.editor.use(automd);
  }
};

/**
 * 默认插件配置
 */
export const defaultPluginOptions: CrepePluginsOptions = {
  automd: true,
};
