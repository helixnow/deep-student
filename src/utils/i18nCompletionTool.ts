/**
 * 国际化文本补全工具
 *
 * 此工具用于检测和补全缺失的翻译键，确保中英文翻译文件的同步
 * 注意：这是一个 Node.js 工具脚本，不应在前端环境中使用
 */

import fs from 'fs';
import path from 'path';

// 翻译文件路径配置
const LOCALES_DIR = path.join(process.cwd(), 'src', 'locales');
const ZH_CN_DIR = path.join(LOCALES_DIR, 'zh-CN');
const EN_US_DIR = path.join(LOCALES_DIR, 'en-US');

// 支持的翻译文件
const TRANSLATION_FILES = [
  'common.json',
  'sidebar.json', 
  'settings.json',
  'analysis.json',
  'library.json',
  'enhanced_rag.json',
  'anki.json',
  'template.json',
  'data.json',
  'workflow.json', // 新增工作流翻译
  'error_handler.json', // 新增错误处理翻译
  'performance.json' // 新增性能优化翻译
];

interface TranslationNode {
  [key: string]: string | TranslationNode;
}

interface CompletionReport {
  file: string;
  missingInZhCN: string[];
  missingInEnUS: string[];
  suggestions: { [key: string]: string };
}

class I18nCompletionTool {
  private zhCNTranslations: Map<string, TranslationNode> = new Map();
  private enUSTranslations: Map<string, TranslationNode> = new Map();
  
  constructor() {
    this.loadTranslations();
  }
  
  /**
   * 加载所有翻译文件
   */
  private loadTranslations(): void {
    for (const file of TRANSLATION_FILES) {
      try {
        // 加载中文翻译
        const zhPath = path.join(ZH_CN_DIR, file);
        if (fs.existsSync(zhPath)) {
          const zhContent = JSON.parse(fs.readFileSync(zhPath, 'utf-8'));
          this.zhCNTranslations.set(file, zhContent);
        }
        
        // 加载英文翻译
        const enPath = path.join(EN_US_DIR, file);
        if (fs.existsSync(enPath)) {
          const enContent = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
          this.enUSTranslations.set(file, enContent);
        }
      } catch (error: unknown) {
        console.error(`Error loading translation file ${file}:`, error);
      }
    }
  }
  
  /**
   * 获取对象的所有键路径
   */
  private getKeyPaths(obj: TranslationNode, prefix = ''): string[] {
    const paths: string[] = [];
    
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      
      if (typeof value === 'string') {
        paths.push(currentPath);
      } else if (typeof value === 'object' && value !== null) {
        paths.push(...this.getKeyPaths(value, currentPath));
      }
    }
    
    return paths;
  }
  
  /**
   * 检查翻译完整性
   */
  public checkCompleteness(): CompletionReport[] {
    const reports: CompletionReport[] = [];
    
    for (const file of TRANSLATION_FILES) {
      const zhTranslation = this.zhCNTranslations.get(file);
      const enTranslation = this.enUSTranslations.get(file);
      
      if (!zhTranslation && !enTranslation) {
        continue; // 两个文件都不存在，跳过
      }
      
      const zhKeys = zhTranslation ? this.getKeyPaths(zhTranslation) : [];
      const enKeys = enTranslation ? this.getKeyPaths(enTranslation) : [];
      
      const missingInZhCN = enKeys.filter(key => !zhKeys.includes(key));
      const missingInEnUS = zhKeys.filter(key => !enKeys.includes(key));
      
      const suggestions = this.generateSuggestions(file, missingInEnUS);
      
      if (missingInZhCN.length > 0 || missingInEnUS.length > 0) {
        reports.push({
          file,
          missingInZhCN,
          missingInEnUS,
          suggestions
        });
      }
    }
    
    return reports;
  }
  
  /**
   * 生成翻译建议
   */
  private generateSuggestions(file: string, missingKeys: string[]): { [key: string]: string } {
    const suggestions: { [key: string]: string } = {};
    
    // 基于键名生成英文翻译建议
    for (const key of missingKeys) {
      const keyParts = key.split('.');
      const lastPart = keyParts[keyParts.length - 1];
      
      // 简单的键名到英文的映射
      const keyTranslations: { [key: string]: string } = {
        // 动作类
        'save': 'Save',
        'cancel': 'Cancel',
        'delete': 'Delete',
        'edit': 'Edit',
        'add': 'Add',
        'remove': 'Remove',
        'upload': 'Upload',
        'download': 'Download',
        'search': 'Search',
        'filter': 'Filter',
        'refresh': 'Refresh',
        'reset': 'Reset',
        'submit': 'Submit',
        'close': 'Close',
        'open': 'Open',
        'clear': 'Clear',
        'export': 'Export',
        'import': 'Import',
        'analyze': 'Analyze',
        'generate': 'Generate',
        'preview': 'Preview',
        'confirm': 'Confirm',
        'retry': 'Retry',
        
        // 状态类
        'loading': 'Loading...',
        'saving': 'Saving...',
        'analyzing': 'Analyzing...',
        'processing': 'Processing...',
        'connecting': 'Connecting...',
        'success': 'Success',
        'error': 'Error',
        'warning': 'Warning',
        'failed': 'Failed',
        'completed': 'Completed',
        'pending': 'Pending',
        
        // 工作流相关
        'workflow': 'Workflow',
        'step': 'Step',
        'progress': 'Progress',
        'status': 'Status',
        'execution': 'Execution',
        'recovery': 'Recovery',
        'fallback': 'Fallback',
        'circuit_breaker': 'Circuit Breaker',
        'timeout': 'Timeout',
        'retry_count': 'Retry Count',
        'max_attempts': 'Max Attempts',
        
        // 错误处理相关
        'error_handler': 'Error Handler',
        'error_type': 'Error Type',
        'error_message': 'Error Message',
        'recovery_strategy': 'Recovery Strategy',
        'abort': 'Abort',
        'skip': 'Skip',
        // 'fallback' already defined in workflow section

        // 性能相关
        'performance': 'Performance',
        'optimization': 'Optimization',
        'cache': 'Cache',
        'cache_hit': 'Cache Hit',
        'cache_miss': 'Cache Miss',
        'latency': 'Latency',
        'throughput': 'Throughput',
        'concurrent': 'Concurrent',
        'parallel': 'Parallel',
        'vector_search': 'Vector Search',
        'similarity': 'Similarity',
        'dimension': 'Dimension',
        'index': 'Index',
        'rebuild': 'Rebuild'
      };
      
      // 尝试匹配键名
      let suggestion = keyTranslations[lastPart];
      
      if (!suggestion) {
        // 如果没有直接匹配，尝试生成基于上下文的建议
        if (key.includes('error')) {
          suggestion = `Error: ${this.capitalizeFirst(lastPart.replace(/_/g, ' '))}`;
        } else if (key.includes('success')) {
          suggestion = `Success: ${this.capitalizeFirst(lastPart.replace(/_/g, ' '))}`;
        } else if (key.includes('workflow')) {
          suggestion = `Workflow ${this.capitalizeFirst(lastPart.replace(/_/g, ' '))}`;
        } else {
          suggestion = this.capitalizeFirst(lastPart.replace(/_/g, ' '));
        }
      }
      
      suggestions[key] = suggestion;
    }
    
    return suggestions;
  }
  
  /**
   * 首字母大写
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
  
  /**
   * 自动补全缺失的翻译
   */
  public autoComplete(): void {
    const reports = this.checkCompleteness();
    
    for (const report of reports) {
      if (report.missingInEnUS.length > 0) {
        this.addMissingTranslations(report.file, 'en-US', report.suggestions);
      }
    }
  }
  
  /**
   * 添加缺失的翻译到文件
   */
  private addMissingTranslations(file: string, locale: string, translations: { [key: string]: string }): void {
    const filePath = path.join(LOCALES_DIR, locale, file);
    
    try {
      let content: TranslationNode = {};
      
      // 如果文件存在，先加载现有内容
      if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
      
      // 添加缺失的翻译
      for (const [keyPath, translation] of Object.entries(translations)) {
        this.setNestedValue(content, keyPath, translation);
      }
      
      // 确保目录存在
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // 写入文件
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
      
      console.log(`✅ Updated ${file} for ${locale} with ${Object.keys(translations).length} missing translations`);
    } catch (error: unknown) {
      console.error(`❌ Error updating ${file} for ${locale}:`, error);
    }
  }
  
  /**
   * 设置嵌套对象的值
   */
  private setNestedValue(obj: TranslationNode, keyPath: string, value: string): void {
    const keys = keyPath.split('.');
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key] as TranslationNode;
    }
    
    current[keys[keys.length - 1]] = value;
  }
  
  /**
   * 生成完整性报告
   */
  public generateReport(): string {
    const reports = this.checkCompleteness();
    
    if (reports.length === 0) {
      return '✅ 所有翻译文件都是完整的！';
    }
    
    let report = '📊 国际化翻译完整性报告\n\n';
    
    for (const fileReport of reports) {
      report += `📁 ${fileReport.file}\n`;
      
      if (fileReport.missingInZhCN.length > 0) {
        report += `  ❌ 中文缺失 (${fileReport.missingInZhCN.length}): ${fileReport.missingInZhCN.join(', ')}\n`;
      }
      
      if (fileReport.missingInEnUS.length > 0) {
        report += `  ❌ 英文缺失 (${fileReport.missingInEnUS.length}): ${fileReport.missingInEnUS.join(', ')}\n`;
      }
      
      report += '\n';
    }
    
    return report;
  }
  
  /**
   * 创建新的翻译文件模板
   */
  public createTranslationTemplate(fileName: string, templateContent: TranslationNode): void {
    const zhPath = path.join(ZH_CN_DIR, fileName);
    const enPath = path.join(EN_US_DIR, fileName);
    
    // 确保目录存在
    if (!fs.existsSync(ZH_CN_DIR)) {
      fs.mkdirSync(ZH_CN_DIR, { recursive: true });
    }
    if (!fs.existsSync(EN_US_DIR)) {
      fs.mkdirSync(EN_US_DIR, { recursive: true });
    }
    
    // 创建中文模板
    fs.writeFileSync(zhPath, JSON.stringify(templateContent, null, 2), 'utf-8');
    
    // 创建英文模板（使用建议翻译）
    const keyPaths = this.getKeyPaths(templateContent);
    const suggestions = this.generateSuggestions(fileName, keyPaths);
    
    const enContent: TranslationNode = {};
    for (const [keyPath, translation] of Object.entries(suggestions)) {
      this.setNestedValue(enContent, keyPath, translation);
    }
    
    fs.writeFileSync(enPath, JSON.stringify(enContent, null, 2), 'utf-8');
    
    console.log(`✅ Created translation template: ${fileName}`);
  }
}

// 导出工具类和模板
export { I18nCompletionTool };

// 工作流翻译模板
export const workflowTranslationTemplate = {
  "workflow": {
    "status": {
      "running": "运行中",
      "completed": "已完成",
      "failed": "失败",
      "paused": "已暂停",
      "cancelled": "已取消"
    },
    "actions": {
      "start": "启动工作流",
      "pause": "暂停工作流",
      "resume": "恢复工作流",
      "cancel": "取消工作流",
      "retry": "重试工作流"
    },
    "steps": {
      "initialization": "初始化",
      "data_processing": "数据处理",
      "analysis": "分析",
      "validation": "验证",
      "completion": "完成"
    }
  }
};

// 错误处理翻译模板
export const errorHandlerTranslationTemplate = {
  "error_handler": {
    "types": {
      "llm_timeout": "LLM超时",
      "llm_parsing_failed": "LLM解析失败",
      "database_connection_lost": "数据库连接丢失",
      "vector_dimension_mismatch": "向量维度不匹配",
      "concurrency_conflict": "并发冲突",
      "network_error": "网络错误",
      "resource_exhausted": "资源耗尽",
      "validation_failed": "验证失败",
      "unknown_error": "未知错误"
    },
    "recovery": {
      "retry": "重试",
      "fallback": "回退",
      "skip": "跳过",
      "abort": "中止"
    },
    "messages": {
      "circuit_breaker_open": "熔断器已打开，跳过执行",
      "max_retry_exceeded": "超过最大重试次数",
      "fallback_strategy_used": "使用回退策略",
      "workflow_aborted": "工作流已中止"
    }
  }
};

// 性能优化翻译模板
export const performanceTranslationTemplate = {
  "performance": {
    "cache": {
      "hit_rate": "缓存命中率",
      "miss_rate": "缓存未命中率",
      "size": "缓存大小",
      "clear": "清空缓存"
    },
    "vector_search": {
      "similarity_threshold": "相似度阈值",
      "search_time": "搜索时间",
      "index_size": "索引大小",
      "dimension_validation": "维度验证",
      "simd_acceleration": "SIMD加速"
    },
    "concurrency": {
      "read_write_optimization": "读写优化",
      "connection_pool": "连接池",
      "parallel_processing": "并行处理",
      "thread_safety": "线程安全"
    }
  }
};

// 使用示例
// 注释掉以下代码，因为这是一个 Node.js 工具脚本，不应在前端环境中运行
/*
if (require.main === module) {
  const tool = new I18nCompletionTool();
  
  // 生成报告
  console.log(tool.generateReport());
  
  // 创建新的翻译文件
  tool.createTranslationTemplate('workflow.json', workflowTranslationTemplate);
  tool.createTranslationTemplate('error_handler.json', errorHandlerTranslationTemplate);
  tool.createTranslationTemplate('performance.json', performanceTranslationTemplate);
  
  // 自动补全缺失翻译
  tool.autoComplete();
  
  console.log('\n✅ 国际化文本补全完成！');
}
*/