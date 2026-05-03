#!/usr/bin/env bash
# Forge iOS deploy — fully non-interactive.
# Reads from EAS Cloud credentials configured once per README.md.
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

# Bump app.json and native Xcode build number together.
# Apple rejects duplicate builds, and EAS reads native iOS values when ios/ exists.
node -e '
  const fs = require("fs");
  const p = "./app.json";
  const xcode = "./ios/App/App.xcodeproj/project.pbxproj";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const cur = parseInt(j.expo.ios.buildNumber || "0", 10);
  const next = String(cur + 1);
  j.expo.ios.buildNumber = next;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");

  let pbx = fs.readFileSync(xcode, "utf8");
  const matches = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = ([0-9]+);/g)];
  if (!matches.length) throw new Error("No CURRENT_PROJECT_VERSION entries found");
  const versions = new Set(matches.map((m) => m[1]));
  if (versions.size !== 1 || !versions.has(String(cur))) {
    throw new Error(`Xcode build number mismatch: app.json=${cur}, xcode=${[...versions].join(",")}`);
  }
  pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [0-9]+;/g, `CURRENT_PROJECT_VERSION = ${next};`);
  fs.writeFileSync(xcode, pbx);

  console.log("buildNumber:", cur, "->", next);
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
  echo "   See: $REPO/README.md#ios-and-testflight (one-time ASC API Key setup)." | tee -a "$LOG"
  echo "   DO NOT ask Bryan to run terminal commands. Fix the cred setup once." | tee -a "$LOG"
  exit 1
fi

# Submit latest build to TestFlight.
eas submit --platform ios --latest --non-interactive 2>&1 | tee -a "$LOG"

echo "[$(date -u +%FT%TZ)] forge-ios deploy: DONE" | tee -a "$LOG"
