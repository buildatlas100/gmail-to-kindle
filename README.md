# Gmail to Kindle

A Google Apps Script that watches Gmail for a `Kindle` label, converts each labeled email into a clean PDF, and emails it to your Kindle's Personal Documents address. Runs hourly, fully inside your Google account, with no external server.

## What it does

1. Every hour, scans Gmail for messages tagged with the `Kindle` label.
2. Strips out newsletter cruft (tracking pixels, hidden elements, table layout, inline styles, scripts).
3. Builds a readable PDF via Google Docs with tight margins and a larger body font.
4. Sends the PDF as an attachment to your Kindle's `@kindle.com` address.
5. Re-tags the thread with `Sent to Kindle` so it isn't re-processed.

## Why it exists

Most "send newsletter to Kindle" tools forward the email raw. HTML newsletters render poorly that way (or get rejected by Amazon). This script does the conversion server-side so what arrives on your Kindle is a clean, readable PDF.

It also works around a subtle bug: Google Apps Script's `GmailApp.sendEmail()` produces a MIME structure that Amazon's Send-to-Kindle parser rejects with `E009 - No Attachment`, even though Gmail's UI shows the attachment correctly. This script hand-builds the MIME message and POSTs it to the Gmail REST API instead, which works reliably.

## Setup

You'll need a Gmail/Google account, a Kindle, and about 10 minutes.

### 1. Find your Kindle's Personal Documents email

Go to [Amazon → Manage Your Content and Devices → Preferences → Personal Document Settings](https://www.amazon.com/hz/mycd/myx#/home/settings/payment). Look for your device's Send-to-Kindle email. It looks like `yourname_abc12@kindle.com`.

### 2. Approve your Gmail address as a sender

On that same page, under **Approved Personal Document E-mail List**, add the Gmail address you'll be sending from (e.g., `you@gmail.com`). Amazon refuses documents from unapproved senders.

### 3. Create the Apps Script project

- Go to [script.google.com](https://script.google.com) and click **New Project**.
- Delete the default `myFunction()` stub and paste in the contents of [`Code.gs`](./Code.gs).
- At the top of the file, replace `YOUR_KINDLE_EMAIL@kindle.com` with the address from step 1.
- Save the project (⌘S / Ctrl+S) and give it a name.

### 4. Enable required Google services

In the left sidebar of the Apps Script editor, click **Services**, then **+ Add a service**, and add both:

- **Drive API** (identifier `Drive`, the version offered)
- **Gmail API** (identifier `Gmail`, the version offered)

You don't need to call them directly in the code — adding them as advanced services enables the underlying APIs on the project, which the script needs.

### 5. Install the hourly trigger

In the function dropdown (top toolbar), select **`setup`** and click **▶ Run**. You'll be prompted to authorize the script — approve the requested permissions (Gmail, Drive, Docs, external requests).

This step:
- Creates an hourly trigger that runs `sendToKindle`
- Creates the `Kindle` label in Gmail if it doesn't already exist

### 6. Try it

In Gmail, apply the `Kindle` label to any newsletter or article-style email. Within an hour, it'll arrive on your Kindle.

To test immediately, select the **`sendToKindle`** function in the dropdown and click **▶ Run**. Check the **Execution log** for `Sent PDF to Kindle (...)` confirmation.

## Tuning the output

These constants near the top of `Code.gs` control the PDF formatting:

| Constant | Default | What it does |
|---|---|---|
| `KINDLE_FONT_SIZE` | `14` | Body text size in points |
| `KINDLE_PAGE_MARGIN` | `14` | Page margin in points (`14pt` ≈ 0.2") |
| `DOC_READY_POLL_MS` | `2000` | How often to poll for the Google Doc to finish rendering |
| `DOC_READY_MAX_TRIES` | `10` | How long to wait total (default = 20s) before giving up |

If text feels too small on your Kindle, bump `KINDLE_FONT_SIZE` to `16` or `18`. If margins still feel wide, drop `KINDLE_PAGE_MARGIN` to `7` (≈ 0.1").

## Troubleshooting

**"E009 - No Attachment" from Amazon**
The sender Gmail address isn't on Amazon's Approved Personal Document E-mail List. Add it (step 2).

**"Gmail API has not been used in project..." (403)**
The Gmail advanced service hasn't been added in step 4. Add it.

**"Drive.Files.insert is not a function"**
The Drive advanced service hasn't been added in step 4. Add it.

**Script says "Completed" but nothing happens**
The `Kindle` label is probably empty, or the labeled threads were already moved to `Sent to Kindle`. Apply the `Kindle` label to a fresh thread and re-run.

**PDF arrives empty**
Bump `DOC_READY_MAX_TRIES` higher — the HTML-to-Doc conversion is racing the PDF export.

## How it works

```
Gmail [label:Kindle] ──► hourly trigger ──► sendToKindle()
                                                │
                                                ├─► strip HTML cruft
                                                ├─► HTML → Google Doc (Drive API)
                                                ├─► poll until Doc is rendered
                                                ├─► apply Kindle margins/font (Docs API)
                                                ├─► export as PDF
                                                ├─► hand-build MIME multipart/mixed
                                                ├─► POST to gmail.googleapis.com
                                                └─► relabel thread as "Sent to Kindle"
                                                                       │
                                                                       ▼
                                                          your Kindle, ~2 minutes later
```

## License

MIT — see [LICENSE](./LICENSE).
