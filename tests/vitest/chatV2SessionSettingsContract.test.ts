import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 session settings contract', () => {
  it('supports distinguishing omitted metadata from explicit null metadata', () => {
    const typesSource = readFileSync(resolve(process.cwd(), 'src-tauri/src/chat_v2/types.rs'), 'utf-8');

    expect(typesSource).toContain('pub metadata: Option<Option<Value>>');
    expect(typesSource).toContain('deserialize_with = "deserialize_optional_value"');
  });

  it('clears metadata when session settings explicitly send null', () => {
    const source = readFileSync(resolve(process.cwd(), 'src-tauri/src/chat_v2/handlers/manage_session.rs'), 'utf-8');

    expect(source).not.toContain('settings.metadata.clone().or(existing.metadata)');
    expect(source).toContain('merge_session_metadata(existing.metadata, &settings.metadata)');
  });
});
