/**
 * Shell-owned file loading for Tauri capabilities. Domain decoding is shared with Host ACL
 * through kernel/api.ts; this layer only handles UTF-8, file context and duplicate identifiers.
 * The value-level decoder does not claim raw typed-list/from_str error-order equivalence.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityDecodeError, decodeCapabilityFile, type Capability } from '../../host/kernel/api.ts';

/** `acl/build.rs::parse_capabilities`: reject duplicate identifiers across files and lists. */
export function readCapabilityDir(dir: string): Capability[] {
  const out: Capability[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const path = join(dir, file);
    let caps: Capability[];
    try {
      // fs::read_to_string rejects invalid UTF-8 and preserves BOM for JSON to reject.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
      caps = decodeCapabilityFile(JSON.parse(text), path);
    } catch (error) {
      const detail = error instanceof CapabilityDecodeError ? error.detail : error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse capability file ${path}: ${detail}`);
    }
    for (const cap of caps) {
      if (seen.has(cap.identifier)) throw new Error(`capability with identifier \`${cap.identifier}\` already exists`);
      seen.add(cap.identifier);
      out.push(cap);
    }
  }
  return out;
}
