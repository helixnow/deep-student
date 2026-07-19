---
name: marketplace-listing
description: Demonstrate preservation of marketplace-only frontmatter keys that Deep Student does not elevate to first-class fields yet, while still parsing license homepage tags compatibility.
license: MIT
homepage: https://skills.example/marketplace-listing
tags: [marketplace, demo]
compatibility: Works with AgentSkills-compatible hosts
x-marketplace-score: 98
x-install-hint: "npx skills add marketplace-listing"
custom-config:
  channel: stable
  region: cn
---

# Marketplace Listing

Unknown keys must survive parse → serialize → parse.
