---
name: pandoc-export
description: Convert Markdown notes into DOCX or PDF via Pandoc. Use when the user wants an exportable document, thesis draft, or printable handout from Markdown sources.
requires:
  bins:
    - pandoc
    - python3
  env:
    - PANDOC_REFERENCE_DOC
metadata:
  openclaw:
    requires:
      bins:
        - pandoc
        - soffice
      env:
        - HOME
version: 2.1.0
skill-type: standalone
allowed-tools:
  - Bash
  - Read
  - Write
---

# Pandoc Export

Call `{baseDir}/scripts/export.py` with `--format docx|pdf`.

```bash
python3 {baseDir}/scripts/export.py --input notes.md --format docx
```
