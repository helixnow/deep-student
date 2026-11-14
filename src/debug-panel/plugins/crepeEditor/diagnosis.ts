/**
 * Crepe 编辑器调试：由实时 DOM 快照和日志得出的诊断（问题与建议），以及按级别、分类的日志计数。
 */

import type { DOMSnapshot, DebugLog } from './model';

// 诊断分析
export function diagnose(liveSnapshot: DOMSnapshot | null, logs: DebugLog[]) {
  if (!liveSnapshot) return null;

  const issues: string[] = [];
  const hints: string[] = [];

  if (!liveSnapshot.wrapperExists) {
    issues.push('❌ Crepe 编辑器容器不存在');
    hints.push('检查 NotesCrepeEditor 是否正确渲染');
  } else {
    if (liveSnapshot.dataReady === 'false') {
      issues.push('❌ data-ready="false"，编辑器未就绪');
      hints.push('检查 Crepe.create() 是否成功完成');
    }
    
    if (!liveSnapshot.milkdownExists) {
      issues.push('❌ .milkdown 容器不存在');
      hints.push('Crepe 实例可能未正确创建');
    }
    
    if (!liveSnapshot.proseMirrorExists) {
      issues.push('❌ ProseMirror 编辑器不存在');
      hints.push('Milkdown 编辑器可能初始化失败');
    } else if (liveSnapshot.contentEditable !== 'true') {
      issues.push(`⚠️ contentEditable="${liveSnapshot.contentEditable}"，应为 "true"`);
      hints.push('编辑器可能处于只读模式或未正确初始化');
    }

    if (liveSnapshot.pointerEvents === 'none') {
      issues.push('❌ pointer-events: none，点击事件被阻止');
      hints.push('检查 CSS 规则，可能是 data-ready="false" 导致');
    }
  }

  // 检查错误日志
  const errorLogs = logs.filter(l => l.level === 'error');
  if (errorLogs.length > 0) {
    issues.push(`⚠️ 存在 ${errorLogs.length} 条错误日志`);
    const prismErrors = errorLogs.filter(l => l.message.includes('Prism'));
    if (prismErrors.length > 0) {
      hints.push('Prism 加载错误可能导致代码高亮失败');
    }
  }

  return { issues, hints, isHealthy: issues.length === 0 };
}

export function logStats(logs: DebugLog[]) {
  const counts: Record<string, number> = { debug: 0, info: 0, warning: 0, error: 0 };
  const categoryStats: Record<string, number> = {};
  
  logs.forEach(log => {
    counts[log.level]++;
    categoryStats[log.category] = (categoryStats[log.category] || 0) + 1;
  });
  
  return { counts, categoryStats };
}
