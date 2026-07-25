# DMV Design and Build — Project Portal

A self-contained web portal for managing commercial construction projects. No installation of packages needed — only [Node.js](https://nodejs.org) 18 or newer.

## Run it

```
node server.js
```

Then open **http://localhost:3000** in your browser.

- **Admin login:** username `dmv` / password `dmv123`
- Customers log in on the same page with the accounts you create on the **Customers** page.

## What it does

- **Home** — dashboard with job count, total contract value, materials still to order, and a map of all jobs. Click the map to expand it full-page; click a pin to open that job.
- **Jobs** — create projects with name, address, price, contract upload, arch plan PDF upload, start date, and assigned customer. The address is automatically located on the map (needs internet).
- **Job page** — upload your Excel material list, check off materials as you order them, see per-item and total prices plus the "still to order" total. Add notes / to-do items per job.
- **Customers** — create customer logins. Customers see only their own jobs (name, address, price, start date, contract and plan files) — not your material lists or internal notes. One customer can have many jobs.

## Material list Excel format

First row = headers. Recognized columns (any order, flexible names):

| Material | Purchase Link | Price | Qty |
|---|---|---|---|
| 2x4 Lumber 8ft | https://homedepot.com/... | $4.25 | 120 |

- Link can be a text URL **or** a real Excel hyperlink on the cell.
- Qty is optional (defaults to 1). Total = price × qty.
- Re-uploading a file replaces the job's material list.
- `.xlsx` and `.csv` both work. A ready-to-use `materials-template.xlsx` is included.

## Notes

- All data is stored in `data/db.json`; uploaded files in `uploads/`. Back up these two to back up everything.
- Restarting the server logs everyone out (they just sign in again).
- To use on your office network, other devices can reach it at `http://YOUR-COMPUTER-IP:3000`. For customers to log in from anywhere, host this folder on any Node.js host (Render, Railway, a VPS) — it runs as-is.
- To change the admin password: delete the admin entry in `data/db.json` is not needed — just edit it: replace the `password` value with the SHA-256 hash of your new password, or ask me to change it for you.

---

Created by Atakan
