import type { QbankGenerationRequest } from '../api.ts';

/** dstu-learning/src/study_loop/media_source.rs:30-33, used by qbank_generation/types.rs:313-315. */
export const MEDIA_QUESTION_REQUIREMENTS = `## 音视频课程出处要求
参考资料含音视频转写（每行 [mm:ss] 为该句开始时间，片段标题含 [媒体@资源ID:时间] 锚点）：
- 每题 explanation 末尾另起一行写依据出处 [媒体@资源ID:mm:ss]（资源 ID 取所在片段标题，时间取依据所在行，≥1 小时写 h:mm:ss），不得编造。
- 题目必须基于课程实际讲到的内容；「上文回顾」引用块只帮助理解语境，不要单独据此出题；不同片段重复讲到的知识点只出一次。

`;

interface GenerationSource {
  source_id?: unknown;
  name?: unknown;
  format?: unknown;
  page_count?: unknown;
}

const text = (value: unknown) => typeof value === 'string' ? value : '';

// qbank_generation/types.rs:220-322
export function buildGenerationInstructions(examName: string, existingSamples: string[],
  request: QbankGenerationRequest, sources: GenerationSource[], hasMediaAnchors: boolean): string {
  const language = request.language ?? 'zh-CN';
  let prompt = `## 题目集\n「${examName}」\n\n`;

  if (request.specs?.length) {
    prompt += '## 题型分布\n';
    for (const spec of request.specs) {
      const difficulty = spec.difficulty ?? request.difficulty ?? '由你按难度梯度合理分布';
      prompt += `- ${spec.question_type}: ${spec.count} 题（难度：${difficulty}）\n`;
    }
    prompt += '\n';
  } else {
    const difficulty = request.difficulty ?? '由你按难度梯度合理分布';
    prompt += `## 题量与难度\n- 总共 ${request.max_questions ?? 10} 题（难度：${difficulty}），题型由你根据知识点合理搭配\n\n`;
  }

  const knowledgePoints = (request.knowledge_points ?? []).map(point => point.trim()).filter(Boolean);
  if (knowledgePoints.length) {
    prompt += '## 知识点范围（围绕这些知识点出题）\n';
    for (const point of knowledgePoints) prompt += `- ${point}\n`;
    prompt += '\n';
  }

  const hint = request.topic_hint?.trim();
  if (hint) prompt += `## 知识点范围要求\n${hint}\n\n`;

  if (request.based_on_existing && existingSamples.length) {
    prompt += '## 现有题目样本（请出与之风格相近、不重复的变式题）\n';
    existingSamples.forEach((sample, index) => {
      prompt += `${index + 1}. ${sample}\n`;
    });
    prompt += '\n';
  }

  if (!sources.length) {
    prompt += '## 参考资料\n本次没有参考文件，请仅依据题目集信息与知识点要求命题。\n\n';
  } else {
    prompt += '## 参考资料清单（完整正文/页图随后提供）\n';
    for (const source of sources) {
      const pages = typeof source.page_count === 'number' && Number.isInteger(source.page_count) && source.page_count >= 0
        ? String(source.page_count) : '无分页';
      prompt += `- source_id=${text(source.source_id)} name=${text(source.name)} format=${text(source.format)} pages=${pages}\n`;
    }
    prompt += '请完整阅读后续全部来源。题干不得直接抄袭原文成句；不得只处理前几页或截断长文。\n\n';
  }

  if (hasMediaAnchors) prompt += MEDIA_QUESTION_REQUIREMENTS;

  prompt += `## 输出语言\n题目使用 ${language}。现在请生成题目，只输出一个 QuestionDocument JSON 根对象。\n`;
  return prompt;
}
