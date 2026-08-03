/**
 * CSV 表头别名：用于自动推断列 → 题目字段映射。
 * 同时包含中英文常见列名，与界面语言无关（匹配用户 CSV 文件本身的表头）。
 */

export type CsvQuestionFieldKey =
  | 'content'
  | 'question_type'
  | 'options'
  | 'answer'
  | 'explanation'
  | 'difficulty'
  | 'tags'
  | 'images'
  | 'question_label';

/** Exact header → field (lowercase trim applied by caller). */
export const CSV_HEADER_EXACT_ALIASES: Record<string, CsvQuestionFieldKey> = {
  // content
  题目: 'content',
  题干: 'content',
  问题: 'content',
  内容: 'content',
  content: 'content',
  question: 'content',
  text: 'content',
  // answer
  答案: 'answer',
  正确答案: 'answer',
  answer: 'answer',
  correct: 'answer',
  // explanation
  解析: 'explanation',
  解答: 'explanation',
  说明: 'explanation',
  explanation: 'explanation',
  analysis: 'explanation',
  // options
  选项: 'options',
  options: 'options',
  choices: 'options',
  // difficulty
  难度: 'difficulty',
  difficulty: 'difficulty',
  level: 'difficulty',
  // tags
  标签: 'tags',
  分类: 'tags',
  类别: 'tags',
  tags: 'tags',
  category: 'tags',
  // images
  图片: 'images',
  配图: 'images',
  图像: 'images',
  images: 'images',
  image: 'images',
  // question_type
  题型: 'question_type',
  类型: 'question_type',
  type: 'question_type',
  question_type: 'question_type',
  // question_label
  题号: 'question_label',
  序号: 'question_label',
  label: 'question_label',
  number: 'question_label',
  no: 'question_label',
};

/** Regex patterns for fuzzy header matching (order matters). */
export const CSV_HEADER_FUZZY_PATTERNS: Array<{
  pattern: RegExp;
  field: CsvQuestionFieldKey;
}> = [
  { pattern: /题目|题干|内容|content|question|text/, field: 'content' },
  { pattern: /答案|正确|answer|correct/, field: 'answer' },
  { pattern: /解析|解答|说明|explanation|analysis/, field: 'explanation' },
  { pattern: /选项|options|choices/, field: 'options' },
  { pattern: /难度|difficulty|level/, field: 'difficulty' },
  { pattern: /标签|分类|tags|category/, field: 'tags' },
  { pattern: /图片|配图|图像|images?|image/, field: 'images' },
  { pattern: /题型|类型|type|question_type/, field: 'question_type' },
  { pattern: /题号|序号|label|number|no/, field: 'question_label' },
];

export function suggestCsvFieldFromHeader(header: string): CsvQuestionFieldKey | '' {
  const headerLower = header.toLowerCase().trim();
  return CSV_HEADER_EXACT_ALIASES[headerLower] || '';
}

export function inferCsvFieldFromHeader(header: string): CsvQuestionFieldKey | '' {
  const headerLower = header.toLowerCase().trim();
  const exact = CSV_HEADER_EXACT_ALIASES[headerLower];
  if (exact) return exact;
  for (const { pattern, field } of CSV_HEADER_FUZZY_PATTERNS) {
    if (pattern.test(headerLower)) return field;
  }
  return '';
}
