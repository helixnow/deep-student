#!/usr/bin/env bash

set -euo pipefail

# Resolve repo root (this script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Output file
TS="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$REPO_ROOT/dist"
OUT_FILE="$OUT_DIR/chat-core-bundle-$TS.zip"

# Ensure output directory exists
mkdir -p "$OUT_DIR"

# Candidate files (front-end + back-end core chat paths)
FILES=(
  "src/components/UniversalAppChatHost.tsx"
  "src/components/UnifiedSmartInputBar.tsx"
  "src/chat-core/runtime/CompatRuntime.ts"
  "src/chat-core/engine/StableStreamEngine.ts"
  "src/chat-core/components/MessageWithThinking.tsx"
  "src/chat-core/runtime/attachments.ts"
  "src/chat-core/utils/buildPersistableSnapshot.ts"
  "src/chat-core/utils/getStableMessageId.ts"
  "src/chat-core/utils/hostUnifiedSender.ts"
  "src/utils/tauriApi.ts"
  "src/contexts/DialogControlContext.tsx"
  "src/contexts/SubjectContext.tsx"
  "src-tauri/src/unified_chat/mod.rs"
  "src-tauri/src/unified_chat/pipeline.rs"
  "src-tauri/src/unified_chat/repo.rs"
  "src-tauri/src/unified_chat/types.rs"
  "src-tauri/src/llm_manager.rs"
  "src-tauri/src/commands.rs"
  "src-tauri/src/database.rs"
  "src-tauri/src/chat_search.rs"
  "src-tauri/src/providers/mod.rs"
)

# Filter existing files; warn for missing
EXISTING_LIST=()
MISSING_COUNT=0
for path in "${FILES[@]}"; do
  if [[ -e "$path" ]]; then
    EXISTING_LIST+=("$path")
  else
    echo "[WARN] Missing path, skipped: $path" >&2
    ((MISSING_COUNT+=1)) || true
  fi
done

if [[ ${#EXISTING_LIST[@]} -eq 0 ]]; then
  echo "[ERROR] No files to archive. Aborting." >&2
  exit 1
fi

echo "[INFO] Archiving ${#EXISTING_LIST[@]} files to: $OUT_FILE"

# Use zip with file list via stdin to preserve spacing safely
{
  for f in "${EXISTING_LIST[@]}"; do
    printf '%s\n' "$f"
  done
} | zip -q -@ "$OUT_FILE"

echo "[DONE] Wrote: $OUT_FILE"
if [[ $MISSING_COUNT -gt 0 ]]; then
  echo "[NOTE] Skipped $MISSING_COUNT missing path(s)." >&2
fi



