export type TaskCenterStatus = 'running' | 'blocked' | 'completed' | 'unknown';

export interface TaskCenterSessionLike {
  id: string;
  metadata?: Record<string, unknown>;
  workspaceKey?: string;
}

export interface TaskCenterSummary {
  workspaceKey: string;
  status: TaskCenterStatus;
  artifactCount: number;
  changeCount: number;
  lastArtifact?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

export function summarizeTaskSession(session: TaskCenterSessionLike): TaskCenterSummary {
  const metadata = session.metadata ?? {};
  const rawStatus = text(metadata.taskStatus ?? metadata.task_status);
  const status: TaskCenterStatus = rawStatus === 'blocked'
    ? 'blocked'
    : rawStatus === 'running' || rawStatus === 'streaming' || rawStatus === 'pending'
      ? 'running'
      : rawStatus === 'completed' || rawStatus === 'success'
        ? 'completed'
        : 'unknown';
  return {
    workspaceKey: session.workspaceKey
      ?? text(metadata.workspaceId ?? metadata.workspace_id)
      ?? text(metadata.defaultRuntimeRootId ?? metadata.default_runtime_root_id)
      ?? 'default',
    status,
    artifactCount: count(metadata.artifactCount ?? metadata.artifact_count),
    changeCount: count(metadata.changeCount ?? metadata.change_count),
    lastArtifact: text(metadata.lastArtifact ?? metadata.last_artifact),
  };
}

export function groupTaskSessions<T extends TaskCenterSessionLike>(sessions: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  sessions.forEach((session) => {
    const key = summarizeTaskSession(session).workspaceKey;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  });
  return groups;
}
