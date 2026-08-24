/**
 * Style Lab — HpiasStore 研究事件模拟序列
 */
import type { HpiasEvent } from '@/stores/researchStore';

export const STYLE_LAB_HPIAS_SESSION_ID = 'style-lab-hpias-demo';

export const STYLE_LAB_HPIAS_DEMO_QUESTION =
  '深度学习在医学影像诊断中的最新进展？';

/** 按时间线推送的演示事件（plan → retrieval → subagents → synthesis） */
export function buildStyleLabHpiasDemoTimeline(): HpiasEvent[] {
  return [
    {
      type: 'session_started',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      question: STYLE_LAB_HPIAS_DEMO_QUESTION,
      options_json: JSON.stringify({ execution_mode: 'autonomous' }),
    },
    { type: 'round_started', session_id: STYLE_LAB_HPIAS_SESSION_ID, round: 1 },
    {
      type: 'plan_generated',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      plan: {
        core: {
          queries: [
            '2024-2026 医学影像深度学习综述',
            'FDA 批准的 AI 影像诊断产品',
          ],
        },
      },
    },
    {
      type: 'retrieval_completed',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      fetched: 42,
    },
    {
      type: 'selection_completed',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      selected: 12,
      citations: { items: [] },
    },
    {
      type: 'subagent_started',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      sub_id: 1,
      query: '2024-2026 医学影像深度学习综述',
    },
    {
      type: 'subagent_completed',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      sub_id: 1,
      steps: 3,
      summary_md: '发现 Transformer 架构在 CT/MRI 分割任务上 SOTA 占比上升。',
      citations: [['paper-1', 1]],
    },
    {
      type: 'subagent_started',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      sub_id: 2,
      query: 'FDA 批准的 AI 影像诊断产品',
    },
    {
      type: 'synthesis_updated',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      synthesis:
        '## 综合结论\n\n深度学习在医学影像领域持续向 **多模态融合** 与 **可解释性** 演进 [review-1]。',
    },
    {
      type: 'subagent_completed',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      sub_id: 2,
      steps: 2,
      summary_md: 'FDA 已批准多款 CADe/CADx 产品用于乳腺与肺结节筛查。',
      citations: [['reg-2', 1]],
    },
    {
      type: 'subagents_done',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
      metrics: { completed: 2 },
      sub_reports: [],
    },
    {
      type: 'session_completed',
      session_id: STYLE_LAB_HPIAS_SESSION_ID,
      round: 1,
    },
  ];
}

/** 按间隔推送演示事件；返回 cancel 函数 */
export function playStyleLabHpiasDemo(
  handleEvent: (event: HpiasEvent) => void,
  intervalMs = 400,
): () => void {
  const timeline = buildStyleLabHpiasDemoTimeline();
  let index = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const schedule = () => {
    if (index >= timeline.length) return;
    const event = timeline[index]!;
    index += 1;
    handleEvent(event);
    timers.push(setTimeout(schedule, intervalMs));
  };

  schedule();
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
  };
}
