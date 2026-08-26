#!/usr/bin/env python3
"""
recalc_sheet.py
------------------------------------------------------------------------------
Force a live recalculation of the volatile / computed cells on the Portfolio_*
sheets, so that after build_transactions.py rewrites the raw ledger the
downstream summary and prices are fresh before update_effective_holdings.py
reads them.

This is the Python/gspread equivalent of the Apps Script `forceRecalc_`: it
scans the computed region and RE-WRITES every formula cell containing
GOOGLEFINANCE / GET_ALL_STOCK_SUMMARIES / TODAY back to itself (value unchanged),
which marks it dirty and makes the calc engine re-evaluate it — including the
GET_ALL_STOCK_SUMMARIES spill anchor at N1. Literals and non-matching formulas
are left untouched.

Usage:  python recalc_sheet.py            # recalc EFF_SHEETS (default both)
        python recalc_sheet.py --sheets Portfolio_AG
Config:  FINANCE_SHEET_ID + service_account.json (via .env / env / CI secrets).
------------------------------------------------------------------------------
"""
import os
import re
import sys
import argparse


def _load_local_env(path=None):
    path = path or os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_local_env()

SPREADSHEET_ID = os.environ.get("FINANCE_SHEET_ID", "PUT-SPREADSHEET-ID-HERE")
SERVICE_ACCOUNT_FILE = os.environ.get("GSPREAD_SA_FILE", "service_account.json")
SHEETS = os.environ.get("EFF_SHEETS", "Portfolio_AG,Portfolio_AA").split(",")

# Region scanned for volatile formulas (well past the real data; header row 1).
SCAN_RANGE = "M1:AL400"
VOLATILE = re.compile(r"GOOGLEFINANCE|GET_ALL_STOCK_SUMMARIES|TODAY", re.I)


def recalc_worksheet(ws):
    from gspread.utils import a1_to_rowcol, rowcol_to_a1
    r0, c0 = a1_to_rowcol(SCAN_RANGE.split(":")[0])
    grid = ws.get(SCAN_RANGE, value_render_option="FORMULA")
    reqs = []
    for i, row in enumerate(grid):
        for j, val in enumerate(row):
            if isinstance(val, str) and val.startswith("=") and VOLATILE.search(val):
                reqs.append({"range": rowcol_to_a1(r0 + i, c0 + j), "values": [[val]]})
    if reqs:
        ws.batch_update(reqs, value_input_option="USER_ENTERED")
    return len(reqs)


def main():
    ap = argparse.ArgumentParser(description="Force-recalc volatile formulas on Portfolio_* sheets.")
    ap.add_argument("--sheets", nargs="*", default=SHEETS)
    args = ap.parse_args()

    import gspread
    if "PUT-SPREADSHEET-ID" in SPREADSHEET_ID:
        sys.exit("Set FINANCE_SHEET_ID to the Google Sheet's id.")
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        sys.exit("Service-account key not found: {}".format(SERVICE_ACCOUNT_FILE))
    sh = gspread.service_account(filename=SERVICE_ACCOUNT_FILE).open_by_key(SPREADSHEET_ID)

    for name in args.sheets:
        name = name.strip()
        try:
            ws = sh.worksheet(name)
        except gspread.WorksheetNotFound:
            print("▸ {}: not found — skipping".format(name))
            continue
        n = recalc_worksheet(ws)
        print("▸ {}: re-stamped {} volatile formula cell(s) to force recalc".format(name, n))


if __name__ == "__main__":
    main()
