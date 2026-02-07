#!/bin/bash
# Raya — Auto-restart wrapper
# Usage: ./start.sh
# Keeps Raya running 24/7. Restarts on crash with backoff.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.claude-relay/logs"
mkdir -p "$LOG_DIR"

MAX_BACKOFF=60
backoff=2

echo "Starting Raya (auto-restart enabled)..."

while true; do
  LOG_FILE="$LOG_DIR/raya-$(date +%Y%m%d).log"
  echo "[$(date)] Starting bot..." | tee -a "$LOG_FILE"

  cd "$SCRIPT_DIR"
  $HOME/.bun/bin/bun run src/relay.ts 2>&1 | tee -a "$LOG_FILE"
  EXIT_CODE=$?

  echo "[$(date)] Bot exited with code $EXIT_CODE" | tee -a "$LOG_FILE"

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date)] Clean exit. Not restarting." | tee -a "$LOG_FILE"
    break
  fi

  echo "[$(date)] Restarting in ${backoff}s..." | tee -a "$LOG_FILE"
  sleep $backoff

  # Exponential backoff (caps at MAX_BACKOFF)
  backoff=$((backoff * 2))
  if [ $backoff -gt $MAX_BACKOFF ]; then
    backoff=$MAX_BACKOFF
  fi
done
