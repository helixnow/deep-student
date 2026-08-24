# anki_cards Image Occlusion preview

## Scope

- Connected the existing `ImageOcclusionOverlay` to collapsed and expanded
  `anki_cards` previews.
- The renderer reads only a successfully parsed
  `card.extra_fields._occlusion`; cards without the field keep their previous
  rendering path.
- No Rust pipeline code was changed.

## Rendering behavior

- Valid specs render the referenced image with percentage-positioned masks.
- Direct `data:`, `blob:`, HTTP(S), and Tauri asset URLs are used directly.
- Local paths pass through the Tauri asset protocol.
- VFS image source IDs are resolved through `vfs_resolve_resource_refs` and
  converted to validated image data URLs.
- While a VFS image is loading, or when it is unavailable, masks remain
  visible over a neutral fallback instead of crashing or exposing answers.
- Clicking a mask reveals its cloze group and does not bubble into the
  surrounding card edit/expand action.

## Defensive boundaries

- Missing `_occlusion`, malformed JSON, invalid object shapes, invalid
  geometry, and unsupported image URL schemes all degrade safely.
- The collapsed preview limits occlusion thumbnails to five, matching the
  existing plain-text stack preview limit. Expanded cards render their own
  overlay.

## Verification

- Added 10 focused Vitest cases for valid/mixed cards, absent fields,
  malformed JSON, invalid structures, VFS success/failure, reveal event
  isolation, local paths, and expanded rendering.
