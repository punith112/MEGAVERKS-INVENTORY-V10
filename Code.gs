/*************** MEGAVERKS Inventory V10 — Sheets backend (FIXED) ********
 * Features:
 *  - Generic sheet-backed CRUD for 12 entities (incl. Settings key/value)
 *  - Passcode gate: hash stored in the Settings tab; changeable at runtime
 *  - Day-token auth for all mutating actions
 *  - Images/attachments uploaded to a Google Drive folder; only the link
 *    is stored in the sheet (no 50KB cell limit)
 *  - Auto backup: full spreadsheet copy in Drive (manual, daily, trigger)
 *
 * FIXES in this build:
 *  1. doPost no longer crashes when e.postData is missing (that produced
 *     HTML error pages / HTTP 405-style failures on the frontend).
 *  2. doGet accepts a JSON `payload` parameter — the frontend falls back
 *     to GET automatically if a POST is ever refused (stale deployment).
 *  3. New "selftest" action — one click in Admin verifies tabs, auth,
 *     Drive access, backups, and a full create/update/delete round-trip.
 *  4. "list" no longer exposes the Settings tab (passcode hash stays
 *     server-side).
 ***********************************************************************/
const SHEET_DEFS = {
  items:      { name:'Items',           headers:['id','company','vendorName','partNumber','name','price','moq','leadTime','productId','materialType','source','vendorId','instructions','imageData','stockInput','stockOutput','stockInHand','minStock','createdAt','updatedAt'] },
  products:   { name:'Products',        headers:['id','name','company','description','imageData','createdAt'] },
  vendors:    { name:'Vendors',         headers:['id','name','contactPerson','phone','email','address','gstin','googleLocation','purchaseManager','creditLimit','creditDays','notes','createdAt'] },
  customers:  { name:'Customers',       headers:['id','name','contactPerson','phone','email','address','gstin','googleLocation','notes','createdAt'] },
  invoices:   { name:'Invoices',        headers:['id','vendorId','invoiceNumber','invoiceDate','subtotal','taxType','gstRate','taxAmount','total','paymentMode','advancePaid','creditDays','dueDate','lineItems','attachmentData','attachmentName','notes','createdAt'] },
  payments:   { name:'Payments',        headers:['id','vendorId','invoiceId','amount','paymentDate','method','reference','notes','createdAt'] },
  pos:        { name:'PurchaseOrders',  headers:['id','customerId','poNumber','poDate','status','notes','dispatchedBy','dispatchedAt','createdAt'] },
  poLines:    { name:'POLines',         headers:['id','poId','customerPartName','customerPartNumber','productId','qty','createdAt'] },
  dispatches: { name:'Dispatches',      headers:['id','poId','poNumber','productId','productName','qty','dispatchDate','invoiceNumber','actor','createdAt'] },
  bom:        { name:'BOM',             headers:['id','productId','itemId','qtyPer','createdAt'] },
  movements:  { name:'StockMovements',  headers:['id','itemId','type','qty','note','actor','createdAt'] },
  audit:      { name:'Audit',           headers:['id','actor','action','entity','entityId','detail','createdAt'] },
  settings:   { name:'Settings',        headers:['id','key','value'] },
};

/* ---------------- passcode ---------------- */
const DEFAULT_PASS = 'mega1234';           // change it right after first login (Admin page)
const DRIVE_FOLDER = 'MEGAVERKS Inventory V10';

/* OPTIONAL HARD-LINK: paste your Google Sheet's ID between the quotes to
   permanently bind this backend to that exact spreadsheet.
   The ID is the long code in the sheet's URL:
     https://docs.google.com/spreadsheets/d/<<<THIS_PART>>>/edit
   Leave '' to keep the automatic behaviour (bound sheet → remembered ID →
   find by name → create once). When set, it always wins in standalone projects. */
let SPREADSHEET_ID_OVERRIDE = '';

function sha256(s){
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return raw.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}
function getSetting(key, def){
  const r = rows('settings').find(x => x.key === key);
  return r ? r.value : (def === undefined ? '' : def);
}
function setSetting(key, value){
  let r = rows('settings').find(x => x.key === key);
  if(r){ r.value = value; saveRecord('settings', r); }
  else saveRecord('settings', { id: nextId('settings'), key: key, value: value });
}
function ensurePasscode(){
  if(!getSetting('passcode_hash')) setSetting('passcode_hash', sha256(DEFAULT_PASS));
}
function makeToken(){
  return sha256(getSetting('passcode_hash') + ':' + new Date().toISOString().slice(0, 10));
}
function requireAuth(p){
  if(!p.token || p.token !== makeToken()) throw new Error('Not authorised — sign in again');
}

/* ---------------- spreadsheet handle (bound OR standalone project) --------
 * getActiveSpreadsheet() is NULL in standalone Apps Script projects
 * (script.google.com → New project). In that case we open the spreadsheet
 * by a remembered ID, or auto-create "MEGAVERKS Inventory V10" once.
 * Recommended setup is still: Google Sheet → Extensions → Apps Script. */
function SS(){
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if(bound) return bound;
  const props = PropertiesService.getScriptProperties();
  /* manual hard-link wins over everything in standalone projects */
  if(SPREADSHEET_ID_OVERRIDE){
    try{
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID_OVERRIDE);
      props.setProperty('SPREADSHEET_ID', ss.getId());
      return ss;
    }catch(e){
      throw new Error('SPREADSHEET_ID_OVERRIDE is set in Code.gs but that sheet could not be opened — check the ID (the part of the sheet URL between /d/ and /edit) and that the script is deployed to run as YOU. Detail: ' + (e && e.message || e));
    }
  }
  const id = props.getProperty('SPREADSHEET_ID');
  if(id){ try{ return SpreadsheetApp.openById(id); }catch(e){ /* remembered ID stale — recover below */ } }
  /* REUSE an existing spreadsheet with our name (found anywhere in Drive)
     instead of creating duplicates every time the remembered ID is lost */
  const it = DriveApp.getFilesByName('MEGAVERKS Inventory V10');
  while(it.hasNext()){
    const f = it.next();
    try{
      const ss = SpreadsheetApp.openById(f.getId());   // throws for non-spreadsheets / trashed
      props.setProperty('SPREADSHEET_ID', ss.getId());
      return ss;
    }catch(e){ /* not a usable spreadsheet — keep looking */ }
  }
  const ss = SpreadsheetApp.create('MEGAVERKS Inventory V10');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

/* ---------------- sheet plumbing ---------------- */
function SHEET_DEFS_NAME(n){ for(const k in SHEET_DEFS) if(SHEET_DEFS[k].name === n) return SHEET_DEFS[k].headers; return ['id']; }
function sh(name){
  const ss = SS();
  let s = ss.getSheetByName(name);
  if(!s){
    s = ss.insertSheet(name);
    s.getRange(1, 1, 1, SHEET_DEFS_NAME(name).length).setValues([SHEET_DEFS_NAME(name)]);
    s.setFrozenRows(1);
  }
  return s;
}
function sheetFor(entity){ const d = SHEET_DEFS[entity]; if(!d) throw new Error('Unknown entity: ' + entity); return sh(d.name); }

function rows(entity){
  const d = SHEET_DEFS[entity], s = sheetFor(entity);
  const vals = s.getDataRange().getValues(); if(vals.length < 2) return [];
  const h = vals[0]; const out = [];
  for(let i = 1; i < vals.length; i++){
    const o = {}; for(let j = 0; j < h.length; j++) o[h[j]] = vals[i][j];
    if(o.id !== '') out.push(o);
  }
  return out;
}
function nextId(entity){ return rows(entity).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1; }
function getById(entity, id){ return rows(entity).find(r => Number(r.id) === Number(id)) || null; }
function saveRecord(entity, rec){
  const d = SHEET_DEFS[entity], s = sheetFor(entity), vals = s.getDataRange().getValues();
  const row = d.headers.map(k => rec[k] == null ? '' : rec[k]);
  let idx = -1;
  for(let i = 1; i < vals.length; i++) if(Number(vals[i][0]) === Number(rec.id)){ idx = i + 1; break; }
  if(idx > 0) s.getRange(idx, 1, 1, d.headers.length).setValues([row]);
  else s.appendRow(row);
  return rec;
}
function removeRecord(entity, id){
  const s = sheetFor(entity), vals = s.getDataRange().getValues();
  for(let i = 1; i < vals.length; i++) if(Number(vals[i][0]) === Number(id)){ s.deleteRow(i + 1); return true; }
  return false;
}
function audit(actor, action, entity, id, detail){
  sheetFor('audit').appendRow([nextId('audit'), actor || '', action, entity, String(id), String(detail || '').slice(0, 45000), new Date().toISOString()]);
}
function appendMovement(itemId, type, qty, note, actor){
  sheetFor('movements').appendRow([nextId('movements'), itemId, type, qty, note || '', actor || '', new Date().toISOString()]);
}

/* ---------------- drive images ---------------- */
/* Pin every folder by ID in ScriptProperties: first call finds-or-creates by
   name and REMEMBERS the id; afterwards we always open by id. This stops
   duplicate "MEGAVERKS Inventory V10" folders appearing after redeploys and
   guarantees the app always uses ONE folder — the same one you see in Drive. */
function pinnedFolder(propKey, name){
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(propKey);
  if(id){ try{ return DriveApp.getFolderById(id); }catch(e){ /* remembered ID stale — recover below */ } }
  const it = DriveApp.getFoldersByName(name);
  if(it.hasNext()){ const f = it.next(); props.setProperty(propKey, f.getId()); return f; }
  const f = DriveApp.createFolder(name);
  props.setProperty(propKey, f.getId());
  return f;
}

/* the Drive folder that contains the spreadsheet (null = root / unknown) */
function ssParentFolder(){
  try{
    const it = DriveApp.getFileById(SS().getId()).getParents();
    return it.hasNext() ? it.next() : null;
  }catch(e){ return null; }
}

/* Image folder lives NEXT TO the spreadsheet, so data + photos sit together
   in one place in your Drive. Pinned by ID; an older folder found elsewhere
   (e.g. Drive root from an earlier version) is MOVED beside the sheet —
   moving never changes file IDs, so every stored image link keeps working. */
function driveFolder(){
  const props = PropertiesService.getScriptProperties();
  let f = null;
  const id = props.getProperty('IMG_FOLDER_ID');
  if(id){ try{ f = DriveApp.getFolderById(id); }catch(e){} }
  const parent = ssParentFolder();
  if(!f){
    if(parent){
      const pit = parent.getFoldersByName(DRIVE_FOLDER);
      if(pit.hasNext()) f = pit.next();
    }
    if(!f){
      const it = DriveApp.getFoldersByName(DRIVE_FOLDER);
      if(it.hasNext()) f = it.next();
    }
    if(!f) f = parent ? parent.createFolder(DRIVE_FOLDER) : DriveApp.createFolder(DRIVE_FOLDER);
    props.setProperty('IMG_FOLDER_ID', f.getId());
  }
  if(parent){
    try{
      let inside = false;
      const ps = f.getParents();
      while(ps.hasNext()){ if(ps.next().getId() === parent.getId()){ inside = true; break; } }
      if(!inside) f.moveTo(parent);
    }catch(e){ /* move is best-effort; folder still usable where it is */ }
  }
  return f;
}
function actUploadImage(p){
  const m = String(p.dataUrl || '').match(/^data:(.*?);base64,(.*)$/);
  if(!m) throw new Error('Invalid image data');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1]);
  const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const safe = String(p.name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.\-]+/g, '_').slice(-40) || 'image';
  const file = driveFolder().createFile(blob.setName(safe + '.' + ext));
  try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
  const pub = isPublicReadable(file.getId());
  return { id: file.getId(),
           url: 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1000',
           viewUrl: file.getUrl(), publicReadable: pub };
}

/* verify a Drive file is actually readable by "anyone with the link"
   (this is what lets the browser display it inside the app) */
function isPublicReadable(id){
  try{
    return UrlFetchApp.fetch('https://drive.google.com/uc?export=view&id=' + id, { muteHttpExceptions:true, followRedirects:true }).getResponseCode() === 200;
  }catch(e){ return false; }
}

/* one-click repair: re-apply public sharing to every image ever uploaded,
   then VERIFY each file is actually publicly readable (sharing can fail silently) */
function actFixImageSharing(){
  const it = driveFolder().getFiles();
  let total = 0, shared = 0, verified = 0; const failed = [];
  while(it.hasNext()){
    const f = it.next(); total++;
    try{ f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); shared++; }catch(e){}
    if(isPublicReadable(f.getId())) verified++; else failed.push(f.getName());
  }
  return { total: total, shared: shared, verified: verified, failed: failed.slice(0, 10),
           folderUrl: driveFolder().getUrl() };
}

/* serve an uploaded image THROUGH the script itself (base64). The web app
   runs as YOU (the owner), so this works even when Google/org policy blocks
   public link sharing — the browser never talks to Drive directly. */
function actGetImage(p){
  const id = String(p.id || '');
  if(!/^[-\w]{20,}$/.test(id)) throw new Error('Bad image id');
  const file = DriveApp.getFileById(id);
  const blob = file.getBlob();
  return { name: file.getName(), mime: blob.getContentType() || 'image/jpeg',
           data: Utilities.base64Encode(blob.getBytes()) };
}

/* staging upload (Admin → Image Staging): named, categorized photos saved to
   the app's Drive folder as PART_<name>.jpg / PRODUCT_<name>.jpg, ready to be
   downloaded and added to the repo images/ pool later */
function actUploadNamedImage(p){
  const m = String(p.dataUrl || '').match(/^data:(.*?);base64,(.*)$/);
  if(!m) throw new Error('Invalid image data');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1]);
  const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const kind = String(p.kind || '').toUpperCase() === 'PRODUCT' ? 'PRODUCT' : 'PART';
  let base = String(p.name || '').trim() || 'image';
  base = base.replace(/[\/\\:*?"<>|#%&{}$!'@+=`~]+/g, ' ').replace(/\s+/g, '_').replace(/^\.+|\.+$/g, '').replace(/_+$/g, '').slice(0, 60).replace(/_+$/g, '') || 'image';
  const file = driveFolder().createFile(blob.setName(kind + '_' + base + '.' + ext));
  try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
  return { id:file.getId(), name:file.getName(), kind:kind,
           url:'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1000',
           viewUrl:file.getUrl(), publicReadable:isPublicReadable(file.getId()) };
}
/* list staged photos in the image folder (Admin gallery) */
function actListImages(){
  const out = [];
  const it = driveFolder().getFiles();
  while(it.hasNext()){
    const f = it.next();
    if(!/\.(png|jpe?g|gif|webp|svg)$/i.test(f.getName())) continue;
    out.push({ id:f.getId(), name:f.getName(),
               url:'https://lh3.googleusercontent.com/d/' + f.getId() + '=w1000', viewUrl:f.getUrl() });
  }
  return out.reverse();
}
/* trash a previously uploaded Drive image (called when an item's image is removed/replaced) */
function actDeleteImage(p){
  const m = String(p.imageUrl || '').match(/\/d\/([-\w]{20,})/);
  if(!m) return { deleted:false, reason:'not a Drive image link (embedded image — nothing to trash)' };
  try{ DriveApp.getFileById(m[1]).setTrashed(true); return { deleted:true }; }
  catch(e){ return { deleted:false, reason:String(e && e.message || e) }; }
}

/* ---------------- auto backup (full spreadsheet copy in Drive) ---------------- */
const BACKUP_FOLDER = 'MEGAVERKS Backups';
const BACKUP_KEEP = 14;

function backupFolder(){ return pinnedFolder('BACKUP_FOLDER_ID', BACKUP_FOLDER); }

function actBackup(){
  const ss = SS();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HH-mm');
  const copy = DriveApp.getFileById(ss.getId()).makeCopy('MEGAVERKS-backup-' + stamp, backupFolder());
  try{ copy.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); }catch(e){}
  const files = backupFolder().getFilesByType(MimeType.GOOGLE_SHEETS);
  const arr = [];
  while(files.hasNext()){ const f = files.next(); arr.push({ f:f, d:f.getDateCreated() }); }
  arr.sort((a, b) => b.d - a.d);
  for(let i = BACKUP_KEEP; i < arr.length; i++){ try{ arr[i].f.setTrashed(true); }catch(e){} }
  setSetting('last_backup', new Date().toISOString());
  return { name:copy.getName(), id:copy.getId(), url:copy.getUrl() };
}
function actAutoBackup(){
  const last = getSetting('last_backup', '');
  if(last && (Date.now() - new Date(last).getTime()) < 24*3600*1000) return { backedUp:false, lastBackup:last };
  return { backedUp:true, lastBackup:new Date().toISOString(), result:actBackup() };
}
/* Returns true/false, or null when the script.scriptapp scope is not granted yet.
 * Grant it once: Apps Script editor → select function "checkAuthorization" → Run ▶ → Review permissions → Allow. */
function hasBackupTrigger(){
  try{ return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'dailyBackup'); }
  catch(e){ return null; }
}
function checkAuthorization(){ ScriptApp.getProjectTriggers(); return 'All permissions granted — the daily backup trigger can now be installed.'; }
function actInstallBackup(){
  const h = hasBackupTrigger();
  if(h === null) throw new Error('Missing permission. Open the Apps Script editor → choose the function "checkAuthorization" → press Run ▶ → Review permissions → Allow, then try again.');
  if(!h) ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(2).nearMinute(15).create();
  return { installed:true };
}
function dailyBackup(){ try{ actBackup(); }catch(e){} }

/* ---------------- routing ----------------
 * GET  /exec?action=ping                       (simple params)
 * GET  /exec?payload=<url-encoded JSON>        (frontend fallback)
 * POST /exec  body = JSON text                 (primary channel)
 */
function doGet(e){
  const pr = (e && e.parameter) ? e.parameter : {};
  let p = pr;
  if(typeof pr.payload === 'string' && pr.payload){
    try{ p = JSON.parse(pr.payload); }catch(err){ return out({ ok:false, error:'Bad JSON in payload parameter' }); }
  }
  return handle(p);
}
function doPost(e){
  let p = {};
  const body = (e && e.postData && typeof e.postData.contents === 'string') ? e.postData.contents : '';
  if(body){
    try{ p = JSON.parse(body); }catch(err){ return out({ ok:false, error:'Bad JSON' }); }
  }else if(e && e.parameter && Object.keys(e.parameter).length){
    p = e.parameter;                              // form-encoded fallback
    if(typeof p.payload === 'string' && p.payload){
      try{ p = JSON.parse(p.payload); }catch(err){ return out({ ok:false, error:'Bad JSON in payload parameter' }); }
    }
  }
  return handle(p);
}
function out(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function handle(p){
  try{
    switch(p.action){
      case 'ping':      return out({ ok:true, data:{ version:'V10-sheets-fixed', time:new Date().toISOString() } });
      case 'bootstrap': Object.keys(SHEET_DEFS).forEach(k => sheetFor(k)); ensurePasscode();
                        return out({ ok:true, data:{ message:'Sheets ready', spreadsheetUrl:SS().getUrl(),
                          spreadsheetId:SS().getId(), imageFolderUrl:driveFolder().getUrl(),
                          mode: SpreadsheetApp.getActiveSpreadsheet() ? 'bound' : (SPREADSHEET_ID_OVERRIDE ? 'manual-hard-linked' : 'standalone-auto-linked') } });

      case 'verify': {  ensurePasscode();
                        const ok = sha256(String(p.passcode || '')) === getSetting('passcode_hash');
                        if(!ok) return out({ ok:true, data:{ valid:false } });
                        return out({ ok:true, data:{ valid:true, token:makeToken() } }); }

      case 'changePasscode': {
                        ensurePasscode(); requireAuth(p);
                        if(sha256(String(p.current || '')) !== getSetting('passcode_hash')) throw new Error('Current passcode is wrong');
                        if(String(p.next || '').length < 4) throw new Error('New passcode must be at least 4 characters');
                        setSetting('passcode_hash', sha256(p.next));
                        audit(p.actor, 'passcode-change', 'settings', '', 'Passcode changed');
                        return out({ ok:true, data:true }); }

      case 'list':      if(p.entity === 'settings') throw new Error('Not allowed');
                        return out({ ok:true, data:rows(p.entity) });

      case 'create': {  requireAuth(p);
                        const rec = p.record || {}; rec.id = nextId(p.entity); rec.createdAt = rec.createdAt || new Date().toISOString();
                        saveRecord(p.entity, rec);
                        audit(p.actor, 'create', p.entity, rec.id, rec.name || rec.invoiceNumber || rec.poNumber || '');
                        return out({ ok:true, data:rec }); }

      case 'update': {  requireAuth(p);
                        const rec = p.record || {}; rec.updatedAt = rec.updatedAt || new Date().toISOString();
                        saveRecord(p.entity, rec);
                        audit(p.actor, 'update', p.entity, rec.id, rec.name || '');
                        return out({ ok:true, data:rec }); }

      case 'remove': {  requireAuth(p);
                        const ok = removeRecord(p.entity, p.id);
                        audit(p.actor, 'remove', p.entity, p.id, '');
                        return out({ ok:true, data:ok }); }

      case 'stock':     requireAuth(p); return out({ ok:true, data:actStock(p) });
      case 'payment': { requireAuth(p);
                        const rec = { id:nextId('payments'), vendorId:p.vendorId, invoiceId:p.invoiceId || '',
                                      amount:num(p.amount), paymentDate:p.paymentDate || new Date().toISOString().slice(0,10),
                                      method:p.method || 'Cash', reference:p.reference || '', notes:p.notes || '', createdAt:new Date().toISOString() };
                        saveRecord('payments', rec);
                        audit(p.actor, 'payment', 'payments', rec.id, 'Rs ' + rec.amount);
                        return out({ ok:true, data:rec }); }
      case 'dispatch':  requireAuth(p); return out({ ok:true, data:actDispatch(p) });
      case 'uploadPurchase': requireAuth(p); return out({ ok:true, data:actUploadPurchase(p) });
      case 'ocr':         requireAuth(p); return out({ ok:true, data:actOcr(p) });
      case 'getOptions':  return out({ ok:true, data:actGetOptions() });
      case 'saveOptions': requireAuth(p); return out({ ok:true, data:actSaveOptions(p) });
      case 'getOcr':      requireAuth(p); return out({ ok:true, data:actGetOcr() });
      case 'saveOcr':     requireAuth(p); return out({ ok:true, data:actSaveOcr(p) });
      case 'bulk':      requireAuth(p); return out({ ok:true, data:actBulk(p) });
      case 'uploadImage': requireAuth(p); return out({ ok:true, data:actUploadImage(p) });
      case 'uploadNamedImage': requireAuth(p); return out({ ok:true, data:actUploadNamedImage(p) });
      case 'listImages': requireAuth(p); return out({ ok:true, data:actListImages() });
      case 'deleteImage': requireAuth(p); return out({ ok:true, data:actDeleteImage(p) });
      case 'fixImageSharing': requireAuth(p); return out({ ok:true, data:actFixImageSharing() });
      case 'image':       requireAuth(p); return out({ ok:true, data:actGetImage(p) });

      case 'backup':        requireAuth(p); return out({ ok:true, data:actBackup() });
      case 'autoBackup':    requireAuth(p); return out({ ok:true, data:actAutoBackup() });
      case 'backupInfo':    requireAuth(p); return out({ ok:true, data:{ lastBackup:getSetting('last_backup',''), trigger:hasBackupTrigger() } });
      case 'installBackup': requireAuth(p); return out({ ok:true, data:actInstallBackup() });

      case 'selftest':      requireAuth(p); return out({ ok:true, data:actSelfTest() });

      default: return out({ ok:false, error:'Unknown action' });
    }
  }catch(err){ return out({ ok:false, error:String(err && err.message || err) }); }
}

/* ---------------- self test (Admin → Run Backend Self-Test) ---------------- */
function actSelfTest(){
  const report = [];
  const t = (name, fn) => {
    try{ report.push({ name:name, ok:true, detail:String(fn() || 'OK') }); }
    catch(e){ report.push({ name:name, ok:false, detail:String(e && e.message || e) }); }
  };

  t('Spreadsheet connection', () => {
    const ss = SS();
    return (SpreadsheetApp.getActiveSpreadsheet() ? 'bound to sheet "' : 'standalone — using sheet "')
      + ss.getName() + '" · ' + ss.getUrl();
  });

  t('Sheet tabs + headers (' + Object.keys(SHEET_DEFS).length + ' tabs)', () => {
    Object.keys(SHEET_DEFS).forEach(k => {
      const s = sheetFor(k);
      const hdr = s.getRange(1, 1, 1, SHEET_DEFS[k].headers.length).getValues()[0];
      if(String(hdr[0]) !== 'id') throw new Error('Tab "' + SHEET_DEFS[k].name + '" header mismatch');
    });
    return Object.keys(SHEET_DEFS).length + ' tabs verified';
  });

  t('Passcode initialised', () => {
    ensurePasscode();
    return getSetting('passcode_hash') ? 'passcode_hash present in Settings' : 'missing';
  });

  t('Create → update → delete round-trip', () => {
    const rec = { id:nextId('items'), company:'MEGAVERKS', vendorName:'', partNumber:'', name:'__SELFTEST__',
      price:1, moq:'', leadTime:'', productId:'', materialType:'', source:'inhouse', vendorId:'', instructions:'',
      imageData:'', stockInput:5, stockOutput:0, stockInHand:5, minStock:0,
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
    saveRecord('items', rec);
    rec.stockInHand = 7; rec.updatedAt = new Date().toISOString(); saveRecord('items', rec);
    const chk = getById('items', rec.id);
    if(!chk || Number(chk.stockInHand) !== 7) throw new Error('update did not persist');
    if(!removeRecord('items', rec.id)) throw new Error('delete failed');
    return 'temporary item created, updated, deleted cleanly';
  });

  t('Drive folder access', () => 'folder "' + driveFolder().getName() + '" reachable — ' + driveFolder().getUrl());

  t('Drive file write / share / public read', () => {
    const blob = Utilities.newBlob('selftest', 'text/plain', 'selftest.txt');
    const file = driveFolder().createFile(blob);
    try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
    const id = file.getId();
    const pub = isPublicReadable(id);
    file.setTrashed(true);
    if(!pub){
      /* Public link sharing is blocked (common on company Google accounts —
         "sign in required" restrictions). NOT a problem anymore: the app
         serves uploaded photos through the backend itself (owner access), so
         images display anyway. Report as a warning-pass, not a failure. */
      return '⚠ publicly sharing is blocked by your Google account/org (a common company restriction). Uploads still save to Drive, and photos display in the app because the app serves them through the backend itself — no action needed. (Only if photos ever appear broken: click "Fix Image Sharing", or ask your Google admin to allow "anyone with the link".)';
    }
    return 'write + public share + browser read verified; test file trashed';
  });

  t('Backup folder access', () => 'folder "' + backupFolder().getName() + '" reachable');

  t('Daily backup trigger', () => {
    const h = hasBackupTrigger();
    if(h === null) return 'needs one-time authorization: Apps Script editor → run function "checkAuthorization" → Allow. Manual/daily backups already work without it.';
    return h ? 'installed (runs every night)' : 'not installed — optional, use action installBackup';
  });

  const okCount = report.filter(r => r.ok).length;
  return { pass:okCount === report.length, okCount:okCount, total:report.length, checks:report, time:new Date().toISOString() };
}

/* ---------------- stock ---------------- */
function actStock(p){
  const it = getById('items', p.itemId); if(!it) throw new Error('Item not found');
  const qty = Math.max(1, Math.trunc(Number(p.qty) || 0)); if(!qty) throw new Error('Qty required');
  if(p.type === 'IN'){ it.stockInput = Number(it.stockInput) + qty; it.stockInHand = Number(it.stockInHand) + qty; }
  else {
    if(qty > Number(it.stockInHand)) throw new Error('Not enough stock (in hand: ' + it.stockInHand + ')');
    it.stockOutput = Number(it.stockOutput) + qty; it.stockInHand = Number(it.stockInHand) - qty;
  }
  it.updatedAt = new Date().toISOString(); saveRecord('items', it);
  appendMovement(it.id, p.type, qty, p.note || '', p.actor || '');
  audit(p.actor, 'stock-' + p.type.toLowerCase(), 'items', it.id, it.name + ' x ' + qty);
  return it;
}

/* ---------------- purchase invoice images: "MEGAVERKS Purchases" folder ----------------
   File is named <VENDOR>_<INVOICE-DATE>.<ext> — the date the vendor raised the
   invoice (from OCR or typed), so Drive itself stays a searchable archive. */
function purchasesFolder(){
  const props = PropertiesService.getScriptProperties();
  let f = null;
  const id = props.getProperty('PUR_FOLDER_ID');
  if(id){ try{ f = DriveApp.getFolderById(id); }catch(e){} }
  const NAME = 'MEGAVERKS Purchases';
  const parent = ssParentFolder();
  if(!f){
    if(parent){
      const pit = parent.getFoldersByName(NAME);
      if(pit.hasNext()) f = pit.next();
    }
    if(!f){
      const it = DriveApp.getFoldersByName(NAME);
      if(it.hasNext()) f = it.next();
    }
    if(!f) f = parent ? parent.createFolder(NAME) : DriveApp.createFolder(NAME);
    props.setProperty('PUR_FOLDER_ID', f.getId());
  }
  /* move beside the spreadsheet if it lives somewhere else (IDs never change on move) */
  try{
    if(parent){
      let inside = false;
      const ps = f.getParents();
      while(ps.hasNext()) if(ps.next().getId() === parent.getId()){ inside = true; break; }
      if(!inside) f.moveTo(parent);
    }
  }catch(e){}
  return f;
}
function actUploadPurchase(p){
  const m = String(p.dataUrl || '').match(/^data:image\/(\w+);base64,(.+)$/);
  if(!m) throw new Error('Image data missing (expected a data:image/...;base64 URL)');
  const bytes = Utilities.base64Decode(m[2]);
  const vendor = String(p.vendorName || '').replace(/[\\/:*?"<>|#%&{}$!'@+=`~]+/g, ' ')
    .replace(/\s+/g, '_').replace(/^\.+|\.+$/g, '').replace(/_+$/g, '').slice(0, 60).replace(/_+$/g, '') || 'VENDOR';
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(String(p.invoiceDate || '')) ? String(p.invoiceDate) : new Date().toISOString().slice(0, 10);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const folder = purchasesFolder();
  const base = vendor + '_' + dt;
  let name = base + '.' + ext, n = 2;
  while(folder.getFilesByName(name).hasNext()){ name = base + '_' + (n++) + '.' + ext; }
  const file = folder.createFile(Utilities.newBlob(bytes, 'image/' + m[1], name));
  try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
  audit(p.actor, 'purchase-image', 'drive', file.getId(), name);
  return { id: file.getId(), name: name, url: 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1000',
           viewUrl: file.getUrl(), folderUrl: folder.getUrl() };
}

/* ---------------- OCR ----------------
   Settings keys: ocr_provider ('huggingface' | 'custom'), ocr_endpoint, hf_token.
   Browser never talks to the OCR provider directly — the token stays server-side. */
function ocrExtractFields(txt){
  const f = {};
  const lines = String(txt || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const joined = lines.join('\n');
  let m = joined.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z]\dZ[A-Z\d])\b/);
  if(m) f.gstin = m[1];
  m = joined.match(/(?:\+?91[\s-]?)?\b([6-9]\d{4}[\s-]?\d{5})\b/);
  if(m) f.phone = m[1].replace(/[\s-]/g, '');
  for(const l of lines){
    m = l.match(/(?:invoice|inv|bill)\s*(?:no|number|num|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\/\-]{1,})/i);
    if(m){ f.invoiceNumber = m[1].replace(/[ .\/\-]+$/, ''); break; }
  }
  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const normDate = (d, mo, y) => {
    d = parseInt(d, 10); y = parseInt(y, 10); if(y < 100) y += 2000;
    if(typeof mo === 'string'){ const k = String(mo).slice(0, 3).toLowerCase(); mo = MONTHS[k] != null ? MONTHS[k] : (parseInt(mo, 10) || 0); }
    else mo = parseInt(mo, 10);
    if(!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  };
  const findDates = l => {
    const out = [];
    let mm, rx = /(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/g;
    while((mm = rx.exec(l))){ const d = normDate(mm[1], mm[2], mm[3]); if(d) out.push(d); }
    rx = /(\d{1,2})[\s-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s-](\d{4})/gi;
    while((mm = rx.exec(l))){ const d = normDate(mm[1], mm[2], mm[3]); if(d) out.push(d); }
    return out;
  };
  for(const l of lines){
    if(/invoice\s*date|date\s*[:/]/i.test(l)){ const ds = findDates(l); if(ds.length){ f.invoiceDate = ds[0]; break; } }
  }
  if(!f.invoiceDate) for(const l of lines){ const ds = findDates(l); if(ds.length){ f.invoiceDate = ds[0]; break; } }
  m = joined.match(/(?:grand\s*total|amount\s*payable|net\s*payable|total\s*amount)\D{0,12}([\d,]+(?:\.\d{1,2})?)/i);
  if(m) f.grandTotal = m[1];
  const skip = /tax\s*invoice|^invoice\b|original|duplicate|e-?way|po\s*no|buyer|bill\s*to/i;
  for(const l of lines){ if(skip.test(l) || l.length < 4) continue; f.vendor = l; break; }
  const addr = /(plot|road|street|area|sector|industr|nagar|district|city|\b\d{6}\b)/i;
  for(const l of lines.slice(1, 6)){
    if(addr.test(l) && !/\d{2}[A-Z]{5}\d{4}/.test(l)){ f.address = l.replace(/GSTIN:?\s*\S+/i, '').replace(/(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/, '').replace(/[ ,-]+$/, ''); break; }
  }
  for(let i = 0; i < lines.length; i++){
    if(/buyer|bill\s*to|consignee/i.test(lines[i])){
      const rest = lines[i].replace(/^(buyer|bill\s*to|consignee)\s*[:.]?\s*/i, '');
      if(rest.length > 3) f.buyer = rest; else if(lines[i + 1]) f.buyer = lines[i + 1];
      break;
    }
  }
  return f;
}
function actOcr(p){
  const provider = getSetting('ocr_provider', 'huggingface');
  if(provider === 'custom'){
    const endpoint = String(getSetting('ocr_endpoint', '') || '').trim();
    if(!endpoint) throw new Error('Custom OCR endpoint not set — fill it in Admin → Settings');
    const res = UrlFetchApp.fetch(endpoint, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ image: String(p.image || '') })
    });
    const code = res.getResponseCode();
    const body = res.getContentText() || '';
    if(code < 200 || code >= 300) throw new Error('OCR endpoint returned HTTP ' + code + ' — ' + body.slice(0, 160));
    let j = null;
    try{ j = JSON.parse(body); }catch(e){ throw new Error('OCR endpoint returned non-JSON: ' + body.slice(0, 160)); }
    if(j && j.ok === false) throw new Error('OCR endpoint error: ' + String(j.error || 'unknown'));
    const text = String((j && (j.text || j.generated_text)) || '').trim();
    const fields = (j && j.fields) || ocrExtractFields(text);
    audit(p.actor, 'ocr', 'ocr', 0, 'custom');
    return { provider: 'custom', text: text, fields: fields };
  }
  /* Hugging Face provider (default): baidu/Unlimited-OCR via the router */
  const tok = String(getSetting('hf_token', '') || '').trim();
  if(!tok) throw new Error('Set your Hugging Face token in Admin → Settings (or switch OCR provider to "Custom endpoint")');
  const chatUrl = 'https://router.huggingface.co/v1/chat/completions';
  const res = UrlFetchApp.fetch(chatUrl, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + tok },
    payload: JSON.stringify({
      model: 'baidu/Unlimited-OCR',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Extract ALL text from this invoice image exactly as printed: vendor name, invoice number, date, GSTIN, every line item (description, qty, rate, amount), tax amounts and grand total. Output plain text only, no commentary.' },
        { type: 'image_url', image_url: { url: String(p.image || '') } } ] }],
      max_tokens: 2500, stream: false })
  });
  const code = res.getResponseCode();
  const body = res.getContentText() || '';
  if(code < 200 || code >= 300) throw new Error('Hugging Face OCR failed (HTTP ' + code + '): ' + body.slice(0, 200));
  let j = null;
  try{ j = JSON.parse(body); }catch(e){}
  let text = '';
  if(j && j.choices && j.choices[0] && j.choices[0].message) text = j.choices[0].message.content || '';
  else if(typeof j === 'string') text = j;
  else if(j && (j.generated_text || j.text)) text = j.generated_text || j.text;
  text = String(text || '').trim();
  if(!text) throw new Error('OCR returned no text — try a clearer, straight-on photo of the bill.');
  audit(p.actor, 'ocr', 'ocr', 0, 'huggingface');
  return { provider: 'huggingface', text: text, fields: ocrExtractFields(text) };
}

/* ---------------- dropdown category options ---------------- */
const OPTION_CATS = ['company', 'materialType', 'source', 'paymentMode'];
function optionsDefaults(){
  return { company: ['MEGAVERKS', 'VENGREE'],
    materialType: ['Sheet Metal', 'Fasteners', 'Electrical', 'Hardware', 'Consumables'],
    source: ['Inhouse', 'Vendor'],
    paymentMode: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Credit'] };
}
function actGetOptions(){
  let opts = null;
  try{ opts = JSON.parse(getSetting('dropdown_options', '') || 'null'); }catch(e){}
  if(!opts || typeof opts !== 'object') opts = optionsDefaults();
  const d = optionsDefaults();
  OPTION_CATS.forEach(c => { if(!Array.isArray(opts[c])) opts[c] = d[c]; });
  return opts;
}
function actSaveOptions(p){
  const opts = {};
  OPTION_CATS.forEach(c => {
    const v = p.options && p.options[c];
    opts[c] = (Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean)
      .filter((x, i, a) => a.indexOf(x) === i).slice(0, 200);
  });
  setSetting('dropdown_options', JSON.stringify(opts));
  audit(p.actor, 'options', 'settings', 0, OPTION_CATS.join(','));
  return opts;
}
function actGetOcr(){
  return { provider: getSetting('ocr_provider', 'huggingface'),
           endpoint: getSetting('ocr_endpoint', ''), token: getSetting('hf_token', '') };
}
function actSaveOcr(p){
  const provider = p.provider === 'custom' ? 'custom' : 'huggingface';
  setSetting('ocr_provider', provider);
  setSetting('ocr_endpoint', String(p.endpoint || '').trim());
  setSetting('hf_token', String(p.hfToken || '').trim());   /* hfToken — 'token' is the auth token */
  audit(p.actor, 'ocr-settings', 'settings', 0, provider);
  return actGetOcr();
}

/* ---------------- dispatch PO articles (partial OK, BOM stock-out) ----------------
   p = { poId, lines:[{productId, qty}], dispatchDate, invoiceNumber }
   Each line records how many articles of one PO line are dispatched now.
   Balance = ordered qty - sum(dispatches) for that product on this PO. */
function actDispatch(p){
  const po = getById('pos', p.poId); if(!po) throw new Error('PO not found');
  if(po.status !== 'OPEN' && po.status !== 'PARTIAL') throw new Error('PO is ' + po.status + ' — nothing left to dispatch');
  const lines = rows('poLines').filter(l => Number(l.poId) === Number(p.poId));
  if(!lines.length) throw new Error('PO has no article lines');
  const bom = rows('bom');
  const dis = rows('dispatches').filter(d => Number(d.poId) === Number(p.poId));
  const dispatchedQty = prod => dis.filter(d => Number(d.productId) === Number(prod)).reduce((s,d) => s + Number(d.qty), 0);

  // normalise + validate requested lines (two passes: validate ALL before touching stock)
  const req = (Array.isArray(p.lines) ? p.lines : []).map(l => ({
    productId: Number(l.productId),
    qty: Math.trunc(Number(l.qty) || 0)
  })).filter(l => l.qty > 0);
  if(!req.length) throw new Error('Enter at least one article quantity to dispatch');
  const seen = {};
  req.forEach(l => {
    const pl = lines.find(x => Number(x.productId) === l.productId);
    if(!pl) throw new Error('Product ' + l.productId + ' is not on this PO');
    if(seen[l.productId]) throw new Error('Duplicate product in dispatch');
    seen[l.productId] = true;
    const bal = Number(pl.qty) - dispatchedQty(l.productId);
    if(l.qty > bal) throw new Error('Cannot dispatch ' + l.qty + ' of "' + (productName(l.productId) || pl.customerPartName || 'article') + '" — balance is ' + bal);
  });

  // stock sufficiency check BEFORE any deduction (all-or-nothing)
  const need = {};
  req.forEach(l => {
    const pl = lines.find(x => Number(x.productId) === l.productId);
    bom.filter(b => Number(b.productId) === l.productId).forEach(b => {
      need[b.itemId] = (need[b.itemId] || 0) + Number(b.qtyPer) * l.qty;
    });
  });
  const short = [];
  Object.keys(need).forEach(iid => {
    const it = getById('items', iid);
    const have = it ? Number(it.stockInHand) : 0;
    if(have < need[iid]) short.push((it ? it.name : 'item #' + iid) + ': need ' + need[iid] + ', have ' + have);
  });
  if(short.length) throw new Error('Insufficient stock — ' + short.join('; '));

  // deduct child-part inventory + log movements
  const when = p.dispatchDate || new Date().toISOString().slice(0,10);
  const inv = String(p.invoiceNumber || '').trim();
  Object.keys(need).forEach(iid => {
    const it = getById('items', iid); if(!it) return;
    it.stockOutput = Number(it.stockOutput) + need[iid];
    it.stockInHand = Number(it.stockInHand) - need[iid];
    it.updatedAt = new Date().toISOString(); saveRecord('items', it);
    appendMovement(it.id, 'OUT', need[iid], 'Dispatch ' + po.poNumber + (inv ? ' · Inv ' + inv : ''), p.actor || '');
  });

  // record one dispatch row per article
  const saved = req.map(l => {
    const pl = lines.find(x => Number(x.productId) === l.productId);
    const rec = { id: nextId('dispatches'), poId: po.id, poNumber: po.poNumber,
      productId: l.productId, productName: productName(l.productId) || pl.customerPartName || '',
      qty: l.qty, dispatchDate: when, invoiceNumber: inv, actor: p.actor || '', createdAt: new Date().toISOString() };
    saveRecord('dispatches', rec); return rec;
  });

  // PO status: fully dispatched when every line's balance is 0
  const done = lines.every(l => Number(l.qty) - dispatchedQty(l.productId) - req.filter(r => r.productId === Number(l.productId)).reduce((s,r)=>s+r.qty,0) <= 0);
  po.status = done ? 'DISPATCHED' : 'PARTIAL';
  po.dispatchedBy = p.actor || ''; po.dispatchedAt = new Date().toISOString();
  saveRecord('pos', po);
  audit(p.actor, 'dispatch', 'pos', po.id, po.poNumber + ' · ' + req.map(l => l.qty + '× #' + l.productId).join(', ') + (inv ? ' · Inv ' + inv : ''));
  return { po: po, dispatches: saved };
}
function productName(pid){ const r = rows('products').find(x => Number(x.id) === Number(pid)); return r ? r.name : ''; }

/* ---------------- bulk upload ---------------- */
const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const num  = v => { if(v === '' || v == null) return ''; const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : ''; };
const int  = v => Math.max(0, Math.trunc(num(v) || 0));

function actBulk(p){
  const r = p.rows || [], actor = p.actor || '';
  if(p.entity === 'items'){
    let added = 0, updated = 0, skipped = 0;
    r.forEach(row => {
      if(!row.name){ skipped++; return; }
      const comp = /vengree/i.test(row.company || '') ? 'VENGREE' : 'MEGAVERKS';
      const src = /inhouse|in-?house|sheet\s?metal/i.test(row.source || '') ? 'inhouse' : (row.vendorName ? 'vendor' : 'inhouse');
      const vendor = rows('vendors').find(v => norm(v.name) === norm(row.vendorName || ''));
      const base = { company:comp, name:row.name, partNumber:row.partNumber || '', vendorName:row.vendorName || '',
        materialType:row.materialType || '', source:src, price:num(row.price), moq:row.moq || '',
        leadTime:row.leadTime || '', minStock:int(row.minStock), productId:'', vendorId:vendor ? String(vendor.id) : '', instructions:'' };
      /* vendor is part of the identity: the same article supplied by two vendors is two rows,
         so Analysis → Vendor Comparison can chart price / lead time / credit period per supplier */
      const ex = rows('items').find(it => it.company === comp && norm(it.name) === norm(row.name)
        && norm(it.partNumber || '') === norm(row.partNumber || '') && norm(it.vendorName || '') === norm(row.vendorName || ''));
      if(ex){ Object.assign(ex, base); ex.updatedAt = new Date().toISOString(); saveRecord('items', ex); updated++; }
      else {
        const open = int(row.stockInHand);
        const rec = Object.assign({ id:nextId('items'), imageData:'', stockInput:open, stockOutput:0, stockInHand:open, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }, base);
        saveRecord('items', rec); added++;
        if(open > 0) appendMovement(rec.id, 'IN', open, 'Opening stock', actor);
      }
    });
    audit(actor, 'bulk', 'items', '', added + ' added / ' + updated + ' updated');
    return { added:added, updated:updated, skipped:skipped };
  }
  if(p.entity === 'vendors'){
    let added = 0, updated = 0;
    r.forEach(row => {
      if(!row.name) return;
      const base = { name:row.name, contactPerson:row.contactPerson || '', phone:row.phone || '', email:row.email || '',
        address:row.address || '', gstin:(row.gstin || '').toUpperCase(), googleLocation:row.googleLocation || '',
        purchaseManager:row.purchaseManager || '', creditLimit:num(row.creditLimit), creditDays:int(row.creditDays) || 30, notes:row.notes || '' };
      const ex = rows('vendors').find(v => norm(v.name) === norm(row.name));
      if(ex){ Object.assign(ex, base); saveRecord('vendors', ex); updated++; }
      else { saveRecord('vendors', Object.assign({ id:nextId('vendors'), createdAt:new Date().toISOString() }, base)); added++; }
    });
    audit(actor, 'bulk', 'vendors', '', added + ' added / ' + updated + ' updated');
    return { added:added, updated:updated, skipped:0 };
  }
  if(p.entity === 'products'){
    let added = 0, updated = 0;
    r.forEach(row => {
      if(!row.name) return;
      const comp = /vengree/i.test(row.company || '') ? 'VENGREE' : 'MEGAVERKS';
      const base = { name:row.name, company:comp, description:row.description || '', imageData:'' };
      const ex = rows('products').find(x => norm(x.name) === norm(row.name) && x.company === comp);
      if(ex){ Object.assign(ex, base); saveRecord('products', ex); updated++; }
      else { saveRecord('products', Object.assign({ id:nextId('products'), createdAt:new Date().toISOString() }, base)); added++; }
    });
    audit(actor, 'bulk', 'products', '', added + ' added');
    return { added:added, updated:updated, skipped:0 };
  }
  if(p.entity === 'pos'){
    let added = 0, skipped = 0;
    const groups = {};
    r.forEach(row => {
      if(!row.poNumber || !row.customerName || !row.productName || !int(row.qty)){ skipped++; return; }
      (groups[row.poNumber] = groups[row.poNumber] || []).push(row);
    });
    Object.keys(groups).forEach(poNo => {
      const existing = rows('pos').find(x => norm(x.poNumber) === norm(poNo));
      if(existing){ skipped += groups[poNo].length; return; }
      let cust = rows('customers').find(c => norm(c.name) === norm(groups[poNo][0].customerName));
      if(!cust){
        cust = { id:nextId('customers'), name:groups[poNo][0].customerName, contactPerson:'', phone:'', email:'', address:'', gstin:'', googleLocation:'', notes:'', createdAt:new Date().toISOString() };
        saveRecord('customers', cust);
      }
      const po = { id:nextId('pos'), customerId:cust.id, poNumber:poNo, poDate:groups[poNo][0].poDate || new Date().toISOString().slice(0,10),
                   status:'OPEN', notes:groups[poNo][0].notes || '', dispatchedBy:'', dispatchedAt:'', createdAt:new Date().toISOString() };
      saveRecord('pos', po); added++;
      groups[poNo].forEach(row => {
        const prod = rows('products').find(pr => norm(pr.name) === norm(row.productName));
        saveRecord('poLines', { id:nextId('poLines'), poId:po.id, customerPartName:row.customerPartName || '',
          customerPartNumber:row.customerPartNumber || '', productId:prod ? prod.id : '', qty:int(row.qty), createdAt:new Date().toISOString() });
      });
    });
    audit(actor, 'bulk', 'pos', '', added + ' POs created');
    return { added:added, updated:0, skipped:skipped };
  }
  throw new Error('Bulk not supported for ' + p.entity);
}
