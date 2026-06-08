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
             nameCol: 'A', catPctCol: 'B', baseCol: 'H', weightCol: 'G',
             tickerCols: ['D', 'E', 'F', 'G', 'H'], investorCols: ['F', 'G', 'H'] },
  Anamika: { investor: 'Anamika', catPctIdx: 2, erIdx: 8, weightIdx: 9, weeklyIdx: 10,
             nameCol: 'A', catPctCol: 'C', baseCol: 'K', weightCol: 'J',
             tickerCols: ['D', 'E', 'I', 'J', 'K'], investorCols: ['I', 'J', 'K'] }
};

// Read window for the Investment sheet (1-based rows, columns A:O).
var INVESTMENT_FIRST_DATA_ROW = 4;   // row 4 = first ticker
var INVESTMENT_LAST_SCAN_ROW = 200;  // generous cap for appended rows
var INVESTMENT_NUM_COLS = 15;        // A:O

// Output-only columns (shared by both investors): the editor shows the computed
// value (never the formula) and disallows editing; new rows auto-fill the
// formula via copyDownFormulas_ (Webapp.gs). The ETF-name column E runs
// GOOGLEFINANCE on the symbol in D. Generic — add specs here to auto-fill more.
var INVESTMENT_READONLY_COLS = ['E'];
var INVESTMENT_AUTOFILL = [
  { col: 'E', template: '=IFERROR(GOOGLEFINANCE($D{ROW}, "name"), "")' }
];

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

// ---------- Investment editor (broad categories as sub-panels) ----------
//
// Column A (broad category) is SHARED by both investors, so the category blocks
// are identical on both tabs; only the weight/$ columns differ. The editor
// groups ticker rows into per-category sub-panels (a category "owns" the rows
// from its A-labelled header row down to the row before the next A-labelled
// row), exposes the weekly base (H3 Anchal / K3 Anamika), and supports adding a
// stock (a row inside a category) or a whole new category.

function getInvestmentEditor(investor) {
  var cfg = invConfig_(investor);
  return buildInvestmentEditor_(getInvestmentSheet_(), cfg);
}

function buildInvestmentEditor_(sheet, cfg) {
  var lastRow = Math.min(sheet.getLastRow(), INVESTMENT_LAST_SCAN_ROW);
  var numRows = Math.max(INVESTMENT_FIRST_DATA_ROW, lastRow);
  var rng = sheet.getRange(1, 1, numRows, INVESTMENT_NUM_COLS);
  var displays = rng.getDisplayValues();
  var formulas = rng.getFormulas();
  var values = rng.getValues();

  var Ai = colLetterToIndex_('A'), Di = colLetterToIndex_('D');
  var tickerIdx = cfg.tickerCols.map(colLetterToIndex_);
  var headers = tickerIdx.map(function (ci, k) {
    return invStr_(displays[1][ci]) || invStr_(values[1][ci]) || cfg.tickerCols[k];
  });

  function cellAt(r, letter) {
    var ci = colLetterToIndex_(letter);
    return { display: displays[r][ci], formula: formulas[r][ci], raw: values[r][ci] };
  }
  function rowCells(r) {
    var cells = {};
    cfg.tickerCols.forEach(function (letter) { cells[letter] = cellAt(r, letter); });
    return { sheetRow: r + 1, cells: cells };
  }
  // "Real" content = category name (A), symbol (D), or this investor's
  // allocation cols (F/G/H or I/J/K). Deliberately ignores E and L:O, which
  // hold derived GOOGLEFINANCE formulas even on blank rows (e.g. the row-46
  // spill artifact), so those don't masquerade as holdings.
  var invIdx = cfg.investorCols.map(colLetterToIndex_);
  function rowHasContent(r) {
    if (!invBlank_(values[r][Ai]) || !invBlank_(values[r][Di])) return true;
    return invIdx.some(function (ci) { return !invBlank_(values[r][ci]); });
  }

  // header rows (col A non-blank) and the last row with real content
  var headerRows = [], lastContent = INVESTMENT_FIRST_DATA_ROW - 2; // 0-based
  for (var r = INVESTMENT_FIRST_DATA_ROW - 1; r < numRows; r++) {
    if (!invBlank_(values[r][Ai])) headerRows.push(r);
    if (rowHasContent(r)) lastContent = r;
  }

  var categories = [];
  for (var i = 0; i < headerRows.length; i++) {
    var hr = headerRows[i];
    var spanEnd = (i < headerRows.length - 1) ? headerRows[i + 1] - 1 : Math.max(hr, lastContent);
    var rows = [];
    for (var rr = hr; rr <= spanEnd; rr++) rows.push(rowCells(rr));
    categories.push({
      headerRow: hr + 1,
      name: invStr_(displays[hr][Ai]) || invStr_(values[hr][Ai]),
      catPct: cellAt(hr, cfg.catPctCol),
      rows: rows
    });
  }

  return {
    investor: cfg.investor,
    columns: cfg.tickerCols,
    headers: headers,
    weightCol: cfg.weightCol,       // client highlights non-zero cells in this column
    readonlyCols: INVESTMENT_READONLY_COLS,
    catPctCol: cfg.catPctCol,
    nameCol: cfg.nameCol,
    base: {
      sheetRow: 3, col: cfg.baseCol,
      display: displays[2][colLetterToIndex_(cfg.baseCol)],
      formula: formulas[2][colLetterToIndex_(cfg.baseCol)],
      raw: values[2][colLetterToIndex_(cfg.baseCol)]
    },
    categories: categories,
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
 * Write one Investment cell. col is a column LETTER; editable cols are the
 * per-ticker columns plus the category name (A), the category % (B/C) and the
 * weekly base (H/K). Auto-detects formula vs literal via setCellSmart_.
 */
function writeInvestmentCell(payload) {
  var cfg = invConfig_(payload.investor);
  if (INVESTMENT_READONLY_COLS.indexOf(payload.col) >= 0) {
    throw new Error('Column ' + payload.col + ' is output-only (auto-filled).');
  }
  var allowed = cfg.tickerCols.concat([cfg.nameCol, cfg.catPctCol, cfg.baseCol]);
  if (allowed.indexOf(payload.col) < 0) {
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

/**
 * Add a stock (row) to a category. Inserts a sheet row just BELOW the
 * category's header row so the category's `=Sum(G..)`-style % formula extends
 * to include it. Rows are shared, so this shifts both investors' columns. The
 * new row's weight is seeded to 0 (so it shows up and reads as a 0% holding).
 */
function addInvestmentStock(investor, headerRow) {
  var cfg = invConfig_(investor);
  var sheet = getInvestmentSheet_();
  var at = headerRow + 1;
  insertRowOnSheet_(sheet, at);
  sheet.getRange(at, colLetterToIndex_(cfg.weightCol) + 1).setValue(0);
  copyDownFormulas_(sheet, at - 1, at, INVESTMENT_AUTOFILL); // ETF-name etc. from the row above
  SpreadsheetApp.flush();
  return buildInvestmentEditor_(sheet, cfg);
}

/**
 * Add a whole new broad category: appends a new block at the bottom with the
 * name in column A (one empty stock row). The user then fills in the first
 * ticker and weights, and the category % formula.
 */
function addInvestmentCategory(investor, name) {
  var cfg = invConfig_(investor);
  var sheet = getInvestmentSheet_();
  var newRow = lastInvestmentContentRow_(sheet) + 1;
  if (newRow < INVESTMENT_FIRST_DATA_ROW) newRow = INVESTMENT_FIRST_DATA_ROW;
  if (newRow > INVESTMENT_LAST_SCAN_ROW) throw new Error('Row cap of ' + INVESTMENT_LAST_SCAN_ROW + ' reached.');
  sheet.getRange(newRow, colLetterToIndex_(cfg.nameCol) + 1).setValue(String(name == null ? '' : name).trim() || 'New Category');
  copyDownFormulas_(sheet, newRow - 1, newRow, INVESTMENT_AUTOFILL); // seed ETF-name formula for the first stock
  SpreadsheetApp.flush();
  return buildInvestmentEditor_(sheet, cfg);
}

/** Clear only this investor's allocation cells (F/G/H or I/J/K) in a row. */
function clearInvestmentRow(payload) {
  var cfg = invConfig_(payload.investor);
  var sheet = getInvestmentSheet_();
  cfg.investorCols.forEach(function (letter) {
    sheet.getRange(payload.sheetRow, colLetterToIndex_(letter) + 1).clearContent();
  });
  SpreadsheetApp.flush();
  return { hash: investmentEditorHash_(sheet, cfg) };
}

/** Insert a blank ROW at 1-based atRow on a sheet (inherits formatting from above). */
function insertRowOnSheet_(sheet, atRow) {
  Sheets.Spreadsheets.batchUpdate(
    { requests: [{ insertDimension: {
      range: { sheetId: sheet.getSheetId(), dimension: 'ROWS', startIndex: atRow - 1, endIndex: atRow },
      inheritFromBefore: atRow > 1
    } }] },
    SpreadsheetApp.getActive().getId()
  );
  SpreadsheetApp.flush();
}

/** Last 1-based row with a category name (A) or symbol (D); ignores L:O spill. */
function lastInvestmentContentRow_(sheet) {
  var lastRow = Math.min(sheet.getLastRow(), INVESTMENT_LAST_SCAN_ROW);
  var numRows = Math.max(INVESTMENT_FIRST_DATA_ROW, lastRow);
  var v = sheet.getRange(1, 1, numRows, INVESTMENT_NUM_COLS).getValues();
  var Ai = colLetterToIndex_('A'), Di = colLetterToIndex_('D');
  var last = INVESTMENT_FIRST_DATA_ROW - 1;
  for (var r = INVESTMENT_FIRST_DATA_ROW - 1; r < numRows; r++) {
    if (!invBlank_(v[r][Ai]) || !invBlank_(v[r][Di])) last = r + 1;
  }
  return last;
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

