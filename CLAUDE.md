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
   `=GET_ALL_STOCK_SUMMARIES(...)` that does FIFO lot accounting over a
   Robinhood-style transaction log on `Portfolio_AG` and emits a 2D
   spilled array of `[ticker, totalShares, ltShares, stShares, ltAvgCost,
   stAvgCost]` for each currently-held ticker.

4. **Investment dashboard pages** (in the same web app) — two extra tabs,
   **Anchal** and **Anamika**, alongside the PayrollSankey landing tab.
   Each renders, from the `Investment` sheet: a hand-rolled SVG **donut/pie**
   (categories as color groups, tickers as shaded sub-slices split by dotted
   radial lines, with an HTML legend of %/weekly-$), a hand-rolled SVG **bar
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
| `Webapp.gs` | Server endpoints for the web app: `doGet`, bootstrap payload, cell writes, row add/delete/move, settings + locks, polling, print-SVG handoff. | yes |
| `WebappPage.html` | Main webapp UI: 3 collapsible panels (Sankey diagram, settings, editor). Formula-aware cell editor. Drag-reorder. 30s polling. PNG/PDF export. | yes |
| `PrintPage.html` | Print-to-PDF view — receives an SVG token, embeds the SVG full-page with `@media print` CSS, auto-opens the print dialog. | yes |
| `Tax.gs` | `FedTax`, `CATax`, year-specific aliases. Brackets for 2023/2024/2025 hardcoded. | yes |
| `Stock.gs` | `GET_ALL_STOCK_SUMMARIES` FIFO lot-accounting function. | yes |
| `appsscript.json` | Apps Script manifest: web-app config (`executeAs: USER_ACCESSING`, `access: ANYONE`), enables Sheets advanced service, declares OAuth scopes. | yes |
| `.clasp.json` | Local clasp config — contains the bound Script ID. | yes |
| `.claspignore` | Denylist mode (push everything except specific noise). | yes |
| `.gitignore` | Excludes `.clasprc.json`, `Finance.xlsx`, `*.xlsx`, OS noise. | yes |
| `setup.sh` | One-shot clasp install + login + push helper. | optional |
| `migrate.sh` | Old migration script from `~/Personal/PayrollSankey/` to this repo. Can delete once you confirm migration succeeded. | delete after migration |
| `DEPLOY.md` | Detailed deployment doc with clasp and manual paths. | yes |
| `Next_Goals.md` | User's original spec for the web app. Historical context — the bonus goal "Add new level" button is still a stub. | yes |
| `Finance.xlsx` | Local snapshot of the workbook (gitignored). May or may not be present. **Never commit.** | gitignored |

---

## 3. Deployment workflow (clasp)

### One-time setup (already done on user's Mac)

1. `npm install -g @google/clasp` (into `~/.npm-global`)
2. `clasp login` (browser OAuth, saves to `~/.clasprc.json`)
3. `.clasp.json` filled with the bound script's Script ID (from the
   Apps Script editor → Project Settings → Script ID).

### Every push from now on

```bash
cd ~/Git/anchal-physics/finance
clasp push --force
```

`--force` skips the "overwrite appsscript.json?" prompt. `.claspignore`
is in **denylist mode** — anything not explicitly ignored gets pushed.

### Critical safety guardrails (we learned these the hard way)

- **`clasp push` syncs local → remote and DELETES remote files that
  aren't present locally.** A previous `clasp push --force` wiped out
  the user's `Tax.gs` and `Stock.gs` because they weren't in the local
  allowlist at the time. We've now switched `.claspignore` to denylist
  mode and added `clasp pull` to `setup.sh`, but **always check the
  push output before assuming all files are safe**. If clasp lists
  files it's about to delete, abort and add them locally first.

- **One-time UI steps** in the Apps Script editor that clasp can't do:
  - Enable the **Google Sheets API** advanced service
    (Services → + → Google Sheets API). Needed for `moveSheetRow()`.
  - **Deploy → New deployment → Web app** to publish the URL.
    `executeAs: User accessing the web app`, `access: Anyone with Google account`.
  - Subsequent updates: **Deploy → Manage deployments → ✏ (pencil) →
    Version: New version**. Re-Deploy. The URL stays the same.

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

### Sheet: Portfolio_AG

Robinhood transaction history.

- Cols A–K = raw transactions (one row each):
  A=Activity Date, B=Process Date, C=Settle Date, D=Instrument,
  E=Description, F=Trans Code, G=Quantity, H=Price, I=Amount,
  J=(blank), K=Closing Price
- Cell **N1** contains:
  `=GET_ALL_STOCK_SUMMARIES($C$2:C1000, $D$2:$D1000, $F$2:$F1000, $G$2:$G1000, $I$2:I1000, $K$2:$K1000)`
  which spills a 6-column array into N:S — one row per currently-held
  ticker, columns: ticker / total shares / LT shares / ST shares /
  LT avg cost per share / ST avg cost per share.
- Cols T–V (Total Cost, Price via `GOOGLEFINANCE`, Total Current Value)
  are pre-filled formulas anchored to the spilled rows.

Sign convention: positive Quantity = adds shares, negative = removes.
Cost basis preference: `|Amount|` if non-zero, else `Quantity * Closing Price`.

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

**Server endpoints** (`Webapp.gs`): `getInvestmentData(investor)` →
chart model; `getInvestmentEditor(investor)` / `writeInvestmentCell` /
`appendInvestmentRow` / `clearInvestmentRow` / `moveInvestmentRow` /
`pollInvestment` for the editor; `getNamedSettings`/`saveNamedSettings`
for per-user, per-chart settings (key `inv:<investor>`). Editor columns:
Anchal `A–H`, Anamika `A–E + I–K`. Charts and editor are all in
`WebappPage.html` under the `// Investment pages` section (hand-rolled SVG,
no chart lib). The reusable export pipeline is `serializeSvg` +
`exportSvgStringToPng` / `exportSvgStringToPdf`.

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
6. When you make changes, push with:
   ```bash
   clasp push --force
   ```
7. If clasp output says it's about to *delete* a remote file, STOP
   and verify — `.claspignore` is in denylist mode, so this shouldn't
   happen, but if it does it means a remote-only file appeared and
   should probably be pulled first (`clasp pull`).

Welcome aboard. Anchal is a good user to work with — direct, technical,
makes decisions fast. Match the energy.
