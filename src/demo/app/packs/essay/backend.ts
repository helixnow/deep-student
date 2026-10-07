/**
 * 第 09 章「作文批改」的内存后端：作文会话（essay_grading_*）+ 资源库里的作文节点（dstu_*）。
 * 批改本身要模型：essay_grading_stream 提示去桌面版。
 */
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';
import { buildGradingResult, dimensionScoresJson, type Annotation, type ScoreSpec } from './build';
import { DEMO_GRADING_MODES } from './modes';
import {
  GAOKAO_ANNOTATIONS, GAOKAO_ESSAY, GAOKAO_MODEL_ESSAY, GAOKAO_POLISH, GAOKAO_SCORE, GAOKAO_TOPIC,
} from './gaokao';
import {
  IELTS_ANNOTATIONS, IELTS_ESSAY, IELTS_MODEL_ESSAY, IELTS_POLISH, IELTS_SCORE, IELTS_TOPIC,
} from './ielts';

export const GAOKAO_SESSION_ID = 'essay_sess_demo_gaokao';
export const IELTS_SESSION_ID = 'essay_sess_demo_ielts';

interface Session {
  id: string;
  title: string;
  essay_type: string;
  grade_level: string;
  custom_prompt: string | null;
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
  deleted_at?: string;
}

interface Round {
  id: string;
  session_id: string;
  round_number: number;
  input_text: string;
  grading_result: string;
  overall_score: number | null;
  dimension_scores_json: string | null;
  created_at: string;
}

const iso = (daysAgo: number, hh: number, mm: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
};

let sessions: Session[] = [];
let rounds: Round[] = [];
let seq = 0;
let ready = false;

function gradedRound(sessionId: string, essay: string, ann: Annotation[], score: ScoreSpec, polish: { original: string; polished: string }[], model: string, at: string): Round {
  return {
    id: `${sessionId}_r1`,
    session_id: sessionId,
    round_number: 1,
    input_text: essay,
    grading_result: buildGradingResult(essay, ann, score, polish, model),
    overall_score: score.total,
    dimension_scores_json: dimensionScoresJson(score),
    created_at: at,
  };
}

function ensureSeeded(): void {
  if (ready) return;
  ready = true;
  const gAt = iso(0, 21, 40);
  const iAt = iso(3, 16, 5);
  sessions = [
    { id: GAOKAO_SESSION_ID, title: '答案易得，思考难得', essay_type: 'argumentative', grade_level: 'high_school', custom_prompt: null, created_at: iso(0, 21, 12), updated_at: gAt, is_favorite: true },
    { id: IELTS_SESSION_ID, title: 'Should students study outside their major?', essay_type: 'argumentative', grade_level: 'college', custom_prompt: null, created_at: iso(3, 15, 30), updated_at: iAt, is_favorite: false },
  ];
  rounds = [
    gradedRound(GAOKAO_SESSION_ID, GAOKAO_ESSAY, GAOKAO_ANNOTATIONS, GAOKAO_SCORE, GAOKAO_POLISH, GAOKAO_MODEL_ESSAY, gAt),
    gradedRound(IELTS_SESSION_ID, IELTS_ESSAY, IELTS_ANNOTATIONS, IELTS_SCORE, IELTS_POLISH, IELTS_MODEL_ESSAY, iAt),
  ];
}

/** 会话级设置：批阅模式与题目（essay_grading.session_mode/context.<id>） */
export const ESSAY_SETTINGS: Record<string, unknown> = {
  'essay_grading.mode_id': 'gaokao',
  'essay_grading.model_id': 'demo-deepseek-v4',
  [`essay_grading.session_mode.${GAOKAO_SESSION_ID}`]: 'gaokao',
  [`essay_grading.session_mode.${IELTS_SESSION_ID}`]: 'ielts',
  [`essay_grading.session_context.${GAOKAO_SESSION_ID}`]: JSON.stringify({ version: 1, topicText: GAOKAO_TOPIC, uploadedImages: [], topicImages: [] }),
  [`essay_grading.session_context.${IELTS_SESSION_ID}`]: JSON.stringify({ version: 1, topicText: IELTS_TOPIC, uploadedImages: [], topicImages: [] }),
};

const live = () => sessions.filter((s) => !s.deleted_at);
const roundsOf = (id: string) => rounds.filter((r) => r.session_id === id).sort((a, b) => a.round_number - b.round_number);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function summary(s: Session) {
  const rs = roundsOf(s.id);
  const latest = rs[rs.length - 1];
  return {
    ...s,
    total_rounds: rs.length,
    ...(latest?.overall_score != null ? { latest_score: Math.round(latest.overall_score) } : {}),
  };
}

function node(s: Session) {
  const sm = summary(s);
  return {
    id: s.id,
    path: `/${s.id}`,
    name: s.title,
    type: 'essay',
    sourceId: s.id,
    resourceId: s.id,
    createdAt: Date.parse(s.created_at),
    updatedAt: Date.parse(s.updated_at),
    metadata: {
      essayType: s.essay_type,
      gradeLevel: s.grade_level,
      totalRounds: sm.total_rounds,
      latestScore: sm.latest_score ?? null,
      isFavorite: s.is_favorite,
    },
  };
}

function idFromPath(path: unknown): string {
  return String(path ?? '').replace(/^\/+/, '').split('/').pop() ?? '';
}

function createSession(title: string, essayType: string, gradeLevel: string, customPrompt: string | null): Session {
  const at = new Date().toISOString();
  const s: Session = {
    id: `essay_sess_demo_${Date.now().toString(36)}${(seq++).toString(36)}`,
    title, essay_type: essayType, grade_level: gradeLevel, custom_prompt: customPrompt,
    created_at: at, updated_at: at, is_favorite: false,
  };
  sessions.unshift(s);
  return s;
}

export function handleEssay(cmd: string, args: DemoArgs): unknown {
  ensureSeeded();
  switch (cmd) {
    // —— 资源库节点 ——
    case 'dstu_list': {
      const options = (args.options ?? {}) as Record<string, unknown>;
      if (options.typeFilter && options.typeFilter !== 'essay') return [];
      return [...live()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(node);
    }
    case 'dstu_get': {
      const s = live().find((x) => x.id === idFromPath(args.path));
      return s ? node(s) : null;
    }
    case 'dstu_create': {
      const s = createSession(tr('新作文', 'New essay'), '', '', null);
      return node(s);
    }
    case 'dstu_delete': {
      const s = live().find((x) => x.id === idFromPath(args.path));
      if (s) s.deleted_at = new Date().toISOString();
      return null;
    }
    case 'dstu_set_metadata':
    case 'dstu_set_favorite':
      return null;
    case 'dstu_rename': {
      const s = live().find((x) => x.id === idFromPath(args.path));
      if (s && typeof args.newName === 'string') s.title = args.newName;
      return s ? node(s) : null;
    }
    // —— 会话 ——
    case 'essay_grading_create_session':
      return clone({ ...createSession(String(args.title ?? ''), String(args.essayType ?? ''), String(args.gradeLevel ?? ''), (args.customPrompt as string | null) ?? null), total_rounds: 0 });
    case 'essay_grading_get_session': {
      const s = live().find((x) => x.id === args.sessionId);
      return s ? clone(summary(s)) : null;
    }
    case 'essay_grading_update_session': {
      const patch = (args.session ?? {}) as Record<string, unknown>;
      const s = sessions.find((x) => x.id === patch.id);
      if (s) {
        if (typeof patch.title === 'string') s.title = patch.title;
        if (typeof patch.essay_type === 'string') s.essay_type = patch.essay_type;
        if (typeof patch.grade_level === 'string') s.grade_level = patch.grade_level;
        if (patch.custom_prompt !== undefined) s.custom_prompt = (patch.custom_prompt as string | null) ?? null;
        if (typeof patch.is_favorite === 'boolean') s.is_favorite = patch.is_favorite;
        s.updated_at = new Date().toISOString();
      }
      return null;
    }
    case 'essay_grading_toggle_favorite': {
      const s = sessions.find((x) => x.id === args.sessionId);
      if (!s) return false;
      s.is_favorite = !s.is_favorite;
      return s.is_favorite;
    }
    case 'essay_grading_delete_session': {
      const before = sessions.length;
      sessions = sessions.filter((x) => x.id !== args.sessionId);
      rounds = rounds.filter((r) => r.session_id !== args.sessionId);
      return before - sessions.length;
    }
    case 'essay_grading_list_sessions': {
      const q = String(args.query ?? '').trim().toLowerCase();
      const list = live()
        .filter((s) => !q || `${s.title} ${s.essay_type} ${s.grade_level}`.toLowerCase().includes(q))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(summary);
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 50);
      return clone(list.slice(offset, offset + limit));
    }
    case 'essay_grading_get_rounds':
      return clone(roundsOf(String(args.sessionId)));
    case 'essay_grading_get_round':
      return clone(roundsOf(String(args.sessionId)).find((r) => r.round_number === args.roundNumber) ?? null);
    case 'essay_grading_get_latest_round_number': {
      const rs = roundsOf(String(args.sessionId));
      return rs.length ? rs[rs.length - 1].round_number : 0;
    }
    // —— 批阅模式 ——
    case 'essay_grading_get_modes':
      return clone(DEMO_GRADING_MODES);
    case 'essay_grading_get_mode':
      return clone(DEMO_GRADING_MODES.find((m) => m.id === args.modeId) ?? null);
    case 'essay_grading_list_custom_modes':
      return [];
    case 'essay_grading_has_builtin_override':
      return false;
    case 'essay_grading_get_models':
      return [
        { id: 'demo-deepseek-v4', name: 'DeepSeek V4', model: 'deepseek-v4', is_default: true },
        { id: 'demo-kimi-k3', name: 'Kimi K3', model: 'kimi-k3', is_default: false },
      ];
    case 'essay_grading_create_custom_mode':
    case 'essay_grading_update_custom_mode':
    case 'essay_grading_save_builtin_override':
    case 'essay_grading_reset_builtin_mode':
    case 'essay_grading_delete_custom_mode':
      throw new Error(tr('自定义批阅模式请在桌面版中使用。', 'Custom grading modes are available in the desktop app.'));
    // —— 批改（要模型） ——
    case 'essay_grading_stream':
      throw new Error(tr(
        '演示里不能发起新的批改——批改要调用你配置的模型，请在桌面版中使用。上面是这篇作文已有的批改结果。',
        'The demo cannot start a new grading run — grading calls your configured model, so it is available in the desktop app. The result shown is this essay’s existing grading.',
      ));
    case 'cancel_stream':
      return null;
    default:
      return undefined;
  }
}
