/**
 * Webapp.gs
 * ----------------------------------------------------------------------
 * Top-level web-app combiner: request routing (doGet), template include(),
 * and cross-feature server code shared by all tabs (print-to-PDF handoff,
 * generic named settings, reorder ack, and shared cell/row helpers).
 *
 * Feature-specific server logic lives in sibling files at the same level:
 *   PayrollSankey.gs  - the PayrollSankey landing tab
 *   Investment.gs     - the Anchal / Anamika investment tabs
 * Add a new feature => add a new <Feature>.gs; Webapp.gs only routes.
 * ----------------------------------------------------------------------
 */

// =====================  Routing  =====================

/** Web-app entry point. Routes between the editor and the print-PDF view. */
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.print === '1' && params.token) {
    return servePrintPage_(params.token);
  }
  var tmpl = HtmlService.createTemplateFromFile('WebappPage');
  tmpl.bootstrap = JSON.stringify(getBootstrapPayload());
  return tmpl.evaluate()
    .setTitle('Capuchin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Allow .html templates to include each other's content. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// =====================  Shared row move  =====================

/**
 * Move an entire spreadsheet row on a given sheet using the Sheets advanced
 * service (same semantics as dragging a row in the UI; formula refs auto-
 * update). Shared by PayrollSankey and Investment editors.
 */
function moveRowOnSheet_(sheet, fromRow, toRow) {
  var ss = SpreadsheetApp.getActive();
  Sheets.Spreadsheets.batchUpdate(
    {
      requests: [{
        moveDimension: {
          source: {
            sheetId: sheet.getSheetId(),
            dimension: 'ROWS',
            startIndex: fromRow - 1, // 0-based, inclusive
            endIndex: fromRow        // 0-based, exclusive
          },
          // destinationIndex is interpreted AFTER the source row is removed.
          // For both directions this equals (toRow - 1) in 1-based input.
          destinationIndex: toRow - 1
        }
      }]
    },
    ss.getId()
  );
  SpreadsheetApp.flush();
}

/**
 * Auto-fill "output-only" formula columns into a newly-created row. For each
 * spec {col, template}, copies the formula DOWN from fromRow — using Sheets'
 * native relative-reference rules (so e.g. $D4 becomes $D5) — or, if fromRow
 * has no formula in that column, writes `template` with `{ROW}` -> toRow.
 *
 * Generic and reusable: any feature's data editor can declare such columns and
 * call this after inserting/appending a row. (See Investment.gs's
 * INVESTMENT_AUTOFILL / INVESTMENT_READONLY_COLS for the ETF-name column.)
 */
function copyDownFormulas_(sheet, fromRow, toRow, specs) {
  (specs || []).forEach(function (spec) {
    var c = colLetterToIndex_(spec.col) + 1;
    var src = (fromRow >= 1) ? sheet.getRange(fromRow, c) : null;
    if (src && src.getFormula()) {
      src.copyTo(sheet.getRange(toRow, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
    } else if (spec.template) {
      sheet.getRange(toRow, c).setFormula(spec.template.replace(/\{ROW\}/g, String(toRow)));
    }
  });
}


// =====================  Settings (shared / generic)  =====================

var REORDER_ACK_KEY_ = 'reorder_warning_ack_v1';

/** Generic per-user named settings (used by the investment chart settings panels). */
function getNamedSettings(key) {
  var raw = PropertiesService.getUserProperties().getProperty('named:' + String(key));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function saveNamedSettings(key, jsonString) {
  PropertiesService.getUserProperties().setProperty('named:' + String(key), String(jsonString || ''));
  return { ok: true };
}

function getReorderAck() {
  return PropertiesService.getUserProperties().getProperty(REORDER_ACK_KEY_) === '1';
}

function setReorderAck() {
  PropertiesService.getUserProperties().setProperty(REORDER_ACK_KEY_, '1');
  return { ok: true };
}

// =====================  Print-to-PDF SVG handoff  =====================

/**
 * Caches a client-rendered SVG string under a random token. The client
 * then opens a new tab at ?print=1&token=<token>; the doGet handler
 * fetches the SVG from cache and serves PrintPage.html with it embedded.
 *
 * Cache lives 60 s — plenty for "click button, new tab opens, render
 * the SVG once". After expiry the print tab can't be reloaded; just go
 * back to the main webapp and click Export PDF again.
 */
function storePrintSvg(svgString) {
  var token = Utilities.getUuid().replace(/-/g, '');
  var cache = CacheService.getUserCache();
  cache.put('print_svg:' + token, String(svgString || ''), 60);
  return { token: token };
}

function servePrintPage_(token) {
  var cache = CacheService.getUserCache();
  var svg = cache.get('print_svg:' + token);
  var tmpl = HtmlService.createTemplateFromFile('PrintPage');
  tmpl.svgContent = svg || '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200"><text x="50%" y="50%" text-anchor="middle" font-family="Arial" font-size="20" fill="#999">Print token expired — reopen from the webapp.</text></svg>';
  return tmpl.evaluate()
    .setTitle('Capuchin — Print')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// =====================  Data freshness (GOOGLEFINANCE / TODAY / custom fns)  =====================
//
// getValues() reads the LAST-COMPUTED cell values; opening the web app does NOT
// recalculate the sheet, and flush() doesn't recompute GOOGLEFINANCE / TODAY() /
// custom functions. So we (a) run a time-driven trigger a couple of times a day
// to keep the sheet fresh in the background, and (b) expose refreshData() for the
// topbar "Recalc" button to force it on demand.
//
// Twice-daily (not every N minutes) is deliberate: the summaries key off daily
// CLOSING prices, so more frequent runs just burn the consumer trigger-runtime
// quota. FRESHNESS_HOURS_ are in the project timezone (America/Los_Angeles):
// ~6am (date rollover / overnight) and ~5pm (after the US market close).
//
// forceRecalc_ re-sets each formula cell that calls GOOGLEFINANCE or
// GET_ALL_STOCK_SUMMARIES to itself — re-setting a formula marks the cell dirty
// so Sheets re-evaluates it (GOOGLEFINANCE refetches; the custom function re-runs
// with a current date). Only formula cells are touched, so literals are safe.

var FRESHNESS_TRIGGER_FN_ = 'scheduledRefresh_';
var FRESHNESS_KEYWORDS_ = ['GOOGLEFINANCE', 'GET_ALL_STOCK_SUMMARIES'];
var FRESHNESS_HOURS_ = [6, 17]; // project-timezone hours to refresh (after close + morning)

/** Sheets that hold volatile/external formulas worth refreshing. */
function refreshSheetsList_() {
  var names = [];
  try { Object.keys(PORTFOLIOS_).forEach(function (k) { names.push(PORTFOLIOS_[k].sheetName); }); } catch (e) {}
  try { if (INVESTMENT_SHEET_NAME) names.push(INVESTMENT_SHEET_NAME); } catch (e) {}
  // de-dup
  return names.filter(function (n, i) { return names.indexOf(n) === i; });
}

/** Re-evaluate every GOOGLEFINANCE / custom-function cell. Returns #cells touched. */
function forceRecalc_() {
  var ss = SpreadsheetApp.getActive();
  var touched = 0;
  refreshSheetsList_().forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return;
    var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();
    for (var r = 0; r < formulas.length; r++) {
      for (var c = 0; c < formulas[r].length; c++) {
        var f = formulas[r][c];
        if (!f) continue;
        for (var k = 0; k < FRESHNESS_KEYWORDS_.length; k++) {
          if (f.indexOf(FRESHNESS_KEYWORDS_[k]) >= 0) { sh.getRange(r + 1, c + 1).setFormula(f); touched++; break; }
        }
      }
    }
  });
  SpreadsheetApp.flush();
  return touched;
}

/** Client-callable: force recalc, wait briefly for external fetches, report. */
function refreshData() {
  var touched = forceRecalc_();
  Utilities.sleep(2500); // give GOOGLEFINANCE a moment to populate before the client re-reads
  return { ok: true, touched: touched };
}

/** Time-driven trigger target (background freshness). */
function scheduledRefresh_() {
  forceRecalc_();
}

/**
 * Run ONCE from the Apps Script editor (Run ▸ installFreshnessTrigger) to keep
 * the sheet fresh a couple of times a day without anyone opening it. Idempotent
 * — removes any existing copies first. Edit FRESHNESS_HOURS_ to change the times.
 */
function installFreshnessTrigger() {
  removeFreshnessTrigger();
  FRESHNESS_HOURS_.forEach(function (h) {
    ScriptApp.newTrigger(FRESHNESS_TRIGGER_FN_).timeBased().atHour(h).everyDays(1).create();
  });
  return 'Installed daily freshness trigger(s) at hours: ' + FRESHNESS_HOURS_.join(', ') + ' (project timezone).';
}

/** Remove the freshness trigger (run from the editor if you want to stop it). */
function removeFreshnessTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === FRESHNESS_TRIGGER_FN_) { ScriptApp.deleteTrigger(t); removed++; }
  });
  return 'Removed ' + removed + ' trigger(s).';
}


// =====================  Small helpers  =====================

function safeGetUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; }
  catch (e) { return ''; }
}

/**
 * Write text into a cell, auto-detecting formula vs number vs string.
 * Shared by PayrollSankey (writeCellEdit) and Investment (writeInvestmentCell).
 */
function setCellSmart_(cell, newText) {
  var text = (newText === null || newText === undefined) ? '' : String(newText);
  if (text === '') {
    cell.clearContent();
  } else if (text.charAt(0) === '=') {
    cell.setFormula(text);
  } else {
    // Accept "$1,234.56" style; strip $ and , and store as a number so
    // downstream formulas stay clean.
    var stripped = text.replace(/[\$,]/g, '').trim();
    var asNum = Number(stripped);
    if (stripped !== '' && !isNaN(asNum) && /^-?\d*\.?\d+$/.test(stripped)) {
      cell.setValue(asNum);
    } else {
      cell.setValue(text);
    }
  }
}

