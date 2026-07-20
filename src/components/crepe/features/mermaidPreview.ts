/**
 * Mermaid 代码块预览功能
 * 在编辑器中的 mermaid 代码块下方渲染图表预览
 */

import DOMPurify from 'dompurify';
import i18n from '@/i18n';

// 🚀 P1-1 性能优化：mermaid 改为动态导入，避免 ~1.6MB 进入 CrepeEditor chunk
let mermaidInstance: typeof import('mermaid').default | null = null;
let mermaidTheme: 'default' | 'dark' | null = null;

/** E3-3：mermaid 主题跟随应用 .dark 模式 */
const resolveMermaidTheme = (): 'default' | 'dark' =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'default';

const ensureMermaid = async () => {
  const theme = resolveMermaidTheme();
  if (mermaidInstance && mermaidTheme === theme) return mermaidInstance;
  if (!mermaidInstance) {
    const mod = await import('mermaid');
    mermaidInstance = mod.default;
  }
  // 主题变化时重新 initialize（mermaid 支持重复 initialize 覆盖配置）
  mermaidInstance.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  });
  mermaidTheme = theme;
  return mermaidInstance;
};

/**
 * 渲染单个 Mermaid 图表
 */
export const renderMermaidDiagram = async (
  code: string,
  container: HTMLElement
): Promise<void> => {
  try {
    const mermaid = await ensureMermaid();
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const { svg } = await mermaid.render(id, code.trim());
    container.innerHTML = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object'],
      FORBID_ATTR: ['xlink:href'],
    });
    container.classList.add('mermaid-rendered');
  } catch (error) {
    console.error('[Mermaid] Render failed:', error);
    container.innerHTML = `<div class="mermaid-error">${i18n.t('chatV2:codeBlock.mermaidFailed')}</div>`;
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
    
    // 检查是否已有预览容器（紧跟在代码块之后，避免同父多个代码块互相串预览）
    let previewContainer: Element | null =
      block.nextElementSibling?.classList.contains('mermaid-preview')
        ? block.nextElementSibling
        : null;
    
    if (!previewContainer) {
      // 创建预览容器
      previewContainer = document.createElement('div');
      previewContainer.className = 'mermaid-preview';
      block.insertAdjacentElement('afterend', previewContainer);
    }
    
    // 检查代码或主题是否变化（主题参与 key，暗色切换后可重渲染）
    const renderKey = `${resolveMermaidTheme()}\u0000${code}`;
    const prevKey = previewContainer.getAttribute('data-code');
    if (prevKey === renderKey) continue;
    
    // 渲染图表
    previewContainer.setAttribute('data-code', renderKey);
    await renderMermaidDiagram(code, previewContainer as HTMLElement);
  }
};

/** 判定 DOM 变更是否可能影响 mermaid 代码块（E1-5：避免任意编辑都触发全树扫描） */
const CODE_BLOCK_SCOPE_SELECTOR = '[data-language], .milkdown-code-block, pre, .cm-editor, code';

const nodeTouchesCodeBlock = (node: Node): boolean => {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return false;
  // 我们自己写入 .mermaid-preview 引发的变更无需再次触发扫描
  if (el.closest('.mermaid-preview')) return false;
  if (el.closest(CODE_BLOCK_SCOPE_SELECTOR)) return true;
  if (el instanceof Element && el.querySelector(CODE_BLOCK_SCOPE_SELECTOR)) return true;
  return false;
};

const isMermaidRelevantMutation = (mutation: MutationRecord): boolean => {
  if (nodeTouchesCodeBlock(mutation.target)) return true;
  if (mutation.type === 'childList') {
    for (const node of mutation.addedNodes) {
      if (nodeTouchesCodeBlock(node)) return true;
    }
    for (const node of mutation.removedNodes) {
      if (nodeTouchesCodeBlock(node)) return true;
    }
  }
  return false;
};

/**
 * 创建 Mermaid 预览观察器
 * 返回清理函数
 *
 * E1-5：只在变更命中代码块相关节点时才调度扫描；
 * 另观察 <html> class 变化以便暗色主题切换后重渲染。
 */
export const createMermaidObserver = (
  editorRoot: HTMLElement,
  debounceMs = 300
): (() => void) => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  
  const debouncedRender = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      void scanAndRenderMermaidBlocks(editorRoot);
    }, debounceMs);
  };
  
  // 使用 MutationObserver 监听编辑器变化（带相关性过滤）
  const observer = new MutationObserver((mutations) => {
    if (mutations.some(isMermaidRelevantMutation)) {
      debouncedRender();
    }
  });
  
  observer.observe(editorRoot, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // 主题切换（.dark class 翻转）时重渲染已有图表
  const themeObserver = new MutationObserver(debouncedRender);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  
  // 初次渲染
  debouncedRender();
  
  // 返回清理函数
  return () => {
    if (timeoutId) clearTimeout(timeoutId);
    observer.disconnect();
    themeObserver.disconnect();
  };
};
