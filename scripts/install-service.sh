#!/bin/bash
# Install Raya as a launchd service (auto-start on boot, auto-restart on crash)
#
# Usage: bash scripts/install-service.sh

set -e

PLIST_SRC="$(dirname "$0")/com.raya.relay.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.raya.relay.plist"
LOG_DIR="$HOME/.claude-relay/logs"

# Create log directory
mkdir -p "$LOG_DIR"

# Stop existing service if running
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# Copy plist to LaunchAgents
cp "$PLIST_SRC" "$PLIST_DEST"

# Update paths in plist for current user
sed -i '' "s|/Users/markphaneuf|$HOME|g" "$PLIST_DEST"

# Load the service
launchctl load "$PLIST_DEST"

echo "Raya service installed and started!"
echo "  Logs: $LOG_DIR/relay.log"
echo "  Errors: $LOG_DIR/relay.err"
echo ""
echo "Commands:"
echo "  Stop:    launchctl unload ~/Library/LaunchAgents/com.raya.relay.plist"
echo "  Start:   launchctl load ~/Library/LaunchAgents/com.raya.relay.plist"
echo "  Status:  launchctl list | grep raya"
echo "  Logs:    tail -f ~/.claude-relay/logs/relay.log"
