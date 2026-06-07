# Develop webapp linked to Finance spreadsheet

## Goal
Develop a webapp that is connected to the finance google sheet and allows me to edit the spreadsheet through a realtime I/O interface with the spreadsheet for entries in the PayrollSankey sheet. It should show the present state of Sankey diagram at the top of the webpage.

## Layout

* First Panle is the Sankey diagram output
* Second Panel is collapsed by default. It is te Sankey Settings.
* Third Panel is collapsed by default as well, it is the input/readback panel for PayrollSankey sheet in the Finance gsheet.
* Within the thir panel are several sub panels distributed in a single column. Each sub panel is for a 3 set of columnds from the default range of Sankey Diagram in SankeyRenderer.gs
 * Example: Input | Monthly Gross Income | Output are A, B, C columns.
 * In each sub subapanel the web app should show three columns that correspond to the input (String), central column which is the value, and output (String)
 * For Inputs, show dropdown option for values read from previous set's outputs combined with all already written values in the column from the spreadsheet.
 * For Value, take numerical entry.
 * For outputs, show dropdown option for values read from next set's inputs combined with all already written values in the column from the spreadsheet.
 * Nominally, show the values from reading back from existing gsheet
 * Give a + row option at the bottom of each subpanel to add additional rows
 * Next to each row in a subpanel, give a red cross option to delete that row
* Nominally all panels and subpanels remain collapsed.
* Make the webapp so that it opens in correct aspect ratio on a mobile phone and a correct aspect ratio on a computer
* All changes int eh inputs would result in realtime changes in the sankey diagram shown
* At the bottom of the page, give options to export vector scalable pdf or png of the sankey diagram.

## Code structure

* Code will be a google appscript that I will upload in my accounts scripts.google.com and deploy that projec tot get a web url. I'll use that web url to securely log in and see this info and plot my sankey diagrams from any device.
* For each subpanel, use a uniform single function with appropriate arguments. This way, make the app completely modular so that if in future more levels are added (more sets of 3 columns in the google sheet, it is easily expandable by just calling the function again, infact we can proabnbly add a "Add new level" option at the bottom of all subpanels that can be scrolled anywhere in beteen after creation, and can be sued to create new levels in the sankey diagram, but this is the bonus goal, in foundational work we just want to elave the possibility of this future expansion.)
* Write all instructions on what to open, where to add the script, with apprscripts.json file to make sure all settings are correct etc. and all steps to make sure the spreadsheet is avaiable by the GAS.

## Deploymnet use case

* Personally would just use the web url deployment link to open my sankey diagram case.
* In future, I might want to create a webapp available on my webpage for anyone to simply import into their own scripts.google.com and they just give it the spreadsheet id and create teh structure from the webapp itself, for whatever, not just payroll. So this version of the scriot would have to be completely scrubeed from any data pertaining to my usecase and would ba e generic web based sankey diagram creator and maintainer app.