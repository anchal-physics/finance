# PayrollSankey Webapp — Deployment

## What gets deployed

All five files in this folder live in the **same Apps Script project** that
already contains `SankeyRenderer.gs`:

| File                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `appsscript.json`   | Manifest (web app config + Sheets advanced service)  |
| `SankeyRenderer.gs` | Existing menu-driven renderer (kept as-is)           |
| `Webapp.gs`         | New: server endpoints for the web app                |
| `WebappPage.html`   | New: the web app UI                                  |
| `PrintPage.html`    | New: print-to-PDF view                               |

You don't need to remove anything — the new files coexist with the existing
menu script.

---

## Path A — Push via clasp (recommended, one-time setup)

**clasp** is Google's official command-line tool for Apps Script. After a
one-time install + login, `clasp push --force` from this folder updates every
file in the project in a single command.

### Step 1: Install Node.js and clasp

You probably already have Node. Check:

```bash
node --version    # need v18 or newer
```

If missing, install from https://nodejs.org (LTS) or via Homebrew:

```bash
brew install node
```

Install clasp globally:

```bash
npm install -g @google/clasp
```

### Step 2: Log clasp into your Google account (browser flow)

```bash
clasp login
```

This opens your browser, asks you to sign in with `agupta@bluelaserfusion.com`,
and grants clasp permission to manage Apps Script projects on your behalf.
After approval, close the tab — credentials are saved in `~/.clasprc.json`.

### Step 3: Find your bound Script ID

1. Open your Finance spreadsheet in Google Sheets.
2. **Extensions → Apps Script** opens the bound script in a new tab.
3. **Project Settings** (the gear icon in the left sidebar).
4. Copy the **Script ID** (a 50+ character string).

### Step 4: Paste the Script ID into `.clasp.json`

Open `.clasp.json` in this folder and replace `REPLACE_WITH_YOUR_SCRIPT_ID`
with the value you copied:

```json
{
  "scriptId": "1AbCdEf...the-long-string...XyZ",
  "rootDir": ".",
  "filePushOrder": ["appsscript.json", "SankeyRenderer.gs", "Webapp.gs", "WebappPage.html", "PrintPage.html"]
}
```

### Step 5: Push

```bash
cd "/Users/anchal/Personal/PayrollSankey"
clasp push --force
```

`--force` tells clasp to skip its prompt about overwriting `appsscript.json`.
You should see:

```
└─ appsscript.json
└─ SankeyRenderer.gs
└─ Webapp.gs
└─ WebappPage.html
└─ PrintPage.html
Pushed 5 files.
```

### Step 6: Enable the Sheets advanced service (one-time, in the Apps Script UI)

The push uploads `appsscript.json` which **declares** the Sheets service, but
the Apps Script UI still needs you to confirm it once:

1. In the Apps Script editor, click **Services** in the left sidebar (the `+`
   icon).
2. Find **Google Sheets API**, click **Add**.
3. It should match the existing `userSymbol: "Sheets"` from the manifest.

Without this step, `moveSheetRow()` (drag-reorder) will fail.

### Step 7: Deploy as Web App

In the Apps Script editor:

1. **Deploy → New deployment**.
2. Type: **Web app**.
3. Description: "PayrollSankey v1" (or whatever).
4. Execute as: **User accessing the web app**.
5. Who has access: **Anyone with Google account**.
6. Click **Deploy**, authorize when prompted (review and accept the OAuth
   scopes — spreadsheets, userinfo, etc.).
7. Copy the **Web app URL** that appears. Bookmark it.

### Step 8: Share the spreadsheet with anyone who should use the webapp

The webapp runs as the *visitor*, so a visitor needs Drive access to the
Finance spreadsheet to read/write anything. From Google Sheets:

1. **Share** button (top right).
2. Add the spouse's / collaborator's Google email.
3. Permission: **Editor** (so writes succeed).

Now sharing the web app URL with them, and they're set.

### Subsequent updates

When the code changes, just:

```bash
clasp push --force
```

No need to repeat steps 6–8. **If the manifest scopes change, the next time
you open the deployed URL it will prompt you to re-authorize**.

---

## Path B — Manual upload (no clasp)

If you don't want to install Node/clasp:

1. Open the bound script: Sheets → Extensions → Apps Script.
2. For each of the five files in this folder:
   - In the Apps Script editor, click the **+** next to "Files" in the left
     sidebar.
   - Choose **Script** for `.gs`, **HTML** for `.html`. Don't add the
     extension — Apps Script adds it.
   - Paste the content from this folder's matching file.
   - For `appsscript.json`, you may need to enable "Show appsscript.json
     manifest file" first via **Project Settings**.
3. **Services → +** → add **Google Sheets API**.
4. Continue from **Path A Step 7** (Deploy as Web App).

---

## Troubleshooting

**"Authorization required"** on the first webapp load — expected, click
through the OAuth prompt. Required scopes are listed in `appsscript.json`.

**"You do not have access"** when someone tries to use the webapp — they need
Drive Edit access on the Finance spreadsheet (Path A Step 8).

**Sheets API "not enabled" error** when reordering — re-do Path A Step 6.

**clasp says "scriptId is required"** — `.clasp.json` still has
`REPLACE_WITH_YOUR_SCRIPT_ID`.

**clasp push wants to delete files** — the `.claspignore` allowlist makes
clasp only manage the five files we care about. If you push and clasp wants
to delete `SankeyRenderer.gs`, your `.claspignore` was edited or missing.
Restore from this folder.

**Old "Sankey Converter" menu still showing in the sheet** — your project
still contains `Sankey.gs` (the legacy file). Delete it from the Apps Script
editor (right-click the file → Remove) and reload the sheet.
