/**
 * 增强的字段类型系统
 * 支持更复杂的数据结构和验证规则
 */

// 扩展的字段类型枚举
// 注意：只保留 Anki 支持的字段类型
export enum EnhancedFieldType {
  // Anki 支持的基础类型
  Text = 'Text',              // 纯文本字段
  Array = 'Array',            // 数组（会被转换为逗号分隔的文本）
  Number = 'Number',          // 数字（会被转换为文本）
  Boolean = 'Boolean',        // 布尔值（会被转换为文本）
  
  // 保留但会降级为文本的类型
  Date = 'Date',              // 日期时间（会被格式化为文本）
  RichText = 'RichText',      // 富文本（会被转换为纯文本或简单HTML）
  Formula = 'Formula',        // 数学公式（LaTeX格式的文本）
  
  // 已废弃：Anki 不支持的复杂类型
  // Object = 'Object',           // 对象类型 - 已移除
  // ArrayObject = 'ArrayObject', // 对象数组 - 已移除
  // Code = 'Code',              // 代码块 - 已移除
  // Media = 'Media',            // 媒体引用 - 已移除
  // Reference = 'Reference',    // 卡片引用 - 已移除
  // Computed = 'Computed'       // 计算字段 - 已移除
}

// 对象结构定义
export interface ObjectSchema {
  properties: Record<string, EnhancedFieldExtractionRule>;
  required?: string[];
}

// 验证规则
export interface ValidationRule {
  pattern?: string;           // 正则表达式
  min?: number;              // 最小值（数字或长度）
  max?: number;              // 最大值（数字或长度）
  enum?: any[];              // 枚举值
  custom?: string;           // 自定义验证函数名
  error_message?: string;    // 自定义错误消息
}

// 转换规则
export interface TransformRule {
  type: 'uppercase' | 'lowercase' | 'capitalize' | 'trim' | 'date_format' | 'custom';
  format?: string;           // 用于date_format
  custom_function?: string;  // 自定义转换函数名
}

// 增强的字段提取规则
export interface EnhancedFieldExtractionRule {
  field_type: EnhancedFieldType;
  is_required: boolean;
  default_value: any;
  description: string;
  
  // 新增配置选项
  schema?: ObjectSchema;              // Object类型的结构定义
  item_schema?: ObjectSchema;         // ArrayObject的项目结构
  validation?: ValidationRule;        // 验证规则
  transform?: TransformRule;          // 转换规则
  display_format?: string;            // 显示格式模板
  ai_hint?: string;                  // AI生成提示
  max_length?: number;               // 最大长度限制
  min_length?: number;               // 最小长度限制
  allowed_values?: any[];            // 允许的值列表
  depends_on?: string;               // 依赖的其他字段
  compute_function?: string;         // 计算函数（用于Computed类型）
}

// 代码字段的结构
export interface CodeFieldStructure {
  language: string;
  code: string;
  explanation?: string;
  runnable?: boolean;
}

// 媒体字段的结构
export interface MediaFieldStructure {
  type: 'image' | 'audio' | 'video';
  url: string;
  alt_text?: string;
  duration?: number; // 音频/视频时长（秒）
  thumbnail?: string; // 视频缩略图
}

// 富文本字段的结构
export interface RichTextFieldStructure {
  format: 'markdown' | 'html' | 'plain';
  content: string;
  attachments?: string[]; // 附件URL列表
}

// 字段值的类型定义
export type FieldValue = 
  | string 
  | number 
  | boolean 
  | any[] 
  | Record<string, any>
  | Date
  | CodeFieldStructure
  | MediaFieldStructure
  | RichTextFieldStructure;

// 模板复杂度级别
export enum ComplexityLevel {
  Simple = 'simple',
  Moderate = 'moderate',
  Complex = 'complex',
  VeryComplex = 'very_complex'
}

// 模板复杂度报告
export interface ComplexityReport {
  score: number;                    // 0-100
  level: ComplexityLevel;
  issues: ComplexityIssue[];
  suggestions: string[];
  estimated_success_rate: number;   // 0-1
  recommended_downgrade?: boolean;
}

// 复杂度问题
export interface ComplexityIssue {
  type: 'deep_nesting' | 'too_many_fields' | 'complex_types' | 'circular_dependency' | 'performance_risk';
  severity: 'low' | 'medium' | 'high';
  field?: string;
  message: string;
}

// 降级结果
export interface DowngradedResult {
  success: boolean;
  data: any;
  warnings?: string[];
  original?: any;
  transformations_applied?: string[];
}

// 字段渲染配置
export interface FieldRenderConfig {
  renderer: 'default' | 'custom' | 'component';
  custom_renderer?: string;      // 自定义渲染函数名
  component_name?: string;       // React组件名
  props?: Record<string, any>;   // 传递给渲染器的属性
}

// 验证结果
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings?: string[];
}

// 验证错误
export interface ValidationError {
  field: string;
  rule: string;
  message: string;
  received_value?: any;
  expected_type?: string;
}

// AI生成配置
export interface AIGenerationConfig {
  example_json: Record<string, any>;
  constraints: string[];
  common_mistakes: string[];
  best_practices: string[];
  max_attempts?: number;
}

// 模板验证器接口
export interface ITemplateValidator {
  validateFieldNames(fields: string[]): ValidationResult;
  validateFieldTypes(rules: Record<string, EnhancedFieldExtractionRule>): ValidationResult;
  validateDependencies(rules: Record<string, EnhancedFieldExtractionRule>): ValidationResult;
  validateAIOutput(output: any, template: any): ValidationResult;
}

// 字段处理器接口
export interface IFieldProcessor {
  canProcess(fieldType: EnhancedFieldType): boolean;
  process(value: any, rule: EnhancedFieldExtractionRule): Promise<FieldValue>;
  validate(value: any, rule: EnhancedFieldExtractionRule): ValidationResult;
  render(value: FieldValue, config?: FieldRenderConfig): string;
}

// 导出便捷函数
export function isComplexFieldType(type: EnhancedFieldType): boolean {
  // 在新的系统中，没有真正的复杂类型了
  // 所有类型都能被 Anki 处理（通过转换为文本）
  return false;
}

export function requiresSchema(type: EnhancedFieldType): boolean {
  // 没有类型需要 schema 了
  return false;
}

export function supportsValidation(type: EnhancedFieldType): boolean {
  // 所有类型都支持验证
  return true;
}