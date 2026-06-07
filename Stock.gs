/**
 * Stock.gs
 * ----------------------------------------------------------------------
 * Stock portfolio summary functions for the Portfolio_AG sheet.
 *
 * Public custom function:
 *   GET_ALL_STOCK_SUMMARIES(activityDates, instruments, transCodes,
 *                           quantities, amounts, closingPrices)
 *
 * Given a Robinhood-style transaction log (one row per transaction),
 * returns a 2D array with one row per currently-held ticker:
 *   [ticker, totalShares, longTermShares, shortTermShares,
 *    longTermAvgCostPerShare, shortTermAvgCostPerShare]
 *
 * Lot accounting: FIFO. A lot is long-term if today is more than
 * one calendar year after the activity date (IRS holding-period rule:
 * "more than one year"). Sells reduce the earliest-acquired lot first.
 *
 * Cost-basis source per buy:
 *   1. If Amount column has a non-zero dollar value, use |Amount| as
 *      that lot's total cost.
 *   2. Otherwise, fall back to Quantity * Closing Price (useful for
 *      DRIP, transfers, splits where Amount may be missing).
 *
 * Quantity sign convention: positive = added shares (buy / DRIP /
 * transfer in / split), negative = removed shares (sell / transfer
 * out). Trans Code is recorded but not currently used for routing —
 * the sign of Quantity is the source of truth.
 *
 * Tickers with zero remaining shares (fully sold off) are omitted.
 * ----------------------------------------------------------------------
 */

/**
 * @param {Array<Array<*>>} activityDates    Range, n×1, dates.
 * @param {Array<Array<*>>} instruments      Range, n×1, ticker strings.
 * @param {Array<Array<*>>} transCodes       Range, n×1, transaction codes.
 * @param {Array<Array<*>>} quantities       Range, n×1, share counts (signed).
 * @param {Array<Array<*>>} amounts          Range, n×1, dollar amounts (signed; absolute value used).
 * @param {Array<Array<*>>} closingPrices    Range, n×1, closing market price on activity date.
 * @return {Array<Array<*>>}                 [[ticker, total, lt, st, ltAvg, stAvg], …] sorted by ticker.
 * @customfunction
 */
function GET_ALL_STOCK_SUMMARIES(activityDates, instruments, transCodes, quantities, amounts, closingPrices) {
  // Custom functions receive ranges as 2D arrays. Single-cell args may come
  // through as scalars — normalize them all to length-N 1D arrays.
  var dates  = stockColToArray_(activityDates);
  var tkr    = stockColToArray_(instruments);
  var codes  = stockColToArray_(transCodes);
  var qtys   = stockColToArray_(quantities);
  var amts   = stockColToArray_(amounts);
  var closes = stockColToArray_(closingPrices);
  var n = Math.max(dates.length, tkr.length, qtys.length);

  // Flatten into a list of transactions, skipping rows we can't use.
  var txs = [];
  for (var i = 0; i < n; i++) {
    var d = dates[i];
    var t = tkr[i];
    var q = qtys[i];
    if (t == null || t === '') continue;
    if (q == null || q === '' || isNaN(Number(q))) continue;
    var qNum = Number(q);
    if (qNum === 0) continue;
    var dateObj = stockToDate_(d);
    if (!dateObj) continue;
    txs.push({
      date: dateObj,
      ticker: String(t).trim(),
      code: String(codes[i] == null ? '' : codes[i]).trim(),
      quantity: qNum,
      amount: amts[i] == null || amts[i] === '' ? 0 : Number(amts[i]) || 0,
      closingPrice: closes[i] == null || closes[i] === '' ? 0 : Number(closes[i]) || 0
    });
  }

  // Group transactions by ticker.
  var byTicker = {};
  for (var k = 0; k < txs.length; k++) {
    var sym = txs[k].ticker;
    if (!byTicker[sym]) byTicker[sym] = [];
    byTicker[sym].push(txs[k]);
  }

  // Holding-period cutoff: a lot is long-term if its date is STRICTLY
  // BEFORE (today - 1 year). I.e., "held more than 1 year" by today.
  var today = new Date();
  var cutoff = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());

  // Walk each ticker, do FIFO lot accounting.
  var output = [];
  var sortedTickers = Object.keys(byTicker).sort();
  for (var ti = 0; ti < sortedTickers.length; ti++) {
    var ticker = sortedTickers[ti];
    var transactions = byTicker[ticker].slice().sort(function (a, b) { return a.date - b.date; });
    var lots = []; // [{date, qty, costPerShare}, ...] in acquisition order

    for (var ji = 0; ji < transactions.length; ji++) {
      var tx = transactions[ji];
      if (tx.quantity > 0) {
        // Buy / add: cost basis preference = |Amount|, else qty * closingPrice
        var totalCost = Math.abs(tx.amount) > 0
          ? Math.abs(tx.amount)
          : (tx.quantity * (tx.closingPrice || 0));
        var costPerShare = tx.quantity > 0 ? (totalCost / tx.quantity) : 0;
        lots.push({ date: tx.date, qty: tx.quantity, costPerShare: costPerShare });
      } else if (tx.quantity < 0) {
        // Sell / remove: FIFO drawdown
        var remaining = -tx.quantity;
        while (remaining > 1e-9 && lots.length > 0) {
          if (lots[0].qty <= remaining + 1e-9) {
            remaining -= lots[0].qty;
            lots.shift();
          } else {
            lots[0].qty -= remaining;
            remaining = 0;
          }
        }
      }
    }

    // Tally LT vs ST from remaining lots.
    var ltShares = 0, ltCost = 0, stShares = 0, stCost = 0;
    for (var li = 0; li < lots.length; li++) {
      var lot = lots[li];
      // IRS "more than one year": today is at least one calendar year + 1 day after lot.date.
      // i.e., lot.date < cutoff (strictly before).
      if (lot.date < cutoff) {
        ltShares += lot.qty;
        ltCost += lot.qty * lot.costPerShare;
      } else {
        stShares += lot.qty;
        stCost += lot.qty * lot.costPerShare;
      }
    }

    var total = ltShares + stShares;
    if (total <= 1e-6) continue; // Fully closed-out tickers: skip.

    output.push([
      ticker,
      total,
      ltShares,
      stShares,
      ltShares > 1e-9 ? (ltCost / ltShares) : 0,
      stShares > 1e-9 ? (stCost / stShares) : 0
    ]);
  }

  // Apps Script requires custom functions return a 2D array. If output is
  // empty, return a single-row placeholder so the cell doesn't show an error.
  if (output.length === 0) return [['', 0, 0, 0, 0, 0]];
  return output;
}


// =====================  Helpers (internal)  =====================

/**
 * Normalize an arg that might be a 2D range (Array of [v]), a 1D array,
 * or a scalar, into a flat 1D array.
 */
function stockColToArray_(arg) {
  if (arg == null) return [];
  if (!Array.isArray(arg)) return [arg];
  if (arg.length === 0) return [];
  if (Array.isArray(arg[0])) {
    var out = new Array(arg.length);
    for (var i = 0; i < arg.length; i++) out[i] = arg[i][0];
    return out;
  }
  return arg;
}

/**
 * Coerce a cell value (Date, string, or number date-serial) into a Date.
 * Returns null if it can't be parsed.
 */
function stockToDate_(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    // Treat as JS millisecond timestamp if very large, else fall through.
    // (Sheets passes Dates as Date instances usually, not serials, when via custom function.)
    if (v > 1e11) return new Date(v);
  }
  var parsed = new Date(v);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}
