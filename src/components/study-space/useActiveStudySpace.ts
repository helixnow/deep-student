import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionGroup } from '@/features/chat/types/group';
import { INBOX_SPACE_ID, type StudySpace } from '@/shared/study-space/types';
import { projectStudySpace, useStudySpaceStore } from '@/stores/studySpaceStore';

function sortActiveGroups(groups: SessionGroup[]): SessionGroup[] {
  return [...groups]
    .filter((group) => group.persistStatus === 'active')
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

export function useActiveStudySpace(externalGroups?: SessionGroup[]) {
  const {
    activeSpaceId,
    viewFilter,
    groupsById,
    profilesBySpaceId,
    mountsBySpaceId,
    loading,
    setActiveSpace,
    setViewFilter,
  } = useStudySpaceStore(
    useShallow((state) => ({
      activeSpaceId: state.activeSpaceId,
      viewFilter: state.viewFilter,
      groupsById: state.groupsById,
      profilesBySpaceId: state.profilesBySpaceId,
      mountsBySpaceId: state.mountsBySpaceId,
      loading: state.loading,
      setActiveSpace: state.setActiveSpace,
      setViewFilter: state.setViewFilter,
    })),
  );

  const spaces = useMemo<StudySpace[]>(() => {
    const sourceGroups =
      externalGroups !== undefined
        ? externalGroups
        : Object.values(groupsById);
    return sortActiveGroups(sourceGroups).map((group) =>
      projectStudySpace(
        group,
        profilesBySpaceId[group.id],
        mountsBySpaceId[group.id],
      ),
    );
  }, [externalGroups, groupsById, mountsBySpaceId, profilesBySpaceId]);

  const activeSpace = useMemo<StudySpace | null>(() => {
    if (activeSpaceId === INBOX_SPACE_ID) return null;
    const fromList = spaces.find((space) => space.spaceId === activeSpaceId);
    if (fromList) return fromList;
    const fallbackGroup = groupsById[activeSpaceId];
    if (!fallbackGroup) return null;
    return projectStudySpace(
      fallbackGroup,
      profilesBySpaceId[activeSpaceId],
      mountsBySpaceId[activeSpaceId],
    );
  }, [activeSpaceId, groupsById, mountsBySpaceId, profilesBySpaceId, spaces]);

  return {
    activeSpaceId,
    isInboxActive: activeSpaceId === INBOX_SPACE_ID,
    activeSpace,
    spaces,
    viewFilter,
    loading,
    setActiveSpace,
    setViewFilter,
  };
}
