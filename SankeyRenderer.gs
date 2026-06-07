/**
 * SankeyRenderer.gs
 * ----------------------------------------------------------------------
 * Single-button Sankey diagram generator for Google Sheets.
 *
 * Replaces the old Sankey.gs copy/paste workflow:
 *   - reads spreadsheet data (Source | Value | Target triplets, like before)
 *   - opens a modal dialog that renders the diagram in-line, mirroring
 *     sankeydiagram.net's settings panel and visual style
 *   - lets you download SVG / PNG, or push the PNG back into the
 *     "PayrollSankey" sheet at a configurable anchor cell
 *
 * NOTE: If your project still contains the old Sankey.gs file, either
 * delete it or remove its onOpen() so the menus do not clash.
 *
 * The embedded renderer uses d3 v7 + d3-sankey (MIT) from a public CDN
 * and mirrors the input grammar and settings of sankeydiagram.net
 * (https://github.com/nxt3AT/sankeydiagram.net, MIT).
 * ----------------------------------------------------------------------
 */

// ======================== CONFIG (edit me) ===========================

/** Default range used by "Render Preset Range". Change as needed. */
const PRESET_RANGE = 'D1:O39';

/** Sheet name where data lives and where the saved image will be dropped. */
const TARGET_SHEET_NAME = 'PayrollSankey';

/** Anchor cell for "Save PNG to Sheet". Image is placed at this cell. */
const IMAGE_ANCHOR_CELL = 'Q1';

/** Alt-text tag used to identify previously-inserted Sankey images so
 *  "Save PNG to Sheet" replaces them instead of stacking. */
const IMAGE_ALT_TAG = 'SankeyDiagram';

/** Columns per flow group (Source, Value, Target). */
const COLUMNS_PER_GROUP = 3;

// =====================================================================


/** Adds the Sankey Renderer menu when the spreadsheet opens. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sankey Renderer')
    .addItem('Render Selected Range', 'renderSelectedRange')
    .addItem('Render Preset Range (' + PRESET_RANGE + ')', 'renderPresetRange')
    .addItem('Render Custom Range…', 'renderCustomRange')
    .addSeparator()
    .addItem('Help', 'showSankeyHelp')
    .addToUi();
}


/** Mode 1: render whatever the user has selected. */
function renderSelectedRange() {
  const range = SpreadsheetApp.getActiveSheet().getActiveRange();
  if (!range) {
    SpreadsheetApp.getUi().alert('Please select a range first.');
    return;
  }
  const text = convertToSankeyFormat(range.getValues());
  openSankeyDialog(text, 'Selected Range: ' + range.getA1Notation());
}


/** Mode 2: render the preset range from the target sheet. */
function renderPresetRange() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TARGET_SHEET_NAME) || SpreadsheetApp.getActiveSheet();
  let range;
  try {
    range = sheet.getRange(PRESET_RANGE);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Could not read preset range "' + PRESET_RANGE + '": ' + e.message);
    return;
  }
  const text = convertToSankeyFormat(range.getValues());
  openSankeyDialog(text, 'Preset Range: ' + PRESET_RANGE + ' on ' + sheet.getName());
}


/** Mode 3: ask for a range. */
function renderCustomRange() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Enter Range',
    'Range (e.g. D1:O39). Leave blank to use the active sheet selection.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const rangeString = (response.getResponseText() || '').trim();
  if (!rangeString) {
    ui.alert('Please enter a range like D1:O39.');
    return;
  }
  try {
    const range = SpreadsheetApp.getActiveSheet().getRange(rangeString);
    const text = convertToSankeyFormat(range.getValues());
    openSankeyDialog(text, 'Range: ' + rangeString);
  } catch (e) {
    ui.alert('Invalid range: ' + e.message);
  }
}


/** Opens the modal dialog with the parsed text and renderer UI. */
function openSankeyDialog(text, subtitle) {
  const html = HtmlService.createHtmlOutput(getSankeyDialogHtml(text, subtitle))
    .setWidth(1400)
    .setHeight(820);
  SpreadsheetApp.getUi().showModalDialog(html, 'Sankey Renderer');
}


/**
 * Called from the dialog (via google.script.run) to drop the rendered PNG
 * into the target sheet at the anchor cell. Replaces any previously inserted
 * image that carries IMAGE_ALT_TAG.
 *
 * @param {string} base64DataUrl  "data:image/png;base64,...." string
 * @return {string} status message shown back in the dialog
 */
function saveSankeyImageToSheet(base64DataUrl) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TARGET_SHEET_NAME);
  if (!sheet) {
    throw new Error('Target sheet "' + TARGET_SHEET_NAME + '" was not found. Update TARGET_SHEET_NAME in the script.');
  }

  // Remove previously inserted Sankey images (matched via alt-text tag).
  const existing = sheet.getImages();
  for (let i = 0; i < existing.length; i++) {
    if (existing[i].getAltTextTitle() === IMAGE_ALT_TAG) {
      existing[i].remove();
    }
  }

  const base64 = String(base64DataUrl).replace(/^data:image\/\w+;base64,/, '');
  const bytes = Utilities.base64Decode(base64);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const blob = Utilities.newBlob(bytes, 'image/png', 'sankey-' + stamp + '.png');

  const anchor = sheet.getRange(IMAGE_ANCHOR_CELL);
  const image = sheet.insertImage(blob, anchor.getColumn(), anchor.getRow());
  image.setAltTextTitle(IMAGE_ALT_TAG);
  image.setAltTextDescription('Sankey diagram generated ' + stamp);

  return 'Inserted image at ' + IMAGE_ANCHOR_CELL + ' on "' + TARGET_SHEET_NAME + '" (' + stamp + ').';
}


// ===================== Spreadsheet → Sankey text =====================

/**
 * Same algorithm as the previous Sankey.gs: walk every group of 3 columns
 * as (source | value | target), strip $/,, round to integers, dedupe within
 * each group, and emit `SOURCE    [VALUE]    TARGET` lines, with blank
 * lines between groups (blank lines are ignored by the parser but help
 * readability when the user edits the textarea in the dialog).
 */
function convertToSankeyFormat(data) {
  let lines = [];
  if (!data || !data.length) return '';

  const maxCols = data.reduce(function (m, row) { return Math.max(m, row.length); }, 0);
  const numSets = Math.floor(maxCols / COLUMNS_PER_GROUP);

  for (let s = 0; s < numSets; s++) {
    const start = s * COLUMNS_PER_GROUP;
    const setLines = [];
    const seen = {};
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (row.every(function (c) { return c === '' || c === null || c === undefined; })) continue;
      const src = cleanText(row[start]);
      const val = cleanValue(row[start + 1]);
      const tgt = cleanText(row[start + 2]);
      if (src && tgt && val && val !== '0') {
        const line = src + '    [' + val + ']    ' + tgt;
        if (!seen[line]) { seen[line] = true; setLines.push(line); }
      }
    }
    if (setLines.length) {
      if (lines.length) lines.push('');
      lines = lines.concat(setLines);
    }
  }
  return lines.join('\n');
}

function cleanText(v) {
  if (v === null || v === undefined) return '';
  return v.toString().trim().replace(/\t/g, '    ');
}

function cleanValue(v) {
  if (v === null || v === undefined || v === '') return '0';
  const cleaned = v.toString().replace(/[\$,]/g, '').replace(/\t/g, ' ').trim();
  const n = parseFloat(cleaned);
  if (isNaN(n)) return '0';
  return Math.round(n).toString();
}


function showSankeyHelp() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    'Sankey Renderer Help',
    [
      'Three modes:',
      '  • Render Selected Range — uses whatever you have selected.',
      '  • Render Preset Range (' + PRESET_RANGE + ') — change PRESET_RANGE constant in this script.',
      '  • Render Custom Range — type in any A1 range.',
      '',
      'Data format: groups of 3 columns (Source | Value | Target).',
      'Empty rows and zero/blank values are skipped.',
      '',
      'In the dialog you can:',
      '  • Edit the parsed flow text (left textarea).',
      '  • Tweak the settings panel (colors, opacity, fonts, layout).',
      '  • Click "Render" to refresh.',
      '  • Download SVG or PNG.',
      '  • Click "Save PNG to Sheet" to drop the image into',
      '    "' + TARGET_SHEET_NAME + '" at ' + IMAGE_ANCHOR_CELL + '. Old saves are replaced.',
      '',
      'Renderer is based on d3 v7 + d3-sankey (MIT). Settings mirror',
      'sankeydiagram.net (also MIT).'
    ].join('\n'),
    ui.ButtonSet.OK
  );
}


// =========================== Dialog HTML =============================
/**
 * Builds the dialog HTML. Kept as a single function returning a string so
 * the project remains "one file" like the previous Sankey.gs. The inner
 * <script> uses string concatenation rather than template literals to
 * avoid backtick/${} collisions with this outer template literal.
 */
function getSankeyDialogHtml(initialText, subtitle) {
  const safeText = JSON.stringify(initialText || '');
  const safeTitle = JSON.stringify(subtitle || '');

  return '' +
'<!DOCTYPE html>\n' +
'<html>\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<style>\n' +
'  :root {\n' +
'    --node-width: 250px;\n' +
'    --node-font-size: 24px;\n' +
'    --node-text-background-opacity: 0;\n' +
'    --flow-opacity: 0.5;\n' +
'  }\n' +
'  html, body { height: 100%; margin: 0; padding: 0;\n' +
'    font-family: "Open Sans", Arial, sans-serif; font-size: 13px;\n' +
'    background: #fff; color: #222; }\n' +
'  .layout { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }\n' +
'  .settings { padding: 10px 12px; overflow-y: auto;\n' +
'    border-right: 1px solid #ddd; background: #f7f7f8; }\n' +
'  .canvas { padding: 10px 14px; overflow: auto; display: flex; flex-direction: column; }\n' +
'  .canvas h3 { margin: 0 0 6px 0; font-size: 14px; color: #555; font-weight: 600; }\n' +
'  .canvas .svg-wrap { flex: 1; min-height: 0; display: flex; }\n' +
'  #sankey-svg { width: 100%; height: 100%; background: white; border: 1px solid #eee; }\n' +
'  .group { margin-bottom: 10px; background: white; border: 1px solid #e3e3e3; border-radius: 4px; }\n' +
'  .group > .hd { padding: 6px 10px; font-weight: 600; background: #f0f1f2; border-bottom: 1px solid #e3e3e3; border-radius: 4px 4px 0 0; font-size: 12px; }\n' +
'  .group > .bd { padding: 8px 10px; }\n' +
'  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0; }\n' +
'  .row label { flex: 1; font-size: 12px; color: #333; }\n' +
'  .row input[type=number], .row input[type=text], .row select { width: 130px; padding: 2px 4px; }\n' +
'  .row input[type=range] { width: 130px; }\n' +
'  textarea#input { width: 100%; box-sizing: border-box; height: 160px;\n' +
'    font-family: "SFMono-Regular","Consolas","Menlo",monospace; font-size: 11px; }\n' +
'  .btn { padding: 6px 10px; background: #4285f4; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }\n' +
'  .btn:hover { background: #3367d6; }\n' +
'  .btn.green { background: #34a853; }\n' +
'  .btn.green:hover { background: #2d8e47; }\n' +
'  .btn.ghost { background: #eee; color: #222; }\n' +
'  .btn.ghost:hover { background: #ddd; }\n' +
'  .btn-row { display: flex; flex-wrap: wrap; gap: 6px; }\n' +
'  #status { padding: 6px 0; font-size: 11px; min-height: 14px; color: #555; }\n' +
'  #status.err { color: #c5221f; }\n' +
'  #status.ok { color: #137333; }\n' +
'  /* Sankey styling — mirrors sankeydiagram.net */\n' +
'  .nodes text { font-family: "Open Sans", Arial, sans-serif; font-weight: 600;\n' +
'    font-size: var(--node-font-size); pointer-events: none; }\n' +
'  .nodes rect { opacity: 0.85; cursor: default; }\n' +
'  .nodes .label-bg { fill: white; rx: 3; opacity: var(--node-text-background-opacity); }\n' +
'  .links path { fill: none; opacity: var(--flow-opacity); }\n' +
'  .links path:hover { opacity: 0.85; }\n' +
'  .watermark { font-size: 11px; fill: #bbb; }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="layout">\n' +
'  <div class="settings">\n' +
'    <div class="group">\n' +
'      <div class="hd">Input</div>\n' +
'      <div class="bd">\n' +
'        <textarea id="input" spellcheck="false"></textarea>\n' +
'        <div class="btn-row" style="margin-top:6px;">\n' +
'          <button class="btn" id="render-btn">Render</button>\n' +
'          <button class="btn ghost" id="reset-btn">Reset settings</button>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +

'    <div class="group">\n' +
'      <div class="hd">Numbers</div>\n' +
'      <div class="bd">\n' +
'        <div class="row"><label>Decimal Precision</label><input type="number" id="precision" value="1" min="0" max="15"></div>\n' +
'        <div class="row"><label>Hide zero decimals</label><input type="checkbox" id="hidezeros" checked></div>\n' +
'        <div class="row"><label>Thousands separators</label><input type="checkbox" id="separators" checked></div>\n' +
'        <div class="row"><label>Value Prefix</label><input type="text" id="prefix" value="$" placeholder="$"></div>\n' +
'        <div class="row"><label>Value Suffix</label><input type="text" id="suffix"></div>\n' +
'        <div class="row"><label>Hide numbers</label><input type="checkbox" id="hidenumbers" checked></div>\n' +
'      </div>\n' +
'    </div>\n' +

'    <div class="group">\n' +
'      <div class="hd">Colors</div>\n' +
'      <div class="bd">\n' +
'        <div class="row"><label>Color scheme</label>\n' +
'          <select id="colorscheme">\n' +
'            <option value="default">default</option>\n' +
'            <option value="accent">accent</option>\n' +
'            <option value="paired">paired</option>\n' +
'            <option value="set2">set2</option>\n' +
'            <option value="set3">set3</option>\n' +
'            <option value="cat10">cat10</option>\n' +
'            <option value="pastel1">pastel1</option>\n' +
'            <option value="nested">nested</option>\n' +
'          </select>\n' +
'        </div>\n' +
'        <div class="row"><label>Flow opacity (%)</label><input type="number" id="flow-opacity" value="50" min="0" max="100"></div>\n' +
'        <div class="row"><label>Color by first word</label><input type="checkbox" id="firstword"></div>\n' +
'        <div class="row"><label>Color nodes</label><input type="checkbox" id="colornodes" checked></div>\n' +
'      </div>\n' +
'    </div>\n' +

'    <div class="group">\n' +
'      <div class="hd">Layout</div>\n' +
'      <div class="bd">\n' +
'        <div class="row"><label>Node width (px)</label><input type="number" id="nodewidth" value="250" min="0"></div>\n' +
'        <div class="row"><label>Node padding (px)</label><input type="number" id="nodepadding" value="20" min="0"></div>\n' +
'        <div class="row"><label>Label placement</label>\n' +
'          <select id="labelplacement">\n' +
'            <option value="inside" selected>inside</option>\n' +
'            <option value="outside">outside</option>\n' +
'            <option value="above">above</option>\n' +
'          </select>\n' +
'        </div>\n' +
'        <div class="row"><label>Label BG opacity (%)</label><input type="number" id="labelbg" value="0" min="0" max="100"></div>\n' +
'        <div class="row"><label>Sort by line number</label><input type="checkbox" id="sortbyline" checked></div>\n' +
'        <div class="row"><label>Canvas width</label><input type="number" id="canvaswidth" value="1920" min="100"></div>\n' +
'        <div class="row"><label>Canvas height</label><input type="number" id="canvasheight" value="1080" min="100"></div>\n' +
'        <div class="row"><label>Font size (px)</label><input type="number" id="fontsize" value="24" min="6"></div>\n' +
'        <div class="row"><label>Node alignment</label>\n' +
'          <select id="nodealign">\n' +
'            <option value="justify">justify</option>\n' +
'            <option value="left">left</option>\n' +
'            <option value="right">right</option>\n' +
'            <option value="center">center</option>\n' +
'          </select>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +

'    <div class="group">\n' +
'      <div class="hd">Export</div>\n' +
'      <div class="bd">\n' +
'        <div class="row"><label>Sheet image width (px)</label><input type="number" id="sheetwidth" value="1280" min="100" max="2000"></div>\n' +
'        <div class="row" style="font-size:11px;color:#777;line-height:1.3;display:block;">Google Sheets caps inserted images at 1,000,000 pixels. Width × (canvas height/width) must stay under that. 1280 → 720 = 921,600 px (safe at 16:9).</div>\n' +
'        <div class="btn-row" style="margin-top:6px;">\n' +
'          <button class="btn" id="dl-svg">Download SVG</button>\n' +
'          <button class="btn" id="dl-png">Download PNG</button>\n' +
'        </div>\n' +
'        <div class="btn-row" style="margin-top:6px;">\n' +
'          <button class="btn green" id="save-sheet">Save PNG to Sheet</button>\n' +
'        </div>\n' +
'        <div id="status"></div>\n' +
'      </div>\n' +
'    </div>\n' +

'  </div>\n' +

'  <div class="canvas">\n' +
'    <h3 id="subtitle"></h3>\n' +
'    <div class="svg-wrap">\n' +
'      <svg id="sankey-svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet"></svg>\n' +
'    </div>\n' +
'  </div>\n' +
'</div>\n' +

'<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>\n' +
'<script src="https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js"></script>\n' +
'<script>\n' +
'(function () {\n' +
'  var INITIAL_TEXT = ' + safeText + ';\n' +
'  var SUBTITLE = ' + safeTitle + ';\n' +

'  // ---------- DOM refs ----------\n' +
'  var $ = function (id) { return document.getElementById(id); };\n' +
'  $("input").value = INITIAL_TEXT;\n' +
'  $("subtitle").textContent = SUBTITLE;\n' +

'  // ---------- Color palettes (mirror sankeydiagram.net) ----------\n' +
'  var PALETTES = {\n' +
'    "default": ["#17becf","#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22"],\n' +
'    "accent":   d3.schemeAccent,\n' +
'    "paired":   d3.schemePaired,\n' +
'    "set2":     d3.schemeSet2,\n' +
'    "set3":     d3.schemeSet3,\n' +
'    "cat10":    d3.schemeCategory10,\n' +
'    "pastel1":  d3.schemePastel1,\n' +
'    "nested": [\n' +
'      "#17becf","#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b",\n' +
'      "#e377c2","#7f7f7f","#bcbd22","#aec7e8","#ffbb78","#98df8a","#ff9896",\n' +
'      "#c5b0d5","#c49c94","#f7b6d2","#c7c7c7","#dbdb8d","#9edae5","#393b79",\n' +
'      "#637939","#8c6d31","#843c39","#7b4173","#3182bd","#e6550d","#31a354",\n' +
'      "#756bb1","#636363","#5254a3","#bd9e39","#ad494a"\n' +
'    ]\n' +
'  };\n' +

'  // ---------- Parser ----------\n' +
'  // Mirrors sankeydiagram.net constants.js lineRegex.\n' +
'  // Capture: source, value (number OR ?  OR (math)), optional currency char, target, optional [color] tail.\n' +
'  var LINE_RE = /^(.*?)\\s*\\[\\s*([0-9,.?]+|\\([0-9.+\\-*\\/()\\s]+\\))\\s*([\\$€£₽¥])?\\s*\\]\\s*(.+?)(?:\\s*\\[(.+?)\\])?\\s*$/;\n' +

'  function isCommentOrBlank(line) {\n' +
'    var t = line.trim();\n' +
'    if (t === "") return true;\n' +
'    if (t.indexOf("//") === 0) return true;\n' +
'    if (t.indexOf("\'") === 0) return true;\n' +
'    return false;\n' +
'  }\n' +

'  function evaluateMath(expr) {\n' +
'    // Safe-ish: only digits, dots, whitespace, parens, + - * /\n' +
'    if (!/^[-+*/().\\d\\s]+$/.test(expr)) return NaN;\n' +
'    try { return Function("\\"use strict\\";return (" + expr + ")")(); }\n' +
'    catch (e) { return NaN; }\n' +
'  }\n' +

'  function firstWordOf(s) {\n' +
'    var m = /\\b(\\w+)\\b/.exec(String(s || ""));\n' +
'    return m ? m[1] : String(s || "");\n' +
'  }\n' +

'  function parseInput(text) {\n' +
'    var rawLines = String(text || "").split(/\\r?\\n/);\n' +
'    var entries = []; // each: {source,target,value|null,color,line}\n' +
'    for (var i = 0; i < rawLines.length; i++) {\n' +
'      var line = rawLines[i];\n' +
'      if (isCommentOrBlank(line)) continue;\n' +
'      var m = LINE_RE.exec(line);\n' +
'      if (!m) continue;\n' +
'      var source = m[1].trim();\n' +
'      var rawVal = m[2].trim();\n' +
'      var target = m[4].trim();\n' +
'      var color  = m[5] ? m[5].trim() : null;\n' +
'      if (!source || !target) continue;\n' +
'      var value = null; // null means "auto-sum"\n' +
'      if (rawVal === "?") {\n' +
'        value = null;\n' +
'      } else if (rawVal.charAt(0) === "(") {\n' +
'        var ev = evaluateMath(rawVal.replace(/[()]/g, function(c){ return c === "(" ? "(" : ")"; }));\n' +
'        value = isNaN(ev) ? 0 : ev;\n' +
'      } else {\n' +
'        var n = parseFloat(rawVal.replace(/,/g, ""));\n' +
'        value = isNaN(n) ? 0 : n;\n' +
'      }\n' +
'      entries.push({source: source, target: target, value: value, color: color, line: i + 1});\n' +
'    }\n' +

'    // Resolve [?] values: a node\'s out-edge "?" = incoming - other outgoing; symmetric for in-edge.\n' +
'    // Iterate a few passes until stable or give up.\n' +
'    for (var pass = 0; pass < 10; pass++) {\n' +
'      var changed = false;\n' +
'      for (var k = 0; k < entries.length; k++) {\n' +
'        var e = entries[k];\n' +
'        if (e.value !== null) continue;\n' +
'        // Try: incoming to target (sum) minus other outgoing of target\n' +
'        var inAll = 0, inHasAuto = false;\n' +
'        var outOther = 0, outHasAuto = false;\n' +
'        for (var j = 0; j < entries.length; j++) {\n' +
'          var f = entries[j];\n' +
'          if (f === e) continue;\n' +
'          if (f.target === e.target) {\n' +
'            if (f.value === null) inHasAuto = true; else inAll += f.value;\n' +
'          }\n' +
'          if (f.source === e.target) {\n' +
'            if (f.value === null) outHasAuto = true; else outOther += f.value;\n' +
'          }\n' +
'        }\n' +
'        // Also: outgoing from source (sum) minus other incoming of source\n' +
'        var outFromSource = 0, outFromSourceAuto = false;\n' +
'        var inToSource = 0, inToSourceAuto = false;\n' +
'        for (var j2 = 0; j2 < entries.length; j2++) {\n' +
'          var g = entries[j2];\n' +
'          if (g === e) continue;\n' +
'          if (g.source === e.source) {\n' +
'            if (g.value === null) outFromSourceAuto = true; else outFromSource += g.value;\n' +
'          }\n' +
'          if (g.target === e.source) {\n' +
'            if (g.value === null) inToSourceAuto = true; else inToSource += g.value;\n' +
'          }\n' +
'        }\n' +
'        // Prefer: value = sum(incoming to target excluding self) - sum(other outgoing from target)\n' +
'        if (!inHasAuto && !outHasAuto && inAll > 0) {\n' +
'          e.value = Math.max(0, inAll - outOther);\n' +
'          changed = true; continue;\n' +
'        }\n' +
'        if (!outFromSourceAuto && !inToSourceAuto && inToSource > 0) {\n' +
'          e.value = Math.max(0, inToSource - outFromSource);\n' +
'          changed = true; continue;\n' +
'        }\n' +
'      }\n' +
'      if (!changed) break;\n' +
'    }\n' +
'    // Anything still unresolved becomes 0 and gets dropped below.\n' +
'    entries = entries.filter(function (e) { return e.value !== null && e.value > 0; });\n' +

'    // Build nodes + links for d3-sankey.\n' +
'    var nodeIndex = {};\n' +
'    var nodes = [];\n' +
'    function addNode(name) {\n' +
'      if (nodeIndex[name] === undefined) {\n' +
'        nodeIndex[name] = nodes.length;\n' +
'        nodes.push({name: name});\n' +
'      }\n' +
'      return nodeIndex[name];\n' +
'    }\n' +
'    var links = [];\n' +
'    for (var p = 0; p < entries.length; p++) {\n' +
'      var ee = entries[p];\n' +
'      var sIdx = addNode(ee.source);\n' +
'      var tIdx = addNode(ee.target);\n' +
'      links.push({source: sIdx, target: tIdx, value: ee.value, color: ee.color, line: ee.line});\n' +
'    }\n' +
'    return {nodes: nodes, links: links};\n' +
'  }\n' +

'  // ---------- Number formatting ----------\n' +
'  function formatValue(v, settings) {\n' +
'    if (settings.hidenumbers) return "";\n' +
'    var precision = Math.max(0, Math.min(15, parseInt(settings.precision, 10) || 0));\n' +
'    var str = Number(v).toFixed(precision);\n' +
'    // Auto-increase precision if non-zero rounded to zero (mirror sankeydiagram.net behavior)\n' +
'    if (v !== 0 && parseFloat(str) === 0) {\n' +
'      for (var p = precision + 1; p <= 15; p++) {\n' +
'        str = Number(v).toFixed(p);\n' +
'        if (parseFloat(str) !== 0) break;\n' +
'      }\n' +
'    }\n' +
'    if (settings.hidezeros && str.indexOf(".") !== -1) {\n' +
'      str = str.replace(/\\.?0+$/, "");\n' +
'    }\n' +
'    if (settings.separators) {\n' +
'      var parts = str.split(".");\n' +
'      parts[0] = Number(parts[0]).toLocaleString("en-US");\n' +
'      str = parts.join(".");\n' +
'    }\n' +
'    return (settings.prefix || "") + str + (settings.suffix || "");\n' +
'  }\n' +

'  // ---------- Settings reader ----------\n' +
'  function readSettings() {\n' +
'    return {\n' +
'      precision: $("precision").value,\n' +
'      hidezeros: $("hidezeros").checked,\n' +
'      separators: $("separators").checked,\n' +
'      prefix: $("prefix").value,\n' +
'      suffix: $("suffix").value,\n' +
'      hidenumbers: $("hidenumbers").checked,\n' +
'      colorscheme: $("colorscheme").value,\n' +
'      flowOpacity: parseInt($("flow-opacity").value, 10),\n' +
'      firstword: $("firstword").checked,\n' +
'      colornodes: $("colornodes").checked,\n' +
'      nodewidth: parseInt($("nodewidth").value, 10),\n' +
'      nodepadding: parseInt($("nodepadding").value, 10),\n' +
'      labelplacement: $("labelplacement").value,\n' +
'      labelbg: parseInt($("labelbg").value, 10),\n' +
'      sortbyline: $("sortbyline").checked,\n' +
'      canvasWidth: parseInt($("canvaswidth").value, 10),\n' +
'      canvasHeight: parseInt($("canvasheight").value, 10),\n' +
'      fontSize: parseInt($("fontsize").value, 10),\n' +
'      nodealign: $("nodealign").value,\n' +
'      sheetWidth: parseInt($("sheetwidth").value, 10)\n' +
'    };\n' +
'  }\n' +

'  function applyCssVars(s) {\n' +
'    var root = document.documentElement;\n' +
'    root.style.setProperty("--node-width", s.nodewidth + "px");\n' +
'    root.style.setProperty("--node-font-size", s.fontSize + "px");\n' +
'    root.style.setProperty("--node-text-background-opacity", (s.labelbg / 100));\n' +
'    root.style.setProperty("--flow-opacity", (s.flowOpacity / 100));\n' +
'  }\n' +

'  // ---------- Render ----------\n' +
'  function render() {\n' +
'    var s = readSettings();\n' +
'    applyCssVars(s);\n' +

'    var parsed = parseInput($("input").value);\n' +
'    if (!parsed.nodes.length) {\n' +
'      d3.select("#sankey-svg").selectAll("*").remove();\n' +
'      setStatus("No flows parsed. Edit the input above.", "err");\n' +
'      return;\n' +
'    }\n' +

'    var svg = d3.select("#sankey-svg");\n' +
'    svg.attr("viewBox", "0 0 " + s.canvasWidth + " " + s.canvasHeight);\n' +
'    svg.selectAll("*").remove();\n' +

'    // Background white rect for export consistency\n' +
'    svg.append("rect")\n' +
'      .attr("x", 0).attr("y", 0)\n' +
'      .attr("width", s.canvasWidth).attr("height", s.canvasHeight)\n' +
'      .attr("fill", "white");\n' +

'    // Build sankey layout\n' +
'    var alignFn = d3.sankeyJustify;\n' +
'    if (s.nodealign === "left") alignFn = d3.sankeyLeft;\n' +
'    else if (s.nodealign === "right") alignFn = d3.sankeyRight;\n' +
'    else if (s.nodealign === "center") alignFn = d3.sankeyCenter;\n' +

'    var rightPad = 60; // mirror sankeydiagram.net layout padding\n' +
'    var sankey = d3.sankey()\n' +
'      .nodeWidth(Math.max(1, s.nodewidth))\n' +
'      .nodePadding(Math.max(0, s.nodepadding))\n' +
'      .nodeAlign(alignFn)\n' +
'      .extent([[10, 10], [s.canvasWidth - rightPad, s.canvasHeight - 10]]);\n' +

'    if (s.sortbyline) {\n' +
'      sankey.nodeSort(function (a, b) {\n' +
'        // Approximate "sort by line number" using the smallest link line each node touches\n' +
'        return (a.__firstLine || 0) - (b.__firstLine || 0);\n' +
'      });\n' +
'    }\n' +

'    // Annotate nodes with their earliest link line for sort\n' +
'    var firstLineByName = {};\n' +
'    parsed.links.forEach(function (l) {\n' +
'      var sName = parsed.nodes[l.source].name;\n' +
'      var tName = parsed.nodes[l.target].name;\n' +
'      if (firstLineByName[sName] === undefined || l.line < firstLineByName[sName]) firstLineByName[sName] = l.line;\n' +
'      if (firstLineByName[tName] === undefined || l.line < firstLineByName[tName]) firstLineByName[tName] = l.line;\n' +
'    });\n' +
'    parsed.nodes.forEach(function (n) { n.__firstLine = firstLineByName[n.name] || 0; });\n' +

'    var graph;\n' +
'    try {\n' +
'      graph = sankey({\n' +
'        nodes: parsed.nodes.map(function (n) { return Object.assign({}, n); }),\n' +
'        links: parsed.links.map(function (l) { return Object.assign({}, l); })\n' +
'      });\n' +
'    } catch (err) {\n' +
'      setStatus("Layout error: " + err.message + " — check for cycles or duplicate flows.", "err");\n' +
'      return;\n' +
'    }\n' +

'    // Color scale\n' +
'    var palette = PALETTES[s.colorscheme] || PALETTES["default"];\n' +
'    var color = d3.scaleOrdinal(palette);\n' +
'    function colorKey(name) { return s.firstword ? firstWordOf(name) : name; }\n' +

'    // Links\n' +
'    var linksG = svg.append("g").attr("class", "links");\n' +
'    linksG.selectAll("path").data(graph.links).enter().append("path")\n' +
'      .attr("d", d3.sankeyLinkHorizontal())\n' +
'      .attr("stroke", function (d) {\n' +
'        if (d.color) return d.color;\n' +
'        return color(colorKey(d.source.name));\n' +
'      })\n' +
'      .attr("stroke-width", function (d) { return Math.max(2.5, d.width); })\n' +
'      .attr("fill", "none")\n' +
'      .append("title").text(function (d) {\n' +
'        return d.source.name + " → " + d.target.name + ": " + formatValue(d.value, s);\n' +
'      });\n' +

'    // Nodes\n' +
'    var nodesG = svg.append("g").attr("class", "nodes");\n' +
'    var nodeG = nodesG.selectAll("g").data(graph.nodes).enter().append("g");\n' +

'    nodeG.append("rect")\n' +
'      .attr("x", function (d) { return d.x0; })\n' +
'      .attr("y", function (d) { return d.y0; })\n' +
'      .attr("width", function (d) { return d.x1 - d.x0; })\n' +
'      .attr("height", function (d) { return Math.max(1, d.y1 - d.y0); })\n' +
'      .attr("fill", function (d) { return s.colornodes ? color(colorKey(d.name)) : "#888"; })\n' +
'      .append("title").text(function (d) { return d.name + ": " + formatValue(d.value, s); });\n' +

'    // Label backgrounds (computed after text placement so we can size them)\n' +
'    function nodeLabel(d) {\n' +
'      if (s.hidenumbers) return d.name;\n' +
'      return d.name + " — " + formatValue(d.value, s);\n' +
'    }\n' +

'    var midX = s.canvasWidth / 2;\n' +

'    var labelData = nodeG.append("text")\n' +
'      .attr("dy", "0.35em")\n' +
'      .text(nodeLabel)\n' +
'      .each(function (d) {\n' +
'        var placement = s.labelplacement;\n' +
'        var nodeMid = (d.y0 + d.y1) / 2;\n' +
'        var sel = d3.select(this);\n' +
'        if (placement === "above") {\n' +
'          sel.attr("x", (d.x0 + d.x1) / 2)\n' +
'             .attr("y", d.y0 - 6)\n' +
'             .attr("text-anchor", "middle");\n' +
'        } else if (placement === "inside") {\n' +
'          sel.attr("x", (d.x0 + d.x1) / 2)\n' +
'             .attr("y", nodeMid)\n' +
'             .attr("text-anchor", "middle");\n' +
'        } else { // outside\n' +
'          if (d.x0 < midX) {\n' +
'            sel.attr("x", d.x1 + 6).attr("y", nodeMid).attr("text-anchor", "start");\n' +
'          } else {\n' +
'            sel.attr("x", d.x0 - 6).attr("y", nodeMid).attr("text-anchor", "end");\n' +
'          }\n' +
'        }\n' +
'      });\n' +

'    // Insert label backgrounds behind text (if opacity > 0)\n' +
'    if (s.labelbg > 0) {\n' +
'      nodeG.each(function () {\n' +
'        var g = d3.select(this);\n' +
'        var txt = g.select("text");\n' +
'        if (txt.empty()) return;\n' +
'        var bbox;\n' +
'        try { bbox = txt.node().getBBox(); } catch (e) { return; }\n' +
'        g.insert("rect", "text")\n' +
'          .attr("class", "label-bg")\n' +
'          .attr("x", bbox.x - 3)\n' +
'          .attr("y", bbox.y - 1)\n' +
'          .attr("width", bbox.width + 6)\n' +
'          .attr("height", bbox.height + 2);\n' +
'      });\n' +
'    }\n' +

'    setStatus("Rendered " + graph.nodes.length + " nodes, " + graph.links.length + " flows.", "ok");\n' +
'  }\n' +

'  // ---------- Status ----------\n' +
'  function setStatus(msg, cls) {\n' +
'    var el = $("status");\n' +
'    el.textContent = msg || "";\n' +
'    el.className = cls || "";\n' +
'  }\n' +

'  // ---------- Export helpers ----------\n' +
'  function inlineStylesToSvg() {\n' +
'    var svgEl = $("sankey-svg");\n' +
'    // Inject a <style> with the four CSS vars resolved to computed values, plus base rules.\n' +
'    var cs = getComputedStyle(document.documentElement);\n' +
'    var vars = [\n' +
'      ["--node-width", cs.getPropertyValue("--node-width").trim() || "10px"],\n' +
'      ["--node-font-size", cs.getPropertyValue("--node-font-size").trim() || "20px"],\n' +
'      ["--node-text-background-opacity", cs.getPropertyValue("--node-text-background-opacity").trim() || "0"],\n' +
'      ["--flow-opacity", cs.getPropertyValue("--flow-opacity").trim() || "0.5"]\n' +
'    ];\n' +
'    var css = ":root{" + vars.map(function (v){ return v[0] + ":" + v[1] + ";"; }).join("") + "}" +\n' +
'              ".nodes text{font-family:\\"Open Sans\\",Arial,sans-serif;font-weight:600;font-size:var(--node-font-size);}" +\n' +
'              ".nodes rect{opacity:0.85;}" +\n' +
'              ".nodes .label-bg{fill:white;opacity:var(--node-text-background-opacity);}" +\n' +
'              ".links path{fill:none;opacity:var(--flow-opacity);}";\n' +
'    // Remove any prior <style> we added\n' +
'    var existingStyle = svgEl.querySelector("style[data-export]");\n' +
'    if (existingStyle) existingStyle.remove();\n' +
'    var styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");\n' +
'    styleEl.setAttribute("data-export", "1");\n' +
'    styleEl.textContent = css;\n' +
'    svgEl.insertBefore(styleEl, svgEl.firstChild);\n' +
'    return svgEl;\n' +
'  }\n' +

'  function svgAsString() {\n' +
'    var svgEl = inlineStylesToSvg();\n' +
'    // Ensure xmlns\n' +
'    if (!svgEl.getAttribute("xmlns")) svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");\n' +
'    var s = new XMLSerializer().serializeToString(svgEl);\n' +
'    // Clean up the style we added so the on-screen SVG matches the rules\n' +
'    var style = svgEl.querySelector("style[data-export]");\n' +
'    if (style) style.remove();\n' +
'    return s;\n' +
'  }\n' +

'  function downloadBlob(blob, filename) {\n' +
'    var url = URL.createObjectURL(blob);\n' +
'    var a = document.createElement("a");\n' +
'    a.href = url;\n' +
'    a.download = filename;\n' +
'    document.body.appendChild(a);\n' +
'    a.click();\n' +
'    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);\n' +
'  }\n' +

'  function exportSvgFile() {\n' +
'    var s = svgAsString();\n' +
'    var blob = new Blob([s], {type: "image/svg+xml;charset=utf-8"});\n' +
'    downloadBlob(blob, "sankey-" + Date.now() + ".svg");\n' +
'  }\n' +

'  function svgToPngDataUrl(opts, callback) {\n' +
'    if (typeof opts === "function") { callback = opts; opts = {}; }\n' +
'    opts = opts || {};\n' +
'    var s = readSettings();\n' +
'    var outW = opts.width  || s.canvasWidth;\n' +
'    var outH = opts.height || s.canvasHeight;\n' +
'    var svgStr = svgAsString();\n' +
'    var img = new Image();\n' +
'    var svgBlob = new Blob([svgStr], {type: "image/svg+xml;charset=utf-8"});\n' +
'    var url = URL.createObjectURL(svgBlob);\n' +
'    img.onload = function () {\n' +
'      var canvas = document.createElement("canvas");\n' +
'      canvas.width = outW;\n' +
'      canvas.height = outH;\n' +
'      var ctx = canvas.getContext("2d");\n' +
'      ctx.fillStyle = "white";\n' +
'      ctx.fillRect(0, 0, canvas.width, canvas.height);\n' +
'      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);\n' +
'      URL.revokeObjectURL(url);\n' +
'      callback(null, canvas.toDataURL("image/png"));\n' +
'    };\n' +
'    img.onerror = function (e) {\n' +
'      URL.revokeObjectURL(url);\n' +
'      callback(e || new Error("Image load failed"));\n' +
'    };\n' +
'    img.src = url;\n' +
'  }\n' +

'  function exportPngFile() {\n' +
'    svgToPngDataUrl(function (err, dataUrl) {\n' +
'      if (err) { setStatus("PNG export failed: " + (err.message || err), "err"); return; }\n' +
'      // Convert dataUrl to blob\n' +
'      var byteString = atob(dataUrl.split(",")[1]);\n' +
'      var ab = new ArrayBuffer(byteString.length);\n' +
'      var ia = new Uint8Array(ab);\n' +
'      for (var i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);\n' +
'      downloadBlob(new Blob([ab], {type: "image/png"}), "sankey-" + Date.now() + ".png");\n' +
'    });\n' +
'  }\n' +

'  // Google Sheets insertImage caps at 1,000,000 pixels AND 2MB blob.\n' +
'  // Default to a width of 1280 → height scales proportionally from the canvas aspect ratio,\n' +
'  // and a guard rail caps total pixels under the limit by shrinking if necessary.\n' +
'  var SHEETS_MAX_PIXELS = 1000000;\n' +
'  function computeSheetDims(s) {\n' +
'    var aspect = (s.canvasHeight && s.canvasWidth) ? (s.canvasHeight / s.canvasWidth) : (1080 / 1920);\n' +
'    var w = Math.max(100, parseInt(s.sheetWidth, 10) || 1280);\n' +
'    var h = Math.max(50, Math.round(w * aspect));\n' +
'    if (w * h > SHEETS_MAX_PIXELS) {\n' +
'      var scale = Math.sqrt(SHEETS_MAX_PIXELS / (w * h));\n' +
'      w = Math.floor(w * scale);\n' +
'      h = Math.floor(h * scale);\n' +
'    }\n' +
'    return {width: w, height: h};\n' +
'  }\n' +

'  function saveToSheet() {\n' +
'    var s = readSettings();\n' +
'    var dims = computeSheetDims(s);\n' +
'    setStatus("Rendering PNG at " + dims.width + "×" + dims.height + " (" + (dims.width * dims.height).toLocaleString() + " px)…", "");\n' +
'    svgToPngDataUrl({width: dims.width, height: dims.height}, function (err, dataUrl) {\n' +
'      if (err) { setStatus("PNG render failed: " + (err.message || err), "err"); return; }\n' +
'      // Rough size check before uploading; we cannot easily measure the encoded PNG bytes here\n' +
'      // but pixel count is enforced above so we should be under both 1M-px and 2MB limits.\n' +
'      setStatus("Uploading to sheet…", "");\n' +
'      google.script.run\n' +
'        .withSuccessHandler(function (msg) { setStatus(msg, "ok"); })\n' +
'        .withFailureHandler(function (e) { setStatus("Save failed: " + (e && e.message ? e.message : e), "err"); })\n' +
'        .saveSankeyImageToSheet(dataUrl);\n' +
'    });\n' +
'  }\n' +

'  // ---------- Reset ----------\n' +
'  function resetSettings() {\n' +
'    $("precision").value = 1;\n' +
'    $("hidezeros").checked = true;\n' +
'    $("separators").checked = true;\n' +
'    $("prefix").value = "$";\n' +
'    $("suffix").value = "";\n' +
'    $("hidenumbers").checked = true;\n' +
'    $("colorscheme").value = "default";\n' +
'    $("flow-opacity").value = 50;\n' +
'    $("firstword").checked = false;\n' +
'    $("colornodes").checked = true;\n' +
'    $("nodewidth").value = 250;\n' +
'    $("nodepadding").value = 20;\n' +
'    $("labelplacement").value = "inside";\n' +
'    $("labelbg").value = 0;\n' +
'    $("sortbyline").checked = true;\n' +
'    $("canvaswidth").value = 1920;\n' +
'    $("canvasheight").value = 1080;\n' +
'    $("fontsize").value = 24;\n' +
'    $("nodealign").value = "justify";\n' +
'    $("sheetwidth").value = 1280;\n' +
'    render();\n' +
'  }\n' +

'  // ---------- Wire up ----------\n' +
'  $("render-btn").addEventListener("click", render);\n' +
'  $("reset-btn").addEventListener("click", resetSettings);\n' +
'  $("dl-svg").addEventListener("click", exportSvgFile);\n' +
'  $("dl-png").addEventListener("click", exportPngFile);\n' +
'  $("save-sheet").addEventListener("click", saveToSheet);\n' +

'  // Live re-render on any settings change. sheetwidth is excluded — it only affects save-to-sheet output.\n' +
'  var watched = ["precision","hidezeros","separators","prefix","suffix","hidenumbers",\n' +
'    "colorscheme","flow-opacity","firstword","colornodes","nodewidth","nodepadding",\n' +
'    "labelplacement","labelbg","sortbyline","canvaswidth","canvasheight","fontsize","nodealign"];\n' +
'  watched.forEach(function (id) {\n' +
'    var el = $(id);\n' +
'    if (!el) return;\n' +
'    var evt = (el.type === "checkbox" || el.tagName === "SELECT") ? "change" : "input";\n' +
'    el.addEventListener(evt, render);\n' +
'  });\n' +

'  // First render once libraries are available\n' +
'  if (typeof d3 === "undefined" || typeof d3.sankey === "undefined") {\n' +
'    setStatus("Waiting for libraries to load…", "");\n' +
'    var tries = 0;\n' +
'    var iv = setInterval(function () {\n' +
'      tries++;\n' +
'      if (typeof d3 !== "undefined" && typeof d3.sankey !== "undefined") {\n' +
'        clearInterval(iv); render();\n' +
'      } else if (tries > 50) {\n' +
'        clearInterval(iv);\n' +
'        setStatus("Failed to load d3 / d3-sankey from CDN. Check your network.", "err");\n' +
'      }\n' +
'    }, 100);\n' +
'  } else {\n' +
'    render();\n' +
'  }\n' +
'})();\n' +
'</script>\n' +
'</body>\n' +
'</html>\n';
}
