# Service-account setup — pushing effective-holdings data to the Google Sheet

`update_effective_holdings.py --online` writes the look-through Sankey block
(`AM:AO`) and summary block (`AQ:AS`) directly to the online Finance spreadsheet
so the **Capuchin** webapp can read them. Python can't reuse your `clasp`/Apps
Script login, so it authenticates with its **own service account**. Do this once.

> ⏱️ ~10 minutes. You need: a Google account (the one that owns the Finance sheet)
> and permission to create a Google Cloud project (free).

---

## 1. Create / pick a Google Cloud project
1. Go to <https://console.cloud.google.com/>.
2. Top bar → project picker → **New Project** (name it e.g. `capuchin-finance`), Create.
3. Make sure that project is selected in the top bar for the next steps.

## 2. Enable the two APIs
In the project, enable both (search each in the top search bar → **Enable**):
- **Google Sheets API**  → <https://console.cloud.google.com/apis/library/sheets.googleapis.com>
- **Google Drive API**   → <https://console.cloud.google.com/apis/library/drive.googleapis.com>

(`gspread.open_by_key` needs Sheets; Drive avoids occasional permission hiccups.)

## 3. Create the service account
1. **APIs & Services → Credentials** (or **IAM & Admin → Service Accounts**).
2. **+ Create credentials → Service account**.
3. Name: `capuchin-sheet-writer` → **Create and continue**.
4. **Skip** "Grant this service account access to project" (roles are NOT needed —
   access is granted by *sharing the sheet* in step 5). Click **Done**.

## 4. Download the JSON key
1. Click the new service account → **Keys** tab → **Add key → Create new key → JSON → Create**.
2. A `*.json` file downloads. **Rename it to `service_account.json` and move it into
   this folder** (`~/Git/anchal-physics/finance/`).
   - It is already in `.gitignore` — **never commit it; it's a credential.**
3. Open the file and copy the **`client_email`** value. It looks like:
   `capuchin-sheet-writer@capuchin-finance.iam.gserviceaccount.com`

## 5. Share the Finance sheet with the service account
1. Open the **Finance** Google Sheet in your browser.
2. **Share** → paste the `client_email` from step 4 → role **Editor** → Send.
   (No notification needed. This is what actually authorizes writes — the service
   account can only touch sheets you explicitly share with it.)

## 6. Get the spreadsheet ID
From the sheet URL:
`https://docs.google.com/spreadsheets/d/`**`THIS_LONG_ID`**`/edit#gid=0`
Copy the id between `/d/` and `/edit`.

## 7. Install dependencies
```bash
cd ~/Git/anchal-physics/finance
python3 -m venv .venv           # (already created if you followed earlier steps)
./.venv/bin/pip install -r requirements.txt
```

## 8. Run it
```bash
export FINANCE_SHEET_ID="THIS_LONG_ID"        # from step 6 (add to your shell profile to persist)
./.venv/bin/python update_effective_holdings.py --online --dry-run   # preview, writes nothing
./.venv/bin/python update_effective_holdings.py --online             # writes AM:AO + AQ:AS
```
Only cells `AM:AO` and `AQ:AS` on `Portfolio_AG` / `Portfolio_AA` are touched;
everything else (formulas, cached values, images, other sheets) is left alone.
Re-run whenever you want to refresh the look-through (it re-clears and rewrites
those two blocks).

---

## Everyday workflow
```bash
./.venv/bin/python update_effective_holdings.py --online     # push latest look-through to the sheet
```
Then the Capuchin webapp reads `AM:AO` and renders the effective-holdings Sankey
panel. (Local `Finance.xlsx` editing is still available without `--online` for
offline testing — it writes a `Finance.xlsx.bak` backup and is equally surgical.)

## Troubleshooting
| Symptom | Fix |
|---|---|
| `gspread ... 403 ... PERMISSION_DENIED` | You didn't share the sheet with the `client_email` (step 5), or share was Viewer not **Editor**. |
| `SpreadsheetNotFound` | Wrong `FINANCE_SHEET_ID`, or the sheet isn't shared with the service account. |
| `403 ... API has not been used/enabled` | Enable **Google Sheets API** (and Drive API) in the project (step 2). |
| `Service-account key not found` | `service_account.json` isn't in this folder, or set `GSPREAD_SA_FILE=/path/to/key.json`. |
| `N1 is not 'Ticker' → skipping` | That sheet isn't a portfolio-summary layout (the guard is protecting it). |

## Config knobs (env vars, optional)
| Var | Default | Meaning |
|---|---|---|
| `FINANCE_SHEET_ID` | — | the spreadsheet id (required for `--online`) |
| `GSPREAD_SA_FILE` | `service_account.json` | path to the key |
| `EFF_SHEETS` | `Portfolio_AG,Portfolio_AA` | sheets to update |
| `EFF_SANKEY_COL` | `AM` | first column of the Source/Value/Target block |
| `EFF_SUMMARY_COL` | `AQ` | first column of the Holding/Value/% block |
| `EFF_TOP_TARGETS` | `24` | # of distinct company nodes in the Sankey; rest → "Other holdings" |
