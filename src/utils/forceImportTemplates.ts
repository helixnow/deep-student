/**
 * 强制导入内置模板工具
 * 使用新的内置模板导入机制
 */

import { invoke } from '@tauri-apps/api/core';
import { CustomAnkiTemplate } from '../types';

const EXPECTED_BUILTIN_TEMPLATE_IDS = [
  'design-lab',
  'design-manuscript',
  'design-redaction',
  'design-glass',
  'design-swiss',
  'design-polaroid',
  'design-architect',
  'design-lexicon',
  'design-botanical',
  'design-eink',
  'design-monograph',
  'design-footnote',
  'design-marginalia',
  'design-seminar',
  'design-nomenclature',
  'design-exam',
];

interface ForceImportResult {
  success: number;
  failed: number;
  details: string[];
  imported: string[];
}

/**
 * 强制导入内置模板，使用新的导入机制
 */
export async function forceImportComplexTemplates(): Promise<ForceImportResult> {
  console.log('🚀 强制导入内置模板开始...');
  
  const result: ForceImportResult = {
    success: 0,
    failed: 0,
    details: [],
    imported: []
  };

  try {
    // 使用新的内置模板导入命令
    const importResult = await invoke<string>('import_builtin_templates');
    console.log('内置模板导入结果:', importResult);
    
    const extractCount = (pattern: RegExp) => {
      const match = importResult.match(pattern);
      return match ? parseInt(match[1], 10) : 0;
    };
    const hasNewOrUpdate = /新增/.test(importResult) || /更新/.test(importResult);
    const hasSummary = /导入完成/.test(importResult) || /个成功/.test(importResult);

    if (hasNewOrUpdate || hasSummary) {
      if (hasNewOrUpdate) {
        const newCount = extractCount(/新增[:：]?\s*(\d+)\s*个/);
        const updateCount = extractCount(/更新[:：]?\s*(\d+)\s*个/);
        const failedCount = extractCount(/(\d+)\s*个失败/);

        result.success = newCount + updateCount;
        result.failed = failedCount;
        result.details.push(`成功导入 ${newCount} 个新模板，更新 ${updateCount} 个现有模板`);
        if (failedCount > 0) {
          result.details.push(importResult);
        }
      } else {
        const successCount = extractCount(/(\d+)\s*个成功/);
        const failedCount = extractCount(/(\d+)\s*个失败/);

        result.success = successCount;
        result.failed = failedCount;
        result.details.push(importResult);
      }
      result.imported.push('内置模板集');
    } else {
      result.failed = 1;
      result.details.push('导入失败: ' + importResult);
    }
    
    // 清除localStorage缓存，确保下次重启时能重新检查
    localStorage.removeItem('high_quality_templates_imported_v2');
    localStorage.setItem('complex_templates_force_imported', new Date().toISOString());
    
    console.log('🎉 强制导入完成!', result);
    return result;
    
  } catch (error: unknown) {
    console.error('强制导入过程发生错误:', error);
    result.failed = 1;
    result.details.push(`系统错误: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
}

/**
 * 检查内置模板导入状态
 */
export async function checkComplexTemplatesStatus(): Promise<{
  totalInDatabase: number;
  expectedTemplates: string[];
  missingTemplates: string[];
  existingTemplates: string[];
}> {
  try {
    const existingTemplates = await invoke<CustomAnkiTemplate[]>('get_all_custom_templates');
    
    const expectedTemplates = [...EXPECTED_BUILTIN_TEMPLATE_IDS];
    const existingIds = existingTemplates.map(t => t.id);
    const missingTemplates = expectedTemplates.filter(id => !existingIds.includes(id));
    const builtinTemplatesInDB = existingIds.filter(id =>
      expectedTemplates.includes(id)
    );
    
    return {
      totalInDatabase: existingTemplates.length,
      expectedTemplates,
      missingTemplates,
      existingTemplates: builtinTemplatesInDB
    };
  } catch (error: unknown) {
    console.error('检查模板状态失败:', error);
    throw error;
  }
}

/**
 * 获取导入历史信息
 */
export function getImportHistory(): {
  lastForceImported: string | null;
  isComplexTemplatesImported: boolean;
} {
  return {
    lastForceImported: localStorage.getItem('complex_templates_force_imported'),
    isComplexTemplatesImported: localStorage.getItem('high_quality_templates_imported_v2') === 'true'
  };
}

/**
 * 清除导入历史
 */
export function clearImportHistory(): void {
  localStorage.removeItem('high_quality_templates_imported_v2');
  localStorage.removeItem('complex_templates_force_imported');
}
