/**
 * 课程学习（音视频网课）Skill
 *
 * 媒体学习闭环的「课程问答 / 制卡 / 出题」话术（docs/dev/media-learning/README.md §3）。
 * 按需技能：只在 load_skills 加载后注入，不占每轮上下文；不新增工具，
 * 复用 knowledge-retrieval（unified_search）与 learning-resource（resource_read）。
 *
 * 检索纪律与「以图为准」规则的思路借鉴 BA7MLV/wangke-agent 的问答提示词
 * （src/harness/prompts.ts，MIT License, Copyright (c) 2026 BA7MLV）。
 */

import type { SkillDefinition } from '../types';
import { SKILL_DEFAULT_PRIORITY } from '../types';

export const COURSE_STUDY_SKILL_ID = 'course-study';

export const courseStudySkill: SkillDefinition = {
  id: COURSE_STUDY_SKILL_ID,
  name: '课程学习',
  description:
    '音视频课程（网课录播、讲座、播客、课堂录音）学习助手：基于带时间戳的转写字幕检索作答并给出可跳转的 [媒体@…] 时间引用，按讲到的时刻制卡、出题。当用户针对已导入的音频/视频提问、要求复习某节课、或让你根据视频制卡出题时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  location: 'builtin',
  sourcePath: 'builtin://course-study',
  priority: SKILL_DEFAULT_PRIORITY,
  disableAutoInvoke: false,
  isBuiltin: true,
  skillType: 'composite',
  dependencies: ['knowledge-retrieval', 'learning-resource'],
  relatedSkills: ['knowledge-retrieval', 'learning-resource', 'media-tools', 'chatanki', 'qbank-tools'],
  allowedTools: [
    'builtin-unified_search',
    'builtin-resource_read',
    'builtin-resource_list',
    'builtin-media_transcribe',
    'builtin-chatanki_run',
    'builtin-qbank_generate_questions',
  ],
  content: `# 媒体课程学习

音视频是资源库里的 \`file_*\` 文件，转写字幕每段自带时间（\`[mm:ss] 文本\`）。

## 检索纪律
1. 先 \`builtin-unified_search\`，\`resource_ids\` 填该课程的 file id，**query 传关键词或短语，不要传整句问题**。
2. 没命中就换说法或更短的词再搜（怀疑原文用词不同时两种都搜，如「正则化」与「惩罚项」）。2~4 次足够，严禁连续多轮只检索不作答。
3. 需要上下文时 \`builtin-resource_read\` 带 \`time_start\`/\`time_end\`（秒，单次 ≤ 600）按时间段读原文，不要整份读长课。
4. 资源尚无转写（读不到带时间的文本）时，告诉用户需先转写（预览页「转写」或加载 media-tools）；不要凭常识假装课程讲过。

## 回答
- 只基于字幕作答；字幕没讲的明确说「课程中未提及」。
- 引用具体内容时句末标注 \`[媒体@{resource_id}:{mm:ss}]\`（≥1 小时用 \`h:mm:ss\`），时间必须来自检索/读取结果，用户可点击跳转。
- 用户附了截图（视频画面）时**以图为准**：先按画面作答再用字幕补充；冲突时以截图为准，看不清就说看不清。

## 制卡 / 出题
- 制卡：\`builtin-chatanki_run\` 传 \`resourceId\`（转写自动作为材料，系统会按约 10 分钟分片并注入时间锚点）。
- 出题：\`builtin-qbank_generate_questions\` 传 \`reference_file_ids\`。
- 两者生成的卡片背面 / 题目解析末尾都应带 \`[媒体@…]\` 出处；一卡一事实、问题自包含，跨片段重复的知识点只出一次。
`,
};
