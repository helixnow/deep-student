import { useCallback, useEffect, useMemo, useRef } from 'react';

interface UploadTask {
  reader: FileReader;
  previewUrl: string;
  finished: boolean;
}

export function useAttachmentUploadScope(
  sessionId: string | undefined,
  attachments: ReadonlyArray<{ id: string }>,
) {
  const scope = useMemo(() => ({
    sessionId,
    disposed: false,
    tasks: new Map<string, UploadTask>(),
  }), [sessionId]);
  const currentScopeRef = useRef(scope);
  currentScopeRef.current = scope;

  const cancel = useCallback((id: string) => {
    const task = scope.tasks.get(id);
    if (!task) return;
    scope.tasks.delete(id);
    URL.revokeObjectURL(task.previewUrl);
    if (task.reader.readyState === FileReader.LOADING) task.reader.abort();
  }, [scope]);

  useEffect(() => {
    scope.disposed = false;
    return () => {
      scope.disposed = true;
      for (const id of scope.tasks.keys()) cancel(id);
    };
  }, [scope, cancel]);

  useEffect(() => {
    const ids = new Set(attachments.map(attachment => attachment.id));
    for (const id of scope.tasks.keys()) {
      if (!ids.has(id)) cancel(id);
    }
  }, [attachments, scope, cancel]);

  const isCurrent = useCallback(() => currentScopeRef.current === scope && !scope.disposed, [scope]);

  const beginUpload = useCallback((id: string, file: File) => {
    cancel(id);
    const task: UploadTask = {
      reader: new FileReader(),
      previewUrl: URL.createObjectURL(file),
      finished: false,
    };
    scope.tasks.set(id, task);
    if (!isCurrent()) cancel(id);
    return {
      reader: task.reader,
      previewUrl: task.previewUrl,
      isActive: () => currentScopeRef.current === scope && !scope.disposed &&
        !task.finished && scope.tasks.get(id) === task,
      finish: () => { task.finished = true; },
      cancel: () => {
        if (scope.tasks.get(id) === task) cancel(id);
      },
    };
  }, [cancel, scope, isCurrent]);

  return { beginUpload, isCurrent };
}
