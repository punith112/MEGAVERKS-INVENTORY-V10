# MEGAVERKS Inventory V10 — FIXED build (HTML + Google Sheets + Google Drive)

This build fixes the **HTTP 405 error** and several functional bugs, and was verified with
**81 automated tests (52 backend + 29 end-to-end browser tests — all passing)**.

## What was broken → what is fixed

| # | Problem | Fix |
|---|---------|-----|
| 1 | **HTTP 405 at login** — deployed script refused the POST (stale deployment / wrong URL) | `doPost` no longer crashes on empty bodies; `doGet` now accepts the same JSON via `?payload=`; the app **automatically retries as GET** when a POST is refused, so even a stale deployment works for login/browsing. Error message now tells you exactly which URL to copy (Web app `/exec`, **not** the Library URL). |
| 2 | **Add Bill dialog wiped your entries** — typing qty/rate/GST rebuilt the dialog and erased Invoice No, Date, Payment Mode and Notes (wrong draft keys + full re-render on every keystroke) | Fields bind to the draft correctly; typing only updates totals live. Verified by regression tests. |
| 3 | **Bill OCR broken** — the old HF endpoint (`hf-inference/models/…`) returns 404/410 for `baidu/Unlimited-OCR` | OCR now uses the current OpenAI-compatible router API (`router.huggingface.co/v1/chat/completions`) with the image embedded, plus a legacy fallback and clear error messages. |
| 4 | Dialogs stacked invisibly (Add line opened a hidden copy; Confirm-over-modal closed the wrong dialog) | Re-renders replace the dialog; Confirm removes itself. |
| 5 | Anyone with the URL could read the `Settings` tab (passcode hash) via `list` | `list` on Settings is now refused. |
| 6 | No way to verify a deployment | New **Admin → 🧪 Run Backend Self-Test**: checks all 12 tabs, passcode, create/update/delete, Drive write, backup folder, daily trigger — 7 checks with ✅/❌ details. |

## ⚠️ Important: you must redeploy the backend once

The 405 lives in your **current Google deployment**, so pasting files alone is not enough:

1. Google Sheet → **Extensions → Apps Script** → delete old code → paste **all of the new `Code.gs`** → **Save**.
2. **Deploy → Manage deployments → ✏️ (edit) → Version: "New version" → Deploy**.
3. In the same dialog copy the **Web app URL** — it ends in `/exec`.
   ❌ Do **not** copy the **Library URL** (`…/macros/library/d/…`) — that one always returns 405.
4. Open the app → **Admin → Settings** → paste the `/exec` URL → **Save Settings** → **Test Connection**
   (should say `Connected — V10-sheets-fixed`) → **Run Backend Self-Test** (should be 7/7 ✅).

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

## Bill OCR (baidu/Unlimited-OCR)

- Needs a **fine-grained Hugging Face token** with **"Make calls to Inference Providers"** permission
  (huggingface.co → Settings → Access Tokens). Paste it in **Admin → Settings**.
- Bills → Add Bill → **OCR** field → choose the invoice photo → **✨ Extract text to Notes**.
- Note: HF serves this model through third-party inference providers; if it is temporarily
  unavailable you'll get a clear message — the photo attachment and manual entry always work.

## Test checklist (all covered by the automated suite)

1. Login `mega1234` → change passcode → old passcode + old session rejected, new one works.
2. Add Item → Stock IN/OUT → In/Out/In-Hand update; over-issue refused; movements logged.
3. Bulk upload vendors/items/products/POs → updates not duplicates, vendor auto-link, opening stock.
4. Add Bill with GST → fields survive typing → totals live → saved; Record Payment → balances.
5. PO → BOM → Dispatch → stock deducted per BOM; double-dispatch refused.
6. Admin → self-test 7/7; audit log records everything.
