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
// Post-AB layout: 9-col spill N:V (N acct,O tkr,P total,Q LT,R ST,S AB,T LTavg,
// U STavg,V ABavg), then W Total Cost, X Total+AB Cost, Y Price, Z Total Current
// Value, AA AB Current Value, AB Total+AB Current Value, AC/AD LT/ST value,
// AE LT profit, AF profit %, AG ticker helper, AH:AL trailing changes,
// AM:AQ trailing "val", AS:AU Sankey, AW:AY summary.
var PF_COLS = {
  account: 'N', ticker: 'O', abShares: 'S',
  cost: 'W', costWithAb: 'X', price: 'Y',
  value: 'Z', abValue: 'AA', valueWithAb: 'AB',
  ltProfit: 'AE', ltProfitPct: 'AF',
  w1: 'AH', w4: 'AI', w12: 'AJ', m6: 'AK', y1: 'AL'
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
  // Read out to AU so we also pick up the Sankey flow block AS|AT|AU that the
  // update_effective_holdings.py script writes (Source | Value | Target).
  var numCols = colLetterToIndex_('AU') - base + 1;        // N..AU
  var lastRow = sheet.getLastRow();
  if (lastRow < PF_FIRST_DATA_ROW) {
    return { key: cfg.key, label: cfg.label, stocks: [], flows: [],
             totals: { value: 0, valueWithAb: 0, cost: 0, costWithAb: 0, profitDollar: 0, profitPct: 0 } };
  }
  var vals = sheet.getRange(1, base + 1, lastRow, numCols).getValues();
  var rel = {};
  Object.keys(PF_COLS).forEach(function (k) { rel[k] = colLetterToIndex_(PF_COLS[k]) - base; });

  // One summary row per (account, ticker). Aggregate by ticker across accounts.
  // "Total" = verified holdings; "Total+AB" also includes projected Assumed-Bought
  // shares. Profit is split by account type: taxable → Long-term capital gain
  // (col AE, verified only); IRA → full gain (Total and Total+AB), tax-free.
  var byTicker = {};   // ticker -> aggregate
  var order = [];
  for (var r = PF_FIRST_DATA_ROW - 1; r < lastRow; r++) {
    var row = vals[r];
    var tk = row[rel.ticker];
    if (tk === '' || tk == null || String(tk).indexOf('#REF') >= 0) continue;
    tk = String(tk).trim();
    if (PF_CASH_TICKERS[tk.toUpperCase()]) continue;        // skip money-market cash
    var value = pfNum_(row[rel.value]);            // Z Total Current Value
    var valueAb = pfNum_(row[rel.valueWithAb]);    // AB Total+AB Current Value
    var abValue = pfNum_(row[rel.abValue]);        // AA AB Current Value
    var cost = pfNum_(row[rel.cost]);              // W Total Cost
    var costAb = pfNum_(row[rel.costWithAb]);      // X Total+AB Cost
    var ltp = pfNum_(row[rel.ltProfit]);           // AE LT profit (taxable, verified)
    var isIRA = /ira/i.test(String(row[rel.account] == null ? '' : row[rel.account]));
    var agg = byTicker[tk];
    if (!agg) {
      agg = byTicker[tk] = { ticker: tk, value: 0, valueAb: 0, abValue: 0, cost: 0, costAb: 0,
                             price: 0, changes: null, taxProfit: 0, taxCost: 0,
                             iraValue: 0, iraCost: 0, iraValueAb: 0, iraCostAb: 0 };
      order.push(tk);
    }
    agg.value += value; agg.valueAb += valueAb; agg.abValue += abValue;
    agg.cost += cost; agg.costAb += costAb;
    if (isIRA) { agg.iraValue += value; agg.iraCost += cost; agg.iraValueAb += valueAb; agg.iraCostAb += costAb; }
    else       { agg.taxProfit += ltp; agg.taxCost += cost; }
    if (!agg.price) agg.price = pfNum_(row[rel.price]);
    if (!agg.changes) {
      var changes = {};
      PF_PERIOD_KEYS.forEach(function (k) { changes[k] = pfNumOrNull_(row[rel[k]]); });
      agg.changes = changes;
    }
  }

  var stocks = [], totalValue = 0, totalValueAb = 0, totalCost = 0, totalCostAb = 0;
  order.forEach(function (tk) {
    var a = byTicker[tk];
    var iraP = a.iraValue - a.iraCost, iraPab = a.iraValueAb - a.iraCostAb;
    stocks.push({
      ticker: a.ticker, price: a.price, changes: a.changes,
      value: a.value, valueWithAb: a.valueAb, abValue: a.abValue,   // pies (Total / Total+AB)
      cost: a.cost, costWithAb: a.costAb,
      // Return %: Total (solid) vs Total+AB (dashed delta)
      pctProfit: a.cost > 0 ? (a.value - a.cost) / a.cost : 0,
      pctProfitWithAb: a.costAb > 0 ? (a.valueAb - a.costAb) / a.costAb : 0,
      // Taxable long-term capital gain (verified only; AB is never LT)
      taxLtProfitDollar: a.taxProfit,
      taxLtProfitPct: a.taxCost > 0 ? a.taxProfit / a.taxCost : 0,
      hasTaxLt: Math.abs(a.taxProfit) > 1e-9,
      // IRA (non-taxable) full gain: Total (solid) vs Total+AB (dashed delta)
      iraProfitDollar: iraP,
      iraProfitPct: a.iraCost > 0 ? iraP / a.iraCost : 0,
      iraProfitDollarWithAb: iraPab,
      iraProfitPctWithAb: a.iraCostAb > 0 ? iraPab / a.iraCostAb : 0,
      hasIra: Math.abs(a.iraValueAb) > 1e-9
    });
    totalValue += a.value; totalValueAb += a.valueAb;
    totalCost += a.cost; totalCostAb += a.costAb;
  });

  // Stable color per ticker = index sorted by Total+AB value (covers AB-only tickers).
  stocks.sort(function (a, b) { return b.valueWithAb - a.valueWithAb; });
  stocks.forEach(function (s, i) { s.colorIndex = i; });

  // Effective-holdings Sankey flows from AS (source) | AT (value) | AU (target).
  var asRel = colLetterToIndex_('AS') - base;
  var atRel = colLetterToIndex_('AT') - base;
  var auRel = colLetterToIndex_('AU') - base;
  var flows = [];
  for (var fr = PF_FIRST_DATA_ROW - 1; fr < lastRow; fr++) {
    var src = vals[fr][asRel];
    if (src === '' || src == null) continue;
    src = String(src).trim();
    if (src === '' || src === 'Source') continue;
    var fv = pfNum_(vals[fr][atRel]);
    if (fv <= 0) continue;
    flows.push({ source: src, value: fv, target: String(vals[fr][auRel] == null ? '' : vals[fr][auRel]).trim() });
  }

  return {
    key: cfg.key,
    label: cfg.label,
    stocks: stocks,
    flows: flows,
    totals: {
      value: totalValue,
      valueWithAb: totalValueAb,
      cost: totalCost,
      costWithAb: totalCostAb,
      profitDollar: totalValue - totalCost,
      profitPct: totalCost > 0 ? (totalValue - totalCost) / totalCost : 0,
      profitDollarWithAb: totalValueAb - totalCostAb,
      profitPctWithAb: totalCostAb > 0 ? (totalValueAb - totalCostAb) / totalCostAb : 0
    }
  };
}

function pfNum_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
// null for blank/non-numeric (so the client can skip that marker), else the number.
function pfNumOrNull_(v) { if (v === '' || v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
