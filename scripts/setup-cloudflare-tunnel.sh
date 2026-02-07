#!/bin/bash
# Setup Cloudflare Tunnel for Raya
# Replaces ngrok with a free, permanent, stable tunnel.
#
# Prerequisites:
#   1. Cloudflare account (free tier works)
#   2. A domain pointed to Cloudflare (or use a .cfargotunnel.com subdomain)
#
# Usage: ./scripts/setup-cloudflare-tunnel.sh

set -e

echo "=== Cloudflare Tunnel Setup for Raya ==="
echo ""

# Step 1: Install cloudflared
if command -v cloudflared &> /dev/null; then
  echo "cloudflared already installed: $(cloudflared --version)"
else
  echo "Installing cloudflared..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install cloudflare/cloudflare/cloudflared
  else
    curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared.deb
    rm cloudflared.deb
  fi
  echo "Installed: $(cloudflared --version)"
fi

echo ""

# Step 2: Login
echo "Step 1: Login to Cloudflare"
echo "  This will open a browser window. Select the domain you want to use."
echo ""
cloudflared tunnel login

echo ""

# Step 3: Create tunnel
TUNNEL_NAME="raya-bot"
echo "Step 2: Creating tunnel '$TUNNEL_NAME'..."
cloudflared tunnel create "$TUNNEL_NAME" || echo "Tunnel may already exist, continuing..."

echo ""

# Step 4: Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "Tunnel ID: $TUNNEL_ID"

# Step 5: Create config
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"

echo ""
echo "Step 3: Creating config at $CONFIG_FILE"

read -p "Enter subdomain for Raya (e.g., raya.yourdomain.com): " SUBDOMAIN

cat > "$CONFIG_FILE" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $SUBDOMAIN
    service: http://localhost:3100
  - service: http_status:404
EOF

echo "Config written."

# Step 6: Create DNS route
echo ""
echo "Step 4: Creating DNS route for $SUBDOMAIN..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$SUBDOMAIN"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Your tunnel URL: https://$SUBDOMAIN"
echo ""
echo "To start the tunnel manually:"
echo "  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "To install as a system service (recommended for Mac Studio):"
echo "  sudo cloudflared service install"
echo ""
echo "Update your .env:"
echo "  TWILIO_PUBLIC_URL=https://$SUBDOMAIN"
echo ""
echo "The tunnel is free, permanent, and doesn't expire like ngrok."
