/**
 * Portfolio.gs
 * ----------------------------------------------------------------------
 * Server for the portfolio-stats tabs. Reads the computed summary columns that
 * GET_ALL_STOCK_SUMMARIES + the anchored price/value/profit formulas produce on
 * a Portfolio_* sheet, and returns a per-stock model for the pie + profit bars.
 *
 * The summary is now MULTI-ACCOUNT: GET_ALL_STOCK_SUMMARIES emits one row per
 * (account, ticker), so the same ticker can appear under several accounts. The
 * pie / return / LT panels AGGREGATE by ticker across accounts (one slice per
 * ticker, portfolio-wide); the per-account breakdown appears only in the
 * effective-holdings Sankey (Account → ticker → company).
 *
 * CONFIG-DRIVEN: to add another investor's portfolio page, add one entry to
 * PORTFOLIOS_ (a key + its sheet name + a label). The client generates the
 * tab + page from getPortfolioList() automatically — no other code changes.
 *
 * Column layout on the portfolio sheet (header row 1, data row 2 onward):
 *   N Account | O Ticker | P Total Shares | Q LT Shares | R ST Shares |
 *   S LT Avg Cost/Share | T ST Avg Cost/Share | U Total Cost | V Price |
 *   W Total Current Value | X Total LT Value | Y Total ST Value |
 *   Z Possible Long Term Profit ($) | AA Possible Simple Profit % (fraction) |
 *   AB Ticker (helper) | AC..AG trailing % changes (1w/4w/12w/6m/1y) |
 *   AN|AO|AP effective-holdings Sankey flows (Source | Value | Target).
 * ----------------------------------------------------------------------
 */

var PORTFOLIOS_ = {
  Anchal:  { key: 'Anchal',  sheetName: 'Portfolio_AG', label: 'Anchal Portfolio' },
  Anamika: { key: 'Anamika', sheetName: 'Portfolio_AA', label: 'Anamika Portfolio' }
};

// Column letters on the portfolio sheet; data starts row 2 (row 1 = header).
// AC:AG are trailing period % changes (fractions) used as markers in the
// return-bar chart. AB is a duplicate ticker column (ignored).
var PF_COLS = {
  account: 'N', ticker: 'O', cost: 'U', price: 'V', value: 'W', ltProfit: 'Z', ltProfitPct: 'AA',
  w1: 'AC', w4: 'AD', w12: 'AE', m6: 'AF', y1: 'AG'
};
// Order + labels for the period-change markers (client draws ticks in this order).
var PF_PERIOD_KEYS = ['w1', 'w4', 'w12', 'm6', 'y1'];
var PF_FIRST_DATA_ROW = 2;
// Money-market / cash-sweep pseudo-tickers to exclude from holdings.
var PF_CASH_TICKERS = { SPAXX: 1, FDRXX: 1, FZFXX: 1, SPRXX: 1, VMFXX: 1 };

/** List of portfolios for the client to build tabs/pages from. */
function getPortfolioList() {
  return Object.keys(PORTFOLIOS_).map(function (k) {
    return { key: PORTFOLIOS_[k].key, label: PORTFOLIOS_[k].label };
  });
}

/**
 * Per-stock stats + portfolio totals for one portfolio.
 * @return {Object} { key, label, stocks:[{ticker, value, cost, price, pctProfit,
 *   taxLtProfitDollar, taxLtProfitPct, hasTaxLt,   // taxable LT capital gain
 *   iraProfitDollar, iraProfitPct, hasIra,          // IRA (non-taxable) full gain
 *   changes, colorIndex}], flows, totals:{value, cost, profitDollar, profitPct} }
 *   Fractions (pctProfit, *Pct, totals.profitPct) are ×100 in the UI.
 */
function getPortfolioStats(key) {
  var cfg = PORTFOLIOS_[key];
  if (!cfg) throw new Error('Unknown portfolio "' + key + '".');
  var sheet = SpreadsheetApp.getActive().getSheetByName(cfg.sheetName);
  if (!sheet) throw new Error('Sheet "' + cfg.sheetName + '" not found.');

  var base = colLetterToIndex_('N');                       // 0-based sheet column of N
  // Read out to AP so we also pick up the Sankey flow block AN|AO|AP that the
  // local update_effective_holdings.py script writes (Source | Value | Target).
  var numCols = colLetterToIndex_('AP') - base + 1;        // N..AP
  var lastRow = sheet.getLastRow();
  if (lastRow < PF_FIRST_DATA_ROW) {
    return { key: cfg.key, label: cfg.label, stocks: [], flows: [], totals: { value: 0, cost: 0, profitDollar: 0, profitPct: 0 } };
  }
  var vals = sheet.getRange(1, base + 1, lastRow, numCols).getValues();
  var rel = {};
  Object.keys(PF_COLS).forEach(function (k) { rel[k] = colLetterToIndex_(PF_COLS[k]) - base; });

  // One summary row per (account, ticker). Aggregate by ticker across accounts,
  // BUT split profit by account type so the client can show two panels:
  //   • taxable accounts → Long-term capital-gain profit (col Z, LT-only $)
  //   • IRA accounts     → full gain (value − cost), sellable tax-free
  // (`isIRA` = "IRA" in the account label, matching Stock.gs.)
  var byTicker = {};   // ticker -> aggregate
  var order = [];      // preserve first-seen order before value sort
  for (var r = PF_FIRST_DATA_ROW - 1; r < lastRow; r++) {
    var row = vals[r];
    var tk = row[rel.ticker];
    if (tk === '' || tk == null || String(tk).indexOf('#REF') >= 0) continue;
    tk = String(tk).trim();
    if (PF_CASH_TICKERS[tk.toUpperCase()]) continue;        // skip money-market cash
    var value = pfNum_(row[rel.value]);
    var cost = pfNum_(row[rel.cost]);
    var ltp = pfNum_(row[rel.ltProfit]);
    var isIRA = /ira/i.test(String(row[rel.account] == null ? '' : row[rel.account]));
    var agg = byTicker[tk];
    if (!agg) {
      agg = byTicker[tk] = { ticker: tk, value: 0, cost: 0, price: 0, changes: null,
                             taxProfit: 0, taxCost: 0, iraProfit: 0, iraCost: 0 };
      order.push(tk);
    }
    agg.value += value;
    agg.cost += cost;
    if (isIRA) { agg.iraProfit += (value - cost); agg.iraCost += cost; }
    else       { agg.taxProfit += ltp;            agg.taxCost += cost; }
    if (!agg.price) agg.price = pfNum_(row[rel.price]);
    if (!agg.changes) {
      var changes = {};
      PF_PERIOD_KEYS.forEach(function (k) { changes[k] = pfNumOrNull_(row[rel[k]]); });
      agg.changes = changes;    // trailing % changes are per-ticker (same across accounts)
    }
  }

  var stocks = [], totalValue = 0, totalCost = 0;
  order.forEach(function (tk) {
    var a = byTicker[tk];
    stocks.push({
      ticker: a.ticker,
      value: a.value,
      cost: a.cost,
      price: a.price,
      pctProfit: a.cost > 0 ? (a.value - a.cost) / a.cost : 0,
      // Taxable long-term capital-gain profit ($ = col Z; % relative to taxable cost)
      taxLtProfitDollar: a.taxProfit,
      taxLtProfitPct: a.taxCost > 0 ? a.taxProfit / a.taxCost : 0,
      hasTaxLt: Math.abs(a.taxProfit) > 1e-9,
      // IRA (non-taxable) profit: full gain on IRA holdings
      iraProfitDollar: a.iraProfit,
      iraProfitPct: a.iraCost > 0 ? a.iraProfit / a.iraCost : 0,
      hasIra: Math.abs(a.iraProfit) > 1e-9,
      changes: a.changes  // {w1,w4,w12,m6,y1} trailing % changes (fraction; null if blank)
    });
    totalValue += a.value;
    totalCost += a.cost;
  });

  stocks.sort(function (a, b) { return b.value - a.value; });
  stocks.forEach(function (s, i) { s.colorIndex = i; });

  // Effective-holdings Sankey flows from AN (source) | AO (value) | AP (target).
  // Row 1 is the header ("Source"); data starts row 2. The block may now hold
  // TWO levels of edges: account → ticker and ticker → effective company.
  var anRel = colLetterToIndex_('AN') - base;
  var aoRel = colLetterToIndex_('AO') - base;
  var apRel = colLetterToIndex_('AP') - base;
  var flows = [];
  for (var fr = PF_FIRST_DATA_ROW - 1; fr < lastRow; fr++) {
    var src = vals[fr][anRel];
    if (src === '' || src == null) continue;
    src = String(src).trim();
    if (src === '' || src === 'Source') continue;
    var fv = pfNum_(vals[fr][aoRel]);
    if (fv <= 0) continue;
    flows.push({ source: src, value: fv, target: String(vals[fr][apRel] == null ? '' : vals[fr][apRel]).trim() });
  }

  return {
    key: cfg.key,
    label: cfg.label,
    stocks: stocks,
    flows: flows,
    totals: {
      value: totalValue,
      cost: totalCost,
      profitDollar: totalValue - totalCost,
      profitPct: totalCost > 0 ? (totalValue - totalCost) / totalCost : 0
    }
  };
}

function pfNum_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
// null for blank/non-numeric (so the client can skip that marker), else the number.
function pfNumOrNull_(v) { if (v === '' || v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
