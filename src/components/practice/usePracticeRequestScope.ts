import { useCallback, useEffect, useMemo, useRef } from 'react';

export function usePracticeRequestScope(examId: string) {
  const scope = useMemo(() => ({ requestId: 0, disposed: false }), [examId]);
  const currentScopeRef = useRef(scope);
  currentScopeRef.current = scope;

  useEffect(() => {
    scope.disposed = false;
    return () => {
      scope.disposed = true;
      scope.requestId += 1;
    };
  }, [scope]);

  return useCallback(() => {
    const requestId = ++scope.requestId;
    return () => currentScopeRef.current === scope
      && !scope.disposed && scope.requestId === requestId;
  }, [scope]);
}
