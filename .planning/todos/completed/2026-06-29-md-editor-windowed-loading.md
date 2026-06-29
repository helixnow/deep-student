---
created: 2026-06-29 07:45
title: Implement windowed loading for markdown editor
area: ui
files:
  - src/features/learning-hub/apps/views/NoteContentView.tsx:12-18,434-446
  - src/features/notes/NotesCrepeEditor.tsx:11-29,643-696,973-1055
  - src/components/crepe/CrepeEditor.tsx:973-1115
source: "promoted from $gsd-note"
status: completed
completed: 2026-06-29T19:09:55+08:00
priority: P2
theme: general
---

## Goal

Implement line-window loading for the markdown editor so large notes stop freezing the UI on open.

## Context

The current Learning Hub note path mounts `NotesCrepeEditor` immediately from `NoteContentView`, and `NotesCrepeEditor` feeds the full markdown into `CrepeEditor` on startup. That makes large markdown files expensive to open.

## Solution

Add a configurable initial line window, load only that window on open, and extend the loaded window on demand as the user scrolls. Preserve save behavior, cursor position, and conflict handling while the window expands.
