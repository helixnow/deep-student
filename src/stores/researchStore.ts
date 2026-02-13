import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { t } from '../utils/i18n';

export type HpiasEvent =
  | { type: 'session_started'; session_id: string; question: string; options_json?: string | null; ts?: string }
  | { type: 'round_started'; session_id: string; round: number; ts?: string }
  | { type: 'round_executing'; session_id: string; round: number; ts?: string }
  | { type: 'plan_pending_approval'; session_id: string; round: number; plan: any; ts?: string }
  | { type: 'plan_generated'; session_id: string; round: number; plan: any; ts?: string }
  | { type: 'retrieval_completed'; session_id: string; round: number; fetched: number; ts?: string }
  | { type: 'selection_completed'; session_id: string; round: number; selected: number; citations?: any; ts?: string }
  | { type: 'round_metrics'; session_id: string; round: number; metrics: any; ts?: string }
  | { type: 'queries_prepared'; session_id: string; round: number; queries: string[]; ts?: string }
  | { type: 'candidate_ranking_started'; session_id: string; round: number; candidate_count: number; ts?: string }
  | { type: 'dedupe_completed'; session_id: string; round: number; before: number; after: number; removed: number; ts?: string }
  | { type: 'per_doc_cap_applied'; session_id: string; round: number; cap: number; before: number; after: number; ts?: string }
  | { type: 'keyword_filter_applied'; session_id: string; round: number; keywords: string[]; hits_needed: number; before: number; after: number; ts?: string }
  | { type: 'filter_short_text_applied'; session_id: string; round: number; min_len: number; before: number; after: number; removed: number; ts?: string }
  | { type: 'subagent_started'; session_id: string; round: number; sub_id: number; query: string; ts?: string }
  | { type: 'subagent_thought'; session_id: string; round: number; sub_id: number; step: number; llm_json: any; display_text?: string; ts?: string; elapsed_ms?: number }
  | { type: 'subagent_tool_call'; session_id: string; round: number; sub_id: number; tool: string; args: any; display_text?: string; ts?: string; elapsed_ms?: number }
  | { type: 'subagent_tool_result'; session_id: string; round: number; sub_id: number; tool: string; info: any; summary?: string; ts?: string }
  | { type: 'subagent_completed'; session_id: string; round: number; sub_id: number; steps: number; summary_md: string; citations: [string, number][], key_findings?: string[]; confidence?: number; uncertainties?: string[]; ts?: string }
  | { type: 'subagent_failed'; session_id: string; round: number; sub_id: number; error: string; ts?: string }
  | { type: 'subagents_done'; session_id: string; round: number; metrics: any; sub_reports: any; ts?: string }
  | { type: 'synthesis_updated'; session_id: string; round: number; synthesis: string; ts?: string }
  | { type: 'critic_updated'; session_id: string; round: number; critic: any; ts?: string }
  | { type: 'macro_insight_generated'; session_id: string; round: number; insight: any; ts?: string }
  | { type: 'ingestion_progress'; total: number; completed: number; percent: number }
  | { type: 'cancellation_requested'; session_id: string; ts?: string }
  | { type: 'session_cancelled'; session_id: string; at_round?: number; ts?: string }
  | { type: 'session_completed'; session_id: string; round: number; ts?: string }
  | { type: 'session_failed'; session_id?: string; round?: number; message: string; ts?: string }
  | { type: 'artifact_created'; session_id: string; round: number; artifact: any; ts?: string }
  | { type: 'agent_request'; session_id: string; round: number; agent: string; sub_id?: number; phase: string; payload: any; ts?: string }
  | { type: 'agent_response'; session_id: string; round: number; agent: string; sub_id?: number; phase: string; payload: any; ts?: string }
  | { type: 'error'; session_id?: string; message: string }
  | { type: 'macro_insight_progress'; session_id: string; round: number; total_chunks: number; completed_chunks: number; ts?: string };

type SubAgentState = {
  status: 'pending' | 'running' | 'completed' | 'failed';
  query?: string;
  steps: any[]; // thought/tool logs
  last_activity?: string;
  progress?: number;
  summary_md?: string;
  citations?: Array<[string, number]>;
  key_findings?: string[];
  confidence?: number;
  uncertainties?: string[];
};

export type ResearchArtifact = {
  id: number;
  round_no: number;
  agent: string;
  artifact_type: string;
  payload_json: string;
  size: number;
  created_at: string;
};

interface HpiasStore {
  sessionId: string | null;
  round: number;
  executionMode: 'autonomous' | 'supervised' | null;
  plan: any | null;
  synthesis: string | null;
  critic: any | null;
  retrievalCount: number | null;
  selectedCount: number | null;
  metrics: any | null;
  retrievedItems: any[] | null;
  // 时间线原始事件流（用于Timeline可视化）
  // 内存清理策略：
  //   1. 运行时：滑动窗口上限 2000 条（handleEvent 入口处截断）
  //   2. 会话结束（session_completed / session_failed）：截断至最后 100 条
  //   3. 主动清理（clear / reset）：清空为 []
  eventsLog: HpiasEvent[];
  roundsView: Record<number, {
    round_no: number;
    status: string;
    created_at?: string;
    plan_json?: string;
    queries_json?: string;
    retrieved_json?: string;
    summary_md?: string;
    citations_json?: string;
    metrics_json?: string;
  }>;
  subAgents: Record<number, SubAgentState>;
  artifactsByRound: Record<number, ResearchArtifact[]>;
  ingestion: { total: number; completed: number; percent: number } | null;
  actions: {
    reset: (sessionId: string, round: number) => void;
    handleEvent: (e: HpiasEvent) => void;
    clear: () => void;
    setRound: (round: number) => void;
    mergeArtifacts: (round: number, items: ResearchArtifact[]) => void;
    importRounds: (sessionId: string, rounds: any[]) => void;
    getSubAgentProgress: (subId: number, defaultMax?: number) => number;
    hydrateRoundFromVisualSummary: (sessionId: string, roundNo: number, v: any) => void;
  };
}

export const useHpiasStore = create<HpiasStore>()(
  devtools(
    subscribeWithSelector<HpiasStore>((set, get) => ({
      sessionId: null,
      round: 0,
      executionMode: null,
      plan: null,
      synthesis: null,
      critic: null,
      retrievalCount: null,
      selectedCount: null,
      metrics: null,
      subAgents: {},
      retrievedItems: null,
      eventsLog: [],
      roundsView: {},
      artifactsByRound: {},
      ingestion: null,
      actions: {
        reset: (sessionId, round) => set({ sessionId, round, executionMode: null, plan: null, synthesis: null, critic: null, retrievalCount: null, selectedCount: null, metrics: null, retrievedItems: null, eventsLog: [], roundsView: {}, subAgents: {} }),
        // 完全重置所有状态，eventsLog 清空释放全部内存
        clear: () => set({ sessionId: null, round: 0, plan: null, synthesis: null, critic: null, retrievalCount: null, selectedCount: null, metrics: null, retrievedItems: null, eventsLog: [], roundsView: {}, subAgents: {}, artifactsByRound: {}, ingestion: null }),
        setRound: (round) => set({ round }),
        mergeArtifacts: (round, items) => set(state => {
          const prev = state.artifactsByRound[round] || [];
          const map = new Map<number, ResearchArtifact>();
          for (const it of prev) map.set(it.id, it);
          for (const it of items) map.set(it.id, it);
          return { artifactsByRound: { ...state.artifactsByRound, [round]: Array.from(map.values()).sort((a,b)=> a.id - b.id) } } as any;
        }),
        importRounds: (sessionId, rounds) => set(state => {
          const rv = { ...state.roundsView } as any;
          for (const r of rounds || []) {
            const rno = r.round_no || r.round || 0;
            if (!rno) continue;
            rv[rno] = rv[rno] || { round_no: rno, status: r.status || 'completed', created_at: r.created_at };
            rv[rno].status = r.status || rv[rno].status;
            if (r.plan_json) rv[rno].plan_json = r.plan_json;
            if (r.queries_json) rv[rno].queries_json = r.queries_json;
            if (r.retrieved_json) rv[rno].retrieved_json = r.retrieved_json;
            if (r.summary_md) rv[rno].summary_md = r.summary_md;
            if (r.citations_json) rv[rno].citations_json = r.citations_json;
            if (r.metrics_json) rv[rno].metrics_json = r.metrics_json;
          }
          return { roundsView: rv };
        }),
        hydrateRoundFromVisualSummary: (sessionId, roundNo, v) => set((state) => {
          const rv = { ...state.roundsView } as any;
          const r = rv[roundNo] || { round_no: roundNo, status: 'completed', created_at: new Date().toISOString() };
          /* 非关键：visualSummary 各字段序列化失败时跳过该字段，不影响其他字段水合 */
          try { if (v?.plan) r.plan_json = JSON.stringify(v.plan); } catch { /* skip */ }
          try { if (v?.queries) r.queries_json = JSON.stringify(v.queries); } catch { /* skip */ }
          try { if (v?.retrieved) r.retrieved_json = JSON.stringify(v.retrieved); } catch { /* skip */ }
          try { if (v?.citations) r.citations_json = JSON.stringify(v.citations); } catch { /* skip */ }
          try { if (v?.metrics) r.metrics_json = JSON.stringify(v.metrics); } catch { /* skip */ }
          if (typeof v?.summary_md === 'string') r.summary_md = v.summary_md;
          rv[roundNo] = r;
          // Subagents from visual summary (may come from artifacts). We mark them completed.
          const subAgents = { ...state.subAgents } as any;
          if (Array.isArray(v?.subagents)) {
            let nextIdBase = 1000;
            for (const sa of v.subagents) {
              const k = typeof sa?.sub_id === 'number' ? sa.sub_id : (nextIdBase++);
              subAgents[k] = {
                status: 'completed',
                query: sa?.query,
                steps: Array.isArray(sa?.steps) ? sa.steps : [],
                summary_md: typeof sa?.summary_md === 'string' ? sa.summary_md : undefined,
                citations: Array.isArray(sa?.citations) ? sa.citations : undefined,
                key_findings: Array.isArray(sa?.key_findings) ? sa.key_findings : undefined,
                progress: 1,
                last_activity: t('status.completed'),
              };
            }
          }
          return { roundsView: rv, subAgents, plan: v?.plan || state.plan, synthesis: v?.summary_md || state.synthesis, metrics: v?.metrics || state.metrics };
        }),
        handleEvent: (e: HpiasEvent) => {
          const s = get();
          // 记录事件到时间线
          try {
            if (e.type !== 'ingestion_progress') {
              const prev = (s as any).eventsLog as HpiasEvent[] || [];
              const next = [...prev, e];
              const limited = next.length > 2000 ? next.slice(next.length - 2000) : next;
              set({ eventsLog: limited } as any);
            }
          } catch (err: unknown) {
            console.warn('[HpiasStore] eventsLog recording failed:', err);
          }
          switch (e.type) {
            case 'session_started': {
              let mode: 'autonomous' | 'supervised' | null = null;
              try {
                if (typeof e.options_json === 'string' && e.options_json.trim()) {
                  const obj = JSON.parse(e.options_json);
                  const m = obj?.execution_mode;
                  if (m === 'autonomous' || m === 'supervised') mode = m;
                }
              } catch { /* 非关键：options_json 解析失败时默认 mode=null，不影响会话启动 */ }
              set({ sessionId: e.session_id, round: 0, executionMode: mode });
              break;
            }
            case 'round_started':
              set(state => {
                const rv = { ...state.roundsView };
                rv[e.round] = rv[e.round] || { round_no: e.round, status: 'started', created_at: new Date().toISOString() };
                rv[e.round].status = 'started';
                return { sessionId: e.session_id, round: e.round, subAgents: {}, synthesis: null, retrievalCount: null, selectedCount: null, metrics: null, roundsView: rv };
              });
              break;
            case 'round_executing':
              set(state => {
                const rv = { ...state.roundsView } as any;
                const rno = (e as any).round as number;
                rv[rno] = rv[rno] || { round_no: rno, status: 'executing', created_at: new Date().toISOString() };
                rv[rno].status = 'executing';
                return { roundsView: rv };
              });
              break;
            case 'plan_pending_approval': {
              const rno = (e as any).round as number;
              set(state => {
                const rv = { ...state.roundsView };
                rv[rno] = rv[rno] || { round_no: rno, status: 'pending_approval', created_at: new Date().toISOString() };
                rv[rno].status = 'pending_approval';
                try { rv[rno].plan_json = JSON.stringify((e as any).plan); } catch { rv[rno].plan_json = String((e as any).plan); }
                // derive queries
                try {
                  const core = (e as any).plan?.core;
                  const qs = Array.isArray(core?.queries) ? core.queries : undefined;
                  if (qs) rv[rno].queries_json = JSON.stringify({ queries: qs });
                } catch { /* 非关键：queries 派生失败不影响 plan 展示 */ }
                return { plan: (e as any).plan, roundsView: rv };
              });
              break;
            }
            case 'plan_generated':
              set(state => {
                const rv = { ...state.roundsView };
                const rno = (e as any).round as number;
                rv[rno] = rv[rno] || { round_no: rno, status: 'started', created_at: new Date().toISOString() };
                try { rv[rno].plan_json = JSON.stringify((e as any).plan); } catch { rv[rno].plan_json = String((e as any).plan); }
                // derive queries_json from plan.core if present
                try {
                  const core = (e as any).plan?.core;
                  const qs = Array.isArray(core?.queries) ? core.queries : undefined;
                  if (qs) rv[rno].queries_json = JSON.stringify({ queries: qs });
                } catch { /* 非关键：queries 派生失败不影响 plan 展示 */ }
                return { plan: (e as any).plan, roundsView: rv };
              });
              break;
            case 'retrieval_completed':
              set({ retrievalCount: e.fetched });
              break;
            case 'selection_completed':
              set(state => {
                let items: any[] | null = null;
                let citations_json: string | undefined = undefined;
                try {
                  const v = (e as any).citations;
                  if (v) { citations_json = JSON.stringify(v); const arr = Array.isArray(v?.items) ? v.items : []; items = arr; }
                } catch { /* 非关键：citations 解析失败时 selectedCount 仍正常更新 */ }
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView };
                rv[rno] = rv[rno] || { round_no: rno, status: 'retrieved', created_at: new Date().toISOString() };
                rv[rno].status = 'retrieved';
                if (citations_json) rv[rno].citations_json = citations_json;
                if (items) rv[rno].retrieved_json = JSON.stringify({ items });
                return { selectedCount: e.selected, retrievedItems: items, roundsView: rv };
              })
              break;
            case 'round_metrics':
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView };
                rv[rno] = rv[rno] || { round_no: rno, status: rv[rno]?.status || 'started', created_at: rv[rno]?.created_at || new Date().toISOString() };
                try { rv[rno].metrics_json = JSON.stringify((e as any).metrics); } catch { rv[rno].metrics_json = String((e as any).metrics); }
                return { metrics: (e as any).metrics, roundsView: rv };
              });
              break;
            case 'queries_prepared':
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView } as any;
                rv[rno] = rv[rno] || { round_no: rno, status: rv[rno]?.status || 'started', created_at: rv[rno]?.created_at || new Date().toISOString() };
                try { rv[rno].queries_json = JSON.stringify({ queries: (e as any).queries || [] }); } catch { rv[rno].queries_json = JSON.stringify({ queries: [] }); }
                return { roundsView: rv };
              });
              break;
            case 'candidate_ranking_started':
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView } as any;
                rv[rno] = rv[rno] || { round_no: rno, status: 'ranking', created_at: new Date().toISOString() };
                rv[rno].status = 'ranking';
                // annotate metrics_json lite
                let m: any = {};
                try { m = rv[rno].metrics_json ? JSON.parse(rv[rno].metrics_json) : {}; } catch { /* 非关键：已有 metrics 损坏时从空对象重建 */ }
                m = { ...m, candidate_count: (e as any).candidate_count };
                rv[rno].metrics_json = JSON.stringify(m);
                return { roundsView: rv };
              });
              break;
            case 'subagent_started':
              set(state => ({ subAgents: { ...state.subAgents, [e.sub_id]: { status: 'running', query: e.query, steps: [], progress: 0 } } }));
              break;
            case 'subagent_thought':
              set(state => ({ subAgents: { ...state.subAgents, [e.sub_id]: { ...(state.subAgents[e.sub_id] || { status: 'running', steps: [] }), status: 'running', steps: [ ...(state.subAgents[e.sub_id]?.steps || []), { type: 'thought', step: e.step, llm_json: e.llm_json, display_text: (e as any).display_text, ts: (e as any).ts, elapsed_ms: (e as any).elapsed_ms } ], last_activity: (e as any).display_text || state.subAgents[e.sub_id]?.last_activity, progress: Math.min(1, ((state.subAgents[e.sub_id]?.steps?.length || 0) + 1) / 8) } } }));
              break;
            case 'subagent_tool_call':
              set(state => ({ subAgents: { ...state.subAgents, [e.sub_id]: { ...(state.subAgents[e.sub_id] || { status: 'running', steps: [] }), status: 'running', steps: [ ...(state.subAgents[e.sub_id]?.steps || []), { type: 'tool_call', tool: e.tool, args: e.args, display_text: (e as any).display_text, ts: (e as any).ts, elapsed_ms: (e as any).elapsed_ms } ], last_activity: (e as any).display_text || `${t('status.calling_tool')}：${e.tool}`, progress: Math.min(1, ((state.subAgents[e.sub_id]?.steps?.length || 0) + 1) / 8) } } }));
              break;
            case 'subagent_tool_result':
              set(state => ({ subAgents: { ...state.subAgents, [e.sub_id]: { ...(state.subAgents[e.sub_id] || { status: 'running', steps: [] }), status: 'running', steps: [ ...(state.subAgents[e.sub_id]?.steps || []), { type: 'tool_result', tool: e.tool, info: e.info, summary: (e as any).summary, ts: (e as any).ts } ] } } }));
              break;
            case 'subagent_completed':
              set(state => {
                const nextSub = { ...(state.subAgents[e.sub_id] || { status: 'completed', steps: [] }), status: 'completed', summary_md: e.summary_md, citations: e.citations, key_findings: (e as any).key_findings, confidence: (e as any).confidence, uncertainties: (e as any).uncertainties, steps: state.subAgents[e.sub_id]?.steps || [], progress: 1, last_activity: t('status.completed') } as any;
                // Best-effort: if synthesis没有对应小节，再追加，避免与 orchestrator 的 SynthesisUpdated 重复
                let synthesis = state.synthesis || '';
                try {
                  const title = state.subAgents[e.sub_id]?.query || '';
                  const head = title ? `\n\n## ${t('research.subtask')} · ${title}\n\n` : `\n\n## ${t('research.subtask')}\n\n`;
                  const marker = title ? `## ${t('research.subtask')} · ${title}` : `## ${t('research.subtask')}`;
                  if (!synthesis.includes(marker)) {
                    synthesis += head + (e.summary_md || '');
                  }
                } catch { /* 非关键：best-effort 合成追加失败，orchestrator 的 synthesis_updated 会覆盖 */ }
                return { subAgents: { ...state.subAgents, [e.sub_id]: nextSub }, synthesis };
              });
              break;
            case 'subagent_failed':
              set(state => ({ subAgents: { ...state.subAgents, [e.sub_id]: { ...(state.subAgents[e.sub_id] || { status: 'failed', steps: [] }), status: 'failed', steps: [ ...(state.subAgents[e.sub_id]?.steps || []), { type: 'error', message: e.error } ] } } }));
              break;
            case 'synthesis_updated':
              set(state => {
                const text = (state.synthesis || '') + ((e as any).synthesis || '');
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView };
                rv[rno] = rv[rno] || { round_no: rno, status: 'streaming', created_at: new Date().toISOString() };
                rv[rno].status = 'streaming';
                rv[rno].summary_md = text;
                return { synthesis: text, roundsView: rv };
              });
              break;
            case 'critic_updated':
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView };
                rv[rno] = rv[rno] || { round_no: rno, status: 'critic', created_at: new Date().toISOString() };
                rv[rno].status = 'critic';
                return { critic: (e as any).critic, roundsView: rv };
              });
              break;
            case 'macro_insight_generated':
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView } as any;
                rv[rno] = rv[rno] || { round_no: rno, status: rv[rno]?.status || 'started', created_at: rv[rno]?.created_at || new Date().toISOString() };
                try { rv[rno].macro_insight_json = JSON.stringify((e as any).insight || {}); } catch { rv[rno].macro_insight_json = JSON.stringify({}); }
                return { roundsView: rv };
              });
              break;
            case 'macro_insight_progress':
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView } as any;
                rv[rno] = rv[rno] || { round_no: rno, status: rv[rno]?.status || 'started', created_at: rv[rno]?.created_at || new Date().toISOString() };
                // store progress into metrics_json snapshot
                let merged: any = {};
                try {
                  const prevM = rv[rno].metrics_json ? JSON.parse(rv[rno].metrics_json) : {};
                  merged = { ...prevM, macro_insight_progress: { total_chunks: (e as any).total_chunks, completed_chunks: (e as any).completed_chunks } };
                  rv[rno].metrics_json = JSON.stringify(merged);
                } catch { merged = { macro_insight_progress: { total_chunks: (e as any).total_chunks, completed_chunks: (e as any).completed_chunks } }; }
                // also update live metrics snapshot for Cockpit
                return { roundsView: rv, metrics: merged } as any;
              });
              break;
            case 'subagents_done':
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView } as any;
                rv[rno] = rv[rno] || { round_no: rno, status: 'completed', created_at: new Date().toISOString() };
                rv[rno].status = 'completed';
                try {
                  const prevM = rv[rno].metrics_json ? JSON.parse(rv[rno].metrics_json) : {};
                  const merged = { ...prevM, subagents_done: (e as any).metrics };
                  rv[rno].metrics_json = JSON.stringify(merged);
                } catch { /* 非关键：子代理完成指标合并失败不影响轮次状态 */ }
                return { roundsView: rv };
              });
              break;
            case 'ingestion_progress':
              set({ ingestion: { total: e.total, completed: e.completed, percent: e.percent } });
              break;
            case 'session_cancelled':
              // Keep state but mark stalled agents as failed
              set(state => ({
                subAgents: Object.fromEntries(Object.entries(state.subAgents).map(([k, v]) => [Number(k), { ...v, status: v.status === 'running' ? 'failed' : v.status }]))
              }));
              break;
            case 'session_completed':
              // 会话结束清理：将 eventsLog 截断为最后 100 条，释放长时间运行积累的内存。
              // 运行时仍保持 2000 条滑动窗口（L186），此处仅在会话完成时做二次收敛。
              set(state => {
                const rno = (e as any).round as number;
                const rv = { ...state.roundsView };
                if (rv[rno]) rv[rno].status = 'completed';
                const trimmed = state.eventsLog.length > 100
                  ? state.eventsLog.slice(-100)
                  : state.eventsLog;
                return { roundsView: rv, eventsLog: trimmed };
              });
              break;
            case 'session_failed':
              // 🔒 审计修复: 只将 running/pending 的 agent 标记为 failed，保留已完成的成功结果
              // 原代码将所有 agent（包括已 completed 的）全部覆盖为 failed，丢失有效研究结果
              // 会话失败清理：同 session_completed，截断 eventsLog 至最后 100 条以释放内存。
              set(state => ({
                subAgents: Object.fromEntries(
                  Object.entries(state.subAgents).map(([k, v]) => [
                    Number(k),
                    (v.status === 'running' || v.status === 'pending')
                      ? { ...v, status: 'failed' }
                      : v // 保留 completed 状态
                  ])
                ),
                eventsLog: state.eventsLog.length > 100
                  ? state.eventsLog.slice(-100)
                  : state.eventsLog,
              }));
              break;
            case 'artifact_created': {
              try {
                const rn = (e as any).round as number;
                const a = (e as any).artifact || {};
                const item: ResearchArtifact = {
                  id: Number(a.id) || Date.now(),
                  round_no: rn,
                  agent: String(a.agent || 'unknown'),
                  artifact_type: String(a.artifact_type || 'unknown'),
                  payload_json: typeof a.payload_json === 'string' ? a.payload_json : JSON.stringify(a.payload_json || {}),
                  size: Number(a.size || 0),
                  created_at: String(a.created_at || new Date().toISOString()),
                };
                const prev = s as any;
                const list: ResearchArtifact[] = [ ...((prev.artifactsByRound?.[rn] || []) as ResearchArtifact[]), item ];
                set({ artifactsByRound: { ...(prev.artifactsByRound || {}), [rn]: list } });
              } catch (err: unknown) {
                console.warn('[HpiasStore] artifact_created processing failed:', err);
              }
              break;
            }
            case 'agent_request':
              // 🔒 审计修复: 移除重复的 eventsLog 写入（通用入口 L181-187 已记录此事件）
              // 原代码导致 agent_request/agent_response 被双写，且第二次写入绕过 2000 条上限
              break;
            case 'agent_response':
              // 🔒 审计修复: 同上
              break;
            case 'error':
              // optionally store last error
              break;
            default:
              break;
          }
        },
        getSubAgentProgress: (subId: number, defaultMax: number = 8) => {
          const st = get().subAgents[subId];
          if (!st) return 0;
          if (typeof st.progress === 'number') return Math.max(0, Math.min(1, st.progress));
          const steps = st.steps?.length || 0;
          return Math.max(0, Math.min(1, steps / Math.max(1, defaultMax)));
        },
      },
    })),
    { name: 'HpiasStore', enabled: import.meta.env.DEV }
  )
);
