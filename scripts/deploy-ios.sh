#!/usr/bin/env bash
# Forge iOS deploy — fully non-interactive.
# Reads from EAS Cloud credentials configured ONCE per DEPLOY-IOS.md.
# If credentials are missing, fails with a pointer to that doc — never prompts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO/frontend"
LOG_DIR="$HOME/.openclaw/logs/forge-ios-deploy"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d_%H%M%S).log"

cd "$APP_DIR"

PROFILE="${1:-production}"   # production | preview
echo "[$(date -u +%FT%TZ)] forge-ios deploy: profile=$PROFILE" | tee -a "$LOG"

# Bump buildNumber in app.json (Apple rejects duplicate builds for the same version).
node -e '
  const fs = require("fs");
  const p = "./app.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const cur = parseInt(j.expo.ios.buildNumber || "0", 10);
  j.expo.ios.buildNumber = String(cur + 1);
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  console.log("buildNumber:", cur, "->", j.expo.ios.buildNumber);
' | tee -a "$LOG"

# Build. --non-interactive forces failure (not prompt) if EAS credentials are missing.
if ! eas build \
      --platform ios \
      --profile "$PROFILE" \
      --non-interactive \
      --wait 2>&1 | tee -a "$LOG"; then
  echo "" | tee -a "$LOG"
  echo "❌ EAS build failed." | tee -a "$LOG"
  echo "   If error mentions credentials/provisioning/cert — EAS Cloud is missing iOS creds." | tee -a "$LOG"
  echo "   See: $REPO/DEPLOY-IOS.md (one-time ASC API Key setup)." | tee -a "$LOG"
  echo "   DO NOT ask Bryan to run terminal commands. Fix the cred setup once." | tee -a "$LOG"
  exit 1
fi

# Submit latest build to TestFlight.
eas submit --platform ios --latest --non-interactive 2>&1 | tee -a "$LOG"

echo "[$(date -u +%FT%TZ)] forge-ios deploy: DONE" | tee -a "$LOG"
