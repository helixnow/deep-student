/**
 * Mermaid 代码块预览功能
 * 在编辑器中的 mermaid 代码块下方渲染图表预览
 */

import mermaid from 'mermaid';

// 初始化 Mermaid
let initialized = false;

const initMermaid = () => {
  if (initialized) return;
  
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  });
  
  initialized = true;
};

/**
 * 渲染单个 Mermaid 图表
 */
export const renderMermaidDiagram = async (
  code: string,
  container: HTMLElement
): Promise<void> => {
  initMermaid();
  
  try {
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const { svg } = await mermaid.render(id, code.trim());
    container.innerHTML = svg;
    container.classList.add('mermaid-rendered');
  } catch (error) {
    console.error('[Mermaid] Render failed:', error);
    container.innerHTML = `<div class="mermaid-error">图表渲染失败</div>`;
    container.classList.add('mermaid-error');
  }
};

/**
 * 扫描并渲染编辑器中的所有 Mermaid 代码块
 * 应在编辑器内容变化后调用（防抖）
 */
export const scanAndRenderMermaidBlocks = async (
  editorRoot: HTMLElement
): Promise<void> => {
  // 查找所有 mermaid 代码块
  // Crepe 使用 data-language="mermaid" 属性
  const codeBlocks = editorRoot.querySelectorAll(
    '[data-language="mermaid"], .language-mermaid'
  );
  
  for (const block of Array.from(codeBlocks)) {
    const codeElement = block.querySelector('code, .cm-content');
    if (!codeElement) continue;
    
    const code = codeElement.textContent || '';
    if (!code.trim()) continue;
    
    // 检查是否已有预览容器
    let previewContainer = block.parentElement?.querySelector('.mermaid-preview');
    
    if (!previewContainer) {
      // 创建预览容器
      previewContainer = document.createElement('div');
      previewContainer.className = 'mermaid-preview';
      block.parentElement?.appendChild(previewContainer);
    }
    
    // 检查代码是否变化
    const prevCode = previewContainer.getAttribute('data-code');
    if (prevCode === code) continue;
    
    // 渲染图表
    previewContainer.setAttribute('data-code', code);
    await renderMermaidDiagram(code, previewContainer as HTMLElement);
  }
};

/**
 * 创建 Mermaid 预览观察器
 * 返回清理函数
 */
export const createMermaidObserver = (
  editorRoot: HTMLElement,
  debounceMs = 500
): (() => void) => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  
  const debouncedRender = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      void scanAndRenderMermaidBlocks(editorRoot);
    }, debounceMs);
  };
  
  // 使用 MutationObserver 监听编辑器变化
  const observer = new MutationObserver(debouncedRender);
  
  observer.observe(editorRoot, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  
  // 初次渲染
  debouncedRender();
  
  // 返回清理函数
  return () => {
    if (timeoutId) clearTimeout(timeoutId);
    observer.disconnect();
  };
};
