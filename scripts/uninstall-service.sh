#!/bin/bash
# Uninstall Raya launchd service
#
# Usage: bash scripts/uninstall-service.sh

PLIST_DEST="$HOME/Library/LaunchAgents/com.raya.relay.plist"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
rm -f "$PLIST_DEST"

echo "Raya service uninstalled."
