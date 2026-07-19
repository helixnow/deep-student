---
name: openclaw-whisper-transcribe
description: Transcribe local audio files with Whisper when the user asks for speech-to-text, meeting notes from audio, or subtitle generation from recordings.
metadata: '{"openclaw":{"requires":{"bins":["whisper","ffmpeg"],"env":["OPENAI_API_KEY"]}}}'
version: "0.3.1"
author: openclaw-community
---

# Whisper Transcribe

Run `{baseDir}/scripts/transcribe.sh` with the audio path. Prefer local Whisper when available.
