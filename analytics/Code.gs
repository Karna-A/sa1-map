/**
 * SA1 map usage log: Google Apps Script web app bound to a Google Sheet.
 *
 * The map page POSTs a small JSON body on every page load ("view") and every
 * print ("print"); each becomes one row on the "Log" sheet. Nothing personal is
 * sent beyond the optional name the organiser types in the sidebar; PINs are
 * never sent.
 *
 * The /exec URL is public (it is in the page), so anyone can post to it. This
 * script therefore (a) only accepts rows shaped exactly like the page's own
 * payload, (b) never blocks for long on the sheet lock, (c) stops appending past
 * a row cap, and (d) never writes anything that could become a formula. Treat
 * the log as advisory: a determined forger can still post well-formed rows.
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
var SITE = 'https://karna-a.github.io/sa1-map/';   // the only page allowed to log
var MAX_ROWS = 200000;                              // stop appending past this (keeps the sheet usable)
var CODES_RE = /^(\d{11}( \d{11})*)?$/;             // space-separated 11-digit SA1 codes

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { body = {}; }
  if (valid_(body)) append_(body);
  return ContentService.createTextOutput('ok');
}

// GET only confirms the deployment is alive; it never writes a row.
function doGet() {
  return ContentService.createTextOutput('ok');
}

// Accept only what the page itself sends; anything else is dropped silently.
function valid_(b) {
  if (b.event !== 'view' && b.event !== 'print') return false;
  if (b.page !== SITE) return false;
  var codes = String(b.sa1s || '');
  if (codes.length > 5000 || !CODES_RE.test(codes)) return false;
  var n = codes ? codes.split(' ').length : 0;
  if (Number(b.sa1_count) !== n) return false;
  return true;
}

function append_(b) {
  var lock = LockService.getScriptLock();
  // A short tryLock rather than a long waitLock: under a flood we drop rows instead
  // of holding one of the account's 30 concurrent-execution slots for 10 seconds each.
  if (!lock.tryLock(2000)) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
    }
    var row = sheet.getLastRow() + 1;
    if (row > MAX_ROWS) return;
    // Format the row as text BEFORE writing it so "007" stays "007" and nothing is
    // parsed as a number or date.
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

// A value starting with = + - or @ (after any whitespace) would be stored as a formula
// even in a text-formatted cell, and would trigger Excel DDE if the sheet is exported
// as CSV, so strip those characters off the front.
function text_(v, max) {
  return String(v || '').replace(/^[\s=+\-@]+/, '').slice(0, max);
}
