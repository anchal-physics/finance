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

