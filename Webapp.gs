/**
 * Webapp.gs
 * ----------------------------------------------------------------------
 * Server-side endpoints for the PayrollSankey web app.
 *
 * This file lives in the SAME Apps Script project as SankeyRenderer.gs
 * and reuses its constants (PRESET_RANGE, TARGET_SHEET_NAME,
 * COLUMNS_PER_GROUP). To deploy:
 *   1. Save this file plus WebappPage.html, PrintPage.html, and
 *      appsscript.json into the same project.
 *   2. Enable the Sheets advanced service (Editor > Services > +).
 *   3. Deploy > New deployment > Web app.
 *   4. Open the resulting URL.
 *
 * See DEPLOY.md for the full walkthrough.
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
    .setTitle('PayrollSankey')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Allow .html templates to include each other's content. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// =====================  Bootstrap (initial payload)  =====================

/**
 * Returns the full state needed to render the page on load:
 *   - sheet identifiers and range metadata
 *   - per-subpanel data (only rows with content for that triplet)
 *   - saved settings + lock state from UserProperties
 *   - a state hash so the client can detect external sheet edits
 *
 * Designed for future expansion: number of subpanels is derived from
 * PRESET_RANGE / COLUMNS_PER_GROUP, so widening the constant in
 * SankeyRenderer.gs auto-creates new subpanels without code changes.
 */
function getBootstrapPayload() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + TARGET_SHEET_NAME + '" not found. Update TARGET_SHEET_NAME in SankeyRenderer.gs.');
  }
  var snapshot = readSheetSnapshot_(sheet);
  return {
    sheetName: TARGET_SHEET_NAME,
    sheetId: sheet.getSheetId(),
    spreadsheetId: ss.getId(),
    presetRange: getEffectiveRange_(),
    startRow: snapshot.startRow,
    startCol: snapshot.startCol,
    numRows: snapshot.numRows,
    numCols: snapshot.numCols,
    columnsPerGroup: COLUMNS_PER_GROUP,
    subpanels: buildSubpanels_(snapshot),
    settings: getSavedSettings(),
    locks: getSavedLocks(),
    hash: snapshot.hash,
    userEmail: safeGetUserEmail_()
  };
}

/** Re-read the full sheet snapshot (used by polling and after writes). */
function refreshState() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TARGET_SHEET_NAME);
  var snapshot = readSheetSnapshot_(sheet);
  return {
    subpanels: buildSubpanels_(snapshot),
    hash: snapshot.hash,
    startRow: snapshot.startRow,
    startCol: snapshot.startCol,
    numRows: snapshot.numRows,
    numCols: snapshot.numCols
  };
}

/**
 * Lightweight poll: returns just the hash and, if it changed since the
 * client's last-known hash, the cells that differ. The client compares
 * the changed cells against its own unsaved edits to decide whether
 * to surface a conflict banner.
 */
function pollChanges(lastHash) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TARGET_SHEET_NAME);
  var snapshot = readSheetSnapshot_(sheet);
  if (snapshot.hash === lastHash) {
    return { changed: false, hash: snapshot.hash };
  }
  return {
    changed: true,
    hash: snapshot.hash,
    subpanels: buildSubpanels_(snapshot),
    startRow: snapshot.startRow,
    numRows: snapshot.numRows
  };
}

/** Internal: read the whole preset range and compute the state hash. */
function readSheetSnapshot_(sheet) {
  // Expand the read range downward beyond the effective range so newly-
  // appended rows beyond it are still picked up. Cap at row 999.
  var declared = sheet.getRange(getEffectiveRange_());
  var startRow = declared.getRow();
  var startCol = declared.getColumn();
  var numCols = declared.getNumColumns();
  var maxAllowedRow = 999;
  var lastRow = Math.min(sheet.getLastRow(), maxAllowedRow);
  var numRows = Math.max(declared.getNumRows(), Math.max(1, lastRow - startRow + 1));
  var range = sheet.getRange(startRow, startCol, numRows, numCols);
  var values = range.getValues();
  var displays = range.getDisplayValues();
  var formulas = range.getFormulas();
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    JSON.stringify(values) + '|' + JSON.stringify(formulas)
  );
  return {
    startRow: startRow,
    startCol: startCol,
    numRows: numRows,
    numCols: numCols,
    values: values,
    displays: displays,
    formulas: formulas,
    hash: Utilities.base64Encode(bytes).substring(0, 16)
  };
}

/**
 * Slice the snapshot into per-subpanel row arrays.
 * Only includes rows where that subpanel's 3 cells have any content.
 */
function buildSubpanels_(snapshot) {
  var numGroups = Math.floor(snapshot.numCols / COLUMNS_PER_GROUP);
  var headerRow = snapshot.values[0] || [];
  var headerDisplays = snapshot.displays[0] || [];
  var subpanels = [];
  for (var g = 0; g < numGroups; g++) {
    var colOffset = g * COLUMNS_PER_GROUP;
    var titleCol = colOffset + 1; // value column header
    var title = String(headerDisplays[titleCol] || headerRow[titleCol] || ('Subpanel ' + (g + 1)));
    subpanels.push({
      groupIndex: g,
      title: title,
      columnStart: snapshot.startCol + colOffset, // 1-based sheet column
      headerRow: snapshot.startRow,
      rows: []
    });
  }
  // Row 0 is the header (skip). Data is rows 1..numRows-1.
  for (var r = 1; r < snapshot.numRows; r++) {
    var sheetRow = snapshot.startRow + r;
    for (var g2 = 0; g2 < numGroups; g2++) {
      var off = g2 * COLUMNS_PER_GROUP;
      var srcV = snapshot.values[r][off];
      var valV = snapshot.values[r][off + 1];
      var tgtV = snapshot.values[r][off + 2];
      var srcF = snapshot.formulas[r][off];
      var valF = snapshot.formulas[r][off + 1];
      var tgtF = snapshot.formulas[r][off + 2];
      var hasContent = !isBlank_(srcV) || !isBlank_(valV) || !isBlank_(tgtV)
                    || !isBlank_(srcF) || !isBlank_(valF) || !isBlank_(tgtF);
      if (!hasContent) continue;
      subpanels[g2].rows.push({
        sheetRow: sheetRow,
        input: { display: snapshot.displays[r][off], formula: srcF, raw: srcV },
        value: { display: snapshot.displays[r][off + 1], formula: valF, raw: valV },
        output: { display: snapshot.displays[r][off + 2], formula: tgtF, raw: tgtV }
      });
    }
  }
  return subpanels;
}

function isBlank_(v) {
  return v === '' || v === null || v === undefined;
}


// =====================  Cell edit  =====================

/**
 * Write a single cell. Auto-detects formula vs literal vs number.
 *
 * @param {Object} payload  { groupIndex, sheetRow, colInGroup (0|1|2), newText }
 * @return {Object} fresh cell state { display, formula, raw, hash }
 */
function writeCellEdit(payload) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TARGET_SHEET_NAME);
  var startCol = sheet.getRange(getEffectiveRange_()).getColumn();
  var colAbs = startCol + payload.groupIndex * COLUMNS_PER_GROUP + payload.colInGroup;
  var cell = sheet.getRange(payload.sheetRow, colAbs);
  var text = (payload.newText === null || payload.newText === undefined) ? '' : String(payload.newText);

  if (text === '') {
    cell.clearContent();
  } else if (text.charAt(0) === '=') {
    cell.setFormula(text);
  } else {
    // For numeric inputs in the value column, accept "$1,234.56" style;
    // strip $ and , and store as a number so Sankey formula stays clean.
    var stripped = text.replace(/[\$,]/g, '').trim();
    var asNum = Number(stripped);
    if (stripped !== '' && !isNaN(asNum) && /^-?\d*\.?\d+$/.test(stripped)) {
      cell.setValue(asNum);
    } else {
      cell.setValue(text);
    }
  }
  SpreadsheetApp.flush();

  var snapshot = readSheetSnapshot_(sheet);
  return {
    cell: {
      sheetRow: payload.sheetRow,
      groupIndex: payload.groupIndex,
      colInGroup: payload.colInGroup,
      display: cell.getDisplayValue(),
      formula: cell.getFormula(),
      raw: cell.getValue()
    },
    hash: snapshot.hash
  };
}


// =====================  Row add / delete / move  =====================

/**
 * Append a new (empty) row to the bottom of a given subpanel.
 * "Bottom" = first row after the last occupied row in that subpanel's
 * column triplet. Does not touch other subpanels.
 *
 * Returns the new row descriptor (sheetRow + empty cell state).
 */
function appendRowToSubpanel(groupIndex) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TARGET_SHEET_NAME);
  var declared = sheet.getRange(getEffectiveRange_());
  var startRow = declared.getRow();
  var startCol = declared.getColumn();
  // Scan up to row 999 for the last row that has content in this group.
  var maxRow = 999;
  var colStart = startCol + groupIndex * COLUMNS_PER_GROUP;
  var groupVals = sheet.getRange(startRow, colStart, maxRow - startRow + 1, COLUMNS_PER_GROUP).getValues();
  var lastUsedOffset = 0; // header row counts as "used"
  for (var r = 0; r < groupVals.length; r++) {
    if (groupVals[r].some(function (c) { return !isBlank_(c); })) lastUsedOffset = r;
  }
  var newSheetRow = startRow + lastUsedOffset + 1;
  if (newSheetRow > maxRow) {
    throw new Error('Cannot append: row cap of ' + maxRow + ' reached.');
  }
  // No write yet (the row is empty); client will issue writeCellEdit when user types.
  SpreadsheetApp.flush();
  var snapshot = readSheetSnapshot_(sheet);
  return {
    sheetRow: newSheetRow,
    row: {
      sheetRow: newSheetRow,
      input: { display: '', formula: '', raw: '' },
      value: { display: '', formula: '', raw: '' },
      output: { display: '', formula: '', raw: '' }
    },
    hash: snapshot.hash
  };
}

/**
 * Clear the 3 cells of a single subpanel row. Other subpanels on the
 * same sheet row are untouched.
 */
function clearRowInSubpanel(groupIndex, sheetRow) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TARGET_SHEET_NAME);
  var startCol = sheet.getRange(getEffectiveRange_()).getColumn();
  var colStart = startCol + groupIndex * COLUMNS_PER_GROUP;
  sheet.getRange(sheetRow, colStart, 1, COLUMNS_PER_GROUP).clearContent();
  SpreadsheetApp.flush();
  var snapshot = readSheetSnapshot_(sheet);
  return { hash: snapshot.hash };
}

/**
 * Move an entire spreadsheet row up or down using the Sheets advanced
 * service. This is the same operation as dragging a row in the Sheets
 * UI: formula references that depend on the moved row's old index are
 * auto-updated by Sheets. As described in the design, this DOES move
 * cells in columns outside the subpanel (A-C, P+, etc.).
 *
 * @param {number} fromRow  1-based sheet row of the row to move
 * @param {number} toRow    1-based sheet row where it should land
 */
function moveSheetRow(fromRow, toRow) {
  if (fromRow === toRow) {
    var sheet0 = SpreadsheetApp.getActive().getSheetByName(TARGET_SHEET_NAME);
    return { hash: readSheetSnapshot_(sheet0).hash };
  }
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(TARGET_SHEET_NAME);
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
  var snapshot = readSheetSnapshot_(sheet);
  return { hash: snapshot.hash };
}


// =====================  Settings + Locks (per-user)  =====================

var SETTINGS_KEY_ = 'sankey_settings_v1';
var LOCKS_KEY_ = 'subpanel_locks_v1';
var REORDER_ACK_KEY_ = 'reorder_warning_ack_v1';

// Effective-range override. PRESET_RANGE in SankeyRenderer.gs is the default;
// "+ Add new level" widens the range and persists the new A1 string here.
// Stored in SCRIPT properties (not user properties) because adding a level is
// a structural change to the shared sheet, not a per-user preference.
var RANGE_OVERRIDE_KEY_ = 'effective_range_v1';

/**
 * The range the webapp currently operates on. Returns the persisted override
 * if one has been set (and looks like a valid A1 range), else PRESET_RANGE.
 */
function getEffectiveRange_() {
  var stored = PropertiesService.getScriptProperties().getProperty(RANGE_OVERRIDE_KEY_);
  if (stored && /^[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(stored)) return stored;
  return PRESET_RANGE;
}

function getSavedSettings() {
  var raw = PropertiesService.getUserProperties().getProperty(SETTINGS_KEY_);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function saveSettings(jsonString) {
  // Accepts a string to keep the over-the-wire payload simple.
  PropertiesService.getUserProperties().setProperty(SETTINGS_KEY_, String(jsonString || ''));
  return { ok: true };
}

function getSavedLocks() {
  var raw = PropertiesService.getUserProperties().getProperty(LOCKS_KEY_);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function setSubpanelLock(groupIndex, locked) {
  var locks = getSavedLocks();
  locks[String(groupIndex)] = !!locked;
  PropertiesService.getUserProperties().setProperty(LOCKS_KEY_, JSON.stringify(locks));
  return { ok: true, locks: locks };
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
    .setTitle('PayrollSankey — Print')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// =====================  Future expansion seam  =====================

/**
 * "+ Add new level" button. Appends one column-triplet (Input | <title> |
 * Output) immediately to the right of the current effective range, seeds the
 * header row with those three labels, and persists the widened range so all
 * subsequent loads (and other users) see the new subpanel.
 *
 * The range constant PRESET_RANGE in SankeyRenderer.gs is NOT edited — the new
 * width is stored as an override (see getEffectiveRange_). buildSubpanels_
 * derives subpanel count from range width / COLUMNS_PER_GROUP, so the new
 * subpanel appears automatically once the range widens.
 *
 * Note: for the default D1:O39 sheet this extends the range to D1:R39, which
 * spans column Q — the same cell SankeyRenderer's IMAGE_ANCHOR_CELL uses for
 * the saved PNG. The image floats over cells rather than occupying them, so
 * data isn't lost, but be aware of the visual overlap if both features are used.
 *
 * @param {string} title  Header label for the new subpanel's value column.
 * @return {Object} { ok, presetRange, subpanels, hash } on success.
 */
function addNewLevel(title) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + TARGET_SHEET_NAME + '" not found.');

  var cleanTitle = String(title == null ? '' : title).trim() || 'New Level';

  var current = sheet.getRange(getEffectiveRange_());
  var startRow = current.getRow();
  var startCol = current.getColumn();
  var numRows = current.getNumRows();
  var numCols = current.getNumColumns();

  // New triplet sits immediately to the right of the current range.
  var newInputCol = startCol + numCols;       // Input
  var newValueCol = newInputCol + 1;          // <title>
  var newOutputCol = newInputCol + 2;         // Output

  // Seed the header row (Input | <title> | Output), matching the existing
  // subpanel header convention.
  sheet.getRange(startRow, newInputCol).setValue('Input');
  sheet.getRange(startRow, newValueCol).setValue(cleanTitle);
  sheet.getRange(startRow, newOutputCol).setValue('Output');

  // Persist the widened range (e.g. D1:O39 -> D1:R39).
  var widened = sheet.getRange(startRow, startCol, numRows, numCols + COLUMNS_PER_GROUP);
  var newRangeA1 = widened.getA1Notation();
  PropertiesService.getScriptProperties().setProperty(RANGE_OVERRIDE_KEY_, newRangeA1);

  SpreadsheetApp.flush();
  var snapshot = readSheetSnapshot_(sheet);
  return {
    ok: true,
    presetRange: newRangeA1,
    subpanels: buildSubpanels_(snapshot),
    hash: snapshot.hash
  };
}


// =====================  Small helpers  =====================

function safeGetUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; }
  catch (e) { return ''; }
}
