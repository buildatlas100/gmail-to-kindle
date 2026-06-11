// Gmail to Kindle - Google Apps Script
//
// Watches Gmail for a "Kindle" label, converts each labeled email into a
// clean PDF via Google Docs, and sends the PDF to your Kindle's Personal
// Documents email address using the Gmail REST API.
//
// Setup: see README.md.

// === CONFIG ===========================================================
// Replace with your Kindle's Personal Documents email
// (Amazon -> Manage Your Content and Devices -> Preferences -> Personal
//  Document Settings). Example: yourname_abc12@kindle.com
var KINDLE_EMAIL = "YOUR_KINDLE_EMAIL@kindle.com";

// Gmail label the script watches. Apply this label to any message you
// want sent to your Kindle.
var LABEL_TO_WATCH = "Kindle";

// Gmail label applied after a message has been sent successfully.
var LABEL_DONE = "Sent to Kindle";

// === TUNABLES =========================================================
var DOC_READY_POLL_MS = 2000;   // how often to check if the Google Doc rendered
var DOC_READY_MAX_TRIES = 10;   // give up after this many polls
var MIN_PDF_BYTES = 1000;       // sanity check: PDFs smaller than this are rejected
var KINDLE_FONT_SIZE = 14;      // body text size in the output PDF (points)
var KINDLE_PAGE_MARGIN = 14;    // page margin in points (14pt ~= 0.2 inch)
// ======================================================================

function sendToKindle() {
  var watchLabel = GmailApp.getUserLabelByName(LABEL_TO_WATCH);
  if (!watchLabel) {
    Logger.log("No '" + LABEL_TO_WATCH + "' label found. Run setup() first.");
    return;
  }

  var doneLabel = GmailApp.getUserLabelByName(LABEL_DONE);
  if (!doneLabel) {
    doneLabel = GmailApp.createLabel(LABEL_DONE);
  }

  var threads = watchLabel.getThreads(0, 10);
  if (threads.length === 0) {
    Logger.log("No new emails to send.");
    return;
  }

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var message = messages[messages.length - 1];

    var subject = message.getSubject() || "Newsletter";
    var from = message.getFrom();
    var date = message.getDate();
    var body = message.getBody();

    var tempDocId = null;

    try {
      // 1. Strip newsletter cruft and build a readable HTML document
      var cleanHtml = buildReadableHtml(subject, from, date, body);

      // 2. Create a Google Doc from the HTML (Drive API v2)
      var htmlBlob = Utilities.newBlob(cleanHtml, "text/html", "temp.html");
      var tempDoc = Drive.Files.insert(
        { title: subject, mimeType: "application/vnd.google-apps.document" },
        htmlBlob
      );
      tempDocId = tempDoc.id;

      // 3. Wait until the Doc's body is actually rendered. The HTML-to-Doc
      //    conversion is async; exporting too early gives an empty PDF.
      if (!waitForDocReady(tempDocId)) {
        throw new Error("Doc never rendered content after " +
          (DOC_READY_POLL_MS * DOC_READY_MAX_TRIES / 1000) + "s");
      }

      // 4. Tighten margins and bump font size for Kindle readability
      applyKindleFormatting(tempDocId);

      // 5. Export the Doc as PDF
      var pdfBlob = DriveApp.getFileById(tempDocId).getAs("application/pdf");
      var pdfBytes = pdfBlob.getBytes();

      if (pdfBytes.length < MIN_PDF_BYTES) {
        throw new Error("PDF too small (" + pdfBytes.length + " bytes)");
      }

      var fileName = sanitizeFileName(subject) + ".pdf";

      // 6. Send via raw Gmail REST API. GmailApp.sendEmail produces a MIME
      //    structure that Amazon's Send-to-Kindle parser rejects with
      //    "E009 - No Attachment", even though Gmail itself shows the
      //    attachment fine. Hand-built MIME with an explicit
      //    Content-Disposition: attachment works.
      sendRawWithAttachment(KINDLE_EMAIL, subject, pdfBytes, fileName);

      // 7. Swap labels
      thread.removeLabel(watchLabel);
      thread.addLabel(doneLabel);

      Logger.log("Sent PDF to Kindle (" + pdfBytes.length + " bytes): " + subject);

    } catch (e) {
      Logger.log("ERROR processing '" + subject + "': " + e.toString());
    } finally {
      if (tempDocId) {
        try {
          DriveApp.getFileById(tempDocId).setTrashed(true);
        } catch (cleanupErr) {
          Logger.log("Cleanup warning for '" + subject + "': " + cleanupErr.toString());
        }
      }
    }
  }
}

// Hand-builds a multipart/mixed MIME message and POSTs it to the Gmail
// REST API. The explicit Content-Disposition: attachment header is what
// the Send-to-Kindle service requires.
function sendRawWithAttachment(to, subject, pdfBytes, fileName) {
  var boundary = "kindle_boundary_" + Utilities.getUuid();

  // Base64-encode the PDF and wrap at 76 chars per line (RFC 2045)
  var pdfBase64 = Utilities.base64Encode(pdfBytes);
  var pdfBase64Wrapped = pdfBase64.replace(/.{76}/g, "$&\r\n");

  var encodedSubject = encodeMimeHeader(subject);
  var encodedFileName = encodeMimeHeader(fileName);

  var mime = [
    "MIME-Version: 1.0",
    "To: " + to,
    "Subject: " + encodedSubject,
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    "",
    "--" + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    "",
    "--" + boundary,
    'Content-Type: application/pdf; name="' + encodedFileName + '"',
    'Content-Disposition: attachment; filename="' + encodedFileName + '"',
    "Content-Transfer-Encoding: base64",
    "",
    pdfBase64Wrapped,
    "--" + boundary + "--"
  ].join("\r\n");

  // Gmail API requires the raw message base64url-encoded
  var raw = Utilities.base64EncodeWebSafe(mime);

  var response = UrlFetchApp.fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "post",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      contentType: "application/json",
      payload: JSON.stringify({ raw: raw }),
      muteHttpExceptions: true
    }
  );

  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Gmail API send failed (" + code + "): " + response.getContentText());
  }
}

// Minimal RFC 2047 encoding for header values containing non-ASCII or
// quote characters. Plain ASCII passes through unchanged.
function encodeMimeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value) && value.indexOf('"') === -1) {
    return value;
  }
  return "=?UTF-8?B?" + Utilities.base64Encode(value, Utilities.Charset.UTF_8) + "?=";
}

// Reduces page margins and forces a larger body font so the PDF is
// readable on a Kindle. Google Docs imports HTML with 1-inch margins and
// 11pt text by default; both are too small for an e-reader.
// 1 inch = 72 points.
function applyKindleFormatting(docId) {
  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();

  body.setMarginTop(KINDLE_PAGE_MARGIN);
  body.setMarginBottom(KINDLE_PAGE_MARGIN);
  body.setMarginLeft(KINDLE_PAGE_MARGIN);
  body.setMarginRight(KINDLE_PAGE_MARGIN);

  var paragraphs = body.getParagraphs();
  for (var i = 0; i < paragraphs.length; i++) {
    var text = paragraphs[i].editAsText();
    if (text.getText().length > 0) {
      // Leave headings alone so they stay proportionally larger
      if (paragraphs[i].getHeading() === DocumentApp.ParagraphHeading.NORMAL) {
        text.setFontSize(KINDLE_FONT_SIZE);
      }
    }
  }

  doc.saveAndClose();
}

// Polls until the Google Doc has rendered body content (or times out).
function waitForDocReady(docId) {
  for (var i = 0; i < DOC_READY_MAX_TRIES; i++) {
    Utilities.sleep(DOC_READY_POLL_MS);
    try {
      var doc = DocumentApp.openById(docId);
      var text = doc.getBody().getText();
      if (text && text.length > 100) {
        return true;
      }
    } catch (e) {
      // Doc may not be readable yet - keep polling
    }
  }
  return false;
}

// Strips scripts, tracking pixels, style blocks, table layout, and inline
// attributes from the email HTML, then wraps the result in a clean
// document with a small header (subject, sender, date).
function buildReadableHtml(subject, from, date, bodyHtml) {
  var cleaned = bodyHtml;

  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.replace(/<[^>]+display\s*:\s*none[^>]*>[\s\S]*?<\/[^>]+>/gi, "");
  cleaned = cleaned.replace(/<img[^>]+(width\s*=\s*["']?1["']?\s*height\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?\s*width\s*=\s*["']?1["']?)[^>]*\/?>/gi, "");

  // Flatten table structure but keep cell content
  cleaned = cleaned.replace(/<\/?table[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?tbody[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?thead[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?tfoot[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?tr[^>]*>/gi, "");
  cleaned = cleaned.replace(/<td[^>]*>/gi, "<div>");
  cleaned = cleaned.replace(/<\/td>/gi, "</div>");
  cleaned = cleaned.replace(/<th[^>]*>/gi, "<div><strong>");
  cleaned = cleaned.replace(/<\/th>/gi, "</strong></div>");

  cleaned = cleaned.replace(/\s*style\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*style\s*=\s*'[^']*'/gi, "");
  cleaned = cleaned.replace(/\s*class\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*class\s*=\s*'[^']*'/gi, "");
  cleaned = cleaned.replace(/\s*id\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*cellpadding\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*cellspacing\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*bgcolor\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*align\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*valign\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*border\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*role\s*=\s*"[^"]*"/gi, "");

  cleaned = cleaned.replace(/<img\s([^>]*)>/gi, function(match) {
    var srcMatch = match.match(/src\s*=\s*["']([^"']+)["']/i);
    var altMatch = match.match(/alt\s*=\s*["']([^"']+)["']/i);
    if (srcMatch) {
      var alt = altMatch ? altMatch[1] : "";
      return '<img src="' + srcMatch[1] + '" alt="' + alt + '" style="max-width:100%;height:auto;">';
    }
    return "";
  });

  cleaned = cleaned.replace(/<div>\s*<\/div>/gi, "");
  cleaned = cleaned.replace(/<span>\s*<\/span>/gi, "");
  cleaned = cleaned.replace(/<p>\s*<\/p>/gi, "");
  cleaned = cleaned.replace(/\s*width\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*height\s*=\s*"[^"]*"/gi, "");

  var html = '<!DOCTYPE html>\n<html>\n<head>\n';
  html += '<meta charset="utf-8">\n';
  html += '<title>' + escapeHtml(subject) + '</title>\n';
  html += '<style>\n';
  html += '  body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.6; margin: 40px; color: #222; }\n';
  html += '  h1 { font-size: 18pt; margin-bottom: 2px; }\n';
  html += '  .meta { color: #888; font-size: 10pt; margin-bottom: 16px; }\n';
  html += '  hr { border: none; border-top: 1px solid #ccc; margin: 16px 0; }\n';
  html += '  img { max-width: 100%; height: auto; display: block; margin: 12px 0; }\n';
  html += '  a { color: #222; text-decoration: underline; }\n';
  html += '  div { margin: 0; padding: 0; }\n';
  html += '</style>\n';
  html += '</head>\n<body>\n';
  html += '<h1>' + escapeHtml(subject) + '</h1>\n';
  html += '<p class="meta">' + escapeHtml(from) + ' | ' + date.toLocaleDateString() + '</p>\n';
  html += '<hr>\n';
  html += cleaned;
  html += '\n</body>\n</html>';

  return html;
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9 \-_]/g, "").substring(0, 80).trim();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Run this once after pasting the script in. Creates the "Kindle" label
// if it doesn't exist and installs an hourly trigger to run sendToKindle.
function setup() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "sendToKindle") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger("sendToKindle")
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log("Hourly trigger created.");

  var label = GmailApp.getUserLabelByName(LABEL_TO_WATCH);
  if (!label) {
    GmailApp.createLabel(LABEL_TO_WATCH);
    Logger.log("Created '" + LABEL_TO_WATCH + "' label in Gmail.");
  }
}
