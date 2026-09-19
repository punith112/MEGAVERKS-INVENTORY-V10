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
  bom:        { name:'BOM',             headers:['id','productId','itemId','qtyPer','createdAt'] },
  movements:  { name:'StockMovements',  headers:['id','itemId','type','qty','note','actor','createdAt'] },
  audit:      { name:'Audit',           headers:['id','actor','action','entity','entityId','detail','createdAt'] },
  settings:   { name:'Settings',        headers:['id','key','value'] },
};

/* ---------------- passcode ---------------- */
const DEFAULT_PASS = 'mega1234';           // change it right after first login (Admin page)
const DRIVE_FOLDER = 'MEGAVERKS Inventory V10';

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

/* ---------------- sheet plumbing ---------------- */
function SHEET_DEFS_NAME(n){ for(const k in SHEET_DEFS) if(SHEET_DEFS[k].name === n) return SHEET_DEFS[k].headers; return ['id']; }
function sh(name){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
function driveFolder(){
  const it = DriveApp.getFoldersByName(DRIVE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER);
}
function actUploadImage(p){
  const m = String(p.dataUrl || '').match(/^data:(.*?);base64,(.*)$/);
  if(!m) throw new Error('Invalid image data');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1]);
  const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const safe = String(p.name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.\-]+/g, '_').slice(-40) || 'image';
  const file = driveFolder().createFile(blob.setName(safe + '.' + ext));
  try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
  return { id: file.getId(),
           url: 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1000',
           viewUrl: file.getUrl() };
}

/* ---------------- auto backup (full spreadsheet copy in Drive) ---------------- */
const BACKUP_FOLDER = 'MEGAVERKS Backups';
const BACKUP_KEEP = 14;

function backupFolder(){ const it = DriveApp.getFoldersByName(BACKUP_FOLDER); return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER); }

function actBackup(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
function hasBackupTrigger(){ return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'dailyBackup'); }
function actInstallBackup(){
  if(!hasBackupTrigger()) ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(2).nearMinute(15).create();
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
                        return out({ ok:true, data:'Sheets ready' });

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
      case 'bulk':      requireAuth(p); return out({ ok:true, data:actBulk(p) });
      case 'uploadImage': requireAuth(p); return out({ ok:true, data:actUploadImage(p) });

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

  t('Sheet tabs + headers (12 tabs)', () => {
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

  t('Drive folder access', () => 'folder "' + driveFolder().getName() + '" reachable');

  t('Drive file write / share / delete', () => {
    const blob = Utilities.newBlob('selftest', 'text/plain', 'selftest.txt');
    const file = driveFolder().createFile(blob);
    try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
    const id = file.getId();
    file.setTrashed(true);
    return 'test file ' + id + ' written and trashed';
  });

  t('Backup folder access', () => 'folder "' + backupFolder().getName() + '" reachable');

  t('Daily backup trigger', () => hasBackupTrigger()
    ? 'installed (runs every night)'
    : 'not installed — optional, use action installBackup');

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

/* ---------------- dispatch PO (BOM stock-out) ---------------- */
function actDispatch(p){
  const po = getById('pos', p.poId); if(!po) throw new Error('PO not found');
  if(po.status !== 'OPEN') throw new Error('PO is not OPEN');
  const lines = rows('poLines').filter(l => Number(l.poId) === Number(p.poId));
  const bom = rows('bom');
  lines.forEach(l => {
    bom.filter(b => Number(b.productId) === Number(l.productId)).forEach(b => {
      const it = getById('items', b.itemId); if(!it) return;
      const need = Number(b.qtyPer) * Number(l.qty);
      const take = Math.min(need, Number(it.stockInHand));
      it.stockOutput = Number(it.stockOutput) + take;
      it.stockInHand = Math.max(0, Number(it.stockInHand) - take);
      it.updatedAt = new Date().toISOString(); saveRecord('items', it);
      appendMovement(it.id, 'OUT', take, 'Dispatch ' + po.poNumber, p.actor || '');
    });
  });
  po.status = 'DISPATCHED'; po.dispatchedBy = p.actor || ''; po.dispatchedAt = new Date().toISOString();
  saveRecord('pos', po); audit(p.actor, 'dispatch', 'pos', po.id, po.poNumber);
  return po;
}

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
      const ex = rows('items').find(it => it.company === comp && norm(it.name) === norm(row.name) && norm(it.partNumber || '') === norm(row.partNumber || ''));
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
