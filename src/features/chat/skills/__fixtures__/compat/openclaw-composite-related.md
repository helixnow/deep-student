---
name: research-bundle
description: Composite research entrypoint that suggests loading retrieval and fetch skills together. Use when the user wants an end-to-end literature or web research workflow rather than a single tool.
skill-type: composite
related-skills:
  - knowledge-retrieval
  - web-fetch
dependencies:
  - knowledge-retrieval
requires:
  bins:
    - rg
metadata: '{"openclaw":{"requires":{"bins":["curl"],"env":["RESEARCH_CACHE_DIR"]}}}'
version: 0.9.0
license: MIT
tags: [research, composite]
---

# Research Bundle

Load related skills, then orchestrate search → fetch → synthesize.
