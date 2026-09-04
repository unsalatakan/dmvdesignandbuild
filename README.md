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
- **Payment schedule** — on any job, type in the payments you expect: what for, how much, and the due date. Unpaid ones show as a banner at the top of the job page (amber, red once overdue) and roll up onto the home page. Tick one off with ✓ and it files itself into Payments Received automatically. Customers see their own schedule as their balance due.
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

## Notes

- All data is stored in `data/db.json`; uploaded files in `uploads/`. Back up these two to back up everything.
- Restarting the server logs everyone out (they just sign in again).
- To use on your office network, other devices can reach it at `http://YOUR-COMPUTER-IP:3000`. For customers to log in from anywhere, host this folder on any Node.js host (Render, Railway, a VPS) — it runs as-is.
- To change the admin password: delete the admin entry in `data/db.json` is not needed — just edit it: replace the `password` value with the SHA-256 hash of your new password, or ask me to change it for you.

---

Created by Atakan

_Last updated: July 26, 2026 — persistence test_
