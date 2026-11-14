/** Project-scoped in-memory storage core. The host owns persistence and lifecycle. */
export class KnowledgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

export interface KnowledgeNote { id: string; body: string; sessionId: string | null }
export interface KnowledgeTodo {
  id: string; body: string; completed: boolean; planId: string | null; dependsOn: string[];
}
export interface KnowledgePlan {
  id: string; body: string; sessionId: string | null; progress: { done: number; total: number }; warning?: string;
}

function bodyOf(body: string | undefined, max: number): string {
  if (typeof body !== 'string' || !body.trim() || body.length > max) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_BODY', `正文必须为非空字符串，且不超过 ${max} 个字符`);
  }
  return body;
}

function checkExpected(current: string | undefined, expected: string | undefined): void {
  if (expected !== undefined && current === undefined) {
    throw new KnowledgeError('KNOWLEDGE_EXPECTED_REQUIRES_ID', '乐观锁必须指定现有条目');
  }
  if (expected !== undefined && current !== expected) {
    throw new KnowledgeError('KNOWLEDGE_EXPECTED_CONFLICT', '正文已变更，请重新读取后再保存');
  }
}

/** Only checkboxes inside the Steps section count; fenced examples are not steps. */
export function withStepsCheck<T extends { body: string }>(plan: T): T & {
  progress: { done: number; total: number }; warning?: string;
} {
  let inSteps = false;
  let fence: string | null = null;
  let done = 0;
  let total = 0;
  for (const line of plan.body.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '';
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^##\s+Steps\s*#*\s*$/i.test(line)) { inSteps = true; continue; }
    if (/^#{1,2}\s/.test(line)) { inSteps = false; continue; }
    const task = inSteps ? /^\s*- \[([ xX])\]\s+\S/.exec(line) : null;
    if (task) { total += 1; if ((task[1] ?? '').toLowerCase() === 'x') done += 1; }
  }
  return {
    ...plan, progress: { done, total },
    ...(total === 0 ? { warning: '计划缺少 ## Steps 章节或任务复选框，请在本轮补齐。' } : {}),
  };
}

export class ProjectKnowledgeStore {
  private notes = new Map<string, KnowledgeNote>();
  private todos = new Map<string, KnowledgeTodo>();
  private plans = new Map<string, KnowledgePlan>();
  private sequence = 0;

  private id(kind: string): string { this.sequence += 1; return `${kind}-${this.sequence}`; }

  private require<T>(map: ReadonlyMap<string, T>, id: string): T {
    const entry = map.get(id);
    if (!entry) throw new KnowledgeError('KNOWLEDGE_NOT_FOUND', `条目不存在：${id}`);
    return entry;
  }

  saveNote(input: { id?: string; body: string; expected?: string }): KnowledgeNote {
    const current = input.id === undefined ? undefined : this.require(this.notes, input.id);
    checkExpected(current?.body, input.expected);
    const body = bodyOf(input.body, 3000);
    const note = { id: current?.id ?? this.id('note'), body, sessionId: current?.sessionId ?? null };
    this.notes.set(note.id, note);
    return { ...note };
  }

  listNotes(): KnowledgeNote[] { return [...this.notes.values()].map((note) => ({ ...note })); }

  pinToSession(noteId: string, sessionId: string | null): KnowledgeNote {
    const note = { ...this.require(this.notes, noteId), sessionId };
    this.notes.set(noteId, note);
    return { ...note };
  }

  deleteNote(id: string): void { this.require(this.notes, id); this.notes.delete(id); }

  saveTodo(input: { id?: string; body?: string; completed?: boolean; planId?: string | null; dependsOn?: string[] }): KnowledgeTodo {
    const current = input.id === undefined ? undefined : this.require(this.todos, input.id);
    const body = bodyOf(input.body ?? current?.body, 1000);
    const planId = input.planId === undefined ? current?.planId ?? null : input.planId;
    if (planId !== null) this.require(this.plans, planId);
    const id = current?.id ?? this.id('todo');
    const dependsOn = [...new Set(input.dependsOn ?? current?.dependsOn ?? [])];
    const reaches = (dependency: string, visited: Set<string>): boolean => {
      if (dependency === id) return true;
      if (visited.has(dependency)) return false;
      visited.add(dependency);
      return this.require(this.todos, dependency).dependsOn.some((next) => reaches(next, visited));
    };
    for (const dependency of dependsOn) {
      if (reaches(dependency, new Set())) throw new KnowledgeError('KNOWLEDGE_DEPENDENCY_CYCLE', '任务依赖不能成环或依赖自身');
    }
    const todo = { id, body, planId, dependsOn, completed: input.completed ?? current?.completed ?? false };
    this.todos.set(id, todo);
    return { ...todo, dependsOn: [...dependsOn] };
  }

  listTodos(filter: { ready?: boolean; planId?: string | null } = {}): KnowledgeTodo[] {
    return [...this.todos.values()].filter((todo) =>
      (filter.planId === undefined || todo.planId === filter.planId)
      && (!filter.ready || (!todo.completed && todo.dependsOn.every((id) => this.todos.get(id)?.completed === true))),
    ).map((todo) => ({ ...todo, dependsOn: [...todo.dependsOn] }));
  }

  deleteTodo(id: string): void {
    this.require(this.todos, id);
    this.todos.delete(id);
    for (const todo of this.todos.values()) {
      if (todo.dependsOn.includes(id)) this.todos.set(todo.id, { ...todo, dependsOn: todo.dependsOn.filter((dependency) => dependency !== id) });
    }
  }

  buildTodoDispatchPayload(todoId: string, target: 'current_session' | 'new_session' | 'new_worktree') {
    const todo = this.require(this.todos, todoId);
    if (!this.listTodos({ ready: true }).some((entry) => entry.id === todoId)) {
      throw new KnowledgeError('KNOWLEDGE_TODO_NOT_READY', '只能派发前置任务已完成的未完成任务');
    }
    const plan = todo.planId === null ? undefined : this.require(this.plans, todo.planId);
    return { todoId, target, planId: todo.planId, prompt: plan ? `${todo.body}\n\n${plan.body}` : todo.body };
  }

  savePlan(input: { id?: string; body?: string; expected?: string; sessionId?: string | null }): KnowledgePlan {
    if (input.sessionId !== undefined && (input.body !== undefined || input.expected !== undefined || input.id === undefined)) {
      throw new KnowledgeError('KNOWLEDGE_PLAN_SEPARATE_SESSION', '正文与会话绑定必须分别保存，绑定需要现有计划 ID');
    }
    const current = input.id === undefined ? undefined : this.require(this.plans, input.id);
    if (input.sessionId !== undefined) {
      const plan = { ...this.require(this.plans, input.id!), sessionId: input.sessionId };
      this.plans.set(plan.id, plan);
      return { ...plan, progress: { ...plan.progress } };
    }
    checkExpected(current?.body, input.expected);
    const body = bodyOf(input.body, 200_000);
    const plan = withStepsCheck({ id: current?.id ?? this.id('plan'), body, sessionId: current?.sessionId ?? null });
    this.plans.set(plan.id, plan);
    return { ...plan, progress: { ...plan.progress } };
  }

  listPlans(): KnowledgePlan[] { return [...this.plans.values()].map((plan) => ({ ...plan, progress: { ...plan.progress } })); }

  deletePlan(id: string): void {
    this.require(this.plans, id);
    this.plans.delete(id);
    for (const todo of this.todos.values()) if (todo.planId === id) this.todos.set(todo.id, { ...todo, planId: null });
  }
}
