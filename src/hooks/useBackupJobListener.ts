import { useRef, useEffect, useCallback, useState } from 'react';
import {
  DataGovernanceApi,
  type BackupJobEvent,
  isBackupJobTerminal,
} from '../api/dataGovernance';

interface UseBackupJobListenerOptions {
  onProgress?: (event: BackupJobEvent) => void;
  onComplete?: (event: BackupJobEvent) => void;
  onError?: (event: BackupJobEvent) => void;
  onCancelled?: (event: BackupJobEvent) => void;
}

interface UseBackupJobListenerReturn {
  startListening: (jobId: string) => Promise<void>;
  stopListening: () => void;
  isListening: boolean;
}

export function useBackupJobListener(
  options: UseBackupJobListenerOptions
): UseBackupJobListenerReturn {
  const unlistenRef = useRef<(() => void) | null>(null);
  const [isListening, setIsListening] = useState(false);
  const mountedRef = useRef(true);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  const stopListening = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setIsListening(false);
  }, []);

  const startListening = useCallback(
    async (jobId: string) => {
      stopListening();

      if (!mountedRef.current) return;

      setIsListening(true);

      // Track whether a terminal event has already been dispatched
      const terminalHandled = { current: false };

      const handleEvent = (event: BackupJobEvent) => {
        if (!mountedRef.current || terminalHandled.current) {
          return;
        }

        optionsRef.current.onProgress?.(event);

        if (isBackupJobTerminal(event.status)) {
          terminalHandled.current = true;
          if (event.status === 'completed') {
            optionsRef.current.onComplete?.(event);
          } else if (event.status === 'failed') {
            optionsRef.current.onError?.(event);
          } else if (event.status === 'cancelled') {
            optionsRef.current.onCancelled?.(event);
          }

          stopListening();
        }
      };

      const unlisten = await DataGovernanceApi.listenBackupProgress(
        jobId,
        (event: BackupJobEvent) => {
          if (!mountedRef.current) {
            unlisten();
            return;
          }
          handleEvent(event);
        }
      );

      if (mountedRef.current) {
        unlistenRef.current = unlisten;
      } else {
        unlisten();
        return;
      }

      // Polling fallback: check current job state once after listener setup.
      // This catches terminal events emitted between job start and listener registration.
      try {
        const job = await DataGovernanceApi.getBackupJob(jobId);
        if (job && mountedRef.current && !terminalHandled.current) {
          if (isBackupJobTerminal(job.status as BackupJobEvent['status'])) {
            handleEvent({
              job_id: job.job_id,
              kind: job.kind,
              status: job.status,
              phase: job.phase || '',
              progress: job.progress ?? 0,
              message: job.message,
              processed_items: 0,
              total_items: 0,
              cancellable: false,
              created_at: job.created_at,
              started_at: job.started_at,
              finished_at: job.finished_at,
              result: job.result,
            } as BackupJobEvent);
          }
        }
      } catch {
        // Polling fallback is best-effort; event listener is the primary mechanism
      }
    },
    [stopListening]
  );

  return {
    startListening,
    stopListening,
    isListening,
  };
}

export default useBackupJobListener;
