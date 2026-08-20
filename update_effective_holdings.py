#!/usr/bin/env python3
"""
update_effective_holdings.py
------------------------------------------------------------------------------
Look-through portfolio exposure.

For each Portfolio_* sheet it reads N (ticker), O (shares) and V (current
value), decomposes every ETF position into its underlying holdings (via
yahooquery), and writes TWO surgical blocks on the SAME sheet:

  SANKEY flows  → AM (Source) | AN (Value $) | AO (Target)
      One row per edge: original position (ETF/stock) → effective holding.
      Capuchin reads this block to draw the effective-holdings Sankey panel.
      All but the top EFF_TOP_TARGETS companies fold into an "Other holdings"
      node; each ETF's un-decomposed remainder is a "<ETF> — other holdings"
      target so dollars reconcile.
  SUMMARY table → AQ (Holding) | AR (Value $) | AS (% of portfolio, a FRACTION)
      The flat effective-holdings table (kept for reference).

Both blocks have a header row. Only those columns are cleared + rewritten;
nothing else is touched. A guard skips any sheet whose N1 isn't "Ticker".

Modes:
    python3 update_effective_holdings.py --dry-run     # print, write nothing
    python3 update_effective_holdings.py               # write into local Finance.xlsx
    python3 update_effective_holdings.py --online       # write to the Google Sheet

BOTH modes are surgical (XML-level for local, cell-range for online): only the
AM:AO and AQ:AS cells change — cached formula values, images, and every other
sheet/cell are left exactly as-is. Local mode writes a Finance.xlsx.bak first.
See SERVICE_ACCOUNT_SETUP.md for the one-time --online credential setup.

Requirements:  pip install -r requirements.txt
Online setup:  Google Cloud project w/ Sheets+Drive API, a Service Account JSON
               key saved as service_account.json (gitignored), the sheet shared
               with that service account (Editor), and FINANCE_SHEET_ID set.
Look-through note: yahooquery returns only each ETF's ~top-10 holdings, so the
un-listed remainder is booked to a "<ETF> — other holdings" line to keep the
dollar totals reconciled.
------------------------------------------------------------------------------
"""
import os
import sys
import shutil
import argparse
from collections import OrderedDict

# ---- config (environment variables override these) ----
LOCAL_FILE = os.environ.get("FINANCE_XLSX", os.path.join(os.path.dirname(__file__), "Finance.xlsx"))
SPREADSHEET_ID = os.environ.get("FINANCE_SHEET_ID", "PUT-SPREADSHEET-ID-HERE")
SERVICE_ACCOUNT_FILE = os.environ.get("GSPREAD_SA_FILE", "service_account.json")
SHEETS = os.environ.get("EFF_SHEETS", "Portfolio_AG,Portfolio_AA").split(",")

# Two output blocks (both 3 columns wide, with a header row):
#   SANKEY  : Source | Value | Target  — one row per flow edge (Capuchin reads
#             this to draw the effective-holdings Sankey panel).
#   SUMMARY : Holding | Value ($) | %   — the flat effective-holdings table.
SANKEY_START_COL = os.environ.get("EFF_SANKEY_COL", "AM")    # → AM, AN, AO
SUMMARY_START_COL = os.environ.get("EFF_SUMMARY_COL", "AQ")  # → AQ, AR, AS
try:
    TOP_TARGETS = int(os.environ.get("EFF_TOP_TARGETS") or 24)   # distinct right nodes; rest → "Other holdings"
except ValueError:
    TOP_TARGETS = 24

MAX_SCAN_ROW = 300          # portfolio positions never exceed this row
RESIDUAL_MIN_FRAC = 0.002   # ignore an ETF's residual if < 0.2% of the position


# ============================ shared helpers ============================
def col_to_num(col):
    n = 0
    for ch in col.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def num_to_col(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def to_float(x):
    try:
        return float(str(x).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def fetch_lookthrough(tickers):
    """(holdings_by_ticker, names_by_ticker).
    holdings_by_ticker[t] = [{symbol,name,pct}] for ETFs, or None for a stock."""
    from yahooquery import Ticker
    tk = Ticker(tickers, asynchronous=False)
    hi = tk.fund_holding_info or {}
    pr = tk.price or {}
    holdings, names = {}, {}
    for t in tickers:
        info = hi.get(t)
        p = pr.get(t) if isinstance(pr.get(t), dict) else {}
        names[t] = p.get("longName") or p.get("shortName") or t
        hs = None
        if isinstance(info, dict) and isinstance(info.get("holdings"), list) and info["holdings"]:
            raw = info["holdings"]
            tot = sum((h.get("holdingPercent") or 0) for h in raw)
            scale = 0.01 if tot > 1.5 else 1.0   # guard if percents come as 0-100
            hs = []
            for h in raw:
                sym = (h.get("symbol") or "").strip()
                nm = (h.get("holdingName") or sym or "").strip()
                hs.append({"symbol": sym, "name": nm, "pct": (h.get("holdingPercent") or 0) * scale})
        holdings[t] = hs
    return holdings, names


def build_effective(positions, holdings, names):
    eff = OrderedDict()   # key -> {name, value}
    total = sum((p["value"] or 0) for p in positions)

    def add(key, name, val):
        if key not in eff:
            eff[key] = {"name": name, "value": 0.0}
        eff[key]["value"] += val

    for p in positions:
        t, val = p["ticker"], (p["value"] or 0)
        if val <= 0:
            continue
        hs = holdings.get(t)
        if hs:  # ETF → distribute across underlyings; remainder → residual line
            allocated = 0.0
            for h in hs:
                key = h["symbol"] or h["name"]
                if not key:
                    continue
                add(key, h["name"] or key, val * h["pct"])
                allocated += h["pct"]
            resid = val * max(0.0, 1.0 - allocated)
            if resid > RESIDUAL_MIN_FRAC * val:
                add("{}::other".format(t), "{} — other holdings".format(t), resid)
        else:   # direct stock (or holdings unavailable) → itself
            add(t, names.get(t, t), val)

    rows = [{"name": v["name"], "value": v["value"],
             "pct": (v["value"] / total if total else 0.0)} for v in eff.values()]
    rows.sort(key=lambda r: -r["value"])
    return rows, total


def summary_table(rows):
    """Effective-holdings summary as a 2D list (header + rows): name / $ / %."""
    data = [["Effective Holding", "Value ($)", "% of Portfolio"]]
    for r in rows:
        data.append([r["name"], round(r["value"], 2), round(r["pct"], 6)])
    return data


def build_flows(positions, holdings, names, top_k):
    """Sankey edges: each original position (ETF/stock) → each effective holding.
    Returns a list of (source, value, target) tuples, aggregated by (source,
    target), with all but the top-`top_k` target companies folded into a single
    'Other holdings' node so the diagram stays readable."""
    edges = OrderedDict()   # (source, tkey) -> value
    tname = {}              # tkey -> display name
    tvalue = {}             # tkey -> total value (for top-k ranking)

    def add(source, tkey, tnm, val):
        edges[(source, tkey)] = edges.get((source, tkey), 0.0) + val
        tname[tkey] = tnm
        tvalue[tkey] = tvalue.get(tkey, 0.0) + val

    for p in positions:
        t, val = p["ticker"], (p["value"] or 0)
        if val <= 0:
            continue
        hs = holdings.get(t)
        if hs:  # ETF → one edge per underlying + a residual edge
            allocated = 0.0
            for h in hs:
                key = h["symbol"] or h["name"]
                if not key:
                    continue
                add(t, key, h["name"] or key, val * h["pct"])
                allocated += h["pct"]
            resid = val * max(0.0, 1.0 - allocated)
            if resid > RESIDUAL_MIN_FRAC * val:
                add(t, "{}::other".format(t), "{} — other holdings".format(t), resid)
        else:   # direct stock → itself
            add(t, t, names.get(t, t), val)

    keep = set(sorted(tvalue, key=lambda k: -tvalue[k])[:top_k])
    agg = OrderedDict()     # (source, target_label) -> value
    for (source, tkey), val in edges.items():
        label = tname[tkey] if tkey in keep else "Other holdings"
        agg[(source, label)] = agg.get((source, label), 0.0) + val

    flows = [(s, round(v, 2), tl) for (s, tl), v in agg.items() if v > 0]
    flows.sort(key=lambda e: (-e[1], e[0]))   # largest edges first
    return flows


def flow_table(flows):
    """Sankey block as a 2D list (header + rows): Source / Value / Target."""
    data = [["Source", "Value", "Target"]]
    for s, v, t in flows:
        data.append([s, v, t])
    return data


def print_preview(name, rows, total, flows):
    targets = {t for _, _, t in flows}
    sources = {s for s, _, _ in flows}
    print("    portfolio total ${:,.2f}; {} effective holdings; "
          "sankey: {} flows, {} sources → {} targets".format(
              total, len(rows), len(flows), len(sources), len(targets)))
    for r in rows[:12]:
        print("      {:40}  ${:>12,.2f}  {:6.2f}%".format(r["name"][:40], r["value"], r["pct"] * 100))
    if len(rows) > 12:
        print("      … +{} more".format(len(rows) - 12))


# ============================ local (.xlsx) backend ============================
def read_positions_xlsx(ws):
    out = []
    for row in range(2, MAX_SCAN_ROW + 1):
        tk = ws["N{}".format(row)].value
        if tk is None or str(tk).strip() == "":
            break  # the N spill is contiguous; stop at the first blank
        tk = str(tk).strip()
        if "#REF" in tk:
            continue
        out.append({"ticker": tk,
                    "shares": to_float(ws["O{}".format(row)].value),
                    "value": to_float(ws["V{}".format(row)].value)})
    return out


SS_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def _sheet_xml_path(zf, sheet_name):
    import re
    wb = zf.read("xl/workbook.xml").decode("utf-8")
    m = re.search(r'<sheet[^>]*name="{}"[^>]*r:id="(rId\d+)"'.format(re.escape(sheet_name)), wb)
    if not m:
        return None
    rels = zf.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    m2 = re.search(r'Id="{}"[^>]*Target="([^"]*)"'.format(m.group(1)), rels)
    tgt = m2.group(1)
    return tgt if tgt.startswith("xl/") else "xl/" + tgt.lstrip("/")


def _col_of(ref):
    import re
    return re.match(r"([A-Z]+)", ref).group(1)


def write_blocks_xlsx(path, sheet_name, blocks):
    """SURGICALLY write one or more column blocks onto ONE sheet in a single pass.
    `blocks` is a list of (start_col, data) where data is a 2D list (header +
    rows). Each block occupies consecutive columns; its columns are set for
    rows 1..len(data) and cleared below. Every other byte of the workbook —
    other sheets, cached formula values, images, styles, shared strings — is
    left exactly as-is (only this sheet's XML is re-emitted, only these cells
    change)."""
    import zipfile, xml.etree.ElementTree as ET
    specs = []   # (c0, cols_set, data)
    for start_col, data in blocks:
        c0 = col_to_num(start_col)
        width = max((len(line) for line in data), default=1)
        specs.append((c0, {num_to_col(c0 + i) for i in range(width)}, data))

    with zipfile.ZipFile(path, "r") as zf:
        sheet_path = _sheet_xml_path(zf, sheet_name)
        if not sheet_path:
            raise RuntimeError("sheet {} not found in {}".format(sheet_name, path))
        names = zf.namelist()
        contents = {n: zf.read(n) for n in names}

    for pfx, uri in [("", SS_NS),
                     ("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"),
                     ("mc", "http://schemas.openxmlformats.org/markup-compatibility/2006"),
                     ("x14ac", "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac")]:
        ET.register_namespace(pfx, uri)
    root = ET.fromstring(contents[sheet_path])
    sd = root.find("{%s}sheetData" % SS_NS)
    rows_by_r = {int(r.get("r")): r for r in sd.findall("{%s}row" % SS_NS)}

    def cell(colnum, rownum, value):
        c = ET.Element("{%s}c" % SS_NS)
        c.set("r", num_to_col(colnum) + str(rownum))
        if isinstance(value, str):
            c.set("t", "inlineStr")
            ET.SubElement(ET.SubElement(c, "{%s}is" % SS_NS), "{%s}t" % SS_NS).text = value
        else:
            ET.SubElement(c, "{%s}v" % SS_NS).text = repr(value) if isinstance(value, float) else str(value)
        return c

    def ensure_row(rownum):
        row = rows_by_r.get(rownum)
        if row is None:
            row = ET.SubElement(sd, "{%s}row" % SS_NS)
            row.set("r", str(rownum))
            rows_by_r[rownum] = row
        return row

    def strip(row, cols):
        for c in list(row):
            if c.get("r") and _col_of(c.get("r")) in cols:
                row.remove(c)

    for c0, cols, data in specs:
        for i, line in enumerate(data):                 # write header + rows
            row = ensure_row(1 + i)
            strip(row, cols)
            for dc, val in enumerate(line):
                row.append(cell(c0 + dc, 1 + i, val))
        for rownum, row in rows_by_r.items():           # clear this block below its data
            if rownum > len(data):
                strip(row, cols)

    for row in rows_by_r.values():                      # keep each row's cells column-ordered
        cells = sorted(list(row), key=lambda c: col_to_num(_col_of(c.get("r"))))
        for c in list(row):
            row.remove(c)
        for c in cells:
            row.append(c)
    rows_sorted = sorted(sd.findall("{%s}row" % SS_NS), key=lambda r: int(r.get("r")))
    for r in list(sd):
        sd.remove(r)
    for r in rows_sorted:
        sd.append(r)

    contents[sheet_path] = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in names:
            zf.writestr(n, contents[n])
    shutil.move(tmp, path)


def run_local(path, sheets, dry_run):
    from openpyxl import load_workbook
    if not os.path.exists(path):
        sys.exit("Local workbook not found: {}".format(path))
    print("Reading {}".format(path))
    wb_r = load_workbook(path, data_only=True, read_only=True)   # cached values only; never saved
    results = {}
    for name in sheets:
        name = name.strip()
        print("▸ {}".format(name))
        if name not in wb_r.sheetnames:
            print("    sheet not found — skipping")
            continue
        ws = wb_r[name]
        if str(ws["N1"].value or "").strip() != "Ticker":
            print("    N1 is not 'Ticker' → not a portfolio-summary layout; skipping.")
            continue
        positions = read_positions_xlsx(ws)
        tickers = sorted({p["ticker"] for p in positions})
        if not tickers:
            print("    no positions found")
            continue
        print("    {} positions; fetching look-through for {} tickers…".format(len(positions), len(tickers)))
        holdings, names = fetch_lookthrough(tickers)
        rows, total = build_effective(positions, holdings, names)
        flows = build_flows(positions, holdings, names, TOP_TARGETS)
        print_preview(name, rows, total, flows)
        results[name] = (rows, flows)
    wb_r.close()

    if dry_run:
        print("[dry-run] nothing written.")
        return
    if not results:
        print("Nothing to write.")
        return

    bak = path + ".bak"
    shutil.copy2(path, bak)
    print("Backup → {}".format(bak))
    for name, (rows, flows) in results.items():
        write_blocks_xlsx(path, name, [
            (SANKEY_START_COL, flow_table(flows)),      # Source | Value | Target
            (SUMMARY_START_COL, summary_table(rows)),   # Holding | Value | %
        ])
    print("Wrote sankey {}:{} + summary {}:{} to [{}] in {}".format(
        SANKEY_START_COL, num_to_col(col_to_num(SANKEY_START_COL) + 2),
        SUMMARY_START_COL, num_to_col(col_to_num(SUMMARY_START_COL) + 2),
        ", ".join(results), path))


# ============================ online (Google Sheet) backend ============================
def run_online(sheets, dry_run):
    import gspread
    if "PUT-SPREADSHEET-ID" in SPREADSHEET_ID:
        sys.exit("Set FINANCE_SHEET_ID (or edit SPREADSHEET_ID) to the Google Sheet's id.")
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        sys.exit("Service-account key not found: {}. See setup notes at the top of this file.".format(SERVICE_ACCOUNT_FILE))
    gc = gspread.service_account(filename=SERVICE_ACCOUNT_FILE)
    sh = gc.open_by_key(SPREADSHEET_ID)

    def write_block_online(ws, start_col, data):
        c0 = col_to_num(start_col)
        cN, cP = num_to_col(c0), num_to_col(c0 + max((len(l) for l in data), default=1) - 1)
        ws.batch_clear(["{}1:{}{}".format(cN, cP, MAX_SCAN_ROW * 4)])
        ws.batch_update([{"range": "{}1:{}{}".format(cN, cP, len(data)), "values": data}])

    for name in sheets:
        name = name.strip()
        print("▸ {}".format(name))
        try:
            ws = sh.worksheet(name)
        except gspread.WorksheetNotFound:
            print("    sheet not found — skipping")
            continue
        if (ws.acell("N1").value or "").strip() != "Ticker":
            print("    N1 is not 'Ticker' → skipping (won't clobber data).")
            continue
        positions = [{"ticker": r[0].strip(), "shares": to_float(r[1]) if len(r) > 1 else None,
                      "value": to_float(r[8]) if len(r) > 8 else None}
                     for r in ws.get("N2:V{}".format(MAX_SCAN_ROW)) if r and r[0] and "#REF" not in r[0]]
        tickers = sorted({p["ticker"] for p in positions})
        if not tickers:
            print("    no positions found")
            continue
        print("    {} positions; fetching look-through for {} tickers…".format(len(positions), len(tickers)))
        holdings, names = fetch_lookthrough(tickers)
        rows, total = build_effective(positions, holdings, names)
        flows = build_flows(positions, holdings, names, TOP_TARGETS)
        print_preview(name, rows, total, flows)
        if dry_run:
            continue
        write_block_online(ws, SANKEY_START_COL, flow_table(flows))
        write_block_online(ws, SUMMARY_START_COL, summary_table(rows))
        print("    wrote sankey {} flows + summary {} holdings".format(len(flows), len(rows)))


def main():
    ap = argparse.ArgumentParser(description="Write effective look-through holdings to Portfolio_* sheets.")
    ap.add_argument("--online", action="store_true", help="update the Google Sheet (default: local Finance.xlsx)")
    ap.add_argument("--dry-run", action="store_true", help="print, do not write")
    ap.add_argument("--file", default=LOCAL_FILE, help="local .xlsx path (local mode)")
    ap.add_argument("--sheets", nargs="*", default=SHEETS, help="sheet names to update")
    args = ap.parse_args()
    if args.online:
        run_online(args.sheets, args.dry_run)
    else:
        run_local(args.file, args.sheets, args.dry_run)


if __name__ == "__main__":
    main()
