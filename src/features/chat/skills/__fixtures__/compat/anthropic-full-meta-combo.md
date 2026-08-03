---
name: academic-citation-helper
description: Format citations and bibliographies for academic papers. Use when the user asks for APA MLA Chicago citations, reference lists, or to fix inconsistent bibliography entries across a manuscript.
license: Apache-2.0
homepage: https://github.com/anthropics/skills/tree/main/skills/citation
tags:
  - academic
  - citation
  - writing
compatibility: Offline; works without network. Optional bibtex tooling if available.
version: 2.4.0
author: anthropics
disable-model-invocation: false
user-invocable: true
argument-hint: "[style] [doi-or-title]"
allowed-tools:
  - Read
  - Write
  - Grep
priority: 2
skill-type: standalone
---

# Academic Citation Helper

1. Ask for citation style if not provided
2. Normalize DOIs and titles
3. Emit a consistent reference list
