/**
 * Re-export platform-level MindMap <-> Note Lecture Handout bridge so both
 * `notes` and `mindmap` features consume a single canonical implementation
 * without cross-feature layer violations.
 */
export * from '@/ui-kernel/services/mindmapHandoutBridge';
