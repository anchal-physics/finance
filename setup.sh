#!/usr/bin/env bash
# setup.sh — one-shot installer + pusher for the PayrollSankey webapp.
#
# Run from this folder on your Mac:
#   cd "/Users/anchal/Personal/PayrollSankey"
#   bash setup.sh
#
# What it does:
#   1. Ensures Node.js is available (fails with a clear message if not).
#   2. Installs @google/clasp into ~/.npm-global (avoids sudo / permission issues).
#   3. Prompts you to run `clasp login` in your browser if not already logged in.
#   4. Prompts for your Apps Script Script ID (only the first time, then remembered).
#   5. Runs `clasp push --force` to upload all 5 files.
#
# Idempotent — running it again just re-pushes.

set -e
cd "$(dirname "$0")"

echo "→ PayrollSankey webapp setup"
echo "  Working directory: $(pwd)"
echo ""

# --- Check Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install it from https://nodejs.org (LTS) or via:"
  echo "    brew install node"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js v$NODE_MAJOR is too old. Need v18+."
  exit 1
fi
echo "✓ Node.js $(node --version)"

# --- Install clasp into ~/.npm-global (no sudo needed) ---
export NPM_GLOBAL_PREFIX="$HOME/.npm-global"
mkdir -p "$NPM_GLOBAL_PREFIX"
export PATH="$NPM_GLOBAL_PREFIX/bin:$PATH"

if ! command -v clasp >/dev/null 2>&1; then
  echo "→ Installing @google/clasp into $NPM_GLOBAL_PREFIX ..."
  npm install -g @google/clasp --prefix "$NPM_GLOBAL_PREFIX" --silent
fi
echo "✓ clasp $(clasp --version)"

# --- Login check ---
if [ ! -f "$HOME/.clasprc.json" ]; then
  echo ""
  echo "→ You need to log clasp in to your Google account (one-time)."
  echo "  This will open your browser; sign in with agupta@bluelaserfusion.com"
  echo "  and grant clasp permission to manage Apps Script projects."
  echo ""
  read -p "  Press Enter to start login... " _
  clasp login
fi
echo "✓ clasp is logged in"

# --- Script ID handling ---
if grep -q "REPLACE_WITH_YOUR_SCRIPT_ID" .clasp.json 2>/dev/null; then
  echo ""
  echo "→ Your .clasp.json still has the placeholder Script ID."
  echo "  Find your Script ID:"
  echo "    1. Open your Finance spreadsheet in Google Sheets."
  echo "    2. Extensions → Apps Script."
  echo "    3. Project Settings (gear icon, left sidebar)."
  echo "    4. Copy the 'Script ID' (long alphanumeric string)."
  echo ""
  read -p "  Paste the Script ID here: " SCRIPT_ID
  if [ -z "$SCRIPT_ID" ]; then
    echo "✗ No Script ID entered. Aborting."
    exit 1
  fi
  # Replace placeholder in .clasp.json
  python3 -c "
import json, sys
p = '.clasp.json'
d = json.load(open(p))
d['scriptId'] = '$SCRIPT_ID'.strip()
json.dump(d, open(p, 'w'), indent=2)
print('  Updated .clasp.json with scriptId = ' + d['scriptId'][:8] + '...')
"
fi

CURRENT_ID=$(python3 -c "import json; print(json.load(open('.clasp.json'))['scriptId'])")
echo "✓ Script ID: ${CURRENT_ID:0:12}..."

# --- Pull first so we don't accidentally delete remote files we don't have locally ---
echo ""
echo "→ Pulling current remote state (so push won't delete unexpected files)..."
clasp pull || {
  echo "  (pull failed; continuing — this is OK if the remote project is empty)"
}

# --- Push ---
echo ""
echo "→ Pushing files to Apps Script..."
clasp push --force
echo ""
echo "✓ Push complete."
echo ""
echo "Next steps:"
echo "  1. Open your Apps Script project (Sheets → Extensions → Apps Script)."
echo "  2. Services (+ icon, left sidebar) → add 'Google Sheets API' if not there."
echo "  3. Deploy → New deployment → Web app."
echo "       Execute as: User accessing the web app"
echo "       Who has access: Anyone with Google account"
echo "  4. Copy the Web app URL and bookmark it."
echo "  5. Share the Finance spreadsheet with anyone who should use the webapp."
echo ""
echo "Future updates: just run this script again, or 'clasp push --force'."
