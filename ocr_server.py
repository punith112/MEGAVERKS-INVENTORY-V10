#!/usr/bin/env python3
"""
MEGAVERKS OCR server v2 — robust invoice/document text recognition
==================================================================

Pipeline (all local, no cloud calls):
  1. INPUT      image data URL (png/jpg/webp/bmp/tiff) OR PDF data URL
                (PDF pages rendered at 300 DPI with pypdfium2)
  2. OPENCV     multi-variant preprocessing, newest classic-CV practice:
                  - auto upscale small scans / downsize huge photos
                  - CLAHE contrast equalisation
                  - fastNlMeans denoising
                  - minAreaRect deskew (fixes tilted scans/photos)
                  - Otsu + adaptive-Gaussian binarisation variants
                  - unsharp-mask sharpening
  3. OCR        PP-OCRv4 (detection+recognition) via RapidOCR/ONNX, run on each
                variant; the variant with the best confidence-weighted text
                yield wins (early exit when the first pass is already clean)
  4. GEOMETRY   boxes re-ordered into true reading order (y-clustered lines)
  5. FIELDS     tolerant extraction: GSTIN (with OCR-confusion repair), phone,
                invoice no/date (many label & date formats), grand total
                (label-aware, falls back to the largest bottom-of-bill amount),
                vendor / address / buyer

Run:    python3 ocr_server.py            # listens on 0.0.0.0:8765
Deps:   pip install rapidocr_onnxruntime opencv-python pypdfium2 numpy

App wiring:  Admin -> Settings -> OCR provider = "Custom OCR endpoint",
             OCR endpoint = https://<your-host>/ocr

Protocol
--------
POST /ocr    {"image": "data:image/jpeg;base64,...."}   or
             {"image": "data:application/pdf;base64,...."}
         ->  {"ok": true, "engine": "rapidocr-ppocrv4+opencv", "pages": 1,
              "variant": "clahe", "text": "...", "fields": {...}}
GET  /health -> {"ok": true, "engine": ..., "version": "2.0"}
"""
import base64
import json
import math
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
VERSION = '2.0'
MAX_PDF_PAGES = 5
MAX_PIXELS = 40_000_000          # safety cap per page
PDF_RENDER_SCALE = 300 / 72      # 300 DPI

_ocr = None
def get_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr

# ---------------------------------------------------------------------------
# input decoding: image or PDF -> list of BGR pages
# ---------------------------------------------------------------------------
def decode_data_url(s):
    m = re.match(r'data:([\w/+.+-]+);base64,(.*)', s or '', re.S)
    if not m:
        raise ValueError('body must be {"image":"data:<mime>;base64,...."}')
    return base64.b64decode(m.group(2)), m.group(1).lower()

def load_pages(raw, mime):
    import numpy as np, cv2
    if mime == 'application/pdf' or raw[:5] == b'%PDF-':
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(raw)
        pages = []
        n = min(len(pdf), MAX_PDF_PAGES)
        for i in range(n):
            bmp = pdf[i].render(scale=PDF_RENDER_SCALE)
            pil = bmp.to_pil()
            arr = np.array(pil.convert('RGB'))
            pages.append(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
        pdf.close()
        if not pages:
            raise ValueError('PDF has no pages')
        return pages
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('image could not be decoded (use jpg/png/webp or a PDF)')
    return [img]

# ---------------------------------------------------------------------------
# OpenCV preprocessing variants
# ---------------------------------------------------------------------------
def _resize_sane(img):
    import cv2
    h, w = img.shape[:2]
    if h * w > MAX_PIXELS:
        s = math.sqrt(MAX_PIXELS / (h * w))
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
    if max(h, w) > 2400:                       # huge phone photo -> shrink
        s = 2400 / max(h, w)
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    elif min(h, w) < 900:                      # small scan / thumbnail -> upscale
        s = min(2.5, 1400 / min(h, w))
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_CUBIC)
    return img

def _deskew(gray):
    """Estimate text skew via minAreaRect over dark pixels; rotate to level."""
    import numpy as np, cv2
    bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    ys, xs = np.nonzero(bw)
    if len(xs) < 50:
        return gray, 0.0
    rect = cv2.minAreaRect(np.column_stack([xs, ys]).astype(np.float32))
    ang = rect[2]
    if ang > 45: ang -= 90
    if ang < -45: ang += 90
    if abs(ang) < 0.3 or abs(ang) > 20:
        return gray, 0.0
    h, w = gray.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    rot = cv2.warpAffine(gray, M, (w, h), flags=cv2.INTER_CUBIC,
                         borderMode=cv2.BORDER_REPLICATE)
    return rot, round(ang, 2)

def make_variants(img):
    """Return [(name, BGR image), ...] best-first candidates for OCR."""
    import numpy as np, cv2
    img = _resize_sane(img)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    dgray, _ang = _deskew(gray)

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(dgray)
    den = cv2.fastNlMeansDenoising(dgray, None, 10, 7, 21)
    otsu = cv2.threshold(den, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    blur = cv2.GaussianBlur(dgray, (0, 0), 3)
    sharp = cv2.addWeighted(dgray, 1.6, blur, -0.6, 0)
    adap = cv2.adaptiveThreshold(den, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY, 35, 15)

    bgr = lambda g: cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
    return [
        ('clahe',    bgr(clahe)),       # best general-purpose for bills
        ('sharp',    bgr(sharp)),
        ('otsu',     bgr(otsu)),
        ('adaptive', bgr(adap)),
        ('color',    img),              # last resort: untouched photo
    ]

# ---------------------------------------------------------------------------
# OCR + geometry-aware reading order
# ---------------------------------------------------------------------------
def _score(result):
    if not result:
        return 0.0
    return sum(len(r[1]) * float(r[2]) for r in result)

def _reading_order(result):
    """Cluster boxes into lines by vertical overlap, sort left->right."""
    rows = []
    for box, txt, conf in result:
        ys = [p[1] for p in box]; xs = [p[0] for p in box]
        rows.append({'cy': sum(ys) / 4, 'x0': min(xs), 'h': max(ys) - min(ys),
                     'text': txt})
    rows.sort(key=lambda r: (r['cy'], r['x0']))
    lines, cur, cur_y = [], [], None
    for r in rows:
        tol = max(10.0, (r['h'] or 12) * 0.65)
        if cur_y is None or abs(r['cy'] - cur_y) <= tol:
            cur.append(r)
            cur_y = r['cy'] if cur_y is None else (cur_y * 0.7 + r['cy'] * 0.3)
        else:
            cur.sort(key=lambda q: q['x0'])
            lines.append(' '.join(q['text'] for q in cur))
            cur, cur_y = [r], r['cy']
    if cur:
        cur.sort(key=lambda q: q['x0'])
        lines.append(' '.join(q['text'] for q in cur))
    return '\n'.join(lines)

def ocr_page(img):
    """Run OCR over preprocessing variants, keep the best-scoring one."""
    variants = make_variants(img)
    best_name, best_res, best_score = variants[0][0], None, -1.0
    tried = []
    for name, v in variants:
        result, _ = get_ocr()(v)
        sc = _score(result)
        tried.append((name, round(sc, 1)))
        if sc > best_score:
            best_name, best_res, best_score = name, result, sc
        # clean bill of text already? skip the remaining variants (speed)
        if best_score > 400 and result and min(float(r[2]) for r in result) > 0.85:
            break
    if not best_res:
        return '', best_name, tried
    return _reading_order(best_res), best_name, tried

# ---------------------------------------------------------------------------
# field extraction (tolerant of OCR misreads)
# ---------------------------------------------------------------------------
GSTIN_RE  = re.compile(r'\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[Zz][A-Z\d])\b')
GSTIN_FUZZY = re.compile(r'\b([0-9O]{2}[A-Z]{5}[0-9O]{4}[A-Z][0-9O1][Zz2][A-Z0-9O])\b')
PHONE_RE  = re.compile(r'(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})')
AMOUNT    = r'([\d,]+(?:\.\d{1,2})?)'
DATE_RES  = [
    re.compile(r'(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})'),
    re.compile(r'(\d{1,2})[\s-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,.-]*(\d{2,4})', re.I),
    re.compile(r'(\d{4})-(\d{1,2})-(\d{1,2})'),
]
INVNO_RES = [
    re.compile(r'(?:invoice|inv|bill|voucher)\s*(?:no|number|num|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{1,25})', re.I),
    re.compile(r'\bno\s*[:.\-#]\s*([A-Z0-9][A-Z0-9/\-]{2,25})\b', re.I),
]
TOTAL_RES = [
    re.compile(r'(?:grand\s*total|net\s*(?:amount|payable)|amount\s*payable|invoice\s*(?:value|total)|bill\s*amount|total\s*amount|balance\s*due)\D{0,15}(?:rs\.?|inr|₹)?\s*' + AMOUNT, re.I),
    re.compile(r'(?:^|\s)total\D{0,10}(?:rs\.?|inr|₹)\s*' + AMOUNT, re.I),
    re.compile(r'(?:^|\s)total\s*[:]?\s*' + AMOUNT + r'\s*$', re.I),
]
MONTHS = {m.lower(): i for i, m in enumerate(
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], 1)}

def _fix_gstin(g):
    """Repair common OCR confusions positionally: O->0 in digit slots, 1->I etc."""
    g = g.upper()
    ch = list(g)
    for i in (0, 1, 7, 8, 9, 10, 12):
        if ch[i] == 'O': ch[i] = '0'
    if ch[11] in '0O': ch[11] = 'Z'
    if ch[11] == '2': ch[11] = 'Z'
    out = ''.join(ch)
    return out if GSTIN_RE.search(out) else g

def norm_date(dd, mm, yy):
    dd = int(dd)
    if isinstance(mm, str) and not mm.isdigit():
        k = mm.lower()[:3]
        if k not in MONTHS: return None
        mm = MONTHS[k]
    mm = int(mm); yy = int(yy)
    if yy < 100: yy += 2000
    if not (1 <= mm <= 12 and 1 <= dd <= 31 and 2000 <= yy <= 2100): return None
    return '%04d-%02d-%02d' % (yy, mm, dd)

def find_dates(line):
    out = []
    for i, rx in enumerate(DATE_RES):
        for m in rx.finditer(line):
            try:
                if i == 2: d = norm_date(m.group(3), m.group(2), m.group(1))
                else:      d = norm_date(m.group(1), m.group(2), m.group(3))
            except Exception:
                d = None
            if d: out.append(d)
    return out

def _amount_to_float(a):
    try: return float(str(a).replace(',', ''))
    except Exception: return 0.0

def extract_fields(text):
    lines = [re.sub(r'\s+', ' ', l).strip() for l in text.splitlines() if l.strip()]
    joined = '\n'.join(lines)
    f = {}

    g = GSTIN_RE.search(joined)
    if not g:
        g2 = GSTIN_FUZZY.search(joined)
        if g2: f['gstin'] = _fix_gstin(g2.group(1))
    else:
        f['gstin'] = g.group(1).upper()

    ph = PHONE_RE.search(joined)
    if ph: f['phone'] = ph.group(1).replace(' ', '').replace('-', '')

    for l in lines:
        for rx in INVNO_RES:
            m = rx.search(l)
            if m:
                cand = m.group(1).strip(' .-/')
                if cand and not re.fullmatch(r'\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}', cand):
                    f['invoiceNumber'] = cand
                    break
        if 'invoiceNumber' in f: break

    for l in lines:
        if re.search(r'invoice\s*date|bill\s*date|dated|^date\s*[:/]', l, re.I):
            ds = find_dates(l)
            if ds: f['invoiceDate'] = ds[0]; break
    if 'invoiceDate' not in f:
        for l in lines:
            ds = find_dates(l)
            if ds: f['invoiceDate'] = ds[0]; break

    for rx in TOTAL_RES:
        m = rx.search(joined)
        if m and _amount_to_float(m.group(1)) > 0:
            f['grandTotal'] = m.group(1); break
    if 'grandTotal' not in f:                      # largest amount in bottom 40%
        tail = lines[int(len(lines) * 0.6):]
        best = 0.0
        for l in tail:
            for m in re.finditer(AMOUNT, l):
                v = _amount_to_float(m.group(1))
                if v > best and v < 100_000_000: best = v
        if best > 0:
            f['grandTotal'] = ('%.2f' % best).rstrip('0').rstrip('.')

    skip = re.compile(r'tax\s*invoice|invoice|original|duplicate|e-?way|po\s*no|buyer|bill\s*to|credit\s*note', re.I)
    for l in lines:
        if skip.search(l) or len(l) < 4: continue
        if GSTIN_RE.search(l) and len(l) < 20: continue
        f['vendor'] = re.sub(r'\s*(gstin|ph|phone|mob).*', '', l, flags=re.I).strip(' ,-') or l
        break

    addr = re.compile(r'(plot|road|street|area|sector|industr|nagar|layout|district|bengaluru|bangalore|mumbai|chennai|\b\d{6}\b)', re.I)
    for l in lines[1:7]:
        if addr.search(l) and not GSTIN_RE.search(l) and not PHONE_RE.search(l):
            f['address'] = l; break
    if 'address' not in f:
        for l in lines[1:7]:
            if addr.search(l):
                f['address'] = re.sub(GSTIN_RE, '', re.sub(PHONE_RE, '', l)).strip(' ,-')
                break

    for i, l in enumerate(lines):
        if re.search(r'buyer|bill\s*to|consignee|ship(ped)?\s*to', l, re.I):
            rest = re.sub(r'^(buyer|bill\s*to|consignee|ship(ped)?\s*to)\s*[:.]?\s*', '', l, flags=re.I)
            if len(rest) > 3: f['buyer'] = rest
            elif i + 1 < len(lines): f['buyer'] = lines[i + 1]
            break
    return f

# ---------------------------------------------------------------------------
# full pipeline
# ---------------------------------------------------------------------------
def run_pipeline(data_url):
    raw, mime = decode_data_url(data_url)
    pages = load_pages(raw, mime)
    all_text, all_fields, used, tried = [], {}, [], []
    for pg in pages:
        text, variant, tr = ocr_page(pg)
        used.append(variant); tried.extend(tr)
        if text.strip():
            all_text.append(text)
    text = '\n'.join(all_text)
    fields = extract_fields(text) if text.strip() else {}
    return {
        'ok': True, 'engine': 'rapidocr-ppocrv4+opencv', 'version': VERSION,
        'pages': len(pages), 'variant': ','.join(sorted(set(used))),
        'text': text, 'fields': fields,
    }

# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------
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
            return self._send(200, {'ok': True, 'engine': 'rapidocr-ppocrv4+opencv', 'version': VERSION})
        self._send(404, {'ok': False, 'error': 'unknown path'})
    def do_POST(self):
        if not self.path.startswith('/ocr'):
            return self._send(404, {'ok': False, 'error': 'unknown path'})
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n > 60_000_000:
                return self._send(413, {'ok': False, 'error': 'file too large (keep PDFs/photos under ~40 MB)'})
            body = json.loads(self.rfile.read(n) or b'{}')
            data_url = body.get('image', '')
            if not data_url:
                return self._send(400, {'ok': False, 'error': 'body must be {"image":"data:...;base64,...."}'})
            return self._send(200, run_pipeline(data_url))
        except Exception as e:
            return self._send(500, {'ok': False, 'error': str(e)})

if __name__ == '__main__':
    print('MEGAVERKS OCR server v%s (OpenCV pipeline + PP-OCRv4, images & PDF) on port %s' % (VERSION, PORT))
    ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
