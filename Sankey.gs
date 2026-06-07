/**
 * Sankey Diagram Converter for Google Sheets
 * Converts spreadsheet data to sankeydiagram.net format
 */

/**
 * Creates custom menu when spreadsheet opens
 */
// function onOpen() {
//   const ui = SpreadsheetApp.getUi();
//   ui.createMenu('Sankey Converter')
//     .addItem('Convert Selected Range', 'convertSelectedRange')
//     .addItem('Convert D1:O38', 'convertPresetRange')
//     .addItem('Convert Custom Range', 'convertCustomRange')
//     .addSeparator()
//     .addItem('Help', 'showHelp')
//     .addToUi();
// }

/**
 * Converts the currently selected range to Sankey format
 */
function convertSelectedRange() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getActiveRange();
  
  if (!range) {
    SpreadsheetApp.getUi().alert('Please select a range first.');
    return;
  }
  
  const data = range.getValues();
  const sankeyFormat = convertToSankeyFormat(data);
  showResult(sankeyFormat, `Selected Range: ${range.getA1Notation()}`);
}

/**
 * Converts preset range D1:O38 to Sankey format
 */
function convertPresetRange() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getRange('D1:O38');
  const data = range.getValues();
  const sankeyFormat = convertToSankeyFormat(data);
  showResult(sankeyFormat, 'Range: D1:O38');
}

/**
 * Prompts user for custom range and converts it
 */
function convertCustomRange() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Enter Range', 'Please enter the range (e.g., C1:L38):', ui.ButtonSet.OK_CANCEL);
  
  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }
  
  const rangeString = response.getResponseText();
  if (!rangeString) {
    ui.alert('Please enter a valid range.');
    return;
  }
  
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const range = sheet.getRange(rangeString);
    const data = range.getValues();
    const sankeyFormat = convertToSankeyFormat(data);
    showResult(sankeyFormat, `Range: ${rangeString}`);
  } catch (error) {
    ui.alert('Error: Invalid range format. Please use format like D1:O38');
  }
}

/**
 * Converts spreadsheet data to Sankey diagram format
 * @param {Array} data - 2D array of spreadsheet values
 * @return {string} - Formatted Sankey diagram input
 */
function convertToSankeyFormat(data) {
  let sankeyLines = [];
  
  // Determine number of column sets (groups of 3)
  const maxColumns = Math.max(...data.map(row => row.length));
  const numSets = Math.floor(maxColumns / 3);
  
  // Process each set of 3 columns separately
  for (let setIndex = 0; setIndex < numSets; setIndex++) {
    const setFlows = [];
    const colStart = setIndex * 3;
    
    // Process all rows for this set
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      
      // Skip completely empty rows
      if (row.every(cell => !cell)) continue;
      
      const source = cleanText(row[colStart]);
      const value = cleanValue(row[colStart + 1]);
      const target = cleanText(row[colStart + 2]);
      
      // Only create flow if we have all three components and value is not 0
      if (source && target && value && value !== '0') {
        setFlows.push(`${source}    [${value}]    ${target}`);
      }
    }
    
    // Remove duplicates within this set while preserving order
    const uniqueSetFlows = [];
    const seen = new Set();
    
    setFlows.forEach(flow => {
      if (!seen.has(flow)) {
        seen.add(flow);
        uniqueSetFlows.push(flow);
      }
    });
    
    // Add this set's flows to the main output
    if (uniqueSetFlows.length > 0) {
      if (sankeyLines.length > 0) {
        sankeyLines.push(''); // Add blank line between sets
      }
      sankeyLines = sankeyLines.concat(uniqueSetFlows);
    }
  }
  
  return sankeyLines.join('\n');
}



/**
 * Clean and format text values
 */
function cleanText(value) {
  if (!value) return '';
  return value.toString().trim().replace(/\t/g, '    ');
}

/**
 * Clean and format numeric values
 */
function cleanValue(value) {
  if (!value) return '0';
  
  let cleanValue = value.toString()
    .replace(/[$,]/g, '')  // Remove $ and commas
    .replace(/\t/g, '    ') // Replace tabs with 4 spaces
    .trim();
  
  // Convert to number and round to whole number
  const numValue = parseFloat(cleanValue);
  if (isNaN(numValue)) return '0';
  
  return Math.round(numValue).toString();
}

/**
 * Shows the conversion result in a dialog
 */
function showResult(result, title) {
  const ui = SpreadsheetApp.getUi();
  
  // Create HTML dialog with copy functionality
  const htmlOutput = HtmlService.createHtmlOutput(`
    <div style="font-family: monospace; font-size: 12px; padding: 10px;">
      <h3>${title}</h3>
      <p><strong>Instructions:</strong></p>
      <ol>
        <li>Click "Copy to Clipboard" button below</li>
        <li>Go to <a href="https://sankeydiagram.net/" target="_blank">sankeydiagram.net</a></li>
        <li>Paste the text into the input area</li>
        <li>Click "Generate" to create your Sankey diagram</li>
      </ol>
      <hr>
      <div style="margin: 10px 0;">
        <button onclick="copyToClipboard()" style="background-color: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px;">📋 Copy to Clipboard</button>
        <button onclick="google.script.host.close()" style="background-color: #f44336; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer;">Close</button>
        <span id="copyStatus" style="margin-left: 15px; color: green; font-weight: bold;"></span>
      </div>
      <textarea id="sankeyText" style="width: 100%; height: 400px; font-family: monospace; font-size: 11px;" readonly>${result}</textarea>
      
      <script>
        function copyToClipboard() {
          const textArea = document.getElementById('sankeyText');
          const statusSpan = document.getElementById('copyStatus');
          
          try {
            // Select the text
            textArea.select();
            textArea.setSelectionRange(0, 99999); // For mobile devices
            
            // Copy the text
            document.execCommand('copy');
            
            // Show success message
            statusSpan.textContent = '✓ Copied to clipboard!';
            statusSpan.style.color = 'green';
            
            // Clear success message after 3 seconds
            setTimeout(() => {
              statusSpan.textContent = '';
            }, 3000);
            
          } catch (err) {
            // Fallback - show manual copy instruction
            statusSpan.textContent = '⚠ Please select all text and copy manually (Ctrl+C)';
            statusSpan.style.color = 'orange';
            textArea.select();
            
            setTimeout(() => {
              statusSpan.textContent = '';
            }, 5000);
          }
        }
        
        // Also allow double-click to select all text
        document.getElementById('sankeyText').addEventListener('dblclick', function() {
          this.select();
        });
      </script>
    </div>
  `).setWidth(700).setHeight(650);
  
  ui.showModalDialog(htmlOutput, 'Sankey Diagram Data');
}

/**
 * Shows help information
 */
function showHelp() {
  const ui = SpreadsheetApp.getUi();
  
  const helpText = `
SANKEY CONVERTER HELP

This tool converts your spreadsheet data into a format compatible with sankeydiagram.net.

MENU OPTIONS:
• Convert Selected Range: Converts whatever range you have selected
• Convert D1:O38: Converts the preset range D1:O38
• Convert Custom Range: Prompts you to enter a specific range

EXPECTED DATA FORMAT:
Your data should be organized in groups of 3 columns:
Column 1: Source | Column 2: Value | Column 3: Target

The tool will:
• Process every group of 3 columns as Source → Value → Target
• Remove dollar signs and commas from values
• Round all values to whole numbers
• Replace tabs with 4 spaces
• Skip rows/flows with zero or empty values
• Format output as: SOURCE    [VALUE]    TARGET

USAGE:
1. Organize your data in triplets of columns (Source, Value, Target)
2. Select your data range or use menu options
3. Copy the generated text from the dialog
4. Go to sankeydiagram.net
5. Paste the text and click Generate

The tool is completely generic - it will process any data that follows
the 3-column pattern, making it work with new rows and values automatically.
  `;
  
  ui.alert('Sankey Converter Help', helpText, ui.ButtonSet.OK);
}