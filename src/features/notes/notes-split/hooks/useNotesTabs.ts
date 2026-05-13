import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from '@tauri-apps/api/core';
import type { NoteItem } from "../../../../utils/notesApi";

export type UseNotesTabsParams = {
  notes: NoteItem[];
  setNotes: React.Dispatch<React.SetStateAction<NoteItem[]>>;
  setActive: React.Dispatch<React.SetStateAction<NoteItem | null>>;
  setSelectedTreeId: React.Dispatch<React.SetStateAction<string>>;
  persistPref: (
    key: string,
    value: string,
    options?: { message?: string; silent?: boolean },
  ) => Promise<boolean>;
  active: NoteItem | null;
  closeEditorForNote: (noteId: string) => void;
};

export type UseNotesTabsResult = {
  openTabs: string[];
  setOpenTabs: React.Dispatch<React.SetStateAction<string[]>>;
  tabsInitialized: boolean;
  tabsContainerRef: React.MutableRefObject<HTMLDivElement | null>;
  loadTabsPrefs: (availableNotes?: NoteItem[]) => Promise<string | null>;
  saveTabsPrefs: (nextTabs: string[], activeId?: string) => Promise<void>;
  openNoteInTab: (noteId: string) => Promise<void>;
  closeTab: (noteId: string) => void;
  onTabReorder: (tabId: string, fromIndex: number, toIndex: number) => void;
};

export function useNotesTabs({
  notes,
  setNotes,
  setActive,
  setSelectedTreeId,
  persistPref,
  active,
  closeEditorForNote,
}: UseNotesTabsParams): UseNotesTabsResult {
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [tabsInitialized, setTabsInitialized] = useState(false);
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = tabsContainerRef.current;
    if (node) {
      const handleWheel = (e: WheelEvent) => {
        // passive listener to avoid warnings
      };
      node.addEventListener("wheel", handleWheel, { passive: true });
      return () => {
        node.removeEventListener("wheel", handleWheel);
      };
    }
  }, []);

  const loadTabsPrefs = async (
    availableNotes?: NoteItem[],
  ): Promise<string | null> => {
    let activatedId: string | null = null;
    try {
      const raw = await invoke<string | null>('notes_get_pref', { key: 'notes_tabs' });
      const obj = JSON.parse(raw || "{}");
      const ids = Array.isArray(obj?.openTabs)
        ? (obj.openTabs as string[])
        : [];
      const allow = new Set((availableNotes || notes).map((n) => n.id));
      const filtered = ids.filter((id) => allow.has(id));
      setOpenTabs(filtered);
      if (obj?.activeId && allow.has(obj.activeId)) {
        const n = (availableNotes || notes).find((x) => x.id === obj.activeId);
        if (n) {
          setActive(n);
          setSelectedTreeId(n.id);
          activatedId = n.id;
        }
      }
      setTabsInitialized(true);
      return activatedId;
    } catch {
      setOpenTabs([]);
      setTabsInitialized(true);
      return activatedId;
    }
  };

  const saveTabsPrefs = async (nextTabs: string[], activeId?: string) => {
    await persistPref(
      'notes_tabs',
      JSON.stringify({ openTabs: nextTabs, activeId: activeId ?? active?.id }),
      { message: "notes:notifications.tagStateSaveFailed" } as any,
    );
  };

  const openNoteInTab = useCallback(
    async (noteId: string) => {
      const existing = notes.find((n) => n.id === noteId);
      if (!existing) {
        // Note should be loaded by NotesContext first
        console.warn('[useNotesTabs] Note not found in notes array:', noteId);
        return;
      }
      if (existing) {
        setActive(existing);
        setSelectedTreeId(existing.id);
        setOpenTabs((prev) =>
          prev.includes(existing.id) ? prev : [...prev, existing.id],
        );
      }
    },
    [notes, setActive, setNotes, setSelectedTreeId],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      setOpenTabs((prev) => {
        const idx = prev.indexOf(tabId);
        if (idx === -1) return prev;
        const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        if (active?.id === tabId) {
          const fallbackId = next[idx] ?? next[idx - 1] ?? null;
          if (fallbackId) {
            const note = notes.find((n) => n.id === fallbackId);
            if (note) {
              setActive(note);
              setSelectedTreeId(note.id);
            }
          } else {
            setActive(null);
            closeEditorForNote(tabId);
          }
        }
        return next;
      });
    },
    [active, closeEditorForNote, notes, setActive, setSelectedTreeId],
  );

  const onTabReorder = useCallback(
    (tabId: string, _fromIndex: number, toIndex: number) => {
      setOpenTabs((prev) => {
        const list = [...prev];
        const idx = list.indexOf(tabId);
        if (idx === -1) return prev;
        list.splice(idx, 1);
        list.splice(toIndex, 0, tabId);
        return list;
      });
    },
    []
  );

  return {
    openTabs,
    setOpenTabs,
    tabsInitialized,
    tabsContainerRef,
    loadTabsPrefs,
    saveTabsPrefs,
    openNoteInTab,
    closeTab,
    onTabReorder,
  };
}
