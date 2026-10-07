/**
 * 把「原文 + 批注列表 + 评分 + 润色 + 范文」拼成后端 grading_result 的 wire 格式
 * （<del>/<ins>/<replace/>/<note>/<good>/<err> 内嵌原文，末尾 <section-polish>、<section-model-essay>、<score>）。
 * 每条批注按原文片段的第一次出现定位，找不到就抛错——剧本写错时开发期立刻暴露。
 */
export type Annotation =
  | { kind: 'del'; text: string; reason: string }
  | { kind: 'ins'; after: string; text: string }
  | { kind: 'replace'; text: string; to: string; reason: string }
  | { kind: 'note'; text: string; comment: string }
  | { kind: 'good'; text: string }
  | { kind: 'err'; type: string; text: string; explanation: string };

export interface ScoreSpec {
  total: number;
  max: number;
  dims: { name: string; score: number; max: number; comment: string }[];
}

const attr = (v: string) => v.replace(/"/g, '「');

function markup(a: Annotation): string {
  switch (a.kind) {
    case 'del': return `<del reason="${attr(a.reason)}">${a.text}</del>`;
    case 'ins': return `${a.after}<ins>${a.text}</ins>`;
    case 'replace': return `<replace old="${attr(a.text)}" new="${attr(a.to)}" reason="${attr(a.reason)}"/>`;
    case 'note': return `<note text="${attr(a.comment)}">${a.text}</note>`;
    case 'good': return `<good>${a.text}</good>`;
    case 'err': return `<err type="${a.type}" explanation="${attr(a.explanation)}">${a.text}</err>`;
  }
}

export function buildGradingResult(
  essay: string,
  annotations: Annotation[],
  score: ScoreSpec,
  polish: { original: string; polished: string }[],
  modelEssay: string,
): string {
  // 先按位置定位所有片段，再从后往前替换，避免前面插入的标记影响后面的定位
  const located = annotations.map((a) => {
    const anchor = a.kind === 'ins' ? a.after : a.text;
    const index = essay.indexOf(anchor);
    if (index < 0) throw new Error(`[essay demo] annotation anchor not found: ${anchor}`);
    return { a, index, length: anchor.length };
  });
  located.sort((x, y) => y.index - x.index);
  let body = essay;
  for (const { a, index, length } of located) {
    body = body.slice(0, index) + markup(a) + body.slice(index + length);
  }
  const polishXml = polish
    .map((p) => `<polish-item><original>${p.original}</original><polished>${p.polished}</polished></polish-item>`)
    .join('\n');
  const dims = score.dims
    .map((d) => `<dim name="${attr(d.name)}" score="${d.score}" max="${d.max}">${d.comment}</dim>`)
    .join('\n');
  return [
    body,
    `<section-polish>\n${polishXml}\n</section-polish>`,
    `<section-model-essay>\n${modelEssay}\n</section-model-essay>`,
    `<score total="${score.total}" max="${score.max}">\n${dims}\n</score>`,
  ].join('\n\n');
}

/** 后端 ParsedScore 的序列化（rounds.dimension_scores_json） */
export function dimensionScoresJson(score: ScoreSpec): string {
  const pct = (score.total / score.max) * 100;
  const grade = pct >= 90 ? '优秀' : pct >= 75 ? '良好' : pct >= 60 ? '及格' : '不及格';
  return JSON.stringify({
    total: score.total,
    max_total: score.max,
    grade,
    dimensions: score.dims.map((d) => ({ name: d.name, score: d.score, max_score: d.max, comment: d.comment })),
  });
}
