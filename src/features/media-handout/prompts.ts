/**
 * 讲义流水线提示词（帧说明 / 分块摘要 / 大纲 / 分节 IR）。
 *
 * Adapted from wangke-agent `src/harness/prompts.ts`
 * (https://github.com/BA7MLV/wangke-agent).
 * MIT License — Copyright (c) 2026 BA7MLV. Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated
 * documentation files, to deal in the Software without restriction, subject to the
 * condition that the above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software. THE SOFTWARE IS
 * PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */

export type HandoutLang = 'zh' | 'en';

/** VLM 输出首行的判定标记（中英两套提示词共用，便于解析） */
export const FRAME_TYPE_TEACHING = 'TYPE: TEACHING';
export const FRAME_TYPE_NONE = 'TYPE: NONE';

export function frameCaptionPrompt(lang: HandoutLang): string {
  return lang === 'zh'
    ? `这是一段课程视频中的一帧画面。请判断：
- 如果是幻灯片、板书、代码、图表、公式等教学内容：第一行输出"${FRAME_TYPE_TEACHING}"，第二行起提取画面中的标题和关键文字，并用一句话概括画面内容（总共不超过 100 字）。
- 如果是讲师人像、片头片尾、过渡动画或无信息画面：只输出"${FRAME_TYPE_NONE}"。`
    : `This is a frame from a lecture video. Decide:
- If it shows teaching content (slides, blackboard, code, charts, formulas): output "${FRAME_TYPE_TEACHING}" on the first line, then the title and key text visible in the frame and a one-sentence summary (under 60 words total).
- If it shows only the speaker, an intro/outro, a transition or nothing informative: output only "${FRAME_TYPE_NONE}".`;
}

/** 解析 VLM 帧说明：返回 {isTeaching, caption}；无法判定时宽容地按教学画面处理 */
export function parseFrameCaption(raw: string, fallbackCaption: string): { isTeaching: boolean; caption: string } {
  const text = raw.trim();
  const upper = text.toUpperCase();
  if (upper.includes(FRAME_TYPE_NONE) || /类型[:：]\s*无/.test(text)) {
    return { isTeaching: false, caption: '' };
  }
  const caption = text
    .split('\n')
    .filter((l) => !l.toUpperCase().includes('TYPE:') && !/^类型[:：]/.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return { isTeaching: caption.length > 4, caption: caption || fallbackCaption };
}

export function chunkSummaryPrompt(chunk: string, lang: HandoutLang): string {
  return lang === 'zh'
    ? `以下是课程字幕转写的一部分（行首为时间戳）。请提取这部分的知识要点，每条一行，格式为"[mm:ss] 要点"（时间取该要点首次出现的时间戳），保留关键术语、定义、步骤。每条必须是具体内容，不写"本段讲了……"一类概括。只输出要点列表。

${chunk}`
    : `Below is part of a lecture transcript (each line starts with a timestamp). Extract the key points of this part, one per line, formatted as "[mm:ss] point" (use the timestamp where the point first appears). Keep key terms, definitions and steps. Each point must be concrete — never write "this part talks about...". Output only the list.

${chunk}`;
}

export function outlinePrompt(material: string, mediaName: string, lang: HandoutLang): string {
  return lang === 'zh'
    ? `请根据以下课程字幕内容（含时间戳），为《${mediaName}》设计一份学习讲义的大纲。

要求：
1. 提炼一个正式的讲义标题：名词性短语，直接点明主题。
2. 写一段课程概述（120 字以内）：直接陈述讲授的对象、内容与结论，不复述讲授流程。
3. 划分 4~10 个章节（最多 12 个），每个章节给出：章节标题（名词性短语）、该章节覆盖的时间范围（开始和结束的 mm:ss，超过 1 小时用 h:mm:ss）、3~5 个学习要点（具体陈述，不是栏目名）。
4. 章节按时间顺序排列，覆盖全部主要内容，不遗漏、不重复。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{"title":"讲义标题","summary":"课程概述","sections":[{"heading":"章节标题","start":"mm:ss","end":"mm:ss","points":["要点1","要点2"]}]}

字幕内容：
${material}`
    : `Based on the lecture transcript below (with timestamps), design the outline of a study handout for "${mediaName}".

Requirements:
1. A formal handout title: a noun phrase naming the topic.
2. A course summary (under 80 words) stating what is taught and the conclusions; do not narrate the lecture flow.
3. 4–10 sections (at most 12). For each: a heading (noun phrase), the time range it covers (start and end as mm:ss, or h:mm:ss past one hour), and 3–5 concrete learning points.
4. Sections in chronological order, covering all main content without gaps or overlap.

Output strictly this JSON and nothing else:
{"title":"...","summary":"...","sections":[{"heading":"...","start":"mm:ss","end":"mm:ss","points":["...","..."]}]}

Transcript:
${material}`;
}

export function sectionPrompt(
  args: {
    heading: string;
    points: string[];
    transcript: string;
    frameNotes: string;
    title: string;
    summary: string;
  },
  lang: HandoutLang,
): string {
  const { heading, points, transcript, frameNotes, title, summary } = args;
  if (lang === 'zh') {
    return `请为讲义《${title}》撰写「${heading}」一节的正文。
${summary ? `\n课程概述：${summary}\n` : ''}
该节学习要点：
${points.map((p) => `- ${p}`).join('\n')}

该节对应的字幕原文（含时间戳）：
${transcript}
${frameNotes ? `\n该节可用的配图（截图）信息：\n${frameNotes}\n` : ''}
【输出契约（必须严格遵守）】
只输出一个 JSON 对象，不要输出任何其他内容：
{"blocks": [ 块, 块, ... ]}

可用块类型：
- {"type":"lead","text":"……"}：节首主旨段。必须是第一个块，且全节只有一个。
- {"type":"para","text":"……"}：正文段。
- {"type":"h2","text":"小节标题"}：名词性短语，不写编号。
- {"type":"list","ordered":true,"items":["……","……"]}：条目；ordered 为 false 表示无序。items 里不要写序号。
- {"type":"table","caption":"表名","header":["列1","列2"],"rows":[["……","……"]]}：仅用于真实的对比，不超过 4 列，每行单元格数必须与 header 一致。
- {"type":"figure","time":"mm:ss","caption":"图名"}：插入配图，time 必须从上方配图信息中原样复制；没有合适配图则不写。
- {"type":"note","text":"……"}：注意或提示，全节最多一处。

【写作要求】
1. 正式书面语，准确、简洁。text 中禁止使用 Markdown 符号（不写 **、##、-、> 等）。
2. 内容必须来自上方字幕原文，术语与原文一致；原文没有的内容不写。
3. 正文总量一般 200~500 字，不凑字数。`;
  }
  return `Write the body of the section "${heading}" for the handout "${title}".
${summary ? `\nCourse summary: ${summary}\n` : ''}
Learning points of this section:
${points.map((p) => `- ${p}`).join('\n')}

Transcript of this section (with timestamps):
${transcript}
${frameNotes ? `\nFigures (screenshots) available for this section:\n${frameNotes}\n` : ''}
[OUTPUT CONTRACT — follow strictly]
Output a single JSON object and nothing else:
{"blocks": [ block, block, ... ]}

Block types:
- {"type":"lead","text":"..."}: the section's key-idea paragraph. Must be the first block; exactly one per section.
- {"type":"para","text":"..."}: body paragraph.
- {"type":"h2","text":"Subheading"}: noun phrase, no numbering.
- {"type":"list","ordered":true,"items":["...","..."]}: list; ordered=false for bullets. No numbers inside items.
- {"type":"table","caption":"Table name","header":["Col1","Col2"],"rows":[["...","..."]]}: only for real comparisons, at most 4 columns, every row must have as many cells as header.
- {"type":"figure","time":"mm:ss","caption":"Figure name"}: insert a figure; time must be copied verbatim from the figure list above; omit if none fits.
- {"type":"note","text":"..."}: a caution or tip, at most one per section.

[WRITING RULES]
1. Formal, precise, concise prose. No Markdown symbols inside text (no **, ##, -, >).
2. Content must come from the transcript above, using its terminology; add nothing it does not say.
3. Usually 150–400 words in total; do not pad.`;
}
