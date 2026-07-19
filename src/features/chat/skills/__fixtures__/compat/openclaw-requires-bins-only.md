---
name: ffmpeg-clip
description: Cut and re-encode short video clips with ffmpeg when the user asks to trim a recording, export a highlight, or convert a clip for sharing.
metadata:
  openclaw:
    requires:
      bins:
        - ffmpeg
        - ffprobe
version: 1.0.2
author: openclaw-community
allowed-tools:
  - Bash
---

# FFmpeg Clip

Run `{baseDir}/scripts/clip.sh` with `--start` and `--end`.
