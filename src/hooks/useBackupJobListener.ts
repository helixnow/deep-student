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

      const unlisten = await DataGovernanceApi.listenBackupProgress(
        jobId,
        (event: BackupJobEvent) => {
          if (!mountedRef.current) {
            unlisten();
            return;
          }

          optionsRef.current.onProgress?.(event);

          if (isBackupJobTerminal(event.status)) {
            if (event.status === 'completed') {
              optionsRef.current.onComplete?.(event);
            } else if (event.status === 'failed') {
              optionsRef.current.onError?.(event);
            } else if (event.status === 'cancelled') {
              optionsRef.current.onCancelled?.(event);
            }

            stopListening();
          }
        }
      );

      if (mountedRef.current) {
        unlistenRef.current = unlisten;
      } else {
        unlisten();
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
