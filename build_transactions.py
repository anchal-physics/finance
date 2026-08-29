#!/usr/bin/env python3
"""
build_transactions.py
------------------------------------------------------------------------------
Merge every brokerage transaction CSV in data/ into a single chronological
ledger per person and write it to that person's Portfolio_* sheet.

Two source formats are auto-detected by header:
  * Robinhood  — already matches the sheet's field order (Activity Date,
                 Process Date, Settle Date, Instrument, Description, Trans Code,
                 Quantity, Price, Amount). Direction is encoded in Trans Code.
  * Fidelity   — Run Date, Action, Symbol, Description, Type, Price ($),
                 Quantity, ..., Amount ($), ..., Settlement Date. Direction is
                 encoded in the Action text ("YOU BOUGHT" / "YOU SOLD" / ...),
                 which we translate to the Robinhood-style Trans Codes so the
                 downstream GET_ALL_STOCK_SUMMARIES logic is unchanged.

Each row is tagged with an Account label derived from the filename and written
as the NEW LEFTMOST column A, so the ledger occupies columns A..J:

    A Account | B Activity Date | C Process Date | D Settle Date |
    E Instrument | F Description | G Trans Code | H Quantity | I Price | J Amount

(Column K — a leftover "Closing Price" — is intentionally left untouched.)

Person -> sheet:  Anchal -> Portfolio_AG,  Anamika -> Portfolio_AA
Account labels:   <Broker> {Investment | Roth IRA | Trad. IRA | IRA}
                  (an IRA is anything with "IRA" in the label; that distinction
                  is what Stock.gs uses to decide long-term-only treatment.)

Modes:
    python3 build_transactions.py               # dry preview: print + write data/merged/*.csv
    python3 build_transactions.py --dry-run     # print only, write nothing
    python3 build_transactions.py --online      # write to the Google Sheet (A1:J)

The --online write is surgical to columns A..J: it rewrites the header (row 1)
and the data rows, clears any stale rows below, and touches NOTHING else on the
sheet (K and everything from L rightward — the summary formula, Sankey block,
etc. — are left exactly as-is). A guard refuses to write unless A1 currently
reads "Activity Date" or "Account". You re-point the GET_ALL_STOCK_SUMMARIES
formula to the shifted columns yourself.

Data source:  by default reads local data/*.csv. If TX_DRIVE_FOLDER (or
              --drive-folder <id>) is set, it instead downloads the CSVs from
              that Google Drive folder (shared with the service account) into a
              temp dir and merges those — so you can just drop files in Drive.

Requirements:  gspread / google-auth (already in requirements.txt).
Online setup:  service_account.json + the sheet shared with it + FINANCE_SHEET_ID
               (same credentials as update_effective_holdings.py). Put local
               values in a gitignored `.env` (see .env.example).
------------------------------------------------------------------------------
"""
import os
import re
import csv
import sys
import glob
import argparse
from datetime import datetime, timedelta
from collections import defaultdict

def _load_local_env(path=None):
    """Load KEY=VALUE lines from a gitignored `.env` next to this script into
    os.environ WITHOUT overriding values already set (so real env / CI wins)."""
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

# ---- config (environment variables override these; see .env / .env.example) ----
DATA_DIR = os.environ.get("TX_DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
OUT_DIR = os.environ.get("TX_OUT_DIR", os.path.join(DATA_DIR, "merged"))
SPREADSHEET_ID = os.environ.get("FINANCE_SHEET_ID", "PUT-SPREADSHEET-ID-HERE")
SERVICE_ACCOUNT_FILE = os.environ.get("GSPREAD_SA_FILE", "service_account.json")
DRIVE_FOLDER_ID = os.environ.get("TX_DRIVE_FOLDER", "")   # if set, read CSVs from Drive
QUIET = False   # set by --quiet: trim output / hide ids (public CI logs)

PERSON_SHEET = {"Anchal": "Portfolio_AG", "Anamika": "Portfolio_AA"}

# ---- Assumed-Bought (AB) projection config ----
# Which account label each Investment-sheet portion maps to (drives taxable vs
# non-taxable and merging with real holdings). See §Investment sheet in CLAUDE.md.
PERSON_ACCOUNTS = {
    "Anchal":  {"taxable": "Robinhood Investment", "roth": "Robinhood Roth IRA"},
    "Anamika": {"taxable": "Robinhood Investment", "roth": "Fidelity Roth IRA"},
}
# Investment-sheet columns per person: symbol, total weekly $, Robinhood/Roth
# sub-fractions, and the two exec switches (post-insert layout, data row 4+).
INVESTMENT_SHEET_NAME = "Investment"
INVESTMENT_FIRST_ROW = 4
INVESTMENT_COLS = {
    "Anchal":  {"symbol": "D", "weekly": "L", "robSub": "H", "rothSub": "I", "execRob": "J", "execRoth": "K"},
    "Anamika": {"symbol": "D", "weekly": "S", "robSub": "O", "rothSub": "P", "execRob": "Q", "execRoth": "R"},
}
AB_CODE = "ABUY"   # Trans Code marking a projected (assumed) weekly buy

# Header written to row 1 (account is the new column A).
HEADER = ["Account", "Activity Date", "Process Date", "Settle Date",
          "Instrument", "Description", "Trans Code", "Quantity", "Price", "Amount"]

# Fidelity Action text -> Robinhood-style Trans Code. Anything share-moving must
# map to Buy/Sell/ACATI (Stock.gs routes on those); cash/dividend rows map to
# zero-quantity codes Stock.gs already ignores (CDIV/ACH).
FIDELITY_CODE_RULES = [
    ("YOU BOUGHT", "Buy"),
    ("YOU SOLD", "Sell"),
    ("REINVESTMENT", "Buy"),       # dividend reinvested -> buys shares (incl. SPAXX cash)
    ("DIVIDEND", "CDIV"),
    ("INTEREST", "CDIV"),
    ("ROLLOVER", "ACH"),           # cash contribution, no security (qty blank -> ignored)
    ("TRANSFER", "ACATI"),
    ("CONTRIBUTION", "ACH"),
]


# ============================ parsing helpers ============================
def parse_num(s):
    """RH '($1,224.50)' -> -1224.5, RH '$2.58' -> 2.58, Fidelity '-2426.1' ->
    -2426.1, '' -> ''. Unparseable -> original string (so nothing is silently
    dropped)."""
    raw = "" if s is None else str(s).strip()
    if raw == "":
        return ""
    neg = raw.startswith("(") and raw.endswith(")")
    t = raw.replace("(", "").replace(")", "").replace("$", "").replace(",", "").strip()
    if t == "":
        return ""
    try:
        v = float(t)
    except ValueError:
        return raw
    return -v if neg else v


def parse_date(s):
    """Return a datetime for sorting, or None. Accepts M/D/YYYY and YYYY-MM-DD."""
    raw = "" if s is None else str(s).strip()
    if not raw:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            pass
    return None


def norm_date(s):
    """Canonical M/D/YYYY string for the sheet (so USER_ENTERED stores a date)."""
    d = parse_date(s)
    return "{}/{}/{}".format(d.month, d.day, d.year) if d else ("" if s is None else str(s).strip())


def account_label(filename):
    """Anchal_Robinhood_Roth_IRA_...csv -> ('Anchal', 'Robinhood Roth IRA')."""
    stem = os.path.basename(filename)
    stem = re.sub(r"\.csv$", "", stem, flags=re.I)
    tokens = stem.split("_")
    person = tokens[0]
    # descriptor = tokens after person, up to the first date-ish token or 'to'
    desc = []
    for tok in tokens[1:]:
        if tok.lower() == "to" or re.match(r"^\d{4}", tok) or re.match(r"^\d{6}", tok):
            break
        desc.append(tok)
    broker = desc[0] if desc else "Unknown"
    rest = " ".join(desc[1:]).lower()
    if "roth" in rest:
        kind = "Roth IRA"
    elif "traditional" in rest or "trad" in rest:
        kind = "Trad. IRA"
    elif "ira" in rest:
        kind = "IRA"
    else:
        kind = "Investment"
    return person, "{} {}".format(broker, kind)


def is_date_row(v):
    return parse_date(v) is not None


def detect_format(header_cells):
    joined = ",".join(c.strip().lower() for c in header_cells)
    if "activity date" in joined and "trans code" in joined:
        return "robinhood"
    if "run date" in joined and "action" in joined:
        return "fidelity"
    return None


# ============================ per-format readers ============================
def read_robinhood(path, account):
    """RH CSV -> list of ledger dicts. Skips the trailing disclaimer/blank rows."""
    out = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        r = csv.reader(fh)
        for row in r:
            if not row or not is_date_row(row[0]):
                continue
            row = (row + [""] * 9)[:9]
            out.append({
                "account": account,
                "activity": norm_date(row[0]),
                "process": norm_date(row[1]),
                "settle": norm_date(row[2]),
                "instrument": row[3].strip(),
                "description": row[4].strip(),
                "code": row[5].strip(),
                "quantity": parse_num(row[6]),
                "price": parse_num(row[7]),
                "amount": parse_num(row[8]),
                "_sortdate": parse_date(row[0]),
            })
    return out


def fidelity_code(action):
    a = (action or "").upper()
    for needle, code in FIDELITY_CODE_RULES:
        if needle in a:
            return code
    # fall back to the first word so nothing is mislabelled as a trade
    return (a.split() or ["MISC"])[0].title()


def read_fidelity(path, account):
    out = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    # find the header row (has "Run Date")
    hidx = next((i for i, r in enumerate(rows)
                 if r and any(c.strip().lower() == "run date" for c in r)), None)
    if hidx is None:
        return out
    header = [c.strip() for c in rows[hidx]]
    idx = {name.lower(): i for i, name in enumerate(header)}

    def get(row, *names):
        for nm in names:
            i = idx.get(nm.lower())
            if i is not None and i < len(row):
                return row[i]
        return ""

    for row in rows[hidx + 1:]:
        if not row or not is_date_row(get(row, "Run Date")):
            continue
        action = get(row, "Action")
        out.append({
            "account": account,
            "activity": norm_date(get(row, "Run Date")),
            "process": norm_date(get(row, "Run Date")),   # Fidelity has no separate process date
            "settle": norm_date(get(row, "Settlement Date")) or norm_date(get(row, "Run Date")),
            "instrument": get(row, "Symbol").strip(),
            "description": (get(row, "Description").strip() or action.strip()),
            "code": fidelity_code(action),
            "quantity": parse_num(get(row, "Quantity")),
            "price": parse_num(get(row, "Price ($)", "Price")),
            "amount": parse_num(get(row, "Amount ($)", "Amount")),
            "_sortdate": parse_date(get(row, "Run Date")),
        })
    return out


READERS = {"robinhood": read_robinhood, "fidelity": read_fidelity}


# ================= cost-basis back-fill (ACATI transfer-ins) =================
# Robinhood reports transferred-in lots (Trans Code ACATI) with shares but no
# dollar Amount and no Price, so there's no cost basis. Look up the closing
# price on the transfer date and set Amount = |shares| * close, making the
# ledger self-contained (the old "Closing Price" column K is then unnecessary).
ADD_CODES = ("BUY", "ACATI")


def _hist_close_map(hist):
    """yahooquery history DataFrame -> {date: close}."""
    m = {}
    try:
        df = hist.reset_index() if hasattr(hist, "reset_index") else hist
        cols = {str(c).lower(): c for c in df.columns}
        dcol, ccol = cols.get("date"), cols.get("close")
        if dcol is None or ccol is None:
            return m
        for _, row in df.iterrows():
            d = row[dcol]
            try:
                dd = d.date() if hasattr(d, "date") else datetime.strptime(str(d)[:10], "%Y-%m-%d").date()
            except (ValueError, TypeError):
                continue
            v = row[ccol]
            if v == v:  # skip NaN
                m[dd] = float(v)
    except Exception:
        pass
    return m


def _nearest_close(closes, d):
    """Close on d, else the nearest trading day within a week (prior first)."""
    if d in closes:
        return closes[d]
    for back in range(1, 8):
        if (d - timedelta(days=back)) in closes:
            return closes[d - timedelta(days=back)]
    for fwd in range(1, 8):
        if (d + timedelta(days=fwd)) in closes:
            return closes[d + timedelta(days=fwd)]
    return None


def fill_missing_basis(rows, enabled):
    need = [t for t in rows
            if t["amount"] in ("", 0) and t["code"].upper() in ADD_CODES
            and isinstance(t["quantity"], float) and abs(t["quantity"]) > 0 and t["_sortdate"]]
    stats = {"needed": len(need), "filled": 0, "failed": 0}
    if not need:
        return stats
    if not enabled:
        return stats
    try:
        from yahooquery import Ticker
    except ImportError:
        print("    ! yahooquery not installed — skipping basis back-fill (use --no-price-fill to silence)")
        return stats
    by_tkr = defaultdict(list)
    for t in need:
        by_tkr[t["instrument"]].append(t)
    for tkr, items in by_tkr.items():
        dts = [t["_sortdate"] for t in items]
        start = (min(dts) - timedelta(days=5)).strftime("%Y-%m-%d")
        end = (max(dts) + timedelta(days=5)).strftime("%Y-%m-%d")
        try:
            closes = _hist_close_map(Ticker(tkr).history(start=start, end=end, interval="1d"))
        except Exception:
            closes = {}
        for t in items:
            price = _nearest_close(closes, t["_sortdate"].date())
            if price:
                t["price"] = round(price, 4)
                t["amount"] = round(abs(t["quantity"]) * price, 2)  # positive, matching RH's ACATI-with-amount rows
                stats["filled"] += 1
            else:
                stats["failed"] += 1
                print("    ! no historical close for {} on {} — left blank".format(tkr, t["activity"]))
    return stats


# ============================ merge ============================
def dedupe_key(t):
    return (t["account"], t["activity"], t["settle"], t["instrument"],
            t["code"], t["quantity"], t["price"], t["amount"], t["description"])


def merge_person_files(files, price_fill=True):
    """Return (rows_sorted_newest_first, stats) for one person's files."""
    all_rows, seen, dupes = [], set(), 0
    per_account = {}
    for path, fmt, account in files:
        rows = READERS[fmt](path, account)
        per_account[account] = per_account.get(account, 0) + len(rows)
        for t in rows:
            k = dedupe_key(t)
            if k in seen:
                dupes += 1
                continue
            seen.add(k)
            all_rows.append(t)
    basis = fill_missing_basis(all_rows, price_fill)
    # newest first; undated rows sort to the bottom, keeping input order (stable)
    all_rows.sort(key=lambda t: (t["_sortdate"] is not None, t["_sortdate"] or datetime.min),
                  reverse=True)
    dates = [t["_sortdate"] for t in all_rows if t["_sortdate"]]
    stats = {
        "count": len(all_rows),
        "dupes": dupes,
        "per_account": per_account,
        "basis": basis,
        "date_min": min(dates).strftime("%Y-%m-%d") if dates else "?",
        "date_max": max(dates).strftime("%Y-%m-%d") if dates else "?",
    }
    return all_rows, stats


def to_matrix(rows):
    """Ledger dicts -> list-of-lists in column order A..J (header first)."""
    out = [HEADER[:]]
    for t in rows:
        out.append([t["account"], t["activity"], t["process"], t["settle"],
                    t["instrument"], t["description"], t["code"],
                    t["quantity"], t["price"], t["amount"]])
    return out


def download_drive_csvs(folder_id):
    """Download every CSV in a Google Drive folder (shared with the service
    account) into a fresh temp dir and return its path. Uses google-auth only
    (no google-api-python-client needed). Native Google Sheets are exported to
    CSV; raw text/csv files are downloaded as-is."""
    import tempfile
    from google.oauth2.service_account import Credentials
    from google.auth.transport.requests import AuthorizedSession
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        sys.exit("Service-account key not found: {}".format(SERVICE_ACCOUNT_FILE))
    creds = Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=["https://www.googleapis.com/auth/drive.readonly"])
    sess = AuthorizedSession(creds)

    files, page = [], None
    while True:
        params = {"q": "'{}' in parents and trashed=false".format(folder_id),
                  "fields": "nextPageToken,files(id,name,mimeType)",
                  "pageSize": 200, "includeItemsFromAllDrives": True, "supportsAllDrives": True}
        if page:
            params["pageToken"] = page
        r = sess.get("https://www.googleapis.com/drive/v3/files", params=params)
        r.raise_for_status()
        j = r.json()
        files += j.get("files", [])
        page = j.get("nextPageToken")
        if not page:
            break

    dest = tempfile.mkdtemp(prefix="tx_drive_")
    n = 0
    for f in files:
        name, fid, mt = f["name"], f["id"], f.get("mimeType", "")
        if mt == "text/csv" or name.lower().endswith(".csv"):
            url = "https://www.googleapis.com/drive/v3/files/{}?alt=media".format(fid)
        elif mt == "application/vnd.google-apps.spreadsheet":
            url = "https://www.googleapis.com/drive/v3/files/{}/export?mimeType=text/csv".format(fid)
            if not name.lower().endswith(".csv"):
                name += ".csv"
        else:
            continue
        rr = sess.get(url, params={"supportsAllDrives": True})
        rr.raise_for_status()
        with open(os.path.join(dest, name), "wb") as out:
            out.write(rr.content)
        n += 1
    if QUIET:
        print("Downloaded {} CSV(s) from Drive folder → {}".format(n, dest))
    else:
        print("Downloaded {} CSV(s) from Drive folder {} → {}".format(n, folder_id, dest))
    return dest


# ================= Assumed-Bought (AB) projection =================
# For each Friday AFTER the person's latest REAL transaction, the weekly strategy
# is assumed to buy each stock whose exec switch is on, priced at that Friday's
# close. Each assumed buy is one ABUY row per (account, ticker, Friday). ABUY
# history is PRESERVED across runs (each row freezes that week's switches/price);
# we only append new Fridays and drop ABUY that new real data has superseded.
def _col0(letter):
    n = 0
    for ch in str(letter).upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1   # 0-based column index


def _num(x):
    v = parse_num(x)
    return v if isinstance(v, float) else 0.0


def fridays_between(after_dt, today_dt):
    """Fridays strictly after `after_dt` and on/before `today_dt` (both datetimes)."""
    out, d, end = [], after_dt.date() + timedelta(days=1), today_dt.date()
    while d <= end:
        if d.weekday() == 4:
            out.append(datetime(d.year, d.month, d.day))
        d += timedelta(days=1)
    return out


def read_investment_strategy(sh, person):
    """[{symbol, robAmount, rothAmount}] for stocks with an executing weekly plan."""
    cols = INVESTMENT_COLS[person]
    ws = sh.worksheet(INVESTMENT_SHEET_NAME)
    vals = ws.get("A{}:W{}".format(INVESTMENT_FIRST_ROW, 300), value_render_option="UNFORMATTED_VALUE")
    out = []
    for row in vals:
        row = (row + [""] * 23)[:23]
        sym = str(row[_col0(cols["symbol"])]).strip()
        if not sym:
            continue
        weekly = _num(row[_col0(cols["weekly"])])
        rob = weekly * _num(row[_col0(cols["robSub"])]) if _num(row[_col0(cols["execRob"])]) else 0.0
        roth = weekly * _num(row[_col0(cols["rothSub"])]) if _num(row[_col0(cols["execRoth"])]) else 0.0
        if rob > 0 or roth > 0:
            out.append({"symbol": sym, "robAmount": round(rob, 2), "rothAmount": round(roth, 2)})
    return out


def read_existing_abuy(ws):
    """Existing ABUY rows on the sheet -> ledger dicts (preserved verbatim)."""
    last = len(ws.col_values(1))
    if last < 2:
        return []
    rows = ws.get("A2:J{}".format(last), value_render_option="FORMATTED_VALUE")
    out = []
    for r in rows:
        r = (r + [""] * 10)[:10]
        if str(r[6]).strip().upper() != AB_CODE:
            continue
        out.append({
            "account": str(r[0]).strip(), "activity": norm_date(r[1]), "process": norm_date(r[2]),
            "settle": norm_date(r[3]), "instrument": str(r[4]).strip(), "description": str(r[5]).strip(),
            "code": AB_CODE, "quantity": parse_num(r[7]), "price": parse_num(r[8]),
            "amount": parse_num(r[9]), "_sortdate": parse_date(r[1]),
        })
    return out


def _ab_row(account, ticker, friday, amount, close):
    return {
        "account": account, "activity": norm_date(friday.strftime("%m/%d/%Y")),
        "process": norm_date(friday.strftime("%m/%d/%Y")), "settle": norm_date(friday.strftime("%m/%d/%Y")),
        "instrument": ticker, "description": "Assumed weekly buy (strategy projection)",
        "code": AB_CODE, "quantity": round(amount / close, 6), "price": round(close, 4),
        "amount": round(-amount, 2), "_sortdate": friday,
    }


def build_ab_rows(sh, sheet_name, person, real_rows):
    """Return (ab_rows, stats): preserved existing ABUY + freshly appended Fridays."""
    stats = {"kept": 0, "new": 0}
    if person not in PERSON_ACCOUNTS:
        return [], stats
    acct = PERSON_ACCOUNTS[person]
    try:
        ws = sh.worksheet(sheet_name)
        existing = read_existing_abuy(ws)
    except Exception as e:
        print("    ! AB: could not read existing ABUY ({}) — skipping AB".format(type(e).__name__))
        return [], stats

    real_dates = [t["_sortdate"] for t in real_rows if t["_sortdate"]]
    latest_real = max(real_dates) if real_dates else datetime(1900, 1, 1)
    kept = [ab for ab in existing if ab["_sortdate"] and ab["_sortdate"] > latest_real]
    stats["kept"] = len(kept)
    covered = set(ab["_sortdate"].date() for ab in kept if ab["_sortdate"])
    start = max([latest_real] + [ab["_sortdate"] for ab in kept if ab["_sortdate"]])
    fridays = [f for f in fridays_between(start, datetime.now()) if f.date() not in covered]
    if not fridays:
        return kept, stats

    try:
        strategy = read_investment_strategy(sh, person)
    except Exception as e:
        print("    ! AB: could not read Investment strategy ({}) — keeping existing ABUY only".format(type(e).__name__))
        return kept, stats
    if not strategy:
        return kept, stats

    # historical daily closes for each strategy ticker over the projection window
    try:
        from yahooquery import Ticker
        tickers = [s["symbol"] for s in strategy]
        start_s = (min(fridays) - timedelta(days=6)).strftime("%Y-%m-%d")
        end_s = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        closes = {}
        for tk in tickers:
            try:
                closes[tk] = _hist_close_map(Ticker(tk).history(start=start_s, end=end_s, interval="1d"))
            except Exception:
                closes[tk] = {}
    except ImportError:
        print("    ! AB: yahooquery not installed — keeping existing ABUY only")
        return kept, stats

    new = []
    for f in fridays:
        for s in strategy:
            px = _nearest_close(closes.get(s["symbol"], {}), f.date())
            if not px:
                continue   # Friday's close not available yet (future / not settled)
            if s["robAmount"] > 0:
                new.append(_ab_row(acct["taxable"], s["symbol"], f, s["robAmount"], px))
            if s["rothAmount"] > 0:
                new.append(_ab_row(acct["roth"], s["symbol"], f, s["rothAmount"], px))
    stats["new"] = len(new)
    return kept + new, stats


def discover():
    """Group data/*.csv by person -> [(path, fmt, account), ...]."""
    by_person = {}
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "*.csv"))):
        with open(path, newline="", encoding="utf-8-sig") as fh:
            for row in csv.reader(fh):
                if row and any(c.strip() for c in row):
                    fmt = detect_format(row)
                    if fmt:
                        break
            else:
                fmt = None
        if not fmt:
            print("  ! {}: unrecognised format — skipping".format(os.path.basename(path)))
            continue
        person, account = account_label(path)
        by_person.setdefault(person, []).append((path, fmt, account))
    return by_person


# ============================ outputs ============================
def print_summary(person, sheet, stats, files):
    if QUIET:
        print("=== {} -> {}: merged {} rows (deduped {}) ===".format(
            person, sheet, stats["count"], stats["dupes"]))
        return
    print("\n=== {} -> {} ===".format(person, sheet))
    for path, fmt, account in files:
        print("    {:<22} [{:<9}] {}".format(account, fmt, os.path.basename(path)))
    print("    merged rows: {}   (deduped {} overlap rows)".format(stats["count"], stats["dupes"]))
    print("    date range : {} .. {}".format(stats["date_min"], stats["date_max"]))
    print("    by account : " + ", ".join("{}={}".format(a, n) for a, n in sorted(stats["per_account"].items())))
    b = stats["basis"]
    if b["needed"]:
        print("    basis fill : {} transfer-in rows needed a cost basis -> {} filled, {} failed"
              .format(b["needed"], b["filled"], b["failed"]))


def write_csv(sheet, matrix):
    os.makedirs(OUT_DIR, exist_ok=True)
    p = os.path.join(OUT_DIR, sheet + ".csv")
    with open(p, "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(matrix)
    print("    wrote preview -> {}".format(p))


def open_spreadsheet():
    import gspread
    if "PUT-SPREADSHEET-ID" in SPREADSHEET_ID:
        sys.exit("Set FINANCE_SHEET_ID to the Google Sheet's id.")
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        sys.exit("Service-account key not found: {}".format(SERVICE_ACCOUNT_FILE))
    return gspread.service_account(filename=SERVICE_ACCOUNT_FILE).open_by_key(SPREADSHEET_ID)


def write_online(sh, sheet, matrix):
    ws = sh.worksheet(sheet)
    a1 = (ws.acell("A1").value or "").strip()
    if a1 not in ("Activity Date", "Account"):
        print("    A1 is '{}', not 'Activity Date'/'Account' -> refusing to write.".format(a1))
        return
    # Clear the old A..J block (leave K and everything from L rightward alone),
    # covering whichever is longer: the existing data or the new data.
    old_last = len(ws.col_values(1))
    last = max(old_last, len(matrix)) + 5
    ws.batch_clear(["A1:J{}".format(last)])
    ws.update(range_name="A1", values=matrix, value_input_option="USER_ENTERED")
    print("    wrote {} rows to {}!A1:J{}".format(len(matrix) - 1, sheet, len(matrix)))


# ============================ main ============================
def main():
    ap = argparse.ArgumentParser(description="Merge data/*.csv into per-person transaction ledgers.")
    ap.add_argument("--online", action="store_true", help="write to the Google Sheet (default: local preview CSVs)")
    ap.add_argument("--dry-run", action="store_true", help="print only, write nothing")
    ap.add_argument("--only", nargs="*", help="limit to these people (e.g. Anchal)")
    ap.add_argument("--no-price-fill", action="store_true",
                    help="skip the historical-close lookup for transfer-in cost basis")
    ap.add_argument("--drive-folder", default=None,
                    help="read CSVs from this Google Drive folder id instead of local data/ "
                         "(defaults to TX_DRIVE_FOLDER)")
    ap.add_argument("--quiet", action="store_true",
                    help="trim output and hide ids (for public CI logs)")
    args = ap.parse_args()

    global QUIET
    QUIET = args.quiet

    global DATA_DIR
    folder = args.drive_folder or DRIVE_FOLDER_ID
    if folder:
        DATA_DIR = download_drive_csvs(folder)   # temp dir of downloaded CSVs

    by_person = discover()
    if not by_person:
        sys.exit("No recognised CSVs in {}".format(DATA_DIR))

    sh = open_spreadsheet() if args.online else None  # one handle for AB reads + writes

    for person, files in sorted(by_person.items()):
        if args.only and person not in args.only:
            continue
        sheet = PERSON_SHEET.get(person)
        rows, stats = merge_person_files(files, price_fill=not args.no_price_fill)
        print_summary(person, sheet or "(no sheet mapping)", stats, files)
        if not sheet:
            print("    ! no sheet mapping for '{}' -> not writing".format(person))
            continue
        # Assumed-Bought projection (online only — needs the sheet + Investment strategy).
        if sh is not None:
            ab_rows, ab_stats = build_ab_rows(sh, sheet, person, rows)
            if ab_stats["kept"] or ab_stats["new"]:
                print("    assumed-buys: kept {} existing ABUY + appended {} new".format(
                    ab_stats["kept"], ab_stats["new"]))
            rows = rows + ab_rows
            rows.sort(key=lambda t: (t["_sortdate"] is not None, t["_sortdate"] or datetime.min), reverse=True)
        matrix = to_matrix(rows)
        if args.dry_run:
            continue
        if args.online:
            write_online(sh, sheet, matrix)
        else:
            write_csv(sheet, matrix)


if __name__ == "__main__":
    main()
