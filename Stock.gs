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
 * returns a 2D array whose FIRST row is a header and each subsequent row
 * is one currently-held ticker:
 *   ['Ticker','Total Shares','LT Shares','ST Shares',
 *    'LT Avg Cost/Share','ST Avg Cost/Share']
 *   [ticker, totalShares, longTermShares, shortTermShares,
 *    longTermAvgCostPerShare, shortTermAvgCostPerShare]
 *   …
 *
 * NOTE: because of the header row the spilled data now starts on the
 * SECOND row. Any downstream formulas anchored to the spill (e.g. the
 * Total Cost / Price / Total Current Value columns) must be shifted down
 * one row to stay aligned.
 *
 * Lot accounting: FIFO. A lot is long-term if today is more than
 * one calendar year after the activity date (IRS holding-period rule:
 * "more than one year"). Sells reduce the earliest-acquired lot first.
 *
 * Cost-basis source per buy:
 *   1. If Amount column has a non-zero dollar value, use |Amount| as
 *      that lot's total cost.
 *   2. Otherwise, fall back to Quantity * Closing Price (useful for
 *      DRIP, transfers where Amount may be missing).
 *
 * Trans Code "SPL" = a stock split. Its Quantity is the NEW TOTAL number
 * of shares held after the split (not a delta). We scale every existing
 * lot by ratio = newTotal / currentTotal, dividing each lot's per-share
 * cost by the same ratio — this preserves total cost basis and each lot's
 * acquisition date (splits don't affect the holding period), and makes the
 * post-split share count exact.
 *
 * Direction of a share-moving row comes from the Trans Code, NOT the sign of
 * Quantity — this Robinhood export lists Quantity UNSIGNED (both Buy and Sell
 * rows are positive). "Buy" and "ACATI" (transfer in) add shares; "Sell"
 * removes them (FIFO); any other share-moving code falls back to the sign of
 * Amount (positive Amount = cash in = a disposal). Zero-quantity rows (CDIV,
 * ACH, DCF, SLIP, …) are ignored.
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
      if (tx.code && tx.code.toUpperCase() === 'SPL') {
        // Stock split: tx.quantity is the NEW TOTAL shares after the split.
        // Scale each lot so the totals match; divide per-share cost by the
        // same ratio to preserve total cost basis. Dates are untouched (a
        // split does not restart the holding period).
        var curTotal = 0;
        for (var si = 0; si < lots.length; si++) curTotal += lots[si].qty;
        if (curTotal > 1e-9 && tx.quantity > 0) {
          var ratio = tx.quantity / curTotal;
          for (var sj = 0; sj < lots.length; sj++) {
            lots[sj].qty *= ratio;
            lots[sj].costPerShare /= ratio;
          }
        }
        continue;
      }
      // Quantity is UNSIGNED in this export — use magnitude and route by code.
      var mag = Math.abs(tx.quantity);
      if (mag <= 1e-12) continue;
      var code = tx.code ? tx.code.toUpperCase() : '';
      var isSell;
      if (code === 'SELL') isSell = true;
      else if (code === 'BUY' || code === 'ACATI') isSell = false;
      else isSell = (tx.amount > 0); // fallback: positive cash = a disposal

      if (!isSell) {
        // Buy / transfer in: cost basis = |Amount|, else magnitude * closingPrice
        var totalCost = Math.abs(tx.amount) > 0
          ? Math.abs(tx.amount)
          : (mag * (tx.closingPrice || 0));
        lots.push({ date: tx.date, qty: mag, costPerShare: totalCost / mag });
      } else {
        // Sell / transfer out: FIFO drawdown
        var remaining = mag;
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

  // Prepend a header row so downstream columns can be referenced by name.
  var header = ['Ticker', 'Total Shares', 'LT Shares', 'ST Shares',
                'LT Avg Cost/Share', 'ST Avg Cost/Share'];

  // Apps Script requires custom functions return a 2D array. If there are no
  // holdings, still return the header plus a blank placeholder row.
  if (output.length === 0) return [header, ['', 0, 0, 0, 0, 0]];
  return [header].concat(output);
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
