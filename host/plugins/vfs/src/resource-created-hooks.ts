/**
 * vfs/hooks.rs:120-136 `ResourceCreatedHook` registry and `notify_resource_created`.
 * L18 registers the short-audio transcription hook; upload commands notify.
 */
export type ResourceCreatedHook = (resourceId: string) => void;

export interface ResourceCreatedHooks {
  /** Returns a disposer that removes this registration. */
  register(hook: ResourceCreatedHook): () => void;
  /** Snapshot first, then call without holding the list (hooks.rs:131-135). */
  notify(resourceId: string): void;
}

export function createResourceCreatedHooks(): ResourceCreatedHooks {
  const hooks: ResourceCreatedHook[] = [];
  return {
    register(hook) {
      hooks.push(hook);
      return () => {
        const index = hooks.indexOf(hook);
        if (index >= 0) hooks.splice(index, 1);
      };
    },
    notify(resourceId) {
      for (const hook of [...hooks]) hook(resourceId);
    },
  };
}
