/**
 * `roxmltree` boundary (`mindmapXml`), consumed by L13 `mindmap_import`.
 *
 * Rust (`builtin_resource_executor.rs:3252,3437,3822,3944`) calls
 * `roxmltree::Document::parse(text)` with default options.  This service runs the
 * same `roxmltree = 0.20.0` crate in the shared F7 WASI engine: DTDs are rejected
 * (`XML with DTD detected`), CDATA merges into the adjacent text node, and parse
 * failures throw an `Error` whose message is `roxmltree::Error`'s `Display`.
 * `parse` returns `doc.root_element()`; the shape is L13's published type.
 */
import type { MindmapXmlNode, MindmapXmlParser } from '../../../plugins/vfs/api.ts';

export type { MindmapXmlNode, MindmapXmlParser };

declare module '@deepseek-ai/cordis' {
  interface Context { mindmapXml: MindmapXmlParser }
}
