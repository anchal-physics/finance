# Drive-folder transactions → auto-update pipeline

Drop a brokerage CSV into a shared Google Drive folder and, within the hour, the
Portfolio_* sheets refresh themselves — merged ledger + look-through holdings.

```
 upload CSV to Drive folder
        │
        ▼
 DriveWatch.gs   (open web app polls every ~30 s; 12 h trigger as backstop)
        │  folder changed?  → POST repository_dispatch
        ▼
 GitHub Actions: update-holdings.yml  (event: new-transactions)
        │  build_transactions.py --online   (Drive CSVs → Portfolio_* A:J)
        │  recalc_sheet.py                   (force recalc + settle)
        │  update_effective_holdings.py --online  (summary → AN:AP Sankey)
        ▼
 Finance sheet updated
```

## Pieces

- **Drive folder** `investment_transactions_data` — holds the raw broker CSVs,
  shared (Viewer) with the **transactions service account** (the same
  `client_email` in `service_account.json`) so the Python side can download them.
  Keep files as raw `.csv` (don't let Drive convert them to Google Sheets).
- **`build_transactions.py`** — with `TX_DRIVE_FOLDER` set (or `--drive-folder <id>`)
  it downloads every CSV from that folder instead of reading local `data/`.
- **`update-holdings.yml`** — now runs *both* steps and also fires on
  `repository_dispatch: new-transactions`.
- **`DriveWatch.gs`** — watches the folder and dispatches. The open web app calls
  `pollDriveChanges()` every ~30 s (fast path); a 12-hour time trigger is the
  backstop for when the app is closed. Both share one lock-guarded detector +
  snapshot, so they never double-fire.

## Local config (Python)

Copy `.env.example` → `.env` (gitignored) and set `FINANCE_SHEET_ID` +
`TX_DRIVE_FOLDER`. Then:

```bash
# reads the Drive folder, merges, writes A:J on both Portfolio_* sheets
python build_transactions.py --online
```

(No `.env`? Pass `--drive-folder <id>`, or omit both to read local `data/*.csv`.)

## GitHub repo secrets (Actions)

The workflow needs (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `SERVICE_ACCOUNT_KEY` | service-account JSON (already set — holdings) |
| `FINANCE_SHEET_ID` | the Google Sheet id (already set) |
| `TX_DRIVE_FOLDER` | **new** — the Drive folder id |

## Apps Script trigger (one-time)

1. **Create a fine-grained GitHub PAT** (github.com → Settings → Developer
   settings → Fine-grained tokens): repository access = **`anchal-physics/finance`**,
   Repository permissions → **Contents: Read and write** (required to POST
   `repository_dispatch`). Copy the token.
2. In the **Apps Script editor** (the bound Capuchin project) → **Project
   Settings → Script Properties**, add:
   - `DRIVE_FOLDER_ID` = the folder id (the `…/drive/folders/<ID>` part of the
     folder URL; it's also in your local `.env` as `TX_DRIVE_FOLDER`)
   - `GITHUB_PAT` = the token from step 1
   - (`GITHUB_REPO` defaults to `anchal-physics/finance`; `DISPATCH_EVENT` to
     `new-transactions` — only set these to override.)
   Or run `setDriveWatchConfig("<folderId>", "<pat>")` once from the editor.
3. Run **`installDriveWatchTrigger()`** once (Run ▸). Approve the new Drive +
   external-request scopes. It seeds a baseline snapshot (so it won't fire on the
   first poll) and creates the **12-hour backstop trigger**. (The open web app's
   30 s `pollDriveChanges()` needs no install — it ships with the client and uses
   the same config/snapshot.)
   - Test the wiring immediately with **`dwTestDispatch()`** — it forces one
     dispatch; check the repo's Actions tab for a run.
   - Stop the trigger anytime with **`removeDriveWatchTrigger()`** (the 30 s app
     poll keeps working; both share the same detector).

Because `DriveWatch.gs` and the new `drive.readonly` scope are in the Apps Script
project, they ship with the normal CI deploy (push to `main`).

## Notes / caveats

- **Cadence:** ~30 s while you have the web app open (the client poll runs as you
  and needs Drive access, so it's your sessions that trip it — which is who
  uploads anyway); otherwise the 12-hour trigger catches it. One Actions run per
  detected change, not per upload burst.
- **Recalc:** after `build_transactions.py` rewrites the raw rows, the workflow
  runs `recalc_sheet.py` (re-stamps every GOOGLEFINANCE / GET_ALL_STOCK_SUMMARIES
  / TODAY formula to itself — the Python equivalent of `forceRecalc_`) and waits
  ~25 s so the summary + prices are fresh before the holdings step reads `N:W`.
  If a run's holdings ever still look stale, the twice-daily freshness trigger
  reconciles it and you can re-run the workflow.
- **Public repo → public Action logs.** The scripts run with `--quiet` in CI so
  dollar figures and the folder id stay out of the logs. Keep it that way if you
  add steps.
