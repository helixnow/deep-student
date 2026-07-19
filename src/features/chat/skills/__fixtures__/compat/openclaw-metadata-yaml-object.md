---
name: openclaw-browser-capture
description: Capture authenticated browser pages and export readable markdown. Use when the user needs a screenshot or clean text dump from a logged-in web app session.
metadata:
  openclaw:
    requires:
      bins:
        - chromium
        - node
      env:
        - BROWSER_PROFILE_DIR
license: Proprietary. LICENSE.txt has complete terms
homepage: https://example.com/skills/browser-capture
tags:
  - browser
  - capture
---

# Browser Capture

1. Launch Chromium with the configured profile
2. Navigate and wait for network idle
3. Export markdown via `{baseDir}/scripts/capture.mjs`
