import { extractMustachePlaceholders } from './templateValidation';

export function analyzeTemplateError(rawContent: string, backendError?: string): string {
  try {
    const reasons: string[] = [];
    const content = (rawContent || '').trim();

    if (!content) {
      return backendError || 'AI 未返回任何内容';
    }

    const noFence = stripCodeFences(content);

    // 常见结构性误用快速提示
    if (/"preview_data_json"\s*:\s*\{/.test(noFence)) {
      reasons.push('preview_data_json 必须是字符串（需要整体转义），而不是对象');
    }

    const candidate = extractJsonCandidate(noFence);
    if (!candidate) {
      reasons.push('未找到完整的 JSON 对象（缺少起始/结束花括号）');
      return format(reasons, backendError);
    }

    let obj: any;
    try {
      obj = JSON.parse(candidate);
    } catch (e: any) {
      reasons.push(`JSON 语法错误: ${e?.message || String(e)}`);
      // 特例：未转义的双引号
      if (/preview_data_json/.test(candidate) && /\"/.test(candidate) === false) {
        reasons.push('preview_data_json 可能未转义内层引号，应为字符串且内部双引号需转义');
      }
      return format(reasons, backendError);
    }

    // 顶层必需字段检查
    const requiredTop = [
      'name',
      'description',
      'note_type',
      'fields',
      'front_template',
      'back_template',
      'css_style',
      'generation_prompt',
      'preview_front',
      'preview_back',
    ];
    for (const key of requiredTop) {
      if (!(key in obj)) {
        reasons.push(`缺少必需字段: ${key}`);
      }
    }

    // 字段与 Mustache 一致性
    if (Array.isArray(obj?.fields)) {
      const fields: string[] = obj.fields || [];
      const placeholders = extractMustachePlaceholders(String(obj.front_template || '') + ' ' + String(obj.back_template || ''));
      const fieldSet = new Set(fields.map((s) => String(s)));
      const unknown = Array.from(placeholders).filter(
        (p) => !fieldSet.has(p) && p.toLowerCase() !== 'frontside'
      );
      if (unknown.length > 0) {
        reasons.push(`发现未在 fields 中定义的占位符: ${unknown.join(', ')}`);
      }
    } else {
      reasons.push('fields 必须是字符串数组');
    }

    // note_type 基础规则
    if (typeof obj?.note_type === 'string') {
      const nt = obj.note_type as string;
      if (nt.startsWith('Basic')) {
        if (!includesCaseInsensitive(obj.fields, 'Front') || !includesCaseInsensitive(obj.fields, 'Back')) {
          reasons.push('Basic 模板必须包含 Front 与 Back 字段（大小写严格）');
        }
      }
      if (nt === 'Cloze') {
        if (!includesCaseInsensitive(obj.fields, 'Text')) {
          reasons.push('Cloze 模板建议包含 Text 字段');
        }
        const front = String(obj.front_template || '');
        const back = String(obj.back_template || '');
        if (!/\{\{\s*cloze:Text\s*\}\}/.test(front + back)) {
          reasons.push('Cloze 模板中未检测到 {{cloze:Text}} 占位符');
        }
      }
    }

    // field_extraction_rules 覆盖检查
    if (obj?.fields && typeof obj.field_extraction_rules === 'object' && obj.field_extraction_rules !== null) {
      const fields: string[] = obj.fields;
      const rules = obj.field_extraction_rules as Record<string, unknown>;
      const missing = fields.filter((f) => !(f in rules));
      if (missing.length > 0) {
        reasons.push(`field_extraction_rules 缺少字段: ${missing.join(', ')}`);
      }
    }

    // preview_data_json 解析
    if (typeof obj?.preview_data_json === 'string' && obj.preview_data_json.trim().length > 0) {
      try {
        JSON.parse(obj.preview_data_json);
      } catch (e: any) {
        reasons.push(`preview_data_json 不是有效 JSON 字符串: ${e?.message || String(e)}`);
      }
    }

    return format(reasons, backendError);
  } catch (e: any) {
    return backendError || `解析失败：${e?.message || String(e)}`;
  }
}

function stripCodeFences(s: string): string {
  return s
    .replace(/```+\s*json\s*/gi, '')
    .replace(/```+/g, '')
    .trim();
}

function extractJsonCandidate(s: string): string | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return null;
}

function includesCaseInsensitive(arr: string[], key: string): boolean {
  return Array.isArray(arr) && arr.some((s) => String(s).toLowerCase() === key.toLowerCase());
}

function format(reasons: string[], backendError?: string): string {
  const uniq = Array.from(new Set(reasons.filter(Boolean)));
  if (uniq.length === 0) return backendError || '无法从 AI 响应中提取有效的模板 JSON';
  return `无法解析的原因：` + uniq.map((r, i) => `(${i + 1}) ${r}`).join('；');
}


