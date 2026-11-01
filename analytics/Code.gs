/**
 * SA1 map usage log: Google Apps Script web app bound to a Google Sheet.
 *
 * The map page POSTs a small JSON body on every page load ("view") and every
 * print ("print"); each becomes one row on the "Log" sheet. Nothing personal is
 * sent beyond the optional name the organiser types in the sidebar; PINs are
 * never sent.
 *
 * Setup (once):
 *   1. New Google Sheet  ->  Extensions  ->  Apps Script.
 *   2. Replace the default code with this file and save.
 *   3. Deploy  ->  New deployment  ->  type "Web app",
 *      Execute as: Me,  Who has access: Anyone.  ->  Deploy, authorise.
 *   4. Copy the Web app URL (ends in /exec) into LOG_URL in app.js.
 *   Any later code change needs Deploy -> Manage deployments -> edit -> New version.
 */

var SHEET_NAME = 'Log';
var HEADERS = ['timestamp', 'event', 'name', 'sa1_count', 'sa1s', 'seat', 'suburb', 'page'];

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { body = {}; }
  append_(body);
  return ContentService.createTextOutput('ok');
}

// Lets you check the deployment in a browser tab: .../exec?event=test
function doGet(e) {
  append_(e.parameter || {});
  return ContentService.createTextOutput('ok');
}

function append_(b) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);   // many organisers printing at once must not clobber rows
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
    }
    // Format the row as text BEFORE writing it. appendRow would parse the values like
    // typing: "21203130422,21203130423" becomes a huge number and a name starting
    // with "=" becomes a formula.
    var row = sheet.getLastRow() + 1;
    var range = sheet.getRange(row, 1, 1, HEADERS.length);
    range.setNumberFormats([['yyyy-mm-dd hh:mm:ss', '@', '@', '0', '@', '@', '@', '@']]);
    range.setValues([[
      new Date(),
      text_(b.event, 20),
      text_(b.name, 80),
      Number(b.sa1_count) || 0,
      text_(b.sa1s, 5000),   // space-separated 11-digit codes; a whole seat fits
      text_(b.seat, 60),
      text_(b.suburb, 60),
      text_(b.page, 200)
    ]]);
  } finally {
    lock.releaseLock();
  }
}

// A value starting with = + - or @ would be stored as a formula even in a text-formatted
// cell (setValues parses formulas), so strip those characters off the front.
function text_(v, max) {
  return String(v || '').replace(/^[=+\-@]+/, '').slice(0, max);
}
