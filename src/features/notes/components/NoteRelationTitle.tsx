import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { dstu } from '@/dstu';
import type { NoteRelation } from '../noteRelations';

/** Titles are display-only and are resolved from the stable reference, never persisted as identity. */
export function NoteRelationTitle({ relation }: { relation: NoteRelation }) {
  const [title, setTitle] = useState('');
  useEffect(() => {
    let active = true;
    setTitle('');
    const resolve = async () => {
      if (relation.locator.type === 'card') {
        const cards = await invoke<Array<{ id: string; front: string; text?: string }>>('get_document_cards', { documentId: relation.resource_id });
        const value = cards?.find((card) => card.id === (relation.locator as { value: string }).value);
        if (active && value) setTitle(value.front || value.text || value.id);
      } else {
        const resource = await invoke<{ sourceId?: string; metadata?: { title?: string; name?: string } } | null>('vfs_get_resource', { resourceId: relation.resource_id });
        if (!resource) return;
        let name = resource.metadata?.title || resource.metadata?.name;
        if (!name && resource.sourceId) {
          const node = await dstu.get(`/${resource.sourceId}`);
          if (node.ok) name = node.value.name;
        }
        if (active && name) setTitle(name);
      }
    };
    // A missing/deleted target still renders its original ID and validity badge.
    void resolve().catch(() => {});
    return () => { active = false; };
  }, [relation.resource_id, relation.locator.type, relation.locator.type === 'whole' ? '' : relation.locator.value]);
  return <span title={relation.resource_id}>{title || relation.resource_id}</span>;
}
