#!/usr/bin/env python3
"""
OCR server for MEGAVERKS Inventory V10  (PaddleOCR models via RapidOCR/ONNX)

Why this exists
---------------
The app's built-in OCR calls a hosted vision model from the browser. That works,
but it depends on a third-party free tier and only returns raw text. This server
runs PP-OCRv4 detection+recognition locally (the same models PaddleOCR ships,
served through onnxruntime — no PaddlePaddle install needed) and additionally
parses the text into structured fields (vendor, GSTIN, address, phone, invoice
no/date, totals) so the app can pre-fill the bill and auto-create vendors.

Install & run (any machine that can reach your network / the internet):
    pip install rapidocr_onnxruntime
    python3 ocr_server.py            # listens on 0.0.0.0:8765

Expose it with a tunnel (e.g. cloudflared, ngrok) or run it on a small cloud VM,
then in the app:  Admin -> Settings -> OCR provider = "Custom OCR endpoint",
OCR endpoint = https://<your-host>/ocr

Protocol
--------
POST /ocr            JSON body: {"image": "data:image/jpeg;base64,...."}
                     Returns:  {"ok": true, "engine": "rapidocr-ppocrv4",
                               "text": "<full text>", "fields": {...}}
GET  /health         -> {"ok": true}
"""
import base64
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

_ocr = None
def get_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr

# ---------------- field extraction ----------------
GSTIN_RE  = re.compile(r'\b(\d{2}[A-Z]{5}\d{4}[A-Z]\dZ[A-Z\d])\b')
PHONE_RE  = re.compile(r'\b(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})\b')
PIN_RE    = re.compile(r'\b(\d{6})\b')
DATE_RES  = [
    re.compile(r'(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})'),          # 15/09/2026, 15-09-26
    re.compile(r'(\d{1,2})[\s-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s-](\d{4})', re.I),
]
INVNO_RE  = re.compile(r'(?:invoice|inv|bill)\s*(?:no|number|num|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{1,})', re.I)
TOTAL_RES = [
    re.compile(r'(?:grand\s*total|amount\s*payable|net\s*payable|total\s*amount)\D{0,12}([\d,]+(?:\.\d{1,2})?)', re.I),
    re.compile(r'(?:total)\D{0,8}(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)', re.I),
]
MONTHS = {m.lower(): i for i, m in enumerate(
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], 1)}

def norm_date(dd, mm, yy):
    dd = int(dd)
    if isinstance(mm, str):
        k = mm.lower()[:3]
        if k in MONTHS: mm = MONTHS[k]
        else:
            try: mm = int(mm)
            except ValueError: mm = 0
    yy = int(yy)
    if yy < 100: yy += 2000
    if not (1 <= mm <= 12 and 1 <= dd <= 31 and 2000 <= yy <= 2100): return None
    return '%04d-%02d-%02d' % (yy, mm, dd)

def find_dates(line):
    out = []
    for rx in DATE_RES:
        for m in rx.finditer(line):
            try:
                if rx is DATE_RES[0]: d = norm_date(m.group(1), m.group(2), m.group(3))
                else:                 d = norm_date(m.group(1), m.group(2), m.group(3))
            except Exception:
                d = None
            if d: out.append(d)
    return out

def extract_fields(text):
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    joined = '\n'.join(lines)
    f = {}
    g = GSTIN_RE.search(joined)
    if g: f['gstin'] = g.group(1)
    ph = PHONE_RE.search(joined.replace('-', '').replace(' ', '') if False else joined)
    if ph: f['phone'] = ph.group(1).replace(' ', '').replace('-', '')
    # invoice number
    for l in lines:
        m = INVNO_RE.search(l)
        if m:
            f['invoiceNumber'] = m.group(1).strip(' .-/')
            break
    # invoice date: prefer a line mentioning invoice/date, else first sane date
    for l in lines:
        if re.search(r'invoice\s*date|date\s*[:/]', l, re.I):
            ds = find_dates(l)
            if ds: f['invoiceDate'] = ds[0]; break
    if 'invoiceDate' not in f:
        for l in lines:
            ds = find_dates(l)
            if ds: f['invoiceDate'] = ds[0]; break
    # totals: grand total first, fallback biggest "total" value
    for rx in TOTAL_RES[0:-1]:
        m = rx.search(joined)
        if m: f['grandTotal'] = m.group(1); break
    if 'grandTotal' not in f:
        cands = []
        for rx in TOTAL_RES[-1:]:
            for m in rx.finditer(joined):
                try: cands.append(float(m.group(1).replace(',', '')))
                except Exception: pass
        if cands: f['grandTotal'] = str(max(cands))
    # vendor = first meaningful line (skip doc-type headers)
    skip = re.compile(r'tax\s*invoice|invoice|original|duplicate|e-?way|po\s*no|buyer|bill\s*to', re.I)
    for l in lines:
        if skip.search(l): continue
        if len(l) < 4: continue
        f['vendor'] = l
        break
    # address: line near the top containing area/pin words
    addr = re.compile(r'(plot|road|street|area|sector|industr|nagar|district|city|\b\d{6}\b)', re.I)
    top = lines[1:6]
    for l in top:
        if addr.search(l) and GSTIN_RE.search(l) is None and not PHONE_RE.search(l):
            f['address'] = l; break
    if 'address' not in f:
        for l in top:
            if addr.search(l):
                f['address'] = re.sub(GSTIN_RE, '', re.sub(PHONE_RE, '', l)).strip(' ,-')
                break
    # buyer name
    for i, l in enumerate(lines):
        if re.search(r'buyer|bill\s*to|consignee', l, re.I):
            rest = re.sub(r'^(buyer|bill\s*to|consignee)\s*[:.]?\s*', '', l, flags=re.I)
            if len(rest) > 3: f['buyer'] = rest
            elif i + 1 < len(lines): f['buyer'] = lines[i + 1]
            break
    return f

def ocr_image(b64, mime_hint=''):
    raw = base64.b64decode(b64)
    import numpy as np, cv2
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None: raise ValueError('image could not be decoded')
    result, _ = get_ocr()(img)
    if not result: return '', {}
    text = '\n'.join(r[1] for r in result)
    return text, extract_fields(text)

# ---------------- HTTP ----------------
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self):
        self._send(200, {'ok': True})
    def do_GET(self):
        if self.path.startswith('/health'):
            try: get_ocr()
            except Exception as e: return self._send(200, {'ok': False, 'error': str(e)})
            return self._send(200, {'ok': True, 'engine': 'rapidocr-ppocrv4'})
        self._send(404, {'ok': False, 'error': 'unknown path'})
    def do_POST(self):
        if not self.path.startswith('/ocr'):
            return self._send(404, {'ok': False, 'error': 'unknown path'})
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n) or b'{}')
            data_url = body.get('image', '')
            m = re.match(r'data:image/[\w+]+;base64,(.*)', data_url, re.S)
            if not m: return self._send(400, {'ok': False, 'error': 'body must be {"image":"data:image/...;base64,...."}'})
            text, fields = ocr_image(m.group(1))
            if not text.strip(): return self._send(200, {'ok': True, 'text': '', 'fields': {}, 'engine': 'rapidocr-ppocrv4'})
            return self._send(200, {'ok': True, 'text': text, 'fields': fields, 'engine': 'rapidocr-ppocrv4'})
        except Exception as e:
            return self._send(500, {'ok': False, 'error': str(e)})

if __name__ == '__main__':
    print('MEGAVERKS OCR server (PaddleOCR PP-OCRv4 via RapidOCR) on port', PORT)
    ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
