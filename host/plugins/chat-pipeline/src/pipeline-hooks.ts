/**
 * Native Cordis `chatPipelineHooks` registry (RFC-002 P2 — DeepSeek Harness-aligned extensibility).
 *
 * Allows official and Tier 3 plugins to participate in the chat lifecycle without
 * ever compromising main-loop stability or bypassing `ApprovalGateHook`:
 * - Every hook runs under a strict per-hook timeout (default 3000ms) and try/catch guard.
 * - Throwing or timing-out hooks are cleanly bypassed with a warning log.
 * - Disposing a plugin automatically removes its registered hooks.
 */

export const DEFAULT_PIPELINE_HOOK_TIMEOUT_MS = 3_000;

export interface PipelineHookPromptInput {
  sessionId: string;
  mode: string | null;
  userContent: string;
}

export interface PipelineHookAfterReplyInput {
  sessionId: string;
  messageId: string;
  userContent: string;
  assistantContent: string;
  durationMs: number;
}

export interface ChatPipelineHookContribution {
  /** Human-readable hook name for diagnostics. */
  name: string;
  /** Lower number runs earlier (default 100). */
  priority?: number;
  /** Per-hook timeout in ms (clamped to 100..10000ms, default 3000ms). */
  timeoutMs?: number;
  /** Optional extra prompt context appended safely inside `<plugin_extensions>` in `turnVolatile`. */
  augmentSystemPrompt?(input: PipelineHookPromptInput): Promise<string | null | undefined> | string | null | undefined;
  /** Optional observer invoked after a turn completes successfully. */
  afterReply?(input: PipelineHookAfterReplyInput): Promise<void> | void;
}

export interface RegisteredPipelineHookInfo {
  pluginId: string;
  name: string;
  priority: number;
  hasAugmentSystemPrompt: boolean;
  hasAfterReply: boolean;
}

export interface ChatPipelineHooksService {
  register(pluginId: string, hook: ChatPipelineHookContribution): () => void;
  list(): RegisteredPipelineHookInfo[];
  runAugmentSystemPrompt(input: PipelineHookPromptInput): Promise<string | null>;
  runAfterReply(input: PipelineHookAfterReplyInput): Promise<void>;
}

interface HookEntry {
  id: number;
  pluginId: string;
  hook: ChatPipelineHookContribution;
  priority: number;
  timeoutMs: number;
}

function clampTimeout(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_PIPELINE_HOOK_TIMEOUT_MS;
  return Math.max(100, Math.min(10_000, Math.floor(raw)));
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`hook timeout after ${timeoutMs}ms (${label})`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ChatPipelineHooksRegistry implements ChatPipelineHooksService {
  private nextId = 1;
  private readonly entries: HookEntry[] = [];
  private readonly warn: (message: string) => void;

  constructor(warn: (message: string) => void = () => undefined) {
    this.warn = warn;
  }

  register(pluginId: string, hook: ChatPipelineHookContribution): () => void {
    const cleanPluginId = pluginId.trim();
    const cleanName = hook.name.trim();
    if (!cleanPluginId || !cleanName) {
      throw new Error('chatPipelineHooks.register requires non-empty pluginId and hook.name');
    }
    const entry: HookEntry = {
      id: this.nextId++,
      pluginId: cleanPluginId,
      hook,
      priority: typeof hook.priority === 'number' && Number.isFinite(hook.priority) ? hook.priority : 100,
      timeoutMs: clampTimeout(hook.timeoutMs),
    };
    this.entries.push(entry);
    this.entries.sort((a, b) => a.priority - b.priority || a.id - b.id);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const idx = this.entries.findIndex(item => item.id === entry.id);
      if (idx !== -1) this.entries.splice(idx, 1);
    };
  }

  list(): RegisteredPipelineHookInfo[] {
    return this.entries.map(e => ({
      pluginId: e.pluginId,
      name: e.hook.name,
      priority: e.priority,
      hasAugmentSystemPrompt: typeof e.hook.augmentSystemPrompt === 'function',
      hasAfterReply: typeof e.hook.afterReply === 'function',
    }));
  }

  async runAugmentSystemPrompt(input: PipelineHookPromptInput): Promise<string | null> {
    const chunks: string[] = [];
    for (const entry of [...this.entries]) {
      const fn = entry.hook.augmentSystemPrompt;
      if (typeof fn !== 'function') continue;
      const label = `${entry.pluginId}/${entry.hook.name}`;
      try {
        const result = await withTimeout(Promise.resolve().then(() => fn(input)), entry.timeoutMs, label);
        if (typeof result === 'string' && result.trim() !== '') {
          chunks.push(`[${entry.pluginId}:${entry.hook.name}]\n${result.trim()}`);
        }
      } catch (error) {
        this.warn(`[chatPipelineHooks] augmentSystemPrompt bypassed (${label}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return chunks.length > 0 ? chunks.join('\n\n') : null;
  }

  async runAfterReply(input: PipelineHookAfterReplyInput): Promise<void> {
    for (const entry of [...this.entries]) {
      const fn = entry.hook.afterReply;
      if (typeof fn !== 'function') continue;
      const label = `${entry.pluginId}/${entry.hook.name}`;
      try {
        await withTimeout(Promise.resolve().then(() => fn(input)), entry.timeoutMs, label);
      } catch (error) {
        this.warn(`[chatPipelineHooks] afterReply bypassed (${label}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export interface DeclarativeStudyPackAssetsLike {
  listSkills(): ReadonlyArray<{ pluginId: string; skillId: string; name: string; description: string; markdown: string }>;
  listWorkflows(): ReadonlyArray<{
    pluginId: string;
    id: string;
    name: string;
    description?: string;
    trigger?: string;
    steps: ReadonlyArray<{ id: string; title: string; prompt: string }>;
  }>;
}

const MAX_STUDY_PACK_PROMPT_CHARS = 1800;

/**
 * Formats installed Tier 1 Study Pack declarative skills & workflows into a bounded
 * prompt section merged into `<plugin_extensions>` (RFC-002 P3/P4).
 */
export function formatDeclarativeStudyPackPrompt(registry: DeclarativeStudyPackAssetsLike | undefined): string | null {
  if (!registry) return null;
  const skills = registry.listSkills();
  const workflows = registry.listWorkflows();
  if (skills.length === 0 && workflows.length === 0) return null;

  const lines: string[] = [];
  if (skills.length > 0) {
    lines.push('### 已安装学习包方法论技能（Study Pack Skills）');
    for (const s of skills) {
      const body = s.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      const excerpt = body.length > 260 ? `${body.slice(0, 260)}…` : body;
      lines.push(`- [${s.pluginId}/${s.skillId}] ${s.name}${s.description ? `：${s.description}` : ''}`);
      if (excerpt) lines.push(`  指引：${excerpt.replace(/\s+/g, ' ')}`);
    }
  }
  if (workflows.length > 0) {
    lines.push('### 已安装学习包工作流（Study Pack Workflows）');
    for (const w of workflows) {
      const triggerText = w.trigger ? `（触发：${w.trigger}）` : '';
      lines.push(`- [${w.pluginId}/${w.id}] ${w.name}${triggerText}${w.description ? `：${w.description}` : ''}`);
      for (let i = 0; i < w.steps.length; i++) {
        const step = w.steps[i]!;
        lines.push(`  ${i + 1}. ${step.title}：${step.prompt}`);
      }
    }
  }

  const joined = lines.join('\n').trim();
  if (!joined) return null;
  return joined.length > MAX_STUDY_PACK_PROMPT_CHARS
    ? `${joined.slice(0, MAX_STUDY_PACK_PROMPT_CHARS)}…`
    : joined;
}
