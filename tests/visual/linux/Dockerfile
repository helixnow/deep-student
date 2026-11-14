# Canonical environment for the platform-specific FE-A1 baselines (screenshots, DOM golden).
# Same Playwright/Chromium as package.json (@playwright/test 1.60.0), fonts pinned by package set;
# the font-environment.json check in __screenshots__/linux/ detects any drift of the resolved fonts.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# dom-golden.mjs imports a .ts helper through Node's built-in type stripping (Node >= 23.6).
ARG NODE_MAJOR=24
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync git \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation2 \
 && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DS_VISUAL_PLATFORM=linux \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

WORKDIR /work
