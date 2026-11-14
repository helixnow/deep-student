/**
 * Crepe 拖放调试的两种诊断：
 * - probeEditor：「运行诊断」按钮，探查 Milkdown / Crepe 全局实例、DOM 结构、ProseMirror view 与 draggable 元素，逐行给出结果；
 * - diagnoseLogs：「实时诊断」面板，按已记录的事件判断 dragstart / dragover / drop 是否正常，并检查当前 DOM。
 */

import { captureDOMState } from './capture';
import type { DiagnosisResult, DragEventLog } from './model';

export function probeEditor(): string[] {
  const results: string[] = [];
  
  // 1. 检查 window.__MILKDOWN_VIEW__
  const milkdownView = (window as any).__MILKDOWN_VIEW__;
  const milkdownCtx = (window as any).__MILKDOWN_CTX__;
  
  if (milkdownView) {
    results.push('✅ window.__MILKDOWN_VIEW__ 存在');
    results.push(`   - editable: ${milkdownView.editable}`);
    results.push(`   - dragging: ${JSON.stringify(milkdownView.dragging)}`);
    results.push(`   - selection: ${milkdownView.state?.selection?.constructor?.name || 'unknown'}`);
    results.push(`   - hasFocus: ${milkdownView.hasFocus?.() ?? 'unknown'}`);
  } else {
    results.push('❌ window.__MILKDOWN_VIEW__ 不存在');
  }
  
  if (milkdownCtx) {
    results.push('✅ window.__MILKDOWN_CTX__ 存在');
  } else {
    results.push('❌ window.__MILKDOWN_CTX__ 不存在');
  }
  
  // 检查 crepe 实例
  const crepe = (window as any).__MILKDOWN_CREPE__;
  if (crepe) {
    results.push('✅ window.__MILKDOWN_CREPE__ 存在');
    results.push(`   - crepe.readonly: ${crepe.readonly}`);
    
    // 检查 crepe 对象结构
    const crepeKeys = Object.keys(crepe).filter(k => !k.startsWith('_'));
    results.push(`   - crepe keys: ${crepeKeys.join(', ')}`);
    
    // 检查 editor 对象
    if (crepe.editor) {
      const editorKeys = Object.keys(crepe.editor).filter(k => !k.startsWith('_'));
      results.push(`   - editor keys: ${editorKeys.join(', ')}`);
      
      // 检查 ctx
      if (crepe.editor.ctx) {
        results.push('   - editor.ctx: ✅');
        
        // 尝试使用 inspect() 获取信息
        try {
          if (typeof crepe.editor.inspect === 'function') {
            const inspectResult = crepe.editor.inspect();
            results.push(`   - inspect() 返回: ${typeof inspectResult}`);
            if (inspectResult) {
              const inspectKeys = Object.keys(inspectResult).slice(0, 10);
              results.push(`   - inspect keys: ${inspectKeys.join(', ')}`);
            }
          }
        } catch (e) {
          results.push(`   - inspect() 失败: ${e}`);
        }
        
        // 尝试获取 ctx 的所有属性
        try {
          const ctx = crepe.editor.ctx;
          const ctxKeys = [];
          for (const key in ctx) {
            ctxKeys.push(key);
          }
          results.push(`   - ctx 属性: ${ctxKeys.slice(0, 15).join(', ')}`);
          
          // 检查 ctx.get 方法
          if (typeof ctx.get === 'function') {
            results.push('   - ctx.get: ✅ 存在');
            
            // 尝试使用 action 来获取 view
            try {
              let viewFound = false;
              crepe.editor.action((actionCtx: any) => {
                // 尝试获取 editorView
                try {
                  // 遍历 actionCtx 找到 get 方法能获取的值
                  // editorViewCtx 的 key 通常包含 'editorView'
                  const testKeys = ['editorView', 'view', 'prosemirror', 'pm'];
                  for (const testKey of testKeys) {
                    try {
                      const val = actionCtx.get(testKey);
                      if (val && val.state && val.dispatch) {
                        results.push(`   - 通过 ctx.get('${testKey}') 获取到 view!`);
                        results.push(`   - view.editable: ${val.editable}`);
                        results.push(`   - view.dragging: ${JSON.stringify(val.dragging)}`);
                        (window as any).__MILKDOWN_VIEW__ = val;
                        (window as any).__MILKDOWN_CTX__ = actionCtx;
                        viewFound = true;
                        break;
                      }
                    } catch (e) {
                      // 这个 key 不存在
                    }
                  }
                  
                  // 如果上面的方法失败，尝试遍历已记录的 slices
                  if (!viewFound && typeof actionCtx.isRecorded === 'function') {
                    // 尝试一些常见的 slice IDs
                    const sliceIds = ['editorView', 'editorViewCtx', 'view', 'editorState', 'proseState'];
                    for (const id of sliceIds) {
                      if (actionCtx.isRecorded({ id })) {
                        try {
                          const val = actionCtx.get({ id });
                          if (val && val.state && val.dispatch) {
                            results.push(`   - 通过 slice id '${id}' 获取到 view!`);
                            (window as any).__MILKDOWN_VIEW__ = val;
                            viewFound = true;
                            break;
                          }
                        } catch (e) {
                          // 忽略
                        }
                      }
                    }
                  }
                } catch (e) {
                  results.push(`   - action 内部错误: ${e}`);
                }
              });
              
              if (!viewFound) {
                results.push('   - 无法通过 action 获取 view');
              }
            } catch (e) {
              results.push(`   - action 调用失败: ${e}`);
            }
          }
        } catch (e) {
          results.push(`   - ctx 检查失败: ${e}`);
        }
      }
    }
    
    // 尝试 getMarkdown 验证 crepe 工作正常
    try {
      const md = crepe.getMarkdown?.();
      results.push(`   - getMarkdown(): ${md ? `"${md.substring(0, 50)}..."` : '(empty)'}`);
    } catch (e) {
      results.push(`   - getMarkdown() 失败: ${e}`);
    }
  } else {
    results.push('❌ window.__MILKDOWN_CREPE__ 不存在');
  }
  
  // 2. 检查 DOM 结构
  const crepeWrapper = document.querySelector('.crepe-editor-wrapper');
  const milkdown = document.querySelector('.milkdown');
  const proseMirror = document.querySelector('.ProseMirror');
  const blockHandle = document.querySelector('.milkdown-block-handle');
  
  results.push('');
  results.push('📦 DOM 结构检查:');
  results.push(`   - .crepe-editor-wrapper: ${crepeWrapper ? '✅' : '❌'}`);
  results.push(`   - .milkdown: ${milkdown ? '✅' : '❌'}`);
  results.push(`   - .ProseMirror: ${proseMirror ? '✅' : '❌'}`);
  results.push(`   - .milkdown-block-handle: ${blockHandle ? '✅' : '❌'}`);
  
  if (blockHandle) {
    const bh = blockHandle as HTMLElement;
    results.push(`   - block handle draggable: ${bh.draggable}`);
    results.push(`   - block handle data-show: ${bh.getAttribute('data-show')}`);
    results.push(`   - block handle pointer-events: ${getComputedStyle(bh).pointerEvents}`);
    results.push(`   - operation-items: ${bh.querySelectorAll('.operation-item').length}`);
  }
  
  // 3. 检查 ProseMirror view 从 DOM
  if (proseMirror) {
    const pmDesc = (proseMirror as any).pmViewDesc;
    if (pmDesc?.view) {
      results.push('');
      results.push('📝 ProseMirror (from DOM):');
      results.push(`   - view exists: ✅`);
      results.push(`   - editable: ${pmDesc.view.editable}`);
      results.push(`   - dragging: ${JSON.stringify(pmDesc.view.dragging)}`);
      
      // 如果全局变量不存在，设置它
      if (!milkdownView) {
        (window as any).__MILKDOWN_VIEW__ = pmDesc.view;
        results.push('   - ⚠️ 已将 view 设置到 window.__MILKDOWN_VIEW__');
      }
    } else {
      results.push('');
      results.push('📝 ProseMirror (from DOM):');
      results.push('   - pmViewDesc: ❌ 不存在');
    }
  }
  
  // 4. 检查 draggable 元素
  const draggableElements = document.querySelectorAll('.crepe-editor-wrapper [draggable="true"]');
  results.push('');
  results.push(`🎯 Draggable 元素: ${draggableElements.length} 个`);
  draggableElements.forEach((el, i) => {
    const tag = el.tagName.toLowerCase();
    const cls = el.className?.toString().split(' ').slice(0, 3).join('.') || '';
    results.push(`   ${i + 1}. ${tag}.${cls}`);
  });

  return results;
}

export function diagnoseLogs(logs: DragEventLog[]): DiagnosisResult[] {
  const results: DiagnosisResult[] = [];
  
  const dragstartLogs = logs.filter(l => l.type === 'dragstart' && l.target !== 'system');
  const dropLogs = logs.filter(l => l.type === 'drop');
  const dragoverLogs = logs.filter(l => l.type === 'dragover');

  // 检查是否有 dragstart
  if (dragstartLogs.length === 0) {
    results.push({
      category: 'dragstart',
      status: 'warning',
      message: '未检测到 dragstart 事件',
      details: '请尝试拖拽 block handle（六个点图标）',
    });
  } else {
    const lastDragstart = dragstartLogs[dragstartLogs.length - 1];
    if (lastDragstart.defaultPrevented) {
      results.push({
        category: 'dragstart',
        status: 'error',
        message: 'dragstart 被阻止',
        details: '某个事件处理器调用了 preventDefault()，阻止了拖拽开始',
      });
    } else if (!lastDragstart.dataTransfer?.hasData) {
      results.push({
        category: 'dragstart',
        status: 'error',
        message: 'dataTransfer 无数据',
        details: 'BlockService 未正确设置拖拽数据',
      });
    } else {
      results.push({
        category: 'dragstart',
        status: 'ok',
        message: 'dragstart 正常触发',
      });
    }
  }

  // 检查 dragover
  if (dragoverLogs.length > 0) {
    const preventedCount = dragoverLogs.filter(l => l.defaultPrevented).length;
    const ratio = preventedCount / dragoverLogs.length;
    if (ratio < 0.5) {
      results.push({
        category: 'dragover',
        status: 'error',
        message: 'dragover 未正确处理',
        details: `${(ratio * 100).toFixed(0)}% 的 dragover 调用了 preventDefault()，需要接近 100%`,
      });
    } else {
      results.push({
        category: 'dragover',
        status: 'ok',
        message: 'dragover 处理正常',
      });
    }
  }

  // 检查 drop
  if (dropLogs.length === 0 && dragstartLogs.length > 0) {
    results.push({
      category: 'drop',
      status: 'error',
      message: '未检测到 drop 事件',
      details: '拖拽后无法放下，可能是 dragover 未正确处理',
    });
  } else if (dropLogs.length > 0) {
    results.push({
      category: 'drop',
      status: 'ok',
      message: 'drop 事件已触发',
    });
  }

  // 检查 DOM 状态
  const domState = captureDOMState();
  if (!domState?.blockHandleExists) {
    results.push({
      category: 'dom',
      status: 'error',
      message: 'Block handle 不存在',
      details: '检查 CrepeFeature.BlockEdit 是否启用',
    });
  }
  if (domState?.draggableElements === 0) {
    results.push({
      category: 'dom',
      status: 'error',
      message: '无 draggable 元素',
      details: 'BlockProvider 未正确设置 draggable 属性',
    });
  }

  return results;
}
