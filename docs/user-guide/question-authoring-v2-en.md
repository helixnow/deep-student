# Question Import and Shared Materials

The parsing model selected in the importer is the main model. A multimodal model
reads the complete original visual input directly. A configured visual model is
used only when visual evidence must be adapted for a text-only main model. The
actual route is shown in the import workflow.

Question and answer files can be supplied together. Documents of 1-20 pages are
provided in one main parsing request. Longer documents are not silently clipped
at page 20. Provider input, image-count and output limits remain real limits and
produce explicit errors; choose a suitable model/configuration or split the
source deliberately.

When a provider rejects the full input, the importer offers explicit original
page ranges. Select the needed question, material and answer ranges together.
Unselected pages remain visible as unprocessed coverage; confirming such a draft
does not mark the entire source complete.

Parsing produces a persisted draft, not formal questions. Review the shared
materials, question selection and unresolved answer associations, then confirm
the import. Only the successful commit receipt establishes that questions have
been added. Missing answers remain missing during extraction; the system does
not ask another model to invent them or conceal truncated source evidence.

Conversation authoring uses the current conversation model. A request to preview
or parse does not authorize committing formal questions. Direct authoring tool
arguments and background document parsing share the same document contract.

A shared passage or common condition is stored once. Each child question retains
its own practice, grading, favorite and review identity. Random single-question
practice must still include its required materials. Material edits use version
checks; referenced materials cannot be silently removed.

Use **Groups and Materials** to reorder membership, edit group names and material
links, dissolve a group while retaining each child's necessary material, or
explicitly delete a group and its children. **Import History and Reparse Review**
audits legacy preview cards and compares saved drafts against current questions.
Existing identities and history are not replaced without explicit confirmation.
**Original Source** opens the real page and highlights its source bounding box
when available; unknown historical coordinates are not fabricated.

Pending conversation drafts appear in the question bank and can be confirmed
without parsing again. Conversation tools can also list/read/review/commit those
saved drafts; only a `committed=true` receipt means the import is finished.

Version 2 JSON preserves question types, structured data, material/group
relationships and source references. Use the portable ZIP format to include
actual image/source assets across databases. TXT/Markdown and CSV are display
formats, not lossless shared-material backups.
