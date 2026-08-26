# PayrollSankey + Finance Tools — Project Context

> **Read this file first.** It captures every architectural decision, the
> exact spreadsheet structure, deployment workflow, coding conventions,
> rebuild history, and user preferences for this project. A fresh Claude
> instance opened in this repo should be able to continue work without
> re-asking the user to re-explain anything.

---

## 1. What this project is

A bound Google Apps Script project attached to **Finance.xlsx** (the user's
personal/family finance workbook in Google Sheets). It does three things:

1. **Sankey diagram tooling** — converts the `PayrollSankey` sheet's
   3-column flow data (Source | Value | Target) into a rendered Sankey
   diagram. Originally just emitted text for sankeydiagram.net; now
   renders the diagram directly inside Sheets via a modal dialog
   (`SankeyRenderer.gs`) and via a deployed web app (`Webapp.gs` +
   `WebappPage.html`).

2. **Tax functions** (`Tax.gs`) — custom spreadsheet functions
   `=FedTax(income, year, [status])` and `=CATax(income, year, [status])`
   for US federal and California state income tax, with backward-compat
   year-specific aliases (`FED_TAX_2023`, `STATE_TAX_2024`, etc.).

3. **Portfolio summary function** (`Stock.gs`) — custom function
   `=GET_ALL_STOCK_SUMMARIES(accounts, dates, instruments, codes, quantities,
   amounts)` that does FIFO lot accounting over a **multi-account** transaction
   log on `Portfolio_AG`/`Portfolio_AA` and emits a 2D spilled array of
   `[account, ticker, totalShares, ltShares, stShares, ltAvgCost, stAvgCost]`
   for each currently-held **(account, ticker)** pair. IRA accounts report all
   shares as long-term. The ledger itself is built by `build_transactions.py`.

4. **Investment dashboard pages** (in the same web app) — two extra tabs,
   **Anchal** and **Anamika**, alongside the PayrollSankey landing tab.
   Each renders, from the `Investment` sheet: a hand-rolled SVG **donut/pie**
   (categories as color groups, tickers as shaded sub-slices split by dotted
   radial lines) with an **alphabetical allocation table** beside it (ticker /
   weekly $ / % of strategy, `invBuildAllocTable`), a hand-rolled SVG **bar
   chart** of strategy-weighted 6mo/1yr/3yr/5yr returns, a per-chart
   **settings** panel, and a full-parity **editor** over that investor's
   columns. Both charts embed a subtitle: *"Investing $X/week at an effective
   expense ratio of Y%."* Nav is tabs (desktop) / hamburger drawer (mobile).

**User**: Anchal (agupta@bluelaserfusion.com). Lives in CA. The workbook
also tracks his wife's (Anamika's) payroll/expenses; both have separate
columns in the Tax and PayrollSankey sheets.

---

## 2. Repository layout

This repo now lives at `~/Git/anchal-physics/finance/`. Files:

| File | Purpose | Don't lose this |
|------|---------|------------------|
| `SankeyRenderer.gs` | Menu-driven Sankey renderer + sankeydiagram.net-style modal dialog. Big file (~42 KB) — most of the bulk is inline HTML+JS for the dialog. | yes |
| ~~`Sankey.gs`~~ | **Deleted** (in git history at/before this point). Legacy copy/paste-to-sankeydiagram.net converter, superseded by `SankeyRenderer.gs`. Removed from `.clasp.json` `filePushOrder` too. | gone |
| `Webapp.gs` | **Thin top-level combiner only**: `doGet` (routing), `include()`, and cross-feature server code shared by all tabs — print-to-PDF handoff (`storePrintSvg`/`servePrintPage_`), generic named settings (`getNamedSettings`/`saveNamedSettings`), reorder ack, and shared helpers (`setCellSmart_`, `moveRowOnSheet_`, `safeGetUserEmail_`). No feature logic. Add a feature ⇒ add a new `<Feature>.gs`; Webapp only routes. ~150 lines. | yes |
| `PayrollSankey.gs` | Server for the PayrollSankey landing tab: bootstrap payload, snapshot/polling, cell writes, row add/delete/move (`moveSheetRow`), settings + subpanel locks, `getEffectiveRange_`, `addNewLevel`. | yes |
| `Portfolio.gs` | Server for the portfolio-stats tabs. Config-driven `PORTFOLIOS_` (key → sheet name → label); `getPortfolioList()` + `getPortfolioStats(key)` read the computed summary columns (`N` account/`O` ticker … `AC`–`AG` changes, `AN`–`AP` Sankey) of a `Portfolio_*` sheet, **aggregating by ticker across accounts** and excluding cash. Add an investor = one `PORTFOLIOS_` entry. | yes |
| `Investment.gs` | Server for the Anchal/Anamika tabs: `computeInvestmentModel_`, `getInvestmentData`, editor endpoints (`getInvestmentEditor`, `writeInvestmentCell`, `addInvestmentStock`/`addInvestmentCategory`, `clearInvestmentRow`, `pollInvestment`), read-only/auto-fill column config, + investment-only helpers. | yes |
| `WebappPage.html` | **Shell only** — `<head>`, topbar, tab nav, page containers, and the one `<script>` IIFE that stitches the client modules via `<?!= include('…') ?>`. The actual code lives in the partials below. | yes |
| `Styles.html` | All CSS (the `<style>` block), included into `<head>`. | yes |
| `PayrollSankeyPage.html` | Static markup for the PayrollSankey landing page's 3 panels. | yes |
| `CoreJs.html` | Shared client JS: bootstrap/state/constants, `PALETTES`, `escapeHtml`, `toast`, `serializeSvg`, `exportSvgStringToPng/Pdf`. | yes |
| `PayrollSankeyJs.html` | PayrollSankey client JS: parser, renderer, subpanel editor, persistence, drag, polling, Sankey export. | yes |
| `InvestmentJs.html` | Investment client JS: pie/bar SVG builders, legend, settings, editor, tab nav (generic — `PAGE_TITLES` + delegated `#tabs` handler), per-chart export, polling. | yes |
| `PortfolioJs.html` | Portfolio-stats client JS: pie (holdings by value) + stats box, **3-level effective-holdings Sankey** (account → ticker → company, depth-based coloring) + a Sankey settings panel, return-% bars with trailing-change line-style markers, dual-axis LT $/% bars. `pfInit()` builds tabs/pages from `getPortfolioList()`. | yes |
| `InitJs.html` | Initial-wiring block; **must be included last** (applies settings, first render, starts polling, `pfInit()`). | yes |
| `PrintPage.html` | Print-to-PDF view — receives an SVG token, embeds the SVG full-page with `@media print` CSS, auto-opens the print dialog. | yes |

> **Client is split across `.html` partials stitched by `include()`.** Apps
> Script serves ONE document: `doGet` evaluates `WebappPage.html`, whose
> `<?!= include('X') ?>` scriptlets inline each partial at serve time. This is
> purely source organization — there is no per-file lazy-loading or runtime
> size win.
>
> ⚠️ **WORKAROUND — every JS partial MUST wrap its code in its own
> `<script>…</script>` tag, and there is NO outer IIFE.** `include()` calls
> `HtmlService.createHtmlOutputFromFile`, which **parses the included file as
> HTML**. A partial of *raw* JS throws `Exception: Malformed HTML content`
> because tag-like string literals (`'<path …>'`, `'<div …>'`, `'<svg …>'`) are
> parsed as real (broken) HTML. Wrapping the body in a `<script>` tag makes the
> HTML parser treat it as opaque text. (We hit this exact error on the dev URL
> after the first split, when the partials were bare JS inside one outer
> `<script>` IIFE in `WebappPage.html`.) Consequences and rules:
> - **No spanning IIFE.** You can't open `(function(){` in one partial and close
>   it in another (each file must be independently valid HTML). So the partials
>   run at **global scope** and share state via globals (`STATE`, `INV`,
>   helpers, `PALETTES`, `toast`, …). This is fine — they shared one scope
>   anyway. Each partial starts with `"use strict";` inside its `<script>`.
> - **Load order matters for top-level statements** (function *declarations*
>   only hoist within their own script now). `InitJs` must be included LAST —
>   it calls functions defined in the other partials.
> - **No partial may contain the literal `</script>`** (it would close the tag
>   early) — the SVG builders emit `<path>`/`<text>`/`<rect>`, never `<script>`,
>   so we're fine. Also keep the literal `<script` out of HTML *comments* in
>   `WebappPage.html`.
> - `Styles.html` (a `<style>` block) and `PayrollSankeyPage.html` (plain
>   markup) are valid HTML, so they include fine without wrapping.
> - All `<?!= ?>` scriptlets stay in `WebappPage.html`; `createHtmlOutputFromFile`
>   does NOT evaluate scriptlets, so partials contain none.
>
> **Verify after editing any client file** (resolve includes, extract the
> non-`src` `<script>` blocks, `node --check` the concatenation):
> ```bash
> python3 - <<'EOF'
> import re
> inc={n:open(n+'.html').read() for n in ['Styles','PayrollSankeyPage','CoreJs','PayrollSankeyJs','InvestmentJs','PortfolioJs','InitJs']}
> page=open('WebappPage.html').read()
> page=re.sub(r"<\?!= include\('([^']+)'\) \?>", lambda m: inc[m.group(1)], page)
> page=page.replace("<?!= bootstrap ?>","null")
> blocks=re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", page, re.S)
> open('/tmp/assembled.js','w').write("\n".join(blocks))
> EOF
> node --check /tmp/assembled.js
> ```
| `Tax.gs` | `FedTax`, `CATax`, year-specific aliases. Brackets for 2023/2024/2025 hardcoded. | yes |
| `Stock.gs` | `GET_ALL_STOCK_SUMMARIES` FIFO lot-accounting function (multi-account; account is the leftmost input & output col; IRA = all long-term). | yes |
| `build_transactions.py` | Merges the broker CSVs (Robinhood + Fidelity) into a per-person chronological ledger with an Account column in A; back-fills transfer-in cost basis via historical-close lookup. Reads local `data/*.csv` OR (if `TX_DRIVE_FOLDER`/`--drive-folder` set) downloads them from a shared Drive folder. `--online` writes A–J surgically to `Portfolio_AG`/`AA`. See §4. | yes |
| `DriveWatch.gs` | Watches the shared Drive folder of transaction CSVs and fires a GitHub `repository_dispatch` (`new-transactions`) when it changes, kicking `update-holdings.yml`. Detection is shared by TWO callers (one `dwDetectAndDispatch_`, lock-guarded, one `DRIVE_SNAPSHOT`): the open web app polls `pollDriveChanges()` every ~30 s (fast path, runs as the viewer) and a 12-hour time trigger (`checkDriveFolderForNewFiles_`) is the backstop. Config (folder id + PAT) in Script Properties. `installDriveWatchTrigger()` once. See `DRIVE_TRIGGER_SETUP.md`. | yes |
| `recalc_sheet.py` | Force-recalcs a `Portfolio_*` sheet by re-stamping every GOOGLEFINANCE / GET_ALL_STOCK_SUMMARIES / TODAY formula to itself (Python port of Apps Script `forceRecalc_`). Runs between the merge and holdings steps in the workflow so the summary is fresh. | yes |
| `.env` / `.env.example` | Gitignored local config (`.env`) for the Python scripts — `FINANCE_SHEET_ID`, `TX_DRIVE_FOLDER`, optional `GSPREAD_SA_FILE`; loaded automatically, real env/CI secrets win. `.env.example` is the committed template. | yes |
| `DRIVE_TRIGGER_SETUP.md` | End-to-end setup for the Drive-folder → auto-update pipeline (folder sharing, repo secrets, PAT, Apps Script trigger). | yes |
| `appsscript.json` | Apps Script manifest: web-app config (`executeAs: USER_ACCESSING`, `access: ANYONE`), enables Sheets advanced service, declares OAuth scopes. | yes |
| `.clasp.json` | Local clasp config — contains the bound Script ID. | yes |
| `.claspignore` | Denylist mode (push everything except specific noise). | yes |
| `.gitignore` | Excludes `.clasprc.json`, `Finance.xlsx`, `*.xlsx`, OS noise. | yes |
| `setup.sh` | One-shot clasp install + login + push helper. | optional |
| `migrate.sh` | Old migration script from `~/Personal/PayrollSankey/` to this repo. Can delete once you confirm migration succeeded. | delete after migration |
| `DEPLOY.md` | Detailed deployment doc with clasp and manual paths. | yes |
| `Next_Goals.md` | User's original spec for the web app. Historical context — the bonus goal "Add new level" button is still a stub. | yes |
| `Finance.xlsx` | Local snapshot of the workbook (gitignored). May or may not be present. **Never commit.** | gitignored |
| `logo/*.png` | Brand logo source art (Capuchin monkey in a dark-green circle). `Logo_Candidate_3.png` is the current source; `capuchin_emblem.png` is the cropped 96px emblem. Source only — clasp doesn't push PNGs (`.claspignore` excludes `logo/**`). | yes |
| `make_emblem.sh` | Regenerates the round emblem from the source art (fixed crop) and optionally re-embeds it into `Styles.html` (`--embed`). | yes |
| `deploy.sh` | `clasp push` + publish a new version to the existing web-app deployment (`clasp deploy -i <id>`), so the `/exec` URL updates in place. Run `./deploy.sh "msg"`. | yes |

> **Branding — "Capuchin".** The app is branded *Capuchin* (a personal-finance
> manager). The brand name + a round logo emblem show in the topbar on every
> tab; the document/web-app title is "Capuchin". The logo emblem is the green
> circle cropped from the full art `logo/Logo_Candidate_3.png` (crop window
> `700x700+354+34`, resized to 96px → `logo/capuchin_emblem.png`) and
> **embedded as a base64 data URI** in the `.brand-logo` CSS rule in
> `Styles.html` (the webapp never fetches the PNG at runtime). Regenerate with
> **`./make_emblem.sh --embed`** — it re-crops the emblem PNG and rewrites the
> data URI in `Styles.html` in one step (uses `-strip`, so output is
> byte-reproducible). Run `./make_emblem.sh --help` for options (different
> source art, size, or output path; override the crop via the `CROP` env var).
> **Theme color** is the logo's dark green `#2D4C36` (hover `#22452D`), which
> replaced the old blue `#1a73e8` throughout `Styles.html`; page background is a
> soft cream `#f1f3ec` echoing the logo field.

---

## 3. Deployment workflow (clasp)

### One-time setup (already done on user's Mac)

1. `npm install -g @google/clasp` (into `~/.npm-global`)
2. `clasp login` (browser OAuth, saves to `~/.clasprc.json`)
3. `.clasp.json` filled with the bound script's Script ID (from the
   Apps Script editor → Project Settings → Script ID).

### Every push from now on

> **⚠️ Claude: do NOT run `clasp push` / `clasp deploy` / `./deploy.sh` locally.**
> The user wants ALL deploys to go through the **GitHub CI on push to `main`**
> (`.github/workflows/deploy-webapp.yml`), so the mechanism stays tied to the
> repo (survives switching computers) and there's one source of truth. Make +
> verify changes locally (`node --check`, synthetic tests), then hand off for the
> user to commit & push; the CI deploys. (Data-only scripts that write to the
> Sheet via the service account — `build_transactions.py`, `update_effective_holdings.py`
> `--online` — are fine to run; they're not clasp deploys.) The manual commands
> below are retained for reference / the user's own use.

```bash
cd ~/Git/anchal-physics/finance
clasp push --force
```

`--force` skips the "overwrite appsscript.json?" prompt. `.claspignore`
is in **denylist mode** — anything not explicitly ignored gets pushed.

**`clasp push` only updates HEAD (the `/dev` test URL).** The `/exec` URL you
bookmark/share is pinned to a deployment **version** and won't reflect changes
until you publish a new version. To do that from the terminal (same URL, no
editor clicks): **`./deploy.sh "what changed"`** — it pushes, then runs
`clasp deploy -i <deploymentId>` against the existing web-app deployment (found
via `clasp deployments`; the `@<number>` entry, not `@HEAD`). Plain `clasp
deploy` with no `-i` mints a *new* deployment (new URL) — avoid. Mobile browsers
cache the HTML, so hard-refresh the phone after deploying.

**Push-to-deploy CI** (`.github/workflows/deploy-webapp.yml`): a push to `main`
touching `*.gs`/`*.html`/`appsscript.json` (or a manual run) does the same
push+deploy on GitHub, independent of any local machine. Auth can't use a
service account (personal `@gmail.com` → no Workspace domain-wide delegation, and
the Apps Script API rejects service accounts), so it authenticates as the owner
via a stored clasp OAuth token (`CLASPRC_JSON` secret) generated from a **custom
Published OAuth client** (durable refresh token) and mints a fresh access token
each run. Secrets: `CLASPRC_JSON`, `SCRIPT_ID`, `DEPLOY_ID`. Full setup in
**`WEBAPP_DEPLOY_CI.md`**. (`DEPLOY_USER_EMAIL` is unused; `SERVICE_ACCOUNT_KEY`
belongs to the holdings workflow, which legitimately uses a service account
against the *Sheets* API.)

### Critical safety guardrails (we learned these the hard way)

- **`clasp push` syncs local → remote and DELETES remote files that
  aren't present locally.** A previous `clasp push --force` wiped out
  the user's `Tax.gs` and `Stock.gs` because they weren't in the local
  allowlist at the time. We've now switched `.claspignore` to denylist
  mode and added `clasp pull` to `setup.sh`, but **always check the
  push output before assuming all files are safe**. If clasp lists
  files it's about to delete, abort and add them locally first.

- **⚠️ clasp obeys `.claspignore`, NOT `.gitignore`.** In denylist mode any
  pushable-extension file (`.gs`/`.js`/`.html`, plus `appsscript.json`) that
  isn't ignored in `.claspignore` gets pushed as project code. The Python work
  introduced `.venv/` (gitignored but NOT claspignored), so `./deploy.sh` pushed
  urllib3's `emscripten_fetch_worker.js` into the project; its top-level
  `new TextEncoder()` (undefined in GAS) threw at load and broke EVERY server
  function (`FedTax`, `GET_ALL_STOCK_SUMMARIES` → "TextEncoder is not defined").
  Fixed by ignoring `.venv/**`, `service_account.json`, `.github/**`, `*.py`,
  `*.yml`, `*.sh`, `*.bak`, `__pycache__/**` in `.claspignore`, and `deploy.sh`
  now aborts (via `clasp status`) if any non-project file is in the push set.
  **Recovery after such a bad push:** fix `.claspignore`, then `clasp push
  --force` — it makes the remote match the (now-clean) local set, deleting the
  junk; custom functions run at HEAD so they recover immediately.

- **One-time UI steps** in the Apps Script editor that clasp can't do:
  - Enable the **Google Sheets API** advanced service
    (Services → + → Google Sheets API). Needed for `moveSheetRow()`.
  - **Deploy → New deployment → Web app** to publish the URL.
    `executeAs: User accessing the web app`, `access: Anyone with Google account`.
  - Subsequent updates: **Deploy → Manage deployments → ✏ (pencil) →
    Version: New version**. Re-Deploy. The URL stays the same.
  - **Data freshness — run `installFreshnessTrigger` once** (Apps Script editor
    → Run). It creates **twice-daily** time-driven triggers (`scheduledRefresh_`
    → `forceRecalc_`) at the hours in `FRESHNESS_HOURS_` (default `[6, 17]`
    project time — morning + after US market close) to keep
    `GOOGLEFINANCE`/`TODAY()`/custom-function values fresh in the background,
    since opening the web app does NOT recalc the sheet and `getValues()` reads
    last-computed values. Twice-daily (not every-N-min) is deliberate: the
    summaries key off daily closing prices, so frequent runs would just burn the
    consumer trigger-runtime quota. `forceRecalc_` re-sets each formula cell
    containing `GOOGLEFINANCE` / `GET_ALL_STOCK_SUMMARIES` to itself (safe —
    literals untouched). The topbar **↻ Recalc** button calls `refreshData()`
    (force recalc + 2.5 s wait, then reload the active page) for on-demand
    refresh. `removeFreshnessTrigger` stops it. (`script.scriptapp` scope is
    already in `appsscript.json`.)

- **Sharing the webapp with someone**: share the Finance spreadsheet
  with their Google account (Editor access). The webapp URL itself is
  open to any signed-in Google user, but the deployment runs as the
  visitor, so they can only read/write the sheet if Drive sharing
  permits it.

---

## 4. Spreadsheet structure — what each part means

### Sheet: PayrollSankey

The preset range used by the Sankey functions is `D1:O39`, configured
via the `PRESET_RANGE` constant in `SankeyRenderer.gs`. Adding columns
to that constant auto-creates more subpanels in the webapp.

**Row 1 = headers only.** Data starts at row 2.

Columns D–O are 4 column-triplets ("subpanels"), each representing one
level of the Sankey flow:

| Cols | Subpanel title (from row 1) | Notes |
|------|-----------------------------|-------|
| D, E, F | Input \| **Portion type** \| Output | Splits gross income (referenced from columns A–C of the same sheet) into named portions like "Anamika Fixed Expenses Income", "Common Income", etc. |
| G, H, I | Input \| **Balanced Income** \| Output | Computes the balanced income flow per category — often `=SUMIF` over downstream subpanels. |
| J, K, L | Input \| **Expenses & Investments** \| Output | The big one. Densely populated (~36 rows). Lists every individual expense line item with `=Amount`-style cost values and a category target. |
| M, N, O | Input \| **Total E&I** \| Output | Mostly derived: M = `=L_n`, N = `=K_n`, O = `=S_n`. Effectively a read-only view. |

**Per-subpanel row independence**: each triplet has its own population
of rows. D:F has ~6 rows; J:L has ~36; rows are not aligned across
subpanels. When the webapp adds a row to a subpanel, it appends below
that subpanel's last occupied row — not at the global bottom.

**Heavy formula usage**: most cells contain formulas, not literals.
Examples:
- `E2 = =75000/12` (monthly gross)
- `H2 = =SUMIF(J:J,"Anamika Fixed Expenses",K:K)`
- `K2 = =FedTax(B2*12, 2025)/12` (uses our `Tax.gs` function)
- `L2 = =CONCAT(R2, S2)` (derived target name)
- `O3 = =S3`

The webapp **shows formula text + computed value side-by-side** in a
muted color and prefills the formula on edit, so users don't
accidentally clobber formula chains. Writes auto-detect formula vs
literal by checking if the input starts with `=`.

### Sheet: TaxBrackets

Reference data (the user's old way of feeding `FED_TAX_YYYY`). Still
present in the spreadsheet but **no longer used by code** — `Tax.gs`
has brackets hardcoded directly. Treat TaxBrackets as documentation
only. The 2025 standard deduction in B22 (`15,750`) reflects the
**One Big Beautiful Bill Act of 2025** retroactive bump, not the
original IRS Rev. Proc. 2024-40 ($15,000). Match this in `Tax.gs`.

### Sheet: Tax

Calls `=FedTax(...)`, `=CATax(...)`, `=FED_TAX_2024(...)`, etc.
across columns for Anchal/Anamika/Both, for 2023/2024/2025. All
existing formulas keep working after the `Tax.gs` rebuild because the
year-specific aliases (`FED_TAX_2023` → `FedTax(income, 2023, 'single')`)
are preserved.

### Sheet: Portfolio_AG (and Portfolio_AA)

**MULTI-ACCOUNT transaction ledger.** No longer Robinhood-only — it merges
every brokerage CSV in `data/` for one person (Anchal → `Portfolio_AG`,
Anamika → `Portfolio_AA`) into one chronological ledger, produced by
**`build_transactions.py`** (see below).

- Cols A–J = raw transactions, one row each, newest-first:
  **A=Account** (new leftmost col), B=Activity Date, C=Process Date,
  D=Settle Date, E=Instrument, F=Description, G=Trans Code, H=Quantity,
  I=Price, J=Amount.
- **Col K = `Closing Price` is DEAD** — a leftover from the old single-account
  layout, no longer read or maintained. `Stock.gs` used to use it as a
  cost-basis fallback; that's gone (transfer-in basis is back-filled into
  Amount instead, see below). Don't reintroduce a dependency on it.
- Cell **N1** contains (columns after the account shift):
  `=GET_ALL_STOCK_SUMMARIES($A$2:A, $D$2:D, $E$2:E, $G$2:G, $H$2:H, $J$2:J)`
  args = account, settle date, instrument, trans code, quantity, amount.
  It spills a **7-column** array into **N:T** (header row 1):
  `Account / Ticker / Total Shares / LT Shares / ST Shares / LT Avg Cost/Share /
  ST Avg Cost/Share`, **one row per (account, ticker)** — the same ticker in two
  accounts is two rows, sorted by account then ticker.
- Downstream computed columns (user-maintained formulas anchored to the spill):
  `U` Total Cost · `V` Price (`GOOGLEFINANCE`) · `W` Total Current Value ·
  `X` Total LT Value · `Y` Total ST Value · `Z` Possible Long Term Profit ($) ·
  `AA` Possible Simple Profit % · `AB` Ticker (helper) · `AC`–`AG` trailing %
  changes (1w/4w/12w/6m/1y). ⚠️ These letters moved right when the Account
  column was added (spill grew 6→7 cols) plus an earlier one-column insert; if
  the layout shifts again, update `Portfolio.gs` `PF_COLS` and
  `update_effective_holdings.py` together.

**IRA vs taxable** (`Stock.gs`): the account label decides the LT/ST split.
Taxable accounts (no "IRA" in the label) do the normal FIFO holding-period
split; **IRA accounts** (label contains "IRA", case-insensitive) report ALL
remaining shares as long-term (ST = 0) — still one row per account.

**Quantity is UNSIGNED** — both Buy and Sell rows are positive. Direction comes
from **Trans Code**, not the sign: `Buy`/`ACATI` (transfer in) add shares,
`Sell` removes them (FIFO); any other share-moving code falls back to the sign
of Amount (positive Amount = cash in = disposal). Zero-quantity rows (`CDIV`,
`ACH`, `DCF`, `SLIP`, …) are ignored. Regression check: a ticker
bought-then-fully-sold must be ABSENT from the output. **Cost basis = `|Amount|`**
(no closing-price fallback anymore). **Stock splits (`SPL`)**: ⚠️ the SPL row's
Quantity is the number of shares **ADDED** by the split (a **DELTA**), NOT the
new total. So `newTotal = current + delta` and `Stock.gs` scales every lot by
`ratio = (current + delta) / current`, dividing per-share cost by the same ratio
(preserves total basis + acquisition dates). **This corrects an earlier wrong
assumption** ("Quantity == new total") that silently dropped the entire
pre-split position from every split holding — e.g. SCHB read 50.42 vs Robinhood's
71.39 (short by the pre-split 20.965). Verified against the app's live counts:
SCHB `20.965 + 41.930 → 62.895` (3:1), VUG → 6:1, MGK → 5:1. (The old examples
"SCHB 2:1 / VUG 5:1, new total" were the same mistake — those numbers are
deltas; the true ratios are 3:1 / 6:1.)

**Money-market cash** (`SPAXX`, `FDRXX`, …) is excluded from holdings in both
`Portfolio.gs` and `update_effective_holdings.py` (it's a cash sweep, not a
position).

**Portfolio-stats page** (`Portfolio.gs` + `PortfolioJs.html`, tab "Anchal
Portfolio"). Reads the computed columns: `N` account · `O` ticker · `U` cost ·
`V` price · `W` current value · `Z` LT profit $ · `AA` profit % (fraction) ·
`AC`–`AG` trailing % changes · `AN`–`AP` effective-holdings **Sankey flow block**
(`Source | Value | Target`, header row 1) written by
`update_effective_holdings.py`. Because tickers now repeat across accounts, the
server **aggregates by ticker across accounts** for the pie/return/LT panels
(one slice per ticker, portfolio-wide) — the per-account breakdown lives ONLY in
the Sankey. Four panels: (1) pie of holdings by value + stats box; (2)
**effective-holdings Sankey** (`pfRenderSankey`, d3-sankey) — now **THREE
levels**: account (left, distinct dark colors) → ticker (middle, stable ticker
color) → effective company (right, grey) + `"<ETF> — other holdings"` residuals
+ a folded "Other holdings"; coloring/labels are **depth-based** (depth 0/1/2),
% is relative to the portfolio total; reads `stats.flows` from `AN:AP`, empty
until the script has run; (3) return-% bars (`(V−cost)/cost`) with trailing-change
markers (1w dotted / 4w dashed / 12w dash-dot / 6m long-dash / 1y solid); (4) LT
capital-gain profit dual-axis bars ($ left, % right; excludes 0/empty) — NOTE
this sums each ticker's LT profit across accounts, so IRA gains are lumped in
with taxable-LT gains. **Each ticker keeps a stable color** (value-sorted index
into the `nested` palette) across the pie, the Sankey's ticker nodes, and the
bars. A **Sankey settings** panel (collapsible, below panel 2) tunes node
width/padding/row height/link opacity/font/alignment/show-$ — persisted per-user
via the shared `wireSettingsPanel()` in `CoreJs` (key `pf:<key>`).
Config-driven: add a portfolio by adding one `PORTFOLIOS_` entry.

The `AN:AP` flow data comes from **`update_effective_holdings.py`** (`--online`),
which reads the summary (`N` account / `O` ticker / `W` value), decomposes ETFs
via `yahooquery`, and surgically writes the 3-level Sankey block (`account →
ticker`, `ticker → company`) + an `AR:AT` summary. `EFF_SANKEY_COL`/
`EFF_SUMMARY_COL` env defaults are `AN`/`AR`. See `SERVICE_ACCOUNT_SETUP.md` and
`.github/workflows/update-holdings.yml`.

### `build_transactions.py` — the transaction merge script

Scans `data/*.csv`, auto-detects format per file (Robinhood — already matches
A–I; or **Fidelity** — `Run Date / Action / Symbol / … / Amount ($) /
Settlement Date`, direction from the `Action` text mapped to RH-style Trans
Codes), tags each row with an **Account label derived from the filename**
(`<Broker> {Investment | Roth IRA | Trad. IRA}`; "IRA" in the label ⇒ IRA
account), merges chronologically per person, dedupes overlapping date-range
boundaries, and writes the ledger to A–J (account in A). Data starts row 2, no
gap. **Transfer-in (`ACATI`) rows** arrive with shares but no dollar
Amount/Price — the script **back-fills Amount = shares × historical close**
(yahooquery lookup on the transfer date), so every lot has a real cost basis and
column K is unnecessary. Modes: default = local preview CSVs in `data/merged/`;
`--dry-run` = print only; `--online` = surgical write to A–J on the Google Sheet
(guarded: refuses unless A1 is `Activity Date`/`Account`; leaves K and everything
from L rightward untouched). Needs `FINANCE_SHEET_ID` + `service_account.json`
(same creds as the holdings script); run with the conda `finance` env's python.
⚠️ Filenames' date ranges are account-*open* dates, not first-transaction dates
(Anchal's RH data actually starts 2024, not the "2016" in the name).

**Data source — local or Drive.** By default it globs local `data/*.csv`. If
`TX_DRIVE_FOLDER` (or `--drive-folder <id>`) is set, it instead downloads every
CSV from that Google Drive folder (shared with the service account) into a temp
dir via `google-auth` + the Drive REST API (no `google-api-python-client`
needed — uses the SA key + `AuthorizedSession`), then merges those. Both scripts
also auto-load a gitignored **`.env`** (`_load_local_env()`; real env / CI
secrets always win) for `FINANCE_SHEET_ID` / `TX_DRIVE_FOLDER` / `GSPREAD_SA_FILE`.

**Auto-update pipeline (Drive upload → sheet).** Drop a CSV in the shared Drive
folder → `DriveWatch.gs` (30 s poll from the open web app, or the 12 h backstop trigger) detects the change and POSTs a
GitHub `repository_dispatch` (`new-transactions`) → `update-holdings.yml` runs
three steps: `build_transactions.py --online` (Drive → `Portfolio_*` A:J) →
`recalc_sheet.py` (force-recalc, +25 s settle) → `update_effective_holdings.py
--online` (summary → `AN:AP`). `recalc_sheet.py` re-stamps every GOOGLEFINANCE /
GET_ALL_STOCK_SUMMARIES / TODAY formula to itself (Python port of `forceRecalc_`)
so the summary + prices are fresh before the holdings step reads `N:W`; if it
ever still lags, the twice-daily freshness trigger reconciles it. ⚠️ **This repo
is PUBLIC**, so Action logs are public — the scripts run with `--quiet` in CI to
keep dollar figures and the folder id out of the logs; preserve that. Full setup
(folder sharing, `TX_DRIVE_FOLDER` secret, fine-grained PAT with
Contents:read+write in Script Properties, `installDriveWatchTrigger()`) is in
**`DRIVE_TRIGGER_SETUP.md`**.

### Sheet: Investment

Drives the **Anchal** and **Anamika** webapp tabs. Headers in row 2,
weighted-cumulative summary in row 3, ticker data row 4 onward:

| Col | Meaning |
|-----|---------|
| A | Broad Category (only on each category's first row; spans the block below) |
| B / C | Anchal / Anamika per-category Target % (sum formulas) |
| D / E | Symbol / ETF name (`GOOGLEFINANCE`) |
| F / G / H | **Anchal**: Expense Ratio / Target % / Weekly $ (base `H3=900`) |
| I / J / K | **Anamika**: Expense Ratio / Target % / Weekly $ (base `K3=375`) |
| L / M / N / O | 6mo / 1yr / 3yr / 5yr return ratios (period totals, not annualized) |

**Conventions that bite if you forget them**: `G`/`J` (Target %) and the
return columns `L:O` are **fractions** (sum of `G`≈1.0); `F`/`I` (Expense
Ratio) are **already in percent** (e.g. `0.03` = 0.03%). So in the webapp,
weights and returns are formatted `×100 + "%"`, but the effective expense
ratio is formatted with just `+ "%"`. Per-ticker allocation weight = Target %
(`G`/`J`) — this matches the sheet's own `L3:O3` cumulative formulas.

**Two sheet quirks the code works around** by computing all aggregates
itself from raw cells (never reading row 3): `I3` (Anamika effective ER) is
weighted by `G` instead of `J`, and there is no Anamika cumulative-return
row. The aggregation in `Webapp.gs` (`computeInvestmentModel_`) was verified
in node against the sheet's `F3`/`G3`/`L3:O3` for Anchal (exact match) and
computes Anamika correctly by `J`.

**Server endpoints** (`Investment.gs`): `getInvestmentData(investor)` →
chart model; `getInvestmentEditor` / `writeInvestmentCell` /
`addInvestmentStock` / `addInvestmentCategory` / `clearInvestmentRow` /
`pollInvestment` for the editor; `getNamedSettings`/`saveNamedSettings`
(in `Webapp.gs`) for per-user, per-chart settings (key `inv:<investor>`).
The charts and editor client code live in `InvestmentJs.html` (hand-rolled
SVG, no chart lib); the reusable export pipeline (`serializeSvg` +
`exportSvgStringToPng` / `exportSvgStringToPdf`) lives in `CoreJs.html`.

**Editor model (category sub-panels).** Because column A is *shared* by both
investors, the broad categories are one structure on both tabs. The editor:
- groups ticker rows into **per-category collapsible sub-panels** (a category
  owns rows from its A-labelled header down to the row before the next A row);
  the sub-panel title is the editable category name (col A).
- shows a **weekly-base box (`H3`/`K3`)** at the top — edit the total weekly
  investment directly.
- per-row columns are ticker-level only (Anchal `D,E,F,G,H` / Anamika
  `D,E,I,J,K`); the category % (`B`/`C`) sits in the sub-panel header.
- **+ Add stock** inserts a sheet row *just below the category header* (so the
  category's `=Sum(G..)` % auto-extends), seeds the weight to 0, and auto-fills
  output columns. **+ Add broad category** appends a new block at the bottom.
  Both shift shared rows → a one-time confirm warns that both investors move.
- per-row **×** clears only this investor's allocation cols (`F,G,H`/`I,J,K`).
- non-zero **Target %** cells (`G`/`J`) get a half-transparent forest-green
  background (`.wt-nonzero`) to spotlight active allocations.
- no drag-reorder (doesn't map to category blocks).

**Read-only / auto-fill columns (generic, reusable).** `INVESTMENT_READONLY_COLS`
+ `INVESTMENT_AUTOFILL` (in `Investment.gs`) mark output-only columns — the ETF
name `E` (runs `GOOGLEFINANCE($D{ROW},"name")`). The editor renders them
value-only (no formula, not editable; `writeInvestmentCell` rejects writes).
On row insert/append, the shared helper **`copyDownFormulas_(sheet, fromRow,
toRow, specs)`** (in `Webapp.gs`) copies each such formula DOWN using Sheets'
relative-reference rules (or a `{ROW}` template if the source has none). Any
future editor can declare the same config + call `copyDownFormulas_`.

---

## 5. Tax brackets — sources and update cadence

### Federal (IRS)

Source: IRS Revenue Procedure for the relevant year (published Oct/Nov
the prior year). For 2025 specifically, the **One Big Beautiful Bill Act
of 2025** (signed July 4, 2025) retroactively bumped the standard
deduction:

| Year | Single SD | MFJ SD | HoH SD | Source |
|------|-----------|--------|--------|--------|
| 2023 | $13,850 | $27,700 | $20,800 | IRS Rev. Proc. 2022-38 |
| 2024 | $14,600 | $29,200 | $21,900 | IRS Rev. Proc. 2023-34 |
| 2025 | **$15,750** | **$31,500** | **$23,625** | OBBBA 2025 (post-July retroactive update) |

Brackets in `Tax.gs` (`FED_BRACKETS[year][status]`) match published IRS
tables exactly. To add a new year: copy the latest year's block, update
upper edges and SD.

### California (FTB)

Single + MFJ brackets in `Tax.gs` (`CA_BRACKETS[year][status]`).
**2025 brackets are now the FTB final indexed values** (Schedule X /
Schedule Y from the 2025 California Tax Rate Schedules), verified
against FTB's own worked example (MFJ taxable $125,000 → $4,768.10).
2025 standard deduction: single $5,706, MFJ $11,412. Code includes
the 1% Mental Health Services surcharge on taxable income over $1M.

### Why hardcoded brackets, not an API

User asked about free APIs. **There aren't any well-trusted free
income-tax APIs** for federal+state by year. TaxJar/Avalara = sales
tax only. Tax-Calculator (Tax Policy Center) = policy research, not
personal estimation. NerdWallet/TurboTax = web UI, no API. IRS/FTB
publish data as PDFs, no API.

Hardcoded brackets are the right engineering choice: 100% reliable,
auditable, fast, no network. Update once a year when IRS/FTB publish.
The data structure makes that a 30-second edit.

---

## 6. Coding conventions to follow

### GAS-specific

- **Custom-function args are 2D arrays** (`Array<Array<*>>`) when a
  range is passed. `Stock.gs` has `stockColToArray_()` to flatten.
- **Custom-function returns** must be 2D arrays to spill correctly.
  Return at least one row even for empty results.
- **`SpreadsheetApp.flush()`** after writes if subsequent reads need
  to see the new state in the same script execution.
- **`Session.getActiveUser().getEmail()`** can fail silently in some
  contexts; wrap in try/catch with empty-string fallback.

### Template-literal escaping in HTML strings inside .gs

When inline HTML inside a .gs file uses `<script>...</script>` and
that script needs to include JS with `${}` or backticks, use string
concatenation (`'... ' + var + ' ...'`) instead of template literals.
`SankeyRenderer.gs` does this consistently. **Never** use a template
literal that contains another template literal — the escaping is
hellish and breaks subtly.

### Separate .html files

For files served via `HtmlService.createTemplateFromFile()`, scriptlets:
- `<?= expr ?>` — HTML-escaped output
- `<?!= expr ?>` — raw output (used for `bootstrap` JSON and `svgContent`)
- `<? code ?>` — code only

### Verification

- After editing a `.gs` file, run `node --check /tmp/copy.js` (rename
  to `.js` since `node --check` rejects `.gs`).
- For HTML files with inline scripts, extract the `<script>` body and
  `node --check` that too — catches IIFE bugs the .gs surrounding it
  wouldn't expose.
- For tax/financial math, ALWAYS sanity-check against hand-computed
  values. Example: `FedTax(100000, 2024, 'single')` must equal
  `$13,841.00` exactly. If your code doesn't, fix it before claiming
  it works.

---

## 7. Architectural decisions, with rationale

These were locked in during a series of AskUserQuestion rounds with
Anchal. Don't relitigate without reason:

| Decision | Choice | Why |
|----------|--------|-----|
| Save model | Debounced auto-save (800 ms) | Best UX, lowest sheet-write churn, no manual save button. |
| Project layout | Same Apps Script project as `SankeyRenderer.gs`, deployed as Web App | Reuses constants and helpers; one project to maintain. |
| Delete row | Clear 3 cells only, don't shift rows | Each subpanel has independent row population; shifting would damage other subpanels. |
| Diagram panel | Expanded by default; Settings + Editor collapsed | Standard dashboard pattern; diagram is the thing you want to see first. |
| Access scope | Webapp `access: ANYONE` + Drive sharing as the real gatekeeper | Spouse can use webapp once you share the sheet with her. |
| Subpanel title source | Row 1 (header) of the value column | Matches the existing spreadsheet convention. |
| Settings persistence | Per-user `UserProperties` | Each user (Anchal, spouse) has their own preferences. |
| Empty subpanel UX | One blank editable row + "+ Add row" button | Usable starting point. |
| Formula display | Formula text in muted color + computed value | User's exact request: "show the formula text with computed value shown in a different color in the same location". |
| Reorder semantics | `Sheets.Spreadsheets.batchUpdate({moveDimension})` — Sheets-native row move | Auto-updates formula refs the way the UI does. **Caveat user accepted**: moves entire spreadsheet row including columns outside the subpanel. |
| Read-only subpanels | Lock toggle per subpanel, stored in `UserProperties` | Useful for derived panels like "Total E&I" (M–O). |
| External edits | Poll every 30s, prompt before overwriting unsaved local edits | Compromise between real-time feel and not hammering Apps Script quotas. |
| PDF export | User-specified: **hardcoded SVG in script** → new tab → browser print-to-PDF | No external libs (no jsPDF/svg2pdf from CDN). |
| Add new level | **Implemented.** Button prompts for a title, calls `addNewLevel(title)`, which appends an `Input \| <title> \| Output` triplet to the right and persists a widened effective-range override in `ScriptProperties` (key `effective_range_v1`). `PRESET_RANGE` constant is left untouched; `getEffectiveRange_()` returns the override if present, else the constant. | Bonus goal from `Next_Goals.md`, now done. Override is script-wide (structural change, shared across users), not per-user. |

---

## 8. What was lost and rebuilt — IMPORTANT

The user's earlier bound script had these files we don't have history of:

1. **`Tax.gs`** — with `FedTax`, `CATax`, and per-year aliases. Used
   `TaxBrackets` sheet for bracket data.
2. **`Stock.gs` (or similarly named)** — with `GET_ALL_STOCK_SUMMARIES`.

**Both were deleted from the remote** when an early `clasp push --force`
ran with a too-restrictive allowlist `.claspignore`. The user's Apps
Script project history was empty (no auto-save revisions captured the
prior state), so the originals were unrecoverable.

We rebuilt both from scratch based on:
- The function-call formulas visible in the spreadsheet
  (e.g. `=GET_ALL_STOCK_SUMMARIES($C$2:C, $D$2:$D, ...)`)
- Output column layouts that the spilled array used to fill
- The `TaxBrackets` reference data
- The user's verbal description of behavior

The rebuilt versions:
- **`Tax.gs`** hardcodes brackets directly (TaxBrackets sheet is now
  documentation-only). Supports single and MFJ filing statuses. Includes
  the CA Mental Health surcharge that the old script didn't have.
  All existing year-specific function calls keep working via aliases.
- **`Stock.gs`** implements FIFO lot accounting. Verified with
  synthetic transactions matching hand-computed expectations.

**Lesson learned, now codified**: `.claspignore` is in denylist mode
and `setup.sh` runs `clasp pull` before `clasp push`. Don't undo either.

---

## 9. User preferences and working style

Things Anchal has demonstrated through conversation:

- **Wants opinionated recommendations.** When asked architecture
  questions, he picks the "Recommended" option ~100% of the time.
  Surface trade-offs clearly and mark your recommendation; don't
  pretend to be neutral when one option is clearly better.
- **Likes to see verification.** When you write code, run sanity
  checks (`node --check`, math validation against known answers) and
  report what passed. He values "verified X cases" more than "I think
  it works".
- **Compact, direct prose.** Avoid bullet-point-heavy responses unless
  the content is genuinely a list. Don't pad with trailing summaries
  of what you just said. He can read the diff.
- **Pragmatic about scope.** Bonus features get flagged as such and
  deferred. Foundational v1 first, then iterate. Don't gold-plate.
- **Will push back on bad choices.** When he doesn't like an answer
  he says so plainly (e.g., on PDF export he told me to hardcode SVG
  instead of using libraries). Take corrections, don't apologize at
  length, fix and move on.
- **Cares about safety with his data.** Finance.xlsx contains real
  income/expense data. Never commit it. Never log it. Never email
  it. `.clasprc.json` is OAuth credentials — same treatment.
- **Iterates fast.** Expects same-session turnaround on substantive
  changes. Don't over-deliberate.

---

## 10. Outstanding / future work

- ~~**CA 2025 brackets**~~ **Done.** `Tax.gs` now holds FTB's final 2025
  indexed brackets + standard deductions (single $5,706 / MFJ $11,412),
  verified against FTB's worked example. Next year's update (2026) is the
  same 30-second edit: add a `2026` block to `CA_BRACKETS` / `FED_BRACKETS`
  and the deduction tables.
- ~~**"+ Add new level" button**~~ **Done.** Button is enabled; calls
  `addNewLevel(title)` which appends an `Input | <title> | Output` triplet
  to the right of the last subpanel and persists a widened effective-range
  override in `ScriptProperties` (`effective_range_v1`). `PRESET_RANGE`
  constant is left untouched — `getEffectiveRange_()` prefers the override.
  Caveat: for the default `D1:O39` sheet the first added level extends to
  `D1:R39`, which spans column Q — the same cell `IMAGE_ANCHOR_CELL` uses
  for the saved PNG. The PNG floats over cells (no data loss) but overlaps
  visually. No "remove level" / range-reset UI yet; to reset, clear the
  `effective_range_v1` script property.
- ~~**Sankey.gs (legacy)**~~ **Deleted** — superseded by `SankeyRenderer.gs`
  and preserved in git history. Also removed from `.clasp.json`.
- ~~**migrate.sh**~~ **Deleted** — migration to this repo is complete.
- **Portfolio pie/bars aggregate across accounts by ticker.** The per-account
  split shows only in the Sankey. Two known-and-accepted simplifications the user
  may want to revisit: (a) the **LT-profit dual-axis panel sums each ticker's LT
  profit across accounts**, lumping (non-taxable) IRA gains in with taxable-LT
  gains; (b) there's no per-account pie/bar view. Both are easy to split later if
  asked.
- **Conflict-resolution UI** during external-edit polling is basic
  (banner with Keep mine / Take sheet version). Could be improved
  with a cell-level diff view if it gets used heavily.
- **Mobile drag-reorder** uses HTML5 native drag-and-drop, which has
  spotty touch support. If reorder on iPhone matters, add a touch
  polyfill or replace handles with ↑ ↓ buttons on mobile.
- **Filing status UI** — `FedTax` accepts `single`/`mfj`/`hoh` but the
  user's existing formulas only call the 2-arg version (defaults to
  single). Could expose filing status in a hidden config cell or in
  the formula directly when MFJ becomes relevant.

---

## 11. Quick orientation for a new Claude session

If you've never seen this repo before, do this:

1. Read this file (you're here).
2. Skim `Next_Goals.md` for the original webapp spec.
3. Open `SankeyRenderer.gs` and `Webapp.gs` — see how
   constants (`PRESET_RANGE`, `TARGET_SHEET_NAME`, etc.) flow from
   `SankeyRenderer.gs` into `Webapp.gs`. They live in the same Apps
   Script project so cross-file references work.
4. Look at the bottom of `SankeyRenderer.gs` to see the
   `getSankeyDialogHtml()` string-concatenation style for inline
   HTML — match this pattern if you need to add another modal.
5. Run a sanity check on the project:
   ```bash
   cd ~/Git/anchal-physics/finance
   for f in *.gs; do cp "$f" /tmp/x.js && node --check /tmp/x.js && echo "$f: OK" || echo "$f: FAIL"; done
   ```
6. When you make changes, DON'T deploy them yourself — verify locally, then
   hand off for the user to commit & push to `main`; the **GitHub CI deploys**
   (see §3). Do not run `clasp push`/`clasp deploy`/`./deploy.sh` locally.

Welcome aboard. Anchal is a good user to work with — direct, technical,
makes decisions fast. Match the energy.
