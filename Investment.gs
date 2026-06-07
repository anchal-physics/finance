/**
 * Investment.gs
 * ----------------------------------------------------------------------
 * Server endpoints + aggregation for the Anchal / Anamika investment
 * dashboard tabs. Reads the `Investment` sheet. Lives in the SAME Apps
 * Script project as Webapp.gs, so it shares its constants and helpers
 * (setCellSmart_, moveRowOnSheet_) via global scope.
 * ----------------------------------------------------------------------
 */

// =====================  Investment pages (Anchal / Anamika)  =====================
//
// The Investment sheet holds a weekly-investment strategy per investor. Layout
// (headers row 2, cumulative/weighted row 3, ticker data row 4 onward):
//
//   A Broad Category | B Anchal cat % | C Anamika cat % | D Symbol | E ETF name
//   F Anchal ExpRatio | G Anchal Target % | H Anchal Weekly $
//   I Anamika ExpRatio | J Anamika Target % | K Anamika Weekly $
//   L 6mo% | M 1yr% | N 3yr% | O 5yr%  (period return ratios, shared)
//
// Per-ticker allocation weight = Target % (G for Anchal, J for Anamika); this
// is what the sheet's own L3:O3 cumulative formulas use. We compute every
// aggregate here from the raw cells rather than reading row 3, because the
// sheet's I3 (Anamika effective ER) is weighted by G not J, and there is no
// Anamika cumulative-return row. Verified against the sheet's F3/G3/L3:O3.

var INVESTMENT_SHEET_NAME = 'Investment';

// 0-based column indices into a row read from A1 (A=0 … O=14).
var INVESTORS_ = {
  Anchal:  { investor: 'Anchal',  catPctIdx: 1, erIdx: 5, weightIdx: 6, weeklyIdx: 7,
             editorCols: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
  Anamika: { investor: 'Anamika', catPctIdx: 2, erIdx: 8, weightIdx: 9, weeklyIdx: 10,
             editorCols: ['A', 'B', 'C', 'D', 'E', 'I', 'J', 'K'] }
};

// Read window for the Investment sheet (1-based rows, columns A:O).
var INVESTMENT_FIRST_DATA_ROW = 4;   // row 4 = first ticker
var INVESTMENT_LAST_SCAN_ROW = 200;  // generous cap for appended rows
var INVESTMENT_NUM_COLS = 15;        // A:O

function invConfig_(investor) {
  var cfg = INVESTORS_[investor];
  if (!cfg) throw new Error('Unknown investor "' + investor + '". Use "Anchal" or "Anamika".');
  return cfg;
}

function getInvestmentSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(INVESTMENT_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + INVESTMENT_SHEET_NAME + '" not found.');
  return sheet;
}

/** Read A1:O<lastDataRow> as a values 2D array (index 0 = sheet row 1). */
function readInvestmentValues_(sheet) {
  var lastRow = Math.min(sheet.getLastRow(), INVESTMENT_LAST_SCAN_ROW);
  var numRows = Math.max(INVESTMENT_FIRST_DATA_ROW, lastRow);
  return sheet.getRange(1, 1, numRows, INVESTMENT_NUM_COLS).getValues();
}

/**
 * Pure aggregation: turn the raw A:O values into the chart model.
 * Verified in node against the sheet's own F3/G3/L3:O3 cumulative cells.
 */
function computeInvestmentModel_(values, cfg) {
  var CAT = 0, SYM = 3, NAME = 4;
  var RET = { m6: 11, y1: 12, y3: 13, y5: 14 };
  var baseWeekly = invNum_(values[2] && values[2][cfg.weeklyIdx]); // row 3 (index 2): H3 / K3
  var categories = [], cur = null;
  var totalW = 0, sumErW = 0, totalWeekly = 0;
  var sumRet = { m6: 0, y1: 0, y3: 0, y5: 0 };
  for (var r = 3; r < values.length; r++) {           // sheet row 4 onward
    var row = values[r] || [];
    var catName = invStr_(row[CAT]);
    if (catName) { cur = { name: catName, tickers: [], weight: 0, weekly: 0 }; categories.push(cur); }
    var sym = invStr_(row[SYM]);
    if (!sym) continue;
    if (!cur) { cur = { name: 'Uncategorized', tickers: [], weight: 0, weekly: 0 }; categories.push(cur); }
    var w = invNum_(row[cfg.weightIdx]), er = invNum_(row[cfg.erIdx]), weekly = invNum_(row[cfg.weeklyIdx]);
    var t = {
      symbol: sym, name: invStr_(row[NAME]), weight: w, expenseRatio: er, weekly: weekly,
      returns: { m6: invNum_(row[RET.m6]), y1: invNum_(row[RET.y1]), y3: invNum_(row[RET.y3]), y5: invNum_(row[RET.y5]) }
    };
    cur.tickers.push(t);
    cur.weight += w; cur.weekly += weekly;
    totalW += w; totalWeekly += weekly; sumErW += er * w;
    sumRet.m6 += t.returns.m6 * w; sumRet.y1 += t.returns.y1 * w;
    sumRet.y3 += t.returns.y3 * w; sumRet.y5 += t.returns.y5 * w;
  }
  var W = totalW || 1;
  var model = {
    investor: cfg.investor,
    weeklyBase: baseWeekly,
    totalWeekly: invRound_(totalWeekly, 2),
    totalWeightPct: totalW,
    effectiveExpenseRatio: sumErW / W,
    weightedReturns: { m6: sumRet.m6 / W, y1: sumRet.y1 / W, y3: sumRet.y3 / W, y5: sumRet.y5 / W },
    categories: []
  };
  for (var i = 0; i < categories.length; i++) {
    var c = categories[i];
    if (c.weight <= 0) continue;                       // drop zero-allocation categories
    var keep = c.tickers.filter(function (t) { return t.weight > 0; });
    model.categories.push({
      name: c.name, weightPct: c.weight / W, weekly: invRound_(c.weekly, 2),
      colorIndex: model.categories.length,
      tickers: keep.map(function (t) {
        return {
          symbol: t.symbol, name: t.name, weightPct: t.weight / W, weekly: invRound_(t.weekly, 2),
          expenseRatio: t.expenseRatio, returns: t.returns
        };
      })
    });
  }
  return model;
}

/** Public: chart model for one investor (pie + bar + subtitle inputs). */
function getInvestmentData(investor) {
  var cfg = invConfig_(investor);
  var sheet = getInvestmentSheet_();
  var values = readInvestmentValues_(sheet);
  var model = computeInvestmentModel_(values, cfg);
  model.hash = investmentEditorHash_(sheet, cfg);
  return model;
}

// ---------- Investment editor (full parity: cells + add/clear/move) ----------

/**
 * Editor snapshot for one investor: each data row's exposed cells with
 * display value + formula, plus a hash for external-edit polling.
 */
function getInvestmentEditor(investor) {
  var cfg = invConfig_(investor);
  var sheet = getInvestmentSheet_();
  return buildInvestmentEditor_(sheet, cfg);
}

function buildInvestmentEditor_(sheet, cfg) {
  var lastRow = Math.min(sheet.getLastRow(), INVESTMENT_LAST_SCAN_ROW);
  var numRows = Math.max(INVESTMENT_FIRST_DATA_ROW, lastRow);
  var rng = sheet.getRange(1, 1, numRows, INVESTMENT_NUM_COLS);
  var displays = rng.getDisplayValues();
  var formulas = rng.getFormulas();
  var values = rng.getValues();
  var colIdx = cfg.editorCols.map(colLetterToIndex_);  // 0-based
  var headers = colIdx.map(function (ci) {
    return invStr_(displays[1][ci]) || invStr_(values[1][ci]) || cfg.editorCols[colIdx.indexOf(ci)];
  });
  var rows = [];
  for (var r = INVESTMENT_FIRST_DATA_ROW - 1; r < numRows; r++) {
    var cells = {};
    var hasContent = false;
    for (var k = 0; k < colIdx.length; k++) {
      var ci = colIdx[k], letter = cfg.editorCols[k];
      var disp = displays[r][ci], f = formulas[r][ci], raw = values[r][ci];
      if (!invBlank_(disp) || !invBlank_(f) || !invBlank_(raw)) hasContent = true;
      cells[letter] = { display: disp, formula: f, raw: raw };
    }
    if (!hasContent) continue;
    rows.push({ sheetRow: r + 1, cells: cells });
  }
  return {
    investor: cfg.investor,
    columns: cfg.editorCols,
    headers: headers,
    rows: rows,
    hash: snapshotHashFrom_(values, formulas)
  };
}

function investmentEditorHash_(sheet, cfg) {
  var lastRow = Math.min(sheet.getLastRow(), INVESTMENT_LAST_SCAN_ROW);
  var numRows = Math.max(INVESTMENT_FIRST_DATA_ROW, lastRow);
  var rng = sheet.getRange(1, 1, numRows, INVESTMENT_NUM_COLS);
  return snapshotHashFrom_(rng.getValues(), rng.getFormulas());
}

/** Lightweight poll for the Investment editor (mirrors pollChanges). */
function pollInvestment(investor, lastHash) {
  var cfg = invConfig_(investor);
  var sheet = getInvestmentSheet_();
  var h = investmentEditorHash_(sheet, cfg);
  if (h === lastHash) return { changed: false, hash: h };
  var editor = buildInvestmentEditor_(sheet, cfg);
  var model = computeInvestmentModel_(readInvestmentValues_(sheet), cfg);
  return { changed: true, hash: h, editor: editor, model: model };
}

/**
 * Write one Investment cell. col is a column LETTER (must be in the investor's
 * editor columns). Auto-detects formula vs literal via setCellSmart_.
 */
function writeInvestmentCell(payload) {
  var cfg = invConfig_(payload.investor);
  if (cfg.editorCols.indexOf(payload.col) < 0) {
    throw new Error('Column ' + payload.col + ' is not editable for ' + cfg.investor + '.');
  }
  var sheet = getInvestmentSheet_();
  var cell = sheet.getRange(payload.sheetRow, colLetterToIndex_(payload.col) + 1);
  setCellSmart_(cell, payload.newText);
  SpreadsheetApp.flush();
  return {
    cell: {
      sheetRow: payload.sheetRow, col: payload.col,
      display: cell.getDisplayValue(), formula: cell.getFormula(), raw: cell.getValue()
    },
    hash: investmentEditorHash_(sheet, cfg)
  };
}

/** Append an empty data row after the last occupied row on the Investment sheet. */
function appendInvestmentRow(investor) {
  var cfg = invConfig_(investor);
  var sheet = getInvestmentSheet_();
  var lastRow = Math.min(sheet.getLastRow(), INVESTMENT_LAST_SCAN_ROW);
  var newRow = Math.max(INVESTMENT_FIRST_DATA_ROW, lastRow + 1);
  if (newRow > INVESTMENT_LAST_SCAN_ROW) throw new Error('Row cap of ' + INVESTMENT_LAST_SCAN_ROW + ' reached.');
  SpreadsheetApp.flush();
  var cells = {};
  cfg.editorCols.forEach(function (c) { cells[c] = { display: '', formula: '', raw: '' }; });
  return {
    sheetRow: newRow,
    row: { sheetRow: newRow, cells: cells },
    hash: investmentEditorHash_(sheet, cfg)
  };
}

/** Clear only this investor's editor cells in a row (leaves the other investor intact). */
function clearInvestmentRow(payload) {
  var cfg = invConfig_(payload.investor);
  var sheet = getInvestmentSheet_();
  cfg.editorCols.forEach(function (letter) {
    sheet.getRange(payload.sheetRow, colLetterToIndex_(letter) + 1).clearContent();
  });
  SpreadsheetApp.flush();
  return { hash: investmentEditorHash_(sheet, cfg) };
}

/**
 * Move a whole Investment row (drag-reorder). Like PayrollSankey, this shifts
 * the entire spreadsheet row, so BOTH investors' columns move together — the
 * UI warns about this before the first reorder.
 */
function moveInvestmentRow(investor, fromRow, toRow) {
  var cfg = invConfig_(investor);
  var sheet = getInvestmentSheet_();
  if (fromRow !== toRow) moveRowOnSheet_(sheet, fromRow, toRow);
  return { hash: investmentEditorHash_(sheet, cfg) };
}


/** SHA-1 state hash over values + formulas (same scheme as readSheetSnapshot_). */
function snapshotHashFrom_(values, formulas) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    JSON.stringify(values) + '|' + JSON.stringify(formulas)
  );
  return Utilities.base64Encode(bytes).substring(0, 16);
}

function colLetterToIndex_(letter) {
  var s = String(letter).toUpperCase(), n = 0;
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1; // 0-based
}

function invNum_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
function invStr_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function invRound_(n, d) { var f = Math.pow(10, d || 0); return Math.round(invNum_(n) * f) / f; }
function invBlank_(v) { return v === '' || v === null || v === undefined; }

