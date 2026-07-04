/**
 * Portfolio.gs
 * ----------------------------------------------------------------------
 * Server for the portfolio-stats tabs. Reads the computed summary columns
 * (N:Z) that GET_ALL_STOCK_SUMMARIES + the anchored price/value/profit
 * formulas produce on a Portfolio_* sheet, and returns a per-stock model
 * for the pie + profit bar charts.
 *
 * CONFIG-DRIVEN: to add another investor's portfolio page, add one entry to
 * PORTFOLIOS_ (a key + its sheet name + a label). The client generates the
 * tab + page from getPortfolioList() automatically — no other code changes.
 *
 * Column layout on the portfolio sheet (header row 1, data row 2 onward):
 *   N Ticker | O Total Shares | P LT Shares | Q ST Shares |
 *   R LT Avg Cost/Share | S ST Avg Cost/Share | T Total Cost |
 *   U Price | V Total Current Value | W LT Value | X ST Value |
 *   Y Possible Long Term Profit ($) | Z Possible Simple Profit % (fraction)
 * ----------------------------------------------------------------------
 */

var PORTFOLIOS_ = {
  Anchal: { key: 'Anchal', sheetName: 'Portfolio_AG', label: 'Anchal Portfolio' }
  // Add later, once the sheet exists:
  // Anamika: { key: 'Anamika', sheetName: 'Portfolio_AA', label: 'Anamika Portfolio' }
};

// Column letters on the portfolio sheet; data starts row 2 (row 1 = header).
// AB:AF are trailing period % changes (fractions) used as markers in the
// return-bar chart. AA is a duplicate ticker column (ignored).
var PF_COLS = {
  ticker: 'N', cost: 'T', price: 'U', value: 'V', ltProfit: 'Y', ltProfitPct: 'Z',
  w1: 'AB', w4: 'AC', w12: 'AD', m6: 'AE', y1: 'AF'
};
var PF_LAST_COL = 'AF';
// Order + labels for the period-change markers (client draws ticks in this order).
var PF_PERIOD_KEYS = ['w1', 'w4', 'w12', 'm6', 'y1'];
var PF_FIRST_DATA_ROW = 2;

/** List of portfolios for the client to build tabs/pages from. */
function getPortfolioList() {
  return Object.keys(PORTFOLIOS_).map(function (k) {
    return { key: PORTFOLIOS_[k].key, label: PORTFOLIOS_[k].label };
  });
}

/**
 * Per-stock stats + portfolio totals for one portfolio.
 * @return {Object} { key, label, stocks:[{ticker, value, cost, price,
 *   pctProfit, ltProfitDollar, ltProfitPct, hasLtProfit, colorIndex}],
 *   totals:{value, cost, profitDollar, profitPct} }
 *   Fractions (pctProfit, ltProfitPct, totals.profitPct) are ×100 in the UI.
 */
function getPortfolioStats(key) {
  var cfg = PORTFOLIOS_[key];
  if (!cfg) throw new Error('Unknown portfolio "' + key + '".');
  var sheet = SpreadsheetApp.getActive().getSheetByName(cfg.sheetName);
  if (!sheet) throw new Error('Sheet "' + cfg.sheetName + '" not found.');

  var base = colLetterToIndex_('N');                       // 0-based sheet column of N
  var numCols = colLetterToIndex_(PF_LAST_COL) - base + 1; // N..AF
  var lastRow = sheet.getLastRow();
  if (lastRow < PF_FIRST_DATA_ROW) {
    return { key: cfg.key, label: cfg.label, stocks: [], totals: { value: 0, cost: 0, profitDollar: 0, profitPct: 0 } };
  }
  var vals = sheet.getRange(1, base + 1, lastRow, numCols).getValues();
  var rel = {};
  Object.keys(PF_COLS).forEach(function (k) { rel[k] = colLetterToIndex_(PF_COLS[k]) - base; });

  var stocks = [], totalValue = 0, totalCost = 0;
  for (var r = PF_FIRST_DATA_ROW - 1; r < lastRow; r++) {
    var row = vals[r];
    var tk = row[rel.ticker];
    if (tk === '' || tk == null || String(tk).indexOf('#REF') >= 0) continue;
    var value = pfNum_(row[rel.value]);
    var cost = pfNum_(row[rel.cost]);
    var ltp = pfNum_(row[rel.ltProfit]);
    var ltpRaw = row[rel.ltProfitPct];
    var ltpPct = pfNum_(ltpRaw);
    var changes = {};
    PF_PERIOD_KEYS.forEach(function (k) { changes[k] = pfNumOrNull_(row[rel[k]]); });
    stocks.push({
      ticker: String(tk).trim(),
      value: value,
      cost: cost,
      price: pfNum_(row[rel.price]),
      pctProfit: cost > 0 ? (value - cost) / cost : 0,
      ltProfitDollar: ltp,
      ltProfitPct: ltpPct,
      // panel-3 inclusion: skip rows whose LT profit $ or % is 0 / empty
      hasLtProfit: ltp !== 0 && !(ltpRaw === '' || ltpRaw == null) && ltpPct !== 0,
      changes: changes  // {w1,w4,w12,m6,y1} trailing % changes (fraction; null if blank)
    });
    totalValue += value;
    totalCost += cost;
  }

  stocks.sort(function (a, b) { return b.value - a.value; });
  stocks.forEach(function (s, i) { s.colorIndex = i; });

  return {
    key: cfg.key,
    label: cfg.label,
    stocks: stocks,
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
