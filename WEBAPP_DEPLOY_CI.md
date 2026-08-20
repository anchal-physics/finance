# Push-to-deploy CI for the Capuchin webapp

`.github/workflows/deploy-webapp.yml` deploys the Apps Script project on every
push to `main` that touches `*.gs` / `*.html` / `appsscript.json` (or manually via
"Run workflow"): it `clasp push`es the project and publishes a new version to the
existing web-app deployment (same `/exec` URL). Everything it needs lives in
**repo secrets**, so it keeps working when you switch or give up this computer.

## Why not a service account (like the Blue-Laser-Fusion repos)?
BLF uses a service account with Google **Workspace domain-wide delegation** to
impersonate a `@bluelaserfusion.com` user. Two blockers here:
- `anchal.physics@gmail.com` is a **personal** account — no Workspace admin
  console, so domain-wide delegation can't be set up.
- **Service accounts can't use the Apps Script API** for user/bound scripts at
  all except via that delegation. So no SA can `clasp push`/`deploy` this project,
  and `DEPLOY_USER_EMAIL` = the SA email would not help. (Your *holdings*
  workflow's `SERVICE_ACCOUNT_KEY` is fine — the **Sheets** API *does* accept
  service accounts once the sheet is shared with them. Different API, different rules.)

So the webapp deploy authenticates as **you** via a stored clasp OAuth token. To
make that token durable (not the 1-hour or 7-day expiry you hit before), we use
**your own Published OAuth client** and refresh the access token every run.

## One-time setup (do this from any browser — not tied to a computer)

**1. Turn on the Apps Script API for your account**
   → <https://script.google.com/home/usersettings> → toggle **Google Apps Script API** ON.

**2. Create your own OAuth client (so the refresh token doesn't expire)**
   In the Google Cloud project you already made for the service account:
   - **APIs & Services → OAuth consent screen** → User type **External** → fill the
     required fields → set **Publishing status = In production** (NOT "Testing" —
     testing tokens die after 7 days). You'll be the only user; an "unverified app"
     warning at login is expected — click **Advanced → Go to (app)**.
   - **APIs & Services → Credentials → Create credentials → OAuth client ID →
     Application type: Desktop app** → Create → **Download JSON** (e.g. `client.json`).

**3. Generate the clasp token with that client**
   ```bash
   clasp login --creds client.json      # opens a browser; approve for anchal.physics@gmail.com
   ```
   clasp prints where it saved the credentials (a `.clasprc.json`). That file now
   contains `tokens.default` with a durable `refresh_token`, plus your
   `client_id` / `client_secret`.

**4. Add the repo secrets** (Settings → Secrets and variables → Actions):
   | Secret | Value |
   |---|---|
   | `CLASPRC_JSON` | the **entire contents** of the `.clasprc.json` from step 3 |
   | `SCRIPT_ID` | the Apps Script **Script ID** (Project Settings in the editor, or your local `.clasp.json`) |
   | `DEPLOY_ID` | the web-app **deployment ID** (the `@N` entry from `clasp deployments`, i.e. the one the `/exec` URL uses) |

   `DEPLOY_USER_EMAIL` is **not used** by this workflow — you can delete it.
   `SERVICE_ACCOUNT_KEY` / `FINANCE_SHEET_ID` stay (they belong to the holdings workflow).

## How a deploy runs
Push a change to a `.gs`/`.html`/`appsscript.json` on `main` → the workflow:
1. refreshes the OAuth **access** token from your refresh token (fresh every run),
2. writes `.clasp.json` from `SCRIPT_ID` (it's gitignored, so CI regenerates it),
3. `clasp push --force` (obeys the committed `.claspignore`),
4. `clasp deploy -i $DEPLOY_ID` → new version on the same URL.

`.claspignore` (committed) keeps `clasp` from pushing `.venv`, `.github`, python,
secrets, etc. — only the `.gs`/`.html`/`appsscript.json` go up.

## Switching computers / rotating the token
Nothing is stored on this machine that the CI needs — the token is the
`CLASPRC_JSON` secret. If it ever stops working (revoked, or unused ~6 months),
just redo step 3 from **any** machine's browser and update the `CLASPRC_JSON`
secret. Local `./deploy.sh` still works too, from any machine where you've run
`clasp login`.
