/**
 * 知识导图导出器
 *
 * 支持格式：
 * - OPML (Outline Processor Markup Language)
 * - Markdown (大纲格式)
 * - JSON (原生格式)
 * - PNG 图片（使用 snapdom）
 * - SVG 矢量图（使用 snapdom）
 */

import { snapdom } from '@zumer/snapdom';
import { getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react';
import i18n from 'i18next';
import { fileManager } from '@/utils/fileManager';
import type { MindMapDocument, MindMapNode } from '../types';
import {
  defaultMindMapStore,
  type MindMapStoreApi,
} from '../store/mindmapStore';

// ============================================================================
// OPML 导出
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function nodeToOpmlOutline(node: MindMapNode, indent: number): string {
  const indentStr = '  '.repeat(indent);
  const attrs = [`text="${escapeXml(node.text)}"`];

  if (node.note) {
    attrs.push(`_note="${escapeXml(node.note)}"`);
  }

  if (node.refs && node.refs.length > 0) {
    const refsStr = node.refs.map(r => `${r.name}(${r.sourceId})`).join('; ');
    attrs.push(`_refs="${escapeXml(refsStr)}"`);
  }

  const children = node.children || [];
  if (children.length === 0) {
    return `${indentStr}<outline ${attrs.join(' ')} />\n`;
  }

  let result = `${indentStr}<outline ${attrs.join(' ')}>\n`;
  for (const child of children) {
    result += nodeToOpmlOutline(child, indent + 1);
  }
  result += `${indentStr}</outline>\n`;
  return result;
}

/**
 * 导出为 OPML 格式
 */
export function exportToOpml(doc: MindMapDocument, title?: string): string {
  const docTitle = title || doc.root.text || 'MindMap';
  const createdAt = doc.meta?.createdAt || new Date().toISOString();

  let opml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  opml += `<opml version="2.0">\n`;
  opml += `  <head>\n`;
  opml += `    <title>${escapeXml(docTitle)}</title>\n`;
  opml += `    <dateCreated>${createdAt}</dateCreated>\n`;
  opml += `  </head>\n`;
  opml += `  <body>\n`;
  opml += nodeToOpmlOutline(doc.root, 2);
  opml += `  </body>\n`;
  opml += `</opml>\n`;

  return opml;
}

// ============================================================================
// Markdown 导出
// ============================================================================

function nodeToMarkdown(node: MindMapNode, level: number): string {
  let result = '';

  if (level === 0) {
    // 根节点作为标题
    result += `# ${node.text}\n\n`;
  } else {
    // 使用缩进列表
    const indent = '  '.repeat(level - 1);
    result += `${indent}- ${node.text}\n`;
  }

  // 添加注释（如果有）
  if (node.note) {
    if (level === 0) {
      result += `${node.note}\n\n`;
    } else {
      const indent = '  '.repeat(level);
      const noteLines = node.note.split('\n');
      for (const line of noteLines) {
        result += `${indent}> ${line}\n`;
      }
    }
  }

  // 添加关联资源引用
  if (node.refs && node.refs.length > 0) {
    const indent = level === 0 ? '' : '  '.repeat(level);
    for (const ref of node.refs) {
      result += `${indent}> 📎 [${ref.name}](${ref.sourceId})\n`;
    }
    if (level === 0) result += '\n';
  }

  // 处理子节点
  const children = node.children || [];
  for (const child of children) {
    result += nodeToMarkdown(child, level + 1);
  }

  return result;
}

/**
 * 导出为 Markdown 格式（大纲结构）
 */
export function exportToMarkdown(doc: MindMapDocument): string {
  return nodeToMarkdown(doc.root, 0);
}

// ============================================================================
// JSON 导出
// ============================================================================

/**
 * 导出为 JSON 格式（原生格式）
 */
export function exportToJson(doc: MindMapDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * 导出为压缩的 JSON 格式
 */
export function exportToJsonCompact(doc: MindMapDocument): string {
  return JSON.stringify(doc);
}

// ============================================================================
// 纯文本导出
// ============================================================================

function nodeToPlainText(node: MindMapNode, level: number): string {
  const indent = '  '.repeat(level);
  let result = `${indent}${node.text}\n`;

  const children = node.children || [];
  for (const child of children) {
    result += nodeToPlainText(child, level + 1);
  }

  return result;
}

/**
 * 导出为纯文本（缩进表示层级）
 */
export function exportToPlainText(doc: MindMapDocument): string {
  return nodeToPlainText(doc.root, 0);
}

// ============================================================================
// 通用导出接口
// ============================================================================

export type ExportFormat = 'opml' | 'markdown' | 'json' | 'json-compact' | 'text';

export interface ExportOptions {
  format: ExportFormat;
  title?: string;
}

/**
 * 统一导出接口
 */
export function exportMindMap(
  doc: MindMapDocument,
  options: ExportOptions
): { content: string; mimeType: string; extension: string } {
  switch (options.format) {
    case 'opml':
      return {
        content: exportToOpml(doc, options.title),
        mimeType: 'text/x-opml',
        extension: 'opml',
      };
    case 'markdown':
      return {
        content: exportToMarkdown(doc),
        mimeType: 'text/markdown',
        extension: 'md',
      };
    case 'json':
      return {
        content: exportToJson(doc),
        mimeType: 'application/json',
        extension: 'json',
      };
    case 'json-compact':
      return {
        content: exportToJsonCompact(doc),
        mimeType: 'application/json',
        extension: 'json',
      };
    case 'text':
      return {
        content: exportToPlainText(doc),
        mimeType: 'text/plain',
        extension: 'txt',
      };
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

/**
 * 触发文件下载（使用原生保存对话框，跨平台兼容）
 */
export async function downloadAsFile(
  content: string,
  filename: string,
  mimeType: string
): Promise<void> {
  const ext = filename.split('.').pop() || 'txt';
  try {
    await fileManager.saveTextFile({
      title: filename,
      defaultFileName: filename,
      content,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
  } catch (error) {
    console.error('[exporters] downloadAsFile failed:', error);
  }
}

// ============================================================================
// 图片导出 (PNG/SVG)
// ============================================================================

export type ImageFormat = 'png' | 'svg';

export interface ImageExportOptions {
  format: ImageFormat;
  filename?: string;
  scale?: number;
  backgroundColor?: string;
  padding?: number;
  /** 指定导出的容器元素，避免多实例时全局选择器命中错误实例 */
  container?: HTMLElement | null;
  /** 当前 MindMapContentView 的实例 store；未传时兼容旧的默认 store。 */
  store?: MindMapStoreApi;
}

// 互斥锁：防止并发调用导致 viewport 状态竞态
let _exportLock = false;

// 额外 padding 用于防止 bezier 曲线等 edge 被裁剪
const EDGE_PADDING = 20;

// 等待所有节点完成 measured（DOM 渲染 + 尺寸测量），最长等待 maxMs
async function waitForNodesMeasured(rfInstance: { getNodes: () => unknown[] }, maxMs = 2000): Promise<void> {
  // 先让出控制权，确保 React 有机会处理 setIsExporting(true) 引起的重渲染
  // （Zustand 同步更新 store，但 React re-render 是异步调度的）
  await new Promise<void>(resolve => {
    setTimeout(resolve, 200); // 兜底：如果 rAF 因窗口不可见等原因不触发
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const nodes = rfInstance.getNodes() as Node[];
    const allMeasured = nodes.every(n => n.measured?.width && n.measured?.height);
    if (allMeasured) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // 超时仍有未 measured 的节点，继续导出但可能不完整
  console.warn('[Export] waitForNodesMeasured timed out after %dms, some nodes may lack measured dimensions', maxMs);
}

/**
 * 将 ReactFlow 画布导出为图片
 *
 * 使用 @zumer/snapdom 替代 html-to-image，性能提升 15-93 倍。
 * 截图前临时设置 viewport transform 使其精确 fit 到内容边界。
 */
export async function exportToImage(
  options: ImageExportOptions = { format: 'png' }
): Promise<{ saved: boolean }> {
  // [问题1修复] 互斥锁防止并发调用导致 viewport 状态竞态
  if (_exportLock) {
    throw new Error('Export already in progress');
  }
  _exportLock = true;
  const storeApi = options.store ?? defaultMindMapStore;

  try {
  const {
    format,
    filename = 'mindmap',
    scale = 2,
    backgroundColor = '#ffffff',
    padding = 40,
    container,
  } = options;

  // SVG 是矢量格式，不需要像素缩放
  const effectiveScale = format === 'svg' ? 1 : scale;

  // 从 store 获取 ReactFlow 实例
  const rfGetter = storeApi.getState()._reactFlowGetter;
  const rfInstance = rfGetter?.();
  const initialNodes = rfInstance?.getNodes() ?? [];
  if (initialNodes.length === 0) {
    _exportLock = false;
    throw new Error('No nodes to export');
  }

  // M-078: 导出前先禁用虚拟化，确保所有节点都被渲染
  // 清除选中和焦点状态，确保导出的是纯净的导图，没有高亮框和操作按钮
  const store = storeApi.getState();
  const originalSelection = store.selection;
  const originalFocusedNodeId = store.focusedNodeId;
  const originalEditingNodeId = store.editingNodeId;
  const originalEditingNoteNodeId = store.editingNoteNodeId;
  const originalReciteMode = store.reciteMode;
  
  store.setIsExporting(true);
  store.setSelection([]);
  store.setFocusedNodeId(null);
  store.setEditingNodeId(null);
  store.setEditingNoteNodeId(null);
  // 导出完整文本，不带背诵遮挡
  if (originalReciteMode) {
    store.setReciteMode(false);
  }
  store.setExportProgress(10);
  
  // 等待所有节点 DOM 渲染并完成尺寸测量（替代固定 500ms 延迟）
  if (rfInstance) {
    await waitForNodesMeasured(rfInstance);
  }
  
  storeApi.getState().setExportProgress(40);
  // 让 UI 有机会刷新
  await new Promise(resolve => setTimeout(resolve, 50));

  // 重新获取节点数据，确保拿到虚拟化禁用后最新的 measured 尺寸
  const freshNodes = (rfInstance?.getNodes() ?? []) as Node[];
  if (freshNodes.length === 0) {
    _exportLock = false;
    storeApi.getState().setIsExporting(false);
    storeApi.getState().setExportProgress(0);
    throw new Error('No nodes to export after rendering');
  }

  // 计算所有节点的精确边界
  const nodesBounds = getNodesBounds(freshNodes);

  // 内容实际尺寸 + padding + edge 安全余量
  const totalPadding = padding + EDGE_PADDING;
  const contentWidth = nodesBounds.width + totalPadding * 2;
  const contentHeight = nodesBounds.height + totalPadding * 2;

  // 计算使内容完美适配的 viewport transform
  // 注意：contentWidth/Height 已含 totalPadding，getViewportForBounds 的 padding 参数
  // 会在其内部再从 width/height 中扣除 2*totalPadding 作为有效区域，
  // 所以有效区域 = nodesBounds 自身尺寸，zoom 结果为 1.0，totalPadding 通过 translate 偏移实现。
  const viewport = getViewportForBounds(
    nodesBounds,
    contentWidth,
    contentHeight,
    0.5,   // minZoom
    2,     // maxZoom
    totalPadding,
  );

  // [安全修复] 检查 Canvas 尺寸限制 (浏览器通常限制 ~268MP)
  // 如果尺寸过大，强制降低缩放比例
  const MAX_CANVAS_AREA = 268_000_000; // 安全余量
  let safeScale = effectiveScale;
  const estimatedArea = (contentWidth * effectiveScale) * (contentHeight * effectiveScale);
  
  if (estimatedArea > MAX_CANVAS_AREA) {
    safeScale = Math.sqrt(MAX_CANVAS_AREA / (contentWidth * contentHeight));
    // 向下取整保留2位小数，防止精度问题溢出
    safeScale = Math.floor(safeScale * 100) / 100;
    console.warn(`Export size exceeds limit, downsizing scale from ${effectiveScale} to ${safeScale}`);
    
    // 如果缩放后甚至小于 0.1，说明图太大无法导出清晰图，抛出错误让用户拆分
    if (safeScale < 0.1) {
       _exportLock = false;
       storeApi.getState().setIsExporting(false);
       storeApi.getState().setExportProgress(0);
       throw new Error('Mind map is too large to export as image. Please try splitting it.');
    }
  }

  // [问题2修复] container 已指定时，不回退到全局搜索
  const scopeRoot = container || document.querySelector('.mindmap-container');
  const reactFlowContainer = scopeRoot?.querySelector('.react-flow') as HTMLElement;
  if (!reactFlowContainer) {
    _exportLock = false;
    storeApi.getState().setIsExporting(false);
    storeApi.getState().setExportProgress(0);
    throw new Error('ReactFlow container not found');
  }

  const viewportEl = reactFlowContainer.querySelector('.react-flow__viewport') as HTMLElement;
  if (!viewportEl) {
    _exportLock = false;
    storeApi.getState().setIsExporting(false);
    storeApi.getState().setExportProgress(0);
    throw new Error('ReactFlow viewport not found');
  }

  // 保存原始状态（容器尺寸、CSS、类名 + viewport transform）
  const originalTransform = viewportEl.style.transform;
  const originalCssText = reactFlowContainer.style.cssText;
  const originalClasses = Array.from(reactFlowContainer.classList);

  // 将外层主题容器的 CSS 变量和关键类名临时下放到 reactFlowContainer
  // 因为 snapdom 是从 reactFlowContainer 开始克隆，如果不下放会导致导出图中丢失主题变量（如 --mm-border）
  if (scopeRoot instanceof HTMLElement) {
    scopeRoot.classList.forEach(cls => {
      if (cls.includes('theme') || cls === 'dark' || cls.includes('mindmap') || cls === 'mm-exporting') {
        reactFlowContainer.classList.add(cls);
      }
    });
    for (let i = 0; i < scopeRoot.style.length; i++) {
      const prop = scopeRoot.style[i];
      if (prop.startsWith('--')) {
        reactFlowContainer.style.setProperty(prop, scopeRoot.style.getPropertyValue(prop));
      }
    }
  }

  // 临时设置：
  // 1. viewport transform → 使所有节点精确 fit 到 contentWidth x contentHeight 区域
  // 2. 容器尺寸 → contentWidth x contentHeight，这样 overflow:hidden 恰好裁剪到内容边界
  viewportEl.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  reactFlowContainer.style.width = `${contentWidth}px`;
  reactFlowContainer.style.height = `${contentHeight}px`;

  // [问题5优化] 自动降级重试逻辑
  const tryExport = async (currentScale: number, attempt = 1): Promise<{ saved: boolean }> => {
    const sanitizedFilename = sanitizeFilename(filename);
    try {
      if (attempt > 1) {
        console.warn(`[Export] Retrying with reduced scale: ${currentScale} (Attempt ${attempt})`);
        storeApi.getState().setExportProgress(50 + (attempt * 10)); // 每次重试增加一点进度反馈
      }

      // 对 reactFlowContainer 截图（不是 viewportEl）
      // 容器有 overflow:hidden，配合临时设置的尺寸和 transform，精确捕获内容区域
      const result = await snapdom(reactFlowContainer, {
        scale: currentScale,
        backgroundColor,
        embedFonts: true, // 强制内联字体，确保 PNG 渲染 KaTeX 等外部字体时不丢失
        outerTransforms: true,
        exclude: [
          '.react-flow__background',
          '.react-flow__controls',
          '.react-flow__minimap',
          '.react-flow__attribution',
        ],
      });

      if (format === 'svg') {
        const blob = await result.toBlob({ type: 'svg' });
        if (!blob) throw new Error('Failed to generate SVG blob');
        
        storeApi.getState().setExportProgress(90);
        await new Promise(resolve => setTimeout(resolve, 50));

        const svgContent = await blob.text();
        const saveResult = await fileManager.saveTextFile({
          title: i18n.t('mindmap:export.dialogSvg'),
          defaultFileName: `${sanitizedFilename}.svg`,
          content: svgContent,
          filters: [{ name: i18n.t('mindmap:export.filterSvg'), extensions: ['svg'] }],
        });
        if (saveResult.canceled) return { saved: false };
      } else {
        const blob = await result.toBlob({ type: 'png' });
        if (!blob) throw new Error('Failed to generate PNG blob');
        
        storeApi.getState().setExportProgress(90);
        await new Promise(resolve => setTimeout(resolve, 50));

        const arrayBuffer = await blob.arrayBuffer();
        const imageData = new Uint8Array(arrayBuffer);
        const saveResult = await fileManager.saveBinaryFile({
          title: i18n.t('mindmap:export.dialogPng'),
          defaultFileName: `${sanitizedFilename}.png`,
          data: imageData,
          filters: [{ name: i18n.t('mindmap:export.filterPng'), extensions: ['png'] }],
        });
        if (saveResult.canceled) return { saved: false };
      }
      return { saved: true };
    } catch (error) {
      // 如果是因为尺寸过大导致的错误，尝试降级
      const isSizeError = error instanceof Error && (
        error.message.includes('too large') || 
        error.message.includes('Failed to generate')
      );
      
      if (isSizeError && currentScale > 0.5) {
        // 降级策略：每次减半，最低 0.5
        const nextScale = Math.max(0.5, currentScale * 0.5);
        return await tryExport(nextScale, attempt + 1);
      } else {
        throw error;
      }
    }
  };

  try {
    storeApi.getState().setExportProgress(60);
    // 让 UI 有机会刷新，因为 snapdom 是重型操作
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // 开始尝试导出，初始使用计算出的安全比例
    const exportResult = await tryExport(safeScale);
    return exportResult;

  } catch (error) {
    console.error('Image export failed:', error);
    // [问题4修复] 使用 cause 保留原始错误链
    throw new Error(
      `Failed to export ${format.toUpperCase()}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error },
    );
  } finally {
    // 恢复原始状态
    viewportEl.style.transform = originalTransform;
    reactFlowContainer.style.cssText = originalCssText;
    reactFlowContainer.className = originalClasses.join(' ');
    
    // 恢复虚拟化及选中状态
    const store = storeApi.getState();
    store.setIsExporting(false);
    store.setExportProgress(0);
    store.setSelection(originalSelection);
    store.setFocusedNodeId(originalFocusedNodeId);
    store.setEditingNodeId(originalEditingNodeId);
    store.setEditingNoteNodeId(originalEditingNoteNodeId);
    if (originalReciteMode) {
      store.setReciteMode(true);
    }
    _exportLock = false;
  }

  } catch (unexpectedError) {
    // 防御性兜底：捕获 setup 阶段（如 getNodesBounds / waitForNodesMeasured 等）的意外异常
    // 内层 finally 可能已执行清理，此处调用为幂等安全
    storeApi.getState().setIsExporting(false);
    storeApi.getState().setExportProgress(0);
    _exportLock = false;
    throw unexpectedError;
  }
}

/**
 * 清理文件名，移除不合法字符
 */
function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return sanitized || 'mindmap';
}
