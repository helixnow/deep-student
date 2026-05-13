import type { SessionGroup } from '../../types/group';

const groupCache = new Map<string, SessionGroup>();

export function setGroupsCache(groups: SessionGroup[]): void {
  groupCache.clear();
  groups.forEach((group) => {
    groupCache.set(group.id, group);
  });
}

export { groupCache };
