#!/usr/bin/env bash
# deploy.sh — push local files and publish a NEW VERSION to the existing web-app
# deployment, so the /exec URL updates in place (no new URL, no editor clicks).
#
# Why this exists: `clasp push` only updates HEAD (the /dev test URL). The /exec
# URL you bookmark/share is pinned to a deployment VERSION and won't change until
# you publish a new version. Plain `clasp deploy` would mint a *new* deployment
# (new URL); `clasp deploy -i <id>` re-versions the existing one (same URL).
#
# Usage:  ./deploy.sh ["change description"]
set -euo pipefail
cd "$(dirname "$0")"

command -v clasp >/dev/null 2>&1 || { echo "clasp not found (npm i -g @google/clasp)." >&2; exit 1; }

# Safety net: clasp obeys .claspignore (NOT .gitignore). Make sure it isn't
# about to push non-Apps-Script files (e.g. a stray .js under .venv, or the
# service-account key). Only inspect the "Not ignored files" section.
NOT_IGNORED="$(clasp status 2>/dev/null | awk '/Not ignored files/{f=1;next} /Ignored files/{f=0} f')"
if printf '%s\n' "$NOT_IGNORED" | grep -qiE '\.venv/|site-packages|node_modules|__pycache__|service_account\.json|\.py$'; then
  echo "✗ Aborting: clasp would push non-project files — fix .claspignore. clasp status:" >&2
  clasp status >&2
  exit 1
fi

echo "▸ Pushing…"
clasp push --force

# The web-app deployment is the versioned one (has an @<number>); @HEAD is /dev.
DID=$(clasp deployments | awk '/@HEAD/{next} /@[0-9]+/{id=$2} END{print id}')
if [ -z "${DID:-}" ]; then
  echo "No versioned web-app deployment found. Create one once in the editor" >&2
  echo "(Deploy ▸ New deployment ▸ Web app), then re-run ./deploy.sh." >&2
  exit 1
fi

DESC="${1:-Update $(date '+%Y-%m-%d %H:%M')}"
echo "▸ Publishing new version to deployment $DID …"
clasp deploy -i "$DID" -d "$DESC"
echo "✓ Done. The /exec URL now serves the new version (same URL). Hard-refresh mobile if cached."
