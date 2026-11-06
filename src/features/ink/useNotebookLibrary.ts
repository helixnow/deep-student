import { useCallback, useEffect, useRef, useState } from 'react';
import type { DstuNode } from '@/dstu';
import { scanNotebookSource, toNotebookEntry, type NotebookSource } from './NotebookLibrary';

export interface NotebookLoadFailure {
  source: NotebookSource;
  error: unknown;
}

interface NotebookLibraryState {
  nodes: DstuNode[];
  loading: boolean;
  complete: boolean;
  failures: NotebookLoadFailure[];
}

export function useNotebookLibrary(isActive: boolean) {
  const [state, setState] = useState<NotebookLibraryState>({
    nodes: [],
    loading: false,
    complete: false,
    failures: [],
  });
  const [refreshToken, setRefreshToken] = useState(0);
  const generationRef = useRef(0);
  const activeRef = useRef(isActive);
  activeRef.current = isActive;

  const refresh = useCallback(() => {
    if (activeRef.current) setRefreshToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!isActive) {
      setState((previous) => previous.loading ? { ...previous, loading: false } : previous);
      return;
    }
    let cancelled = false;
    const isCancelled = () => cancelled || generationRef.current !== generation || !activeRef.current;
    const nodes = new Map<string, DstuNode>();
    const failures: NotebookLoadFailure[] = [];
    setState({ nodes: [], loading: true, complete: false, failures: [] });

    const load = async (source: NotebookSource) => {
      try {
        await scanNotebookSource(source, (page) => {
          for (const node of page) {
            if (toNotebookEntry(node)) nodes.set(node.id, node);
          }
          setState((previous) => ({ ...previous, nodes: [...nodes.values()] }));
        }, isCancelled);
      } catch (error) {
        if (isCancelled()) return;
        failures.push({ source, error });
        setState((previous) => ({ ...previous, failures: [...failures] }));
      }
    };

    void Promise.all([load('note'), load('file')]).then(() => {
      if (isCancelled()) return;
      setState((previous) => ({ ...previous, loading: false, complete: failures.length === 0 }));
    });
    return () => { cancelled = true; };
  }, [isActive, refreshToken]);

  return { ...state, refresh };
}
