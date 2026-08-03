import { registerDomainListener } from '@/features/workbench/agent/domainEvents';

type RefreshMemoryView = () => void | Promise<void>;

/** Keep an open Memory view in sync with Agent writes. */
export function registerMemoryDomainRefresh(
  refreshList: RefreshMemoryView,
  refreshTree: RefreshMemoryView,
): () => void {
  return registerDomainListener('memory://changed', () => {
    void refreshList();
    void refreshTree();
  });
}
