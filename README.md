# MEGAVERKS Inventory V10.4 — HTML app + Google Sheets + Google Drive

This build fixes the **HTTP 405 error** and several functional bugs, and was verified with
**224 automated tests (135 backend + 89 end-to-end browser tests — all passing)**.

**New: 📷 Image Staging (Admin).** Upload a photo with a proper name and type — **Part / Inventory image** or **Product / Packing image** — and it is automatically renamed (`PART_<name>.jpg` / `PRODUCT_<name>.jpg`, unsafe characters cleaned) and saved into the app's Google Drive folder. A gallery in Admin lists every staged photo with thumbnail, **⬇ open/download**, and **🗑 trash**. Workflow: stage photos here any time → download them → drop them into the repo's `images/` folder → assign them to items/products instantly via the **📁 repo pool** picker (same-origin, always displays).

**New: 📁 Repo Image Pool — photos stored with the app, always displayed.** Add your photos (JPG/PNG/GIF/WebP/SVG) to an `images/` folder in this GitHub repo, next to `index.html`. The app then **lists them automatically** (via the GitHub API — no manifest needed; an optional `images/manifest.json` acts as a fallback). To assign one: click **📷 on any inventory row (or the image field in the Item / Product dialog) → 📁 Pick from repo image pool** → click the photo. Because repo images are served by GitHub Pages **from the same website as the app**, they display instantly with **no Drive, no sharing settings, no company-account restrictions**. Only a short path (`images/…`) is stored in the sheet. Removing the image from an item just unlinks it — the photo file stays in the repo. Google Drive upload remains available as the second option in the same menu.

**The Apps Script `/exec` URL is hard-coded in `index.html`** (the `DEFAULT_API` constant) — the app connects out of the box, no pasting needed. Admin → Settings shows **✓ Using the hard-coded URL** (or warns **⚠ A saved override is active** if someone saved a different one), and a **↺ Reset to Built-in URL** button instantly returns to the hard-coded URL. Change the URL only if you ever redeploy and it changes.

**New: ❓ Help button in the top bar** — opens an in-app procedure guide (first-time setup, loading your data, the daily workflow in order, backups, and troubleshooting), so anyone on the team can learn the flow without leaving the app.

**New: inline item images in the Inventory table** — every row manages its photo directly: 📷 on an empty slot uploads to Google Drive; the thumbnail then shows **both in the IMAGE column and next to the Item / Part No.**; **⤴ Replace** swaps the photo (old Drive file is auto-trashed); **🗑** removes it after a confirm. No need to open the edit dialog.
> Drive previews are delivered via a 3-step fallback (`lh3.googleusercontent.com` → `drive.google.com/thumbnail` → `uc?export=view`), so images render reliably; if Google blocks all three, a ⚠ chip explains what to do instead of a silent broken image. The same fallback applies in the product table and the item photo viewer.
>
> **Images visible in Drive but broken in the app?** That means the uploads saved to Drive but Google did **not** make them publicly readable (silent sharing restriction — folder-level "anyone with link" does NOT make `lh3.googleusercontent.com` previews load; on company Google accounts the admin often forces "sign in required", which blocks it completely). This build fixes it permanently, four ways: ① every upload is **verified at upload time** and warns immediately if Google blocked sharing; ② **Admin → 🖼 Fix Image Sharing** re-applies sharing AND verifies every previously uploaded image in one click; ③ **the app no longer depends on Google's public sharing at all** — if every Google URL fails, the photo is fetched through your own backend (which runs as you, the owner) and displayed anyway, so images work even with sharing fully blocked by your organisation; ④ the self-test's Drive check now **passes with a clear warning** in this situation instead of failing — because it is expected on restricted accounts and display is unaffected. After redeploying, run 🖼 Fix Image Sharing once and hard-refresh (Ctrl+Shift+R) — all existing photos appear.
>
> **No more duplicate Drive files/folders:** the backend now **pins** the spreadsheet, the image folder and the backup folder by ID (remembered permanently) and, if that memory is ever lost (new deployment, new project), it **finds and reuses your existing file by name** instead of creating another one. Clicking *Create/Verify Sheet Tabs* any number of times always returns the same spreadsheet — verified by tests.
>
> **Images now live next to your spreadsheet:** the image folder is created **inside the same Drive folder as the "MEGAVERKS Inventory V10" spreadsheet**, so data and photos sit together and you have just one place to look/share/back up. If your existing image folder is sitting at Drive root, it is **moved** beside the sheet automatically on first use — moving never changes file IDs, so every already-saved image keeps working. (Note: folder *location* never affected image display — that was a sharing issue, fixed separately above.)

**Improved: instant saves** — every entry (item, stock IN/OUT, bill, payment, vendor, customer, product, BOM, PO, dispatch) now appears on screen **immediately** when you hit Save, using the app's local cache. The full sheet re-sync happens silently in the background (watch the "Synced" clock in the top bar), so data is both instant to see and safely stored. Previously every save waited for all 12 tabs to re-download before showing anything.

**New: ⚖️ Vendor Comparison on the Analysis page** — search an Item / Part Number, select it, and get side-by-side bar charts of **Price (₹) · Lead time (days) · Credit period (days)** for every vendor supplying that article, with the best value in each column marked ★ BEST (green) plus a table and a verdict line. Lead times like "2 weeks" / "1 month" are converted to days automatically.
> ⚠️ One backend behaviour change to support this: an item row is now identified by **company + name + part number + vendor** (vendor was added). The same article from two vendors is now two rows — that's what makes comparison possible. Re-uploading the same vendor's row still updates in place, no duplicates. **If you already uploaded items, re-run your items bulk upload once** so vendor-specific rows split correctly.

## What was broken → what is fixed

| # | Problem | Fix |
|---|---------|-----|
| 1 | **HTTP 405 at login** — deployed script refused the POST (stale deployment / wrong URL) | `doPost` no longer crashes on empty bodies; `doGet` now accepts the same JSON via `?payload=`; the app **automatically retries as GET** when a POST is refused, so even a stale deployment works for login/browsing. Error message now tells you exactly which URL to copy (Web app `/exec`, **not** the Library URL). |
| 2 | **Add Bill dialog wiped your entries** — typing qty/rate/GST rebuilt the dialog and erased Invoice No, Date, Payment Mode and Notes (wrong draft keys + full re-render on every keystroke) | Fields bind to the draft correctly; typing only updates totals live. Verified by regression tests. |
| 3 | **Bill OCR broken** — the old HF endpoint (`hf-inference/models/…`) returns 404/410 for `baidu/Unlimited-OCR` | OCR now uses the current OpenAI-compatible router API (`router.huggingface.co/v1/chat/completions`) with the image embedded, plus a legacy fallback and clear error messages. |
| 4 | Dialogs stacked invisibly (Add line opened a hidden copy; Confirm-over-modal closed the wrong dialog) | Re-renders replace the dialog; Confirm removes itself. |
| 5 | Anyone with the URL could read the `Settings` tab (passcode hash) via `list` | `list` on Settings is now refused. |
| 6 | No way to verify a deployment | New **Admin → 🧪 Run Backend Self-Test**: checks the spreadsheet connection, all 13 tabs, passcode, create/update/delete, Drive write, backup folder, daily trigger — 8 checks with ✅/❌ details. |
| 7 | **App stuck on "Loading…" forever** when the saved URL was wrong/dead (no way to reach Settings) | Requests now time out (20 s) and show a proper error card with a **Go to Settings** button; the Loading screen has a "Stuck here?" link; the lock screen has a "Set up the backend connection" link when no URL is saved. |
| 8 | **`Cannot read properties of null (reading 'getSheetByName')`** — happens when Code.gs lives in a **standalone** Apps Script project (script.google.com → New project), where `getActiveSpreadsheet()` is null | Backend now works in both modes: bound to a sheet, or standalone (auto-links by remembered ID, or auto-creates a spreadsheet named "MEGAVERKS Inventory V10" on first run). Self-test shows the exact sheet URL it is using. |
| 9 | **Self-test 7/8: "You do not have permission to call ScriptApp.getProjectTriggers"** — Google granted permissions before the trigger code existed, so the `script.scriptapp` scope is missing | The check now degrades to a warning with exact instructions instead of failing, and a new helper function `checkAuthorization` triggers Google's permission prompt. **One-time fix (1 minute):** Apps Script editor → function dropdown → select **`checkAuthorization`** → **Run ▶** → **Review permissions** → choose your account → **Allow**. Then re-run the self-test → **8/8**. Note: manual and daily backups already work without this — it only affects the trigger *status check*. |
| 10 | **Images uploaded to Drive but show as dark/broken squares in the app** — the Drive files were never made publicly readable (sharing can silently fail; folder-level sharing doesn't reliably unlock `lh3` previews; company accounts often force "sign in required") | Uploads are probed for public readability at upload time; **Admin → 🖼 Fix Image Sharing** repairs + verifies all existing uploads; and as the final fallback the app **fetches photos through your own backend** (runs as the owner), so images display even if Google blocks public sharing entirely. The self-test now **passes with a warning** when public sharing is blocked, explaining that no action is needed. |
| 11 | **Duplicate spreadsheets/folders in Drive** — "Create/Verify Sheet Tabs" (or a redeploy) could create a new "MEGAVERKS Inventory V10" spreadsheet/folder each time | Spreadsheet and both folders (images, backups) are now **pinned by ID**; if the pinned ID is ever lost, the backend **searches Drive by name and reuses your existing file** — it only creates one when truly none exists. Repeated clicks are idempotent (test-verified). Bootstrap/self-test now print the exact spreadsheet + image folder URLs being used so there is no confusion about which file is live. |
| 12 | **Images scattered away from the data** — uploads went to a folder at Drive root, far from the spreadsheet they belong to | The image folder is now created **next to the spreadsheet** (same parent folder in Drive); an existing root-level image folder is **moved** there automatically (file IDs unchanged — no image links break). Everything — data + photos — now sits in one place. |
| 13 | **Uncertainty about WHICH spreadsheet is live** after duplicates/redeploys | New optional `SPREADSHEET_ID_OVERRIDE` constant in `Code.gs` — paste your sheet's ID to hard-link it permanently; bootstrap confirms `manual-hard-linked` mode, and a wrong ID produces a clear error instead of a silent new sheet. |
| 14 | **Company Google account blocks public sharing → Drive photos unreliable** | New **repo image pool**: keep photos in an `images/` folder inside this GitHub repo; the app lists them and assigns with one click. Same-origin serving means they always display, regardless of Drive sharing. Drive upload remains as an option. |
| 15 | **No orderly way to collect & name photos before adding them to the repo pool** | New **Admin → 📷 Image Staging**: upload + assign a name + pick a type (Part / Product); the file is renamed (`PART_…` / `PRODUCT_…`) into the Drive folder, listed in a gallery with download/trash, ready to be moved into the repo `images/` pool. |

## Optional: hard-link your exact Google Sheet (SPREADSHEET_ID_OVERRIDE)

If you want zero ambiguity about which spreadsheet the app uses, you can hard-link it in `Code.gs`:

1. Open your Google Sheet → copy the ID from its URL — the long part between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`1AbC…xYz`**`/edit`
2. In `Code.gs` near the top, paste it between the quotes:
   `let SPREADSHEET_ID_OVERRIDE = '1AbC…xYz';`
3. Save → **Deploy → Manage deployments → ✏️ → New version → Deploy**.

From then on the backend always opens exactly that sheet (and remembers it). **Admin → Create/Verify Sheet Tabs** will confirm with `mode: manual-hard-linked` and the sheet's URL. If the ID is wrong, you get a clear error telling you exactly what to fix — it never silently creates a new sheet when the override is set.

## How to add / change the Apps Script URL

**You don't need to** — your current `/exec` URL is pre-filled inside `index.html` (`DEFAULT_API`), so the app works out of the box and the Settings field already shows it.

**Only touch this if the URL ever changes** (e.g. you create a brand-new deployment instead of a new version):

**Three ways to change it:**

1. **Admin page**: **Admin → Connection Settings** → the field is pre-filled with the default → edit → **Save Settings** → **Test Connection** → should say `Connected — V10-sheets-fixed`.
2. **Inside `index.html`**: change the `DEFAULT_API` constant near the top of the script (line ~82) to make a different URL the built-in default for everyone.
3. **Browser console** (if the page is stuck): press **F12 → Console**, paste this with your URL, press Enter:
   ```js
   localStorage.setItem('mv_api','https://script.google.com/macros/s/YOUR_ID/exec'); location.reload();
   ```

## ⚠️ Important: redeploy the backend once (two ways — pick one)

**Option A — keep your current standalone project (easiest, same URL keeps working):**
1. Open your existing Apps Script project → delete old code → paste **all of the new `Code.gs`** → **Save**.
2. **Deploy → Manage deployments → ✏️ → Version: "New version" → Deploy**. The URL stays the same.
3. Done — on the next login the backend **auto-creates/links** a spreadsheet named "MEGAVERKS Inventory V10".
   Click **Admin → Create/Verify Sheet Tabs** or **Run Backend Self-Test** to see its URL (open it to watch your data).

**Option B — bind to your Google Sheet (recommended, data lives in a sheet you own):**
1. Open your Google Sheet → **Extensions → Apps Script** → delete default code → paste **all of `Code.gs`** → **Save**.
2. **Deploy → New deployment → Web app** → Execute as: **Me** → Access: **Anyone** → Deploy → authorize.
3. Copy the new **Web app URL** (ends in `/exec`) — ❌ not the Library URL — and save it in **Admin → Settings**.

**Either way, finish with:**
1. Admin → **Test Connection** (`Connected — V10-sheets-fixed`).
2. **One-time authorization for the backup trigger:** in the Apps Script editor, choose function **`checkAuthorization`** in the toolbar dropdown → **Run ▶** → **Review permissions** → your account → **Allow**. (Google only asks once.)
3. Admin → **🧪 Run Backend Self-Test** → expect **8/8 ✅**.
4. Admin → **🖼 Fix Image Sharing** → **hard-refresh the app (Ctrl+Shift+R)** → all previously uploaded photos appear.

## Files

| File | Use |
|---|---|
| `index.html` | The whole app — replace the file in your GitHub repo (Pages rebuilds itself) |
| `Code.gs` | Apps Script backend — paste into the Sheet's script editor and redeploy (steps above) |

## Setup from scratch (5–10 minutes)

1. **Create the spreadsheet:** New Google Sheet (any name).
2. **Backend:** Extensions → Apps Script → delete default code → paste all of `Code.gs` → **Save** → **Deploy → New deployment → Web app** → Execute as: **Me** → Access: **Anyone** → Deploy → authorize the Drive permission → copy the **`/exec` URL**.
3. **Frontend (GitHub):** upload `index.html` to your repo with Pages enabled (`https://<user>.github.io/<repo>/`) — or just double-click `index.html` locally.
4. **Connect:** Open the app → passcode `mega1234` → **Admin → Settings** → paste the `/exec` URL → **Test Connection** → **Create/Verify Sheet Tabs** → **Run Backend Self-Test**.
5. **Change the passcode:** **Admin → Change Passcode** (stored in the sheet, effective for everyone).
6. **Load data:** **Vendors → Bulk Upload** → then **Inventory → Bulk Upload** (same CSVs as before).

## Bill OCR — how robust is it, and the new engines (V10.2)

**Honest answer about the old tool:** the previous OCR sent the photo straight from your browser
to Hugging Face's *baidu/Unlimited-OCR* and dumped raw text into Notes — no field extraction,
provider availability decided everything, and your token sat in the browser's localStorage.

**V10.2 fixes all three.** The browser now asks the Apps Script backend, which calls the OCR
provider — your **token stays server-side** (Settings tab). Returned text is parsed into
structured fields: **vendor, GSTIN, invoice number, invoice date (normalised to ISO),
grand total, address, phone** — and the bill form is pre-filled for you.

Two engines, switchable in **🛡️ Admin → ✨ OCR engine**:

1. **Hugging Face (Unlimited-OCR)** — zero setup. Needs a **fine-grained token** with
   "Make calls to Inference Providers" permission (huggingface.co → Settings → Access Tokens),
   pasted in Admin → OCR engine. If the provider is down you get a clear message — photo
   attachment and manual entry always work.
2. **Custom endpoint (self-hosted OCR server v2, recommended for robustness)** — run your
   own OCR server: **OpenCV preprocessing + PP-OCRv4 recognition**, fully offline on your
   own machine/server, and no invoice ever leaves your network.

### OCR server v2 — OpenCV pipeline (rebuilt, images + PDF)

The rebuilt `ocr_server.py` is far more robust than a plain OCR call:

- **PDF support** — invoice PDFs are rendered at 300 DPI (pypdfium2, up to 5 pages) and read page by page. The app's OCR field accepts `application/pdf` alongside photos.
- **OpenCV pre-processing with best-variant selection** — every page is OCR'd through multiple cleaned variants and the highest-confidence result wins:
  auto resize/upscale, CLAHE contrast equalisation, fastNlMeans denoising,
  **minAreaRect deskew** (straightens tilted photos/scans), Otsu + adaptive-Gaussian
  binarisation, and unsharp-mask sharpening.
- **Geometry-aware reading order** — detected boxes are clustered into lines by vertical overlap and sorted left→right, so columns never interleave.
- **Tolerant field parsing** — GSTIN repair for OCR confusions (`O↔0`, `2↔Z`), many invoice-number/date label formats, and a grand-total fallback that picks the largest amount in the bottom of the bill.

Verified by an automated accuracy suite: clean, rotated (±3°), gaussian-noise, low-res,
and low-contrast invoice photos **plus a PDF invoice** — 51/51 checks extract the correct
vendor, GSTIN, phone, invoice number, date and total.

### Self-hosting the OCR server (included: `ocr_server.py`)

```bash
pip install rapidocr_onnxruntime opencv-python pypdfium2 numpy
python3 ocr_server.py 8765            # serves POST /ocr and GET /health
```

- `POST /ocr  { "image": "data:image/jpeg;base64,..." }` — also accepts `data:application/pdf;base64,...` → `{ ok, engine, version, pages, variant, text, fields:{ gstin, phone, invoiceNumber, invoiceDate, grandTotal, vendor, address, buyer } }`
- Then set **Admin → ✨ OCR engine → Provider: Custom OCR endpoint → URL: `http://your-server:8765/ocr`** → Save.
- For permanent use put it on a small VM/always-on PC (systemd service or `nohup`), and expose the URL over HTTPS (nginx/Caddy or a tunnel) — the Apps Script backend calls this URL, so it must be reachable from the internet.
- OCR settings (provider, endpoint, token) are stored in the sheet's Settings tab.

## Purchase photos auto-filed to Drive

- Bills → Add Bill → **Attachment** — on Save the photo is uploaded to the
  **MEGAVERKS Purchases** Drive folder (created beside your spreadsheet, pinned by ID).
- Named **VENDOR_INVOICE-DATE.jpg** — the date the *vendor* raised the invoice
  (e.g. `SHREE_BALAJI_ENTERPRISES_2026-08-15.jpg`); a duplicate gets a `_2` suffix.

## Vendor List auto-add from invoices

- OCR recognises a new vendor → green note in the bill dialog → on Save the vendor is created
  with **name, GSTIN, address and contact number** and the bill is linked to it.
- Existing vendor missing those details → they're **backfilled** from the invoice.

## Editable dropdown categories

- **🛡️ Admin → 🗂️ Dropdown categories** — add/delete options for **Company, Material Type,
  Source and Payment Mode** (stored in the sheet, so the whole team shares the lists).
- Or add inline anywhere: pick **＋ New…** inside any dropdown (vendor, product, customer,
  company, material type…) and type it — saved instantly.

## Help guide with screenshots
The **❓ Help** button (top bar) opens the full procedure guide, now illustrated with real screenshots stored in `images/help/`:
- `po-dispatch.png` — a PO window: heading = PO number, articles inside with Ordered / Dispatched / Balance
- `dispatch-dialog.png` — the Dispatched dialog (quantities, date, invoice no., live BOM deduction preview)
- `inventory-images.png` — photos shown in the Inventory table and how to replace them
- `pool-picker.png` — picking an image from the repo pool (`images/` folder)
- `image-staging.png` — Admin → Image Staging (named `PART_*.jpg` / `PRODUCT_*.jpg` uploads)
- `vendor-comparison.png` — price / lead-time / credit-period comparison across vendors
- `self-test.png` — a healthy 8/8 backend self-test

To re-capture them after UI changes, run the `shots.js` script in the test harness.

## Purchase-order dispatch workflow (V10.1)
- **Orders are grouped by PO**: each PO is a window headed by the **PO number** (with customer, date, status and dispatch progress); the articles sit inside with **Ordered · Dispatched · Balance** per line.
- **🚚 Dispatched button** (while balance remains): record what left now — per-article quantities (partial is fine), **dispatch date** and **invoice number** (required). A live preview shows exactly which child parts will be deducted, and blocks the save if stock is short.
- **Automatic deductions**: on save, child-part inventory is reduced per BOM × dispatched qty and a **Stock OUT movement** is logged (visible in Inventory → stock history and the audit log). The save is all-or-nothing — if any material is short, nothing is deducted.
- **Balance tracking**: the PO card always shows remaining qty ("12 to dispatch"); status moves OPEN → **PARTIAL** → **DISPATCHED** as balances reach zero. Full history per PO under 👁 Details → **Dispatch History** (date, qty, invoice no., who dispatched).
- **Analysis integration**: open-PO requirements and material shortfalls are computed from the **remaining balance** (already-dispatched qty is excluded), and PARTIAL POs count as open.
- New **Dispatches** tab in the Google Sheet stores every dispatch record (PO no., article, qty, date, invoice no., actor).

## Vendor Purchase Orders — order components from your vendors (V10.3)

A new **📤 Vendor POs** page (top nav) lets you raise professional purchase orders to your vendors, picking components straight from the inventory list.

- **Create**: choose the letterhead (**MEGAVERKS Technologies** — 137/2, & Post, Magadi Main Rd, Kamath Layout, Kadabagere Cross, Machohalli, Karnataka 562130, or **Vengree Metal Punch Pvt Ltd** — 37/2 Shed No 9, Kadabgere Cross, Machohalli, Industrial Area, B - 91, Machohalli, Karnataka 562130), pick a vendor (contact person, phone, GSTIN, address auto-fill and stay editable), auto PO number (`MV/PO/2026/001`), PO date, **expected delivery date**, editable **GST %** (default 18).
- **Lines**: components are selected from the **inventory list**; the **rate is derived from the saved item price** and is editable, as is the quantity. Subtotal / GST / grand total compute live.
- **Terms of Agreement** are pre-filled and **editable per PO** — they print on the document.
- **Outputs**: **🖨 PDF** (print / save-as-PDF professional document with company monogram, address, GST, terms, signature block), **📊 XLSX** (a real Excel file with header, lines, totals and terms — generated offline, no library), **📲 WhatsApp** (opens WhatsApp with the full PO message to the vendor's number).
- **Amendment (✎ Edit)**: change delivery date, quantities, rates, GST, contacts, terms, add/remove components — everything saves back to the sheet. **✕ Cancel** stops the PO counting as on-order.
- **Inventory integration**: the inventory table has an **On Order** column — every item shows the ordered qty and expected delivery ("📦 50 ordered · due 2026-10-05"), so out-of-stock items show they are already ordered, how much, and when they arrive.
- **Analysis integration**: two new stat cards (**Vendor POs Open**, **Units on Order**), an **On Order (ETA)** column in Material Shortfalls, and an **📥 Incoming Material** card listing every open vendor-PO line with its expected delivery date.
- **Sheets**: two new tabs are auto-created by the backend — **VendorPOs** and **VendorPOLines**.

> ⚠️ This release changes `Code.gs` (two new sheet tabs). After uploading it to Apps Script, **redeploy**: Deploy → Manage deployments → ✎ → Version: *New version* → Deploy. The new tabs are auto-created on first use — no manual sheet work needed. The web-app URL stays the same.

## Test checklist (all covered by the automated suite)

1. Login `mega1234` → change passcode → old passcode + old session rejected, new one works.
2. Add Item → Stock IN/OUT → In/Out/In-Hand update; over-issue refused; movements logged.
3. Bulk upload vendors/items/products/POs → updates not duplicates, vendor auto-link, opening stock.
4. Add Bill with GST → fields survive typing → totals live → saved; Record Payment → balances.
5. PO → BOM → Dispatch → stock deducted per BOM; double-dispatch refused; partial dispatch balances tracked.
6. Admin → self-test 8/8 (after the one-time `checkAuthorization` run); audit log records everything.
7. OCR (custom endpoint) → invoice fields extracted (GSTIN/invoice no/date/total/vendor) → bill pre-filled.
8. Bill Save with a new OCR vendor → vendor created with GSTIN/address/phone; attachment in Purchases folder as `VENDOR_DATE.jpg`.
9. Dropdown categories → add/delete via Admin manager and inline "＋ New…" in every dropdown.

**Automated suites:** 170 backend tests + 145 e2e browser tests (Chrome) covering all of the above.

---

## What's new in V10.4

**⚠️ Code.gs changed — after uploading, you MUST redeploy the backend:** Apps Script editor → paste new `Code.gs` → **Save** → **Deploy → Manage deployments → ✎ → Version: New version → Deploy**. Three new sheet tabs (`ItemVendors`, `RawMaterials`, `RawMatMoves`) are auto-created on first use.

### Multiple vendors per inventory item
- Edit Item → new **Vendor Prices** block — add any number of vendors with each vendor's own price.
- Inventory shows a "N vendors" badge; View Item lists every vendor + price; the Analysis price comparison includes them when picking the cheapest source.
- Prices editable/deletable at any time; everything syncs to the `ItemVendors` tab.

### Raw Material Sheets section (🔩 Raw Material)
- **Sheet types with your presets:** CRCA/MS (0.8, 1, 1.2, 1.6, 2, 2.5, 3 mm), GP With Laminate 120 GSM (2 mm), HRPO (1, 1.5, 2, 2.5, 3 mm), SS 304 / SS 202 (0.6 & 1 mm Single Side Matt, 2 mm 2B finish); sizes 8 ft × 4 ft (2500 × 1250 mm) and 10 ft × 5 ft (3000 × 1500 mm) — plus free-text custom values for anything else.
- **⇲ Receive:** sheets + date + ₹/kg + vendor + vendor invoice no (required) + **weighment slip photo** (saved to Drive, attached to the bill). Stock increases, a vendor **bill is auto-created and interlinked** (kg × ₹/kg total), and the sheet's ₹/kg updates to the latest purchase.
- **Sheets In Hand (editable):** the sheet-type dialog now has a **Sheets In Hand** field — enter opening stock when adding a type, or correct the count anytime when editing. Every change is logged as an **ADJ entry in History** (e.g. "Stock correction 40 → 35"), so stock is always auditable.
- **⇱ Daily usage (end-of-day entry):** sheets used (never more than in hand) + date + **customer + P.O/reference + job done** — the P.O box auto-lists that customer's purchase orders, or type any reference. Stock subtracts immediately.

### Raw Material Usage section (📝 RM Usage — new page)
- Dedicated end-of-day entry page: **date (selectable) → sheet type → operation → sheets used → purpose → customer → P.O/reference → job done**.
- **Operation** is one of **Punching / Laser / Hand Cutting / Ducting**.
- The sheet-type dropdown shows live availability ("CRCA / MS · 2.5 mm — 20 available"); saving subtracts from the master list instantly and the log + Raw Material page show the updated available sheets.
- Over-use is blocked ("Only N sheets available"), every entry records operation, purpose, kg (auto from kg/sheet), customer, P.O and user — with edit/delete that recalculates stock.
- The ⇱ quick-entry dialog on the Raw Material page now captures operation + purpose too.
- **🕓 History:** every receipt/usage with slip viewer links; entries can be **edited (amendment)** or deleted — stock totals auto-recalculate.
- **📈 Procurement price trends:** per sheet type — sparkline chart of ₹/kg over time, latest/min/max price, % change since first purchase, and a full dated table (date, vendor, invoice, qty, ₹/kg).
- Everything else editable: thickness, grade, finish, size, kg/sheet, min-stock alert, vendor, notes. CSV export included.

All raw-material data lives in the `RawMaterials` + `RawMatMoves` sheet tabs, so it syncs across every user and is backed up with the rest of the spreadsheet.

### Bills → Raw Material (works from the other side too)
- In **Add Vendor Bill**, each line now has a **sheet-type dropdown** under the description plus a **Sheets (Nos)** box.
- Enter the bill exactly as printed: e.g. *GI Coil / Sheet 0.80 X 1250 X 2000 — 255 Nos, 3,970 kg @ ₹84/kg* → Qty = weight in kg, Rate = ₹/kg, Sheets = 255.
- On Save, the sheets are added to Raw Material stock as a receipt interlinked to the bill (same invoice no., vendor, ₹/kg, and the bill photo doubles as the weighment slip). The sheet's ₹/kg updates and **kg-per-sheet is auto-derived** (kg ÷ sheets) when not set.
- So you can receive raw material either from the Raw Material page (⇲ Receive creates the bill) or straight from the bill (creates the receipt) — both stay in sync.

### Help & User Manual
- The **❓ Help** dialog is updated for every feature — PO grouping/search/amendment, Vendor POs (PDF/WhatsApp/XLSX), multi-vendor prices, multi-product parts, Raw Material (receive/usage/trends/weighment slips) and the RM Usage daily page.
- A downloadable **User Manual PDF** (`MEGAVERKS-Inventory-User-Manual.pdf`) ships with the app — the Help dialog has a **Download Manual** button so any user can save and share the full operating guide. Upload the PDF to the repo next to `index.html`.

### Vendor Comparison fully synced with Inventory (Analysis)
- The ⚖️ Vendor Comparison dropdown is **populated on page load** — no typing needed — and always mirrors the inventory list.
- Articles supplied **only through the multi-vendor price list** (no primary vendor set) now appear too, showing all their vendors and prices.
- Select any article → price / lead-time / credit-period charts per vendor, BEST badges, and the verdict line. Price amendments in Inventory reflect here on the next view.

### Multi-user sync hardening (5–6 concurrent users)
- **Single-call refresh:** the whole database now loads in ONE `listAll` request instead of 17 separate ones — far lighter on Apps Script when the whole team is online. Falls back automatically on older backends.
- **Server write lock:** saves are serialised with `LockService`, so two users creating records at the same second get distinct IDs and never overwrite each other's rows.
- **Never lose the screen:** if a refresh fails (network blip, Apps Script cold start), the data already on screen stays — nothing ever blanks out. A failed entity keeps its last-known rows.
- **Silent retry:** network calls retry once before reporting an error.
- **Always fresh:** sync runs every 45 s, on tab focus, on returning to the tab (visibility change), and immediately when the network comes back; the top bar shows "Synced …" or "⚠ offline — will retry".
- Help dialog updated with a multi-user sync note.

### Export ⇄ Bulk Upload round trip (every section)
- **Every data page now has ⇩ Export** (Inventory, Raw Material, RM Usage, Orders, Vendor POs, Customers, Bills, Vendors, Products) — the CSV uses the **exact spreadsheet column format**, so it round-trips.
- **⇪ Bulk Upload accepts the same file back**: rows with an existing `id` are **updated in place**, rows without an id are **added**, and re-uploading an unchanged export creates **zero duplicates**. Edit in Excel in between.
- Orders and Vendor POs export two linked files (header + lines) — upload each back on its page.
- The legacy friendly Excel format (Item Name, Part Number, …) still works for items / vendors / products / POs.
- New backend action `bulkImport` (LockService-serialised) powers the round trip; photo/PDF columns (`imageData`, `attachmentData`, `weightSlipData`) are never touched by CSV import — blank means "keep the existing file".
- `settings` and `audit` tabs refuse bulk upload; unknown entities and empty rows are safely rejected/skipped.

### Connection watchdog — sync recovers by itself
- Every API answer updates a live connection state. On a drop, the top bar shows **"⚠ offline — will retry"** and a watchdog pings the backend every 20 s; the moment it answers, the app **reloads all data and re-renders automatically** — nobody needs to open Admin → Test Connection.
- All bulk uploads (legacy + round-trip) now run inside the server write lock, so simultaneous imports from several users can't race.

⚠️ **Code.gs changed — redeploy required** (Deploy → Manage deployments → ✎ → New version → Deploy).

### OCR server v2 — OpenCV-enhanced recognition (images + PDF)
- The invoice OCR stack was rebuilt: **OpenCV preprocessing pipeline** (auto-resize, CLAHE contrast, fastNlMeans denoise, **minAreaRect deskew**, Otsu/adaptive binarisation, unsharp sharpen) runs PP-OCRv4 on multiple variants and keeps the best-confidence result; boxes are re-ordered into true reading order; field parsing repairs common OCR misreads (O↔0, 2↔Z in GSTIN) and finds totals even without a "Grand Total" label.
- **PDF invoices supported** — rendered at 300 DPI and read page by page; the bill dialog's OCR field now accepts `application/pdf`.
- Bill dialog OCR now sends sharper 2000px photos for better accuracy.
- ⚠️ If you self-host the OCR server, update it: `pip install rapidocr_onnxruntime opencv-python pypdfium2 numpy` and restart `ocr_server.py`.

Tested: 208 backend + 232 browser tests + 51 OCR accuracy checks (clean/rotated/noisy/low-res/dark/PDF), all passing (run twice, error-free).
