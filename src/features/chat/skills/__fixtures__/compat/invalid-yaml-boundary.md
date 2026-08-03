---
name: broken-frontmatter
description: This fixture intentionally contains invalid YAML so the parser must fail cleanly.
tags:
  - ok
  nested_without_indent: true
  - still-broken
compatibility: [this, is, not, a, string
---

# Should not parse

Body is irrelevant when frontmatter YAML is illegal.
