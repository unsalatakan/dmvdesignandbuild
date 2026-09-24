# DMV Design and Build — Project Portal

A self-contained web portal for managing commercial construction projects. No installation of packages needed — only [Node.js](https://nodejs.org) 18 or newer.

## Run it

```
node server.js
```

Then open **http://localhost:3000** in your browser.

- **Admin login:** use your admin credentials (change the default password after first login via the sidebar)
- Customers log in on the same page with the accounts you create on the **Customers** page.

## What it does

- **Home** — dashboard with job count, **Payments Due** (everything unpaid across all jobs, with a table of which job owes what and when), total contract value, materials still to order, and a map of all jobs. Click the map to expand it full-page; click a pin to open that job.
- **Receipts** — a tab for capturing receipts on site without stopping to pick a job. Snap several, upload the batch, and each one is read automatically. They sit in the inbox with editable fields until you choose a job and hit **File to Job**, which moves it into that job's invoices with the file attached. Anything the scanner couldn't read is kept anyway, just blank, so a receipt is never lost.
- **Documents** — a per-job file drawer for permits, inspection reports, warranties, correspondence, anything else. Upload several at once (PDF, Word, Excel, CSV, text or images). Each document has a **Shared / Internal** toggle: internal by default, flip it and the customer sees it on their own view of the job. Files open in place, no new tab. Admin, project managers and delivery can all upload.
- **Invoices & Job Costs** — on each job, log what you're spending: description, cost, who it was paid to, the date, and optionally the invoice PDF (attach it later if you don't have it yet). The table totals at the bottom, and the panel shows Contract Price / Total Invoiced / Profit So Far. "Paid To" suggests subs and suppliers you've already used on that job. Attach a Home Depot receipt and it can fill the fields in for you — see **Receipt scanning** below. Internal only — customers never see invoices or their files.
- **To-Do** — the home page panel now carries a **General** list at the top for anything not tied to a job (licenses, insurance, calls to make), plus the per-job notes underneath. General items are admin-only; project managers still see job notes. Type in the box and press Enter to add.
- **Payment schedule** — on any job, type in the payments you expect: what for, how much, and the due date. Unpaid ones show as a banner at the top of the job page (amber, red once overdue) and roll up onto the home page. Tick one off with ✓ and it files itself into Payments Received automatically. **This is internal only** — customers see the contract price on their job and nothing else about money: no schedule, no due dates, no receipts, no balance, no material costs.
- **Jobs** — create projects with name, address, lockbox code, price, contract upload, arch plan PDF upload, start date, and assigned customer. The address is automatically located on the map (needs internet).
- **Job page** — lockbox code (tap it to copy), Excel material list upload, check off materials as you order them, see per-item and total prices plus the "still to order" total. Add notes / to-do items per job.
- **Addresses are tappable** — anywhere an address shows (job cards, job page, jobs table, map pins), tapping it opens Apple Maps on iPhone, your map app of choice on Android, and Google Maps on a computer.
- **Photos** — tap **Take Photo** as many times as you want; each shot lands in a staging tray on the page. Drop any bad shots, then tap **Upload All** once to send the whole batch. **Choose Photos** picks several from the camera roll at once.
- **Customers** — create customer logins. Customers see only their own jobs (name, address, price, start date, contract and plan files) — not your material lists or internal notes. One customer can have many jobs.

## Material list Excel format

First row = headers. Recognized columns (any order, flexible names):

| Material | Purchase Link | Price | Qty |
|---|---|---|---|
| 2x4 Lumber 8ft | https://homedepot.com/... | $4.25 | 120 |

- Link can be a text URL **or** a real Excel hyperlink on the cell.
- Qty is optional (defaults to 1). Total = price × qty.
- Re-uploading a file replaces the job's material list.
- `.xlsx` and `.csv` both work. A ready-to-use `materials-template.xlsx` (full material takeoff workbook) is included.
- **Material takeoff workbooks** are also supported: if the workbook has a `Summary` tab with `Category | Item | Quantity | Unit | Unit Cost ($) | Total Cost ($) | Supplier Link` columns, the portal reads that tab, skips subtotal and grand-total rows, keeps supplier hyperlinks, and groups items by category — each category is one order to place. The job page shows how many orders are left and the total cost.

## Receipt scanning (optional)

Attach a receipt photo or PDF to an invoice and the portal reads the vendor, total and date off it, filling the form in for you. **Always check the numbers against the receipt before saving** — the fields stay editable and nothing is saved automatically.

To turn it on:

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) → API Keys.
2. Set it as an environment variable before starting the server:

   ```
   ANTHROPIC_API_KEY=sk-ant-... node server.js
   ```

   On a host like Render or Railway, add `ANTHROPIC_API_KEY` in that service's environment-variables settings instead.

3. Restart. The startup banner will say `Receipt scanning: enabled`.

Notes:

- Costs roughly **a quarter of a cent per receipt** — about $0.25 for 100 receipts.
- Without the key the feature is simply off; the invoice form works as normal manual entry.
- Optional `SCAN_MODEL` env var overrides which model is used.
- If a receipt can't be read the form stays blank and tells you why. Nothing breaks and no receipt is lost — tap 🔎 on a receipt card to try reading it again.
- **Getting good reads:** fill the frame with the receipt, flat and well lit. A long receipt shot from far away leaves the text too small to resolve — for a very long one, crop to the part with the total, or photograph it in two goes.
- iPhone HEIC photos are converted in the browser before upload, and big photos are shrunk, so neither format nor size should ever block a scan.
- Receipts are sent to Anthropic's API to be read. They are not used to train models.

## Reports (admin only)

Every job cost carries a **category** — Materials, Subcontractor, Labor, Permits & Fees, Equipment Rental, Tools, Fuel & Vehicle, Insurance, Office & Admin, Other. The receipt scanner picks one for you; you can change it. Three reports build on that:

- **Profit & Loss** — pick a date range (or This year / Last year / This quarter). Money in against money out, broken down by category with a bar for each, then a per-job summary.
- **Job Profitability** — every job's contract price, costs to date, profit, margin and unbilled balance. Margins under 10% show red, under 25% amber.
- **1099s** — per contractor per tax year: total paid by check, whether they cross that year's reporting threshold, and whether you hold a tax ID for them. The threshold is applied per year (**$600** through 2025, **$2,000** from 2026 on).

All three export to CSV for your accountant.

**Read the caveats.** These are cash basis — money counts on the day it moved. They're management reports, not bookkeeping: there's no general ledger, balance sheet or depreciation, and the 1099 page is a worksheet that files nothing with the IRS. Totals only include what's logged here, so anything paid outside the portal is missing. Check against your bank before filing anything.

## General spending

Not every cost belongs to a job — fuel, tools, office supplies. **DMV Design and Build — General** appears at the top of the job dropdown on any receipt or check line, so the delivery crew can file that spending without picking a job.

It behaves like a job for costs only: no contract price, no payment schedule, no materials, and it stays out of the jobs list, the map, contract-value totals and profit figures. Admins get a **General Spending** tile on the home page that opens it. It's created automatically and can't be deleted.

Note this is different from a **contractor** — contractors are who you write checks *to*. You don't need your own company in that list.

## Who sees what

| | Admin | Project Manager | Delivery | Customer |
|---|---|---|---|---|
| Jobs | all | assigned only | all | own only |
| Address, lockbox, plans | ✓ | ✓ | ✓ | ✓ |
| Contract price | ✓ | ✓ | — | ✓ |
| Job costs (invoices) | ✓ | ✓ | view only | — |
| Payments & schedule | ✓ | ✓ | — | — |
| Material orders | ✓ | ✓ | — | — |
| Photos | ✓ | ✓ | view + add | view |
| Documents | ✓ | ✓ | view + add | shared ones only |
| Receipts tab | ✓ | ✓ | ✓ | — |
| Contractors & checks | ✓ | — | — | — |
| Home page | full dashboard | full dashboard | map only | jobs summary |

Add delivery logins on the **Managers** page, under Delivery Crew.

## Contractors and checks (admin only)

The **Contractors** tab holds the subs and suppliers you write checks to — name, EIN or SSN, contact details.

Checks can be logged two ways:

- **📷 Scan a Check** — photograph the check or its carbon stub. The check number, payee, date and handwritten lines are read for you. Lines whose writing clearly names one job are matched to it automatically; anything ambiguous is left for you rather than guessed at. If the payee isn't a contractor you already have, it offers to create them.
- **✍️ Enter by Hand** — no photo needed. Type the check number, date and contractor, then add a line per job. You can attach the photo later, and it back-fills onto every job cost the check created.

Either way, a line is just **a job and an amount** — one line per job. A single check covering four jobs splits across all four, and the total sits under the check number. Every check appears on its contractor's page; click one for the breakdown.

Receipts and checks use separate scanners tuned to each — the check one knows your company name is the payer and looks for the handwritten payee instead.

Editing stays consistent: change a line's amount and the job's cost follows, move it to another job and the cost moves with it, delete the check and every cost it created is removed.

**Tax IDs are encrypted at rest.** To enable that, set a second environment variable alongside your API key:

```
TAXID_KEY=some-long-random-passphrase
```

- Without it the portal refuses to store tax IDs at all rather than writing them in plain text.
- **Keep a copy of this passphrase somewhere safe.** If you lose it or change it, the stored numbers cannot be recovered — only the last 4 digits survive, and you'd have to re-enter each contractor's number.
- Numbers show masked (`••-•••6789`); tapping one fetches the full value, hides it again after 15 seconds, and writes a line to the server log.
- Contractors, checks, check images and tax IDs are admin-only. Project managers and customers cannot see any of it.

## Notes

- All data is stored in `data/db.json`; uploaded files in `uploads/`. Back up these two to back up everything.
- `db.json` and your backups contain business data. Tax IDs inside it are encrypted, but treat the file as sensitive.
- Restarting the server logs everyone out (they just sign in again).
- To use on your office network, other devices can reach it at `http://YOUR-COMPUTER-IP:3000`. For customers to log in from anywhere, host this folder on any Node.js host (Render, Railway, a VPS) — it runs as-is.
- To change the admin password: delete the admin entry in `data/db.json` is not needed — just edit it: replace the `password` value with the SHA-256 hash of your new password, or ask me to change it for you.

---

Created by Atakan

_Last updated: July 26, 2026 — persistence test_
