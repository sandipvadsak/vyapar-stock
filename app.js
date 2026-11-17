'use strict';
const sb = supabase.createClient(CFG.url, CFG.key);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : '₹ ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const qty = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fdate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const today = () => new Date().toLocaleDateString('en-CA');
const monthStart = () => today().slice(0, 8) + '01';
const TYPE = { sale: 'Sale', purchase: 'Purchase', sale_return: 'Credit Note', purchase_return: 'Debit Note',
  payment_in: 'Payment-In', payment_out: 'Payment-Out', other: 'Other' };
const PERMS = [
  ['sale_price', 'Can see sale price and sale amounts'],
  ['purchase_price', 'Can see purchase price, purchase amounts and stock value'],
  ['party_balance', 'Can see party balances and payments'],
  ['reports', 'Can open reports'],
  ['manage_items', 'Can add and edit items'],
  ['manage_parties', 'Can add and edit parties'],
  ['entries', 'Can make entries (sale, purchase, stock)'],
];

let ME = null, ITEMS = [], PARTIES = [], CATS = [], LABEL = new Map(), BYLABEL = new Map();
const can = (p) => ME?.perms?.[p] === true;
const owner = () => ME?.role === 'owner';
const sees = (type) => can(type === 'sale' || type === 'sale_return' ? 'sale_price'
  : type === 'purchase' || type === 'purchase_return' ? 'purchase_price' : 'party_balance');

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }
async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(error.message); return data; }
async function all(table, build) {
  let out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select('*').range(from, from + 999);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out = out.concat(data);
    if (data.length < 1000) return out;
  }
}
async function loadMaster() {
  [ITEMS, PARTIES, CATS] = await Promise.all([
    all('v_items', (q) => q.order('name').order('id')),
    all('v_parties', (q) => q.order('name').order('id')),
    all('v_categories', (q) => q.order('name').order('id')),
  ]);
  const seen = new Map();
  for (const i of ITEMS) seen.set(i.name, (seen.get(i.name) || 0) + 1);
  LABEL = new Map(); BYLABEL = new Map();
  for (const i of ITEMS) { const l = seen.get(i.name) > 1 ? `${i.name} #${i.id}` : i.name; LABEL.set(i.id, l); BYLABEL.set(l.toLowerCase(), i); }
}
const balHtml = (b) => (b == null ? '<span class="mute">—</span>'
  : b > 0.005 ? `<span class="good">${money(b)}</span>` : b < -0.005 ? `<span class="bad">${money(-b)}</span>` : money(0));
const balWord = (b) => (b == null ? '' : b > 0.005 ? "You'll get" : b < -0.005 ? "You'll pay" : 'Settled');

// ---------- sign in ----------
let signup = false;
function showLogin(msg) {
  $('#app').classList.add('hide'); $('#login').classList.remove('hide');
  $('#lmsg').textContent = msg || '';
}
$('#lswap').onclick = () => {
  signup = !signup;
  $('#nameWrap').classList.toggle('hide', !signup);
  $('#lgo').textContent = signup ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('#lswap').textContent = signup ? 'I already have an account' : 'Create a new account';
  $('#loginSub').textContent = signup ? 'New staff accounts work after the owner switches them on' : 'Sign in to continue';
};
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('#lemail').value.trim(), password = $('#lpass').value;
  $('#lgo').disabled = true; $('#lmsg').textContent = 'Please wait…';
  const res = signup
    ? await sb.auth.signUp({ email, password, options: { data: { name: $('#lname').value.trim() }, emailRedirectTo: location.origin + location.pathname } })
    : await sb.auth.signInWithPassword({ email, password });
  $('#lgo').disabled = false;
  if (res.error) { $('#lmsg').textContent = res.error.message; return; }
  if (!res.data.session) { $('#lmsg').textContent = 'Account created. Open the link sent to your email, then come back here and sign in.'; return; }
  boot();
};
$('#logout').onclick = async () => { await sb.auth.signOut(); ME = null; showLogin(); };

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  try {
    ME = await rpc('me');
    if (!ME) return showLogin('Account not ready. Try again in a moment.');
    if (!ME.active) { await sb.auth.signOut(); return showLogin('Your account is waiting for the owner to switch it on.'); }
    await loadMaster();
  } catch (err) { return showLogin(err.message); }
  $('#login').classList.add('hide'); $('#app').classList.remove('hide');
  document.title = CFG.appName;
  $('#whoName').textContent = ME.name; $('#whoRole').textContent = owner() ? '(Owner)' : '(Staff)';
  const menu = [['home', 'Dashboard', '🏠'], ['parties', 'Parties', '👥'], ['items', 'Items', '📦'], ['entries', 'Transactions', '🧾']];
  if (can('reports')) menu.push(['reports', 'Reports', '📊']);
  if (owner()) menu.push(['staff', 'Staff & Access', '⚙️']);
  $('#menu').innerHTML = menu.map(([k, v, ic]) => `<a href="#${k}" data-k="${k}"><i>${ic}</i>${v}</a>`).join('');
  route();
}
window.onhashchange = () => ME && route();

const VIEWS = {};
let SEL = { party: null, item: null };
async function route() {
  const k = (location.hash.slice(1) || 'home').split('/')[0];
  const view = VIEWS[k] ? k : 'home';
  document.querySelectorAll('#menu a').forEach((a) => a.classList.toggle('on', a.dataset.k === view));
  const acts = [];
  if (can('entries')) {
    acts.push('<button class="btn sale" data-new="sale">+ ADD SALE</button>', '<button class="btn buy" data-new="purchase">+ ADD PURCHASE</button>');
    acts.push('<button class="btn gold" data-new="sale_return">+ CREDIT NOTE</button>', '<button class="btn" data-more="1">+ MORE</button>');
  }
  $('#actions').innerHTML = acts.join('');
  $('#view').innerHTML = '<div class="empty">Loading…</div>';
  try { await VIEWS[view](); } catch (err) { $('#view').innerHTML = `<div class="empty bad">${esc(err.message)}</div>`; }
}
const refresh = async () => { await loadMaster(); await route(); };
$('#refreshBtn').onclick = async () => { try { await refresh(); toast('Refreshed'); } catch (err) { toast(err.message); } };

// ---------- shared pieces ----------
function txnTable(rows, { party = true } = {}) {
  if (!rows.length) return '<div class="empty">No transactions yet</div>';
  return `<div class="tw"><table><thead><tr><th>DATE</th><th>TYPE</th><th>NO.</th>${party ? '<th>PARTY</th>' : ''}<th class="r">TOTAL</th><th class="r">BALANCE</th></tr></thead><tbody>${
    rows.map((t) => `<tr class="click" data-txn="${t.id}"><td>${fdate(t.date)}</td><td><span class="tag ${t.type}">${TYPE[t.type]}</span></td><td>${esc(t.ref_no || '')}</td>${
      party ? `<td>${esc(t.party || 'Cash')}</td>` : ''}<td class="r">${money(t.total)}</td><td class="r">${money(t.balance)}</td></tr>`).join('')}</tbody></table></div>`;
}
function csv(name, head, rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv' }));
  a.download = `${name}_${today()}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// ---------- dialog ----------
let onSave = null;
function dialog(title, body, save, { saveText = 'SAVE', extra = '' } = {}) {
  $('#dtitle').textContent = title; $('#dbody').innerHTML = body; $('#derr').textContent = '';
  $('#dextra').innerHTML = extra;
  $('#dsave').textContent = saveText; $('#dsave').classList.toggle('hide', !save); $('#dsave').disabled = false;
  onSave = save;
  if (!$('#dlg').open) $('#dlg').showModal();
}
$('#dclose').onclick = () => $('#dlg').close();
$('#dform').onsubmit = async (e) => {
  e.preventDefault();
  if (!onSave) return;
  $('#dsave').disabled = true; $('#derr').textContent = '';
  try { await onSave(); $('#dlg').close(); await refresh(); toast('Saved'); }
  catch (err) { $('#derr').textContent = err.message; }
  $('#dsave').disabled = false;
};
const val = (id) => { const v = $('#' + id)?.value?.trim(); return v === '' || v == null ? null : v; };
const numv = (id) => { const v = val(id); return v == null ? null : Number(v); };
const field = (id, label, value = '', attrs = '') => `<label class="f">${label}<input id="${id}" value="${esc(value ?? '')}" ${attrs}></label>`;

// ---------- home ----------
VIEWS.home = async () => {
  $('#title').textContent = 'Dashboard';
  const { data: recent, error } = await sb.from('v_transactions').select('*').order('date', { ascending: false }).order('id', { ascending: false }).limit(15);
  if (error) throw new Error(error.message);
  const goods = ITEMS.filter((i) => i.active && !i.is_service);
  const low = goods.filter((i) => i.min_stock > 0 && i.stock <= i.min_stock).length;
  const cards = [];
  if (can('party_balance')) {
    cards.push(['To receive', `<span class="good">${money(PARTIES.reduce((s, p) => s + Math.max(p.balance || 0, 0), 0))}</span>`]);
    cards.push(['To pay', `<span class="bad">${money(PARTIES.reduce((s, p) => s + Math.max(-(p.balance || 0), 0), 0))}</span>`]);
  }
  if (can('purchase_price')) cards.push(['Stock value', money(goods.reduce((s, i) => s + Math.max(i.stock, 0) * (i.purchase_price || 0), 0))]);
  cards.push(['Items', goods.length], ['Low stock items', `<span class="${low ? 'warn' : ''}">${low}</span>`], ['Parties', PARTIES.filter((p) => p.active).length]);
  $('#view').innerHTML = `<div class="cards">${cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
    <div class="panel"><div class="hd"><h2>Recent transactions</h2><a class="btn sm buy" href="#entries">See all</a></div>${txnTable(recent)}</div>`;
};

// ---------- parties ----------
VIEWS.parties = async () => {
  $('#title').textContent = 'Parties';
  const list = PARTIES.filter((p) => p.active);
  if (!list.find((p) => p.id === SEL.party)) SEL.party = list[0]?.id ?? null;
  $('#view').innerHTML = `<div class="split"><div class="panel list"><div class="hd"><input class="search" id="psearch" placeholder="Search party">${
    can('manage_parties') ? '<button class="btn pri sm" data-party-new="1">+ ADD PARTY</button>' : ''}</div><div class="rows" id="prows"></div></div><div class="det" id="pdet"></div></div>`;
  const draw = () => {
    const s = $('#psearch').value.toLowerCase();
    $('#prows').innerHTML = list.filter((p) => p.name.toLowerCase().includes(s)).map((p) =>
      `<div class="row ${p.id === SEL.party ? 'on' : ''}" data-party="${p.id}"><span class="n">${esc(p.name)}</span><span>${balHtml(p.balance)}</span></div>`).join('') || '<div class="empty">No party found</div>';
  };
  $('#psearch').oninput = draw; draw();
  await partyDetail();
};
async function partyDetail() {
  const p = PARTIES.find((x) => x.id === SEL.party);
  if (!p) { $('#pdet').innerHTML = '<div class="panel"><div class="empty">Add your first party</div></div>'; return; }
  const rows = await all('v_transactions', (q) => q.eq('party_id', p.id).order('date', { ascending: false }).order('id', { ascending: false }));
  const pay = can('entries') && can('party_balance');
  $('#pdet').innerHTML = `<div class="panel"><div class="hd"><h2>${esc(p.name)}</h2>${
    pay ? `<button class="btn sm" data-new="payment_in" data-for="${p.id}">+ PAYMENT-IN</button><button class="btn sm" data-new="payment_out" data-for="${p.id}">+ PAYMENT-OUT</button>` : ''}${
    can('manage_parties') ? `<button class="btn sm" data-party-edit="${p.id}">EDIT</button>` : ''}</div>
    <div class="facts"><div><span>Phone</span><b>${esc(p.phone || '—')}</b></div><div><span>GSTIN</span><b>${esc(p.gstin || '—')}</b></div>
    <div><span>${balWord(p.balance) || 'Balance'}</span><b>${balHtml(p.balance)}</b></div><div><span>Address</span><b>${esc(p.address || '—')}</b></div></div></div>
    <div class="panel"><div class="hd"><h2>Transactions (${rows.length})</h2></div>${txnTable(rows, { party: false })}</div>`;
}
function partyForm(p = {}) {
  dialog(p.id ? 'Edit party' : 'Add party', `<div class="grid">${field('f_name', 'Party name *', p.name, 'required')}${field('f_phone', 'Phone', p.phone)}
    ${field('f_gstin', 'GSTIN', p.gstin)}${field('f_state', 'State', p.state)}${field('f_email', 'Email', p.email)}
    ${can('party_balance') ? field('f_open', "Opening balance (plus = you'll get, minus = you'll pay)", p.opening_balance ?? 0, 'type="number" step="any"') : ''}</div>
    <label class="f" style="margin-top:12px">Address<textarea id="f_addr" rows="2">${esc(p.address || '')}</textarea></label>
    ${p.id ? `<label class="c"><input type="checkbox" id="f_active" ${p.active ? 'checked' : ''}> Active</label>` : ''}`,
  async () => {
    SEL.party = await rpc('save_party', { p: { id: p.id ?? null, name: val('f_name'), phone: val('f_phone'), gstin: val('f_gstin'), state: val('f_state'),
      email: val('f_email'), address: val('f_addr'), opening_balance: numv('f_open'), active: p.id ? $('#f_active').checked : true } });
  });
}

// ---------- items ----------
VIEWS.items = async () => {
  $('#title').textContent = 'Items';
  const list = ITEMS.filter((i) => i.active);
  if (!list.find((i) => i.id === SEL.item)) SEL.item = list[0]?.id ?? null;
  $('#view').innerHTML = `<div class="split"><div class="panel list"><div class="hd"><input class="search" id="isearch" placeholder="Search item or code">${
    can('manage_items') ? '<button class="btn pri sm" data-item-new="1">+ ADD ITEM</button>' : ''}</div><div class="rows" id="irows"></div></div><div class="det" id="idet"></div></div>`;
  const draw = () => {
    const s = $('#isearch').value.toLowerCase();
    const hit = list.filter((i) => i.name.toLowerCase().includes(s) || (i.code || '').toLowerCase().includes(s));
    $('#irows').innerHTML = hit.slice(0, 400).map((i) => {
      const low = !i.is_service && (i.stock < 0 || (i.min_stock > 0 && i.stock <= i.min_stock));
      return `<div class="row ${i.id === SEL.item ? 'on' : ''}" data-item="${i.id}"><span class="n">${esc(i.name)}</span><span class="${low ? 'bad' : 'good'}">${i.is_service ? '' : qty(i.stock)}</span></div>`;
    }).join('') + (hit.length > 400 ? `<div class="empty">${hit.length - 400} more — type to search</div>` : '') || '<div class="empty">No item found</div>';
  };
  $('#isearch').oninput = draw; draw();
  await itemDetail();
};
async function itemDetail() {
  const i = ITEMS.find((x) => x.id === SEL.item);
  if (!i) { $('#idet').innerHTML = '<div class="panel"><div class="empty">Add your first item</div></div>'; return; }
  const [lines, adj] = await Promise.all([
    sb.from('v_line_items').select('*').eq('item_id', i.id).order('date', { ascending: false }).order('id', { ascending: false }).limit(300),
    sb.from('v_adjustments').select('*').eq('item_id', i.id).order('date', { ascending: false }).order('id', { ascending: false }).limit(300),
  ]);
  if (lines.error || adj.error) throw new Error((lines.error || adj.error).message);
  const KIND = { opening: 'Opening Stock', add: 'Add Stock', reduce: 'Reduce Stock' };
  const rows = [
    ...lines.data.map((l) => ({ date: l.date, type: TYPE[l.type], cls: l.type, txn: l.txn_id, qty: (l.type === 'purchase' || l.type === 'sale_return' ? 1 : l.type === 'other' ? 0 : -1) * l.qty, raw: l.qty, price: l.price, note: l.description })),
    ...adj.data.map((a) => ({ date: a.date, type: KIND[a.kind], cls: '', adj: a.id, qty: (a.kind === 'reduce' ? -1 : 1) * a.qty, raw: a.qty, price: a.at_price, note: a.description })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const facts = [];
  if (can('sale_price')) facts.push(['Sale price', money(i.sale_price)]);
  if (can('purchase_price')) facts.push(['Purchase price', money(i.purchase_price)]);
  if (!i.is_service) facts.push(['Stock quantity', `<span class="${i.stock < 0 ? 'bad' : ''}">${qty(i.stock)} ${esc(i.unit || '')}</span>`]);
  if (can('purchase_price') && !i.is_service) facts.push(['Stock value', money(Math.max(i.stock, 0) * (i.purchase_price || 0))]);
  facts.push(['Category', esc(i.category || '—')], ['Item code', esc(i.code || '—')]);
  $('#idet').innerHTML = `<div class="panel"><div class="hd"><h2>${esc(i.name)}</h2>${
    can('entries') && !i.is_service ? `<button class="btn sm pri" data-adjust="${i.id}">ADJUST STOCK</button>` : ''}${
    can('manage_items') ? `<button class="btn sm" data-item-edit="${i.id}">EDIT</button>` : ''}</div>
    <div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div></div>
    <div class="panel"><div class="hd"><h2>Stock movement</h2><span class="mute">latest ${rows.length}</span></div>${rows.length ? `<div class="tw"><table><thead><tr><th>DATE</th><th>TYPE</th><th class="r">QUANTITY</th><th class="r">PRICE / UNIT</th><th>NOTE</th><th></th></tr></thead><tbody>${
      rows.map((r) => `<tr ${r.txn ? `class="click" data-txn="${r.txn}"` : ''}><td>${fdate(r.date)}</td><td><span class="tag ${r.cls}">${r.type}</span></td><td class="r ${r.qty < 0 ? 'bad' : r.qty > 0 ? 'good' : ''}">${r.qty > 0 ? '+' : r.qty < 0 ? '−' : ''}${qty(r.raw)}</td><td class="r">${money(r.price)}</td><td>${esc(r.note || '')}</td><td>${
        r.adj && owner() ? `<button class="btn sm danger" data-adj-del="${r.adj}">DELETE</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No movement yet</div>'}</div>`;
}
function itemForm(i = {}) {
  dialog(i.id ? 'Edit item' : 'Add item', `<div class="grid">${field('f_name', 'Item name *', i.name, 'required')}${field('f_code', 'Item code', i.code)}
    <label class="f">Category<input id="f_cat" list="catlist" value="${esc(i.category || '')}"><datalist id="catlist">${CATS.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
    ${field('f_unit', 'Unit (Pcs, Kg, Box…)', i.unit)}${field('f_hsn', 'HSN code', i.hsn)}${field('f_tax', 'Tax %', i.tax_rate ?? 0, 'type="number" step="any" min="0"')}
    ${can('sale_price') ? field('f_sale', 'Sale price', i.sale_price, 'type="number" step="any" min="0"') : ''}
    ${can('purchase_price') ? field('f_buy', 'Purchase price', i.purchase_price, 'type="number" step="any" min="0"') : ''}
    ${i.id ? '' : field('f_open', 'Opening stock', '', 'type="number" step="any"')}
    ${field('f_min', 'Low stock alert at', i.min_stock ?? 0, 'type="number" step="any" min="0"')}${field('f_loc', 'Location', i.location)}</div>
    ${i.id ? `<label class="c"><input type="checkbox" id="f_active" ${i.active ? 'checked' : ''}> Active</label>` : ''}`,
  async () => {
    const cat = val('f_cat');
    const category_id = cat ? await rpc('save_category', { p_name: cat }) : null;
    SEL.item = await rpc('save_item', { p: { id: i.id ?? null, name: val('f_name'), code: val('f_code'), category_id, unit: val('f_unit'), hsn: val('f_hsn'),
      tax_rate: numv('f_tax') ?? 0, sale_price: numv('f_sale'), purchase_price: numv('f_buy'), opening_stock: numv('f_open'), min_stock: numv('f_min') ?? 0,
      location: val('f_loc'), description: i.description ?? null, is_service: i.is_service ?? false, active: i.id ? $('#f_active').checked : true } });
  });
}
function adjustForm(id) {
  const i = ITEMS.find((x) => x.id === id);
  dialog(`Adjust stock — ${i.name}`, `<div class="grid"><label class="f">Type<select id="f_kind"><option value="add">Add stock</option><option value="reduce">Reduce stock</option></select></label>
    ${field('f_qty', `Quantity (${esc(i.unit || 'units')}) *`, '', 'type="number" step="any" min="0" required')}${field('f_date', 'Date', today(), 'type="date"')}
    ${can('purchase_price') ? field('f_at', 'At price', i.purchase_price ?? '', 'type="number" step="any" min="0"') : ''}${field('f_note', 'Note', '')}</div>
    <p class="mute">Current stock: ${qty(i.stock)} ${esc(i.unit || '')}</p>`,
  () => rpc('save_adjustment', { p: { item_id: id, kind: val('f_kind'), qty: numv('f_qty'), date: val('f_date'), at_price: numv('f_at'), description: val('f_note') } }));
}

// ---------- transactions ----------
let FILTER = { type: '', from: '', to: '' };
VIEWS.entries = async () => {
  $('#title').textContent = 'Transactions';
  if (!FILTER.from) FILTER = { type: '', from: monthStart(), to: today() };
  const rows = await all('v_transactions', (q) => {
    q = q.gte('date', FILTER.from).lte('date', FILTER.to).order('date', { ascending: false }).order('id', { ascending: false });
    return FILTER.type ? q.eq('type', FILTER.type) : q;
  });
  const sum = (t) => rows.filter((r) => r.type === t).reduce((s, r) => s + (r.total || 0), 0);
  $('#view').innerHTML = `<div class="panel"><div class="hd"><h2>${rows.length} entries</h2><div class="filters">
    <select id="ft"><option value="">All types</option>${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${FILTER.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <input type="date" id="ff" value="${FILTER.from}"><span>to</span><input type="date" id="fto" value="${FILTER.to}">
    <button class="btn sm" id="fcsv">EXCEL (CSV)</button></div></div>
    ${can('sale_price') || can('purchase_price') ? `<div class="facts">${can('sale_price') ? `<div><span>Sale</span><b>${money(sum('sale'))}</b></div><div><span>Credit notes</span><b>${money(sum('sale_return'))}</b></div>` : ''}${
      can('purchase_price') ? `<div><span>Purchase</span><b>${money(sum('purchase'))}</b></div>` : ''}</div>` : ''}${txnTable(rows)}</div>`;
  const go = () => { FILTER = { type: $('#ft').value, from: $('#ff').value || monthStart(), to: $('#fto').value || today() }; route(); };
  $('#ft').onchange = go; $('#ff').onchange = go; $('#fto').onchange = go;
  $('#fcsv').onclick = () => csv('transactions', ['Date', 'Type', 'No', 'Party', 'Total', 'Paid', 'Balance'],
    rows.map((t) => [fdate(t.date), TYPE[t.type], t.ref_no, t.party || 'Cash', t.total, t.paid, t.balance]));
};
async function txnView(id) {
  const [{ data: t, error }, lines] = await Promise.all([
    sb.from('v_transactions').select('*').eq('id', id).single(),
    all('v_line_items', (q) => q.eq('txn_id', id).order('id')),
  ]);
  if (error) throw new Error(error.message);
  dialog(`${TYPE[t.type]} ${t.ref_no ? '#' + t.ref_no : ''}`, `<div class="facts" style="padding:0 0 12px"><div><span>Date</span><b>${fdate(t.date)}</b></div><div><span>Party</span><b>${esc(t.party || 'Cash')}</b></div>
    <div><span>Total</span><b>${money(t.total)}</b></div><div><span>Paid</span><b>${money(t.paid)}</b></div><div><span>Balance</span><b>${money(t.balance)}</b></div>
    <div><span>Entered by</span><b>${esc(t.created_by_name || 'Imported')}</b></div></div>${t.description ? `<p>${esc(t.description)}</p>` : ''}
    ${lines.length ? `<div class="tw"><table><thead><tr><th>#</th><th>ITEM</th><th class="r">QTY</th><th class="r">PRICE</th><th class="r">AMOUNT</th></tr></thead><tbody>${
      lines.map((l, n) => `<tr><td>${n + 1}</td><td>${esc(l.item)}</td><td class="r">${qty(l.qty)} ${esc(l.unit || '')}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.total)}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
  null, { extra: owner() ? `<button class="btn danger" type="button" data-txn-del="${id}">DELETE</button>` : '' });
}
function paymentForm(type, partyId) {
  dialog(TYPE[type], `<div class="grid"><label class="f">Party *<select id="f_party" required><option value="">Choose</option>${
    PARTIES.filter((p) => p.active).map((p) => `<option value="${p.id}" ${p.id === partyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    ${field('f_date', 'Date', today(), 'type="date"')}${field('f_amt', type === 'payment_in' ? 'Amount received *' : 'Amount paid *', '', 'type="number" step="any" min="0" required')}
    <label class="f">Mode<select id="f_mode"><option>Cash</option><option>Bank</option><option>UPI</option><option>Cheque</option></select></label>${field('f_note', 'Note', '')}</div>`,
  () => rpc('save_transaction', { p: { type, party_id: Number(val('f_party')), date: val('f_date'), amount: numv('f_amt'), payment_type: val('f_mode'), description: val('f_note') } }));
}
function billForm(type) {
  const see = sees(type), sale = type === 'sale' || type === 'sale_return';
  const line = () => `<tr><td><input class="li" list="itemlist" placeholder="Type item name"></td><td style="width:110px"><input class="lq" type="number" step="any" min="0"></td>${
    see ? '<td style="width:130px"><input class="lp" type="number" step="any" min="0"></td><td class="r la" style="width:120px"></td>' : ''}<td style="width:36px"><button class="btn sm" type="button" data-rm="1">✕</button></td></tr>`;
  dialog(type === 'sale_return' ? 'Credit Note (Sale Return)' : type === 'purchase_return' ? 'Debit Note (Purchase Return)' : TYPE[type], `${type === 'sale_return' ? '<p class="mute" style="margin-top:0">Items come back into stock and the party balance goes down.</p>' : ''}<div class="grid"><label class="f">Party<select id="f_party"><option value="">Cash (no party)</option>${
    PARTIES.filter((p) => p.active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
    ${field('f_date', 'Date', today(), 'type="date"')}${field('f_ref', 'Bill no. (blank = next number)', '')}</div>
    <datalist id="itemlist">${ITEMS.filter((i) => i.active).map((i) => `<option value="${esc(LABEL.get(i.id))}">`).join('')}</datalist>
    <table class="lines" style="margin-top:14px"><thead><tr><th>ITEM</th><th>QTY</th>${see ? '<th>PRICE / UNIT</th><th class="r">AMOUNT</th>' : ''}<th></th></tr></thead><tbody id="lbody">${line()}${line()}</tbody></table>
    <button class="btn sm" type="button" id="ladd">+ ADD ROW</button>
    <div class="totals">${see ? `<span>Total: <b id="ltotal">${money(0)}</b></span><label class="f" id="paidWrap">Paid now<input id="f_paid" type="number" step="any" min="0" style="width:140px"></label>`
      : '<span class="mute">Prices are filled automatically from the item.</span>'}</div>
    <label class="f" style="margin-top:10px">Note<input id="f_note"></label>`,
  async () => {
    const lines = [];
    for (const tr of $('#lbody').children) {
      const name = $('.li', tr).value.trim(); if (!name) continue;
      const it = BYLABEL.get(name.toLowerCase()); if (!it) throw new Error(`Item not found: ${name}`);
      const q = Number($('.lq', tr).value); if (!(q > 0)) throw new Error(`Enter quantity for ${name}`);
      const l = { item_id: it.id, qty: q };
      if (see && $('.lp', tr).value !== '') l.price = Number($('.lp', tr).value);
      lines.push(l);
    }
    if (!lines.length) throw new Error('Add at least one item');
    const party = val('f_party');
    await rpc('save_transaction', { p: { type, party_id: party ? Number(party) : null, date: val('f_date'), ref_no: val('f_ref'), lines, paid: numv('f_paid'), description: val('f_note') } });
  });
  const calc = () => {
    if (!see) return;
    let total = 0;
    for (const tr of $('#lbody').children) {
      const it = BYLABEL.get($('.li', tr).value.trim().toLowerCase());
      const a = Number($('.lq', tr).value || 0) * Number($('.lp', tr).value || 0);
      const amt = a + (it ? a * (it.tax_rate || 0) / 100 : 0);
      $('.la', tr).textContent = amt ? money(amt) : ''; total += amt;
    }
    $('#ltotal').textContent = money(total);
    $('#paidWrap').classList.toggle('hide', !$('#f_party').value);
  };
  $('#lbody').oninput = (e) => {
    const tr = e.target.closest('tr');
    if (e.target.classList.contains('li')) {
      const it = BYLABEL.get(e.target.value.trim().toLowerCase());
      if (it && see && $('.lp', tr).value === '') $('.lp', tr).value = (sale ? it.sale_price : it.purchase_price) ?? '';
      if (it && tr === $('#lbody').lastElementChild) $('#lbody').insertAdjacentHTML('beforeend', line());
    }
    calc();
  };
  $('#lbody').onclick = (e) => { if (e.target.dataset.rm) { e.target.closest('tr').remove(); calc(); } };
  $('#ladd').onclick = () => $('#lbody').insertAdjacentHTML('beforeend', line());
  $('#f_party').onchange = calc; calc();
}
function newEntry(type, partyId) {
  if (type === 'payment_in' || type === 'payment_out') paymentForm(type, partyId); else billForm(type);
}
function moreMenu() {
  const opts = [['sale_return', 'Credit Note (Sale Return)'], ['purchase_return', 'Debit Note (Purchase Return)']];
  if (can('party_balance')) opts.push(['payment_in', 'Payment-In'], ['payment_out', 'Payment-Out']);
  dialog('Add entry', `<div class="grid">${opts.map(([k, v]) => `<button class="btn buy" type="button" data-new="${k}">${v}</button>`).join('')}</div>`, null);
}

// ---------- reports ----------
let REP = { tab: 'stock', from: '', to: '' };
VIEWS.reports = async () => {
  $('#title').textContent = 'Reports';
  if (!REP.from) { REP.from = monthStart(); REP.to = today(); }
  const tabs = [['stock', 'Stock summary'], ['low', 'Low stock'], ['itemwise', 'Item-wise movement']];
  if (can('party_balance')) tabs.push(['party', 'Party balances']);
  let head = [], rows = [], foot = '';
  if (REP.tab === 'stock' || REP.tab === 'low') {
    let list = ITEMS.filter((i) => i.active && !i.is_service);
    if (REP.tab === 'low') list = list.filter((i) => i.stock < 0 || (i.min_stock > 0 && i.stock <= i.min_stock));
    const v = can('purchase_price');
    head = ['Item', 'Code', 'Category', 'Stock', 'Unit', ...(REP.tab === 'low' ? ['Alert at'] : []), ...(v ? ['Purchase price', 'Stock value'] : [])];
    rows = list.map((i) => [i.name, i.code || '', i.category || '', i.stock, i.unit || '', ...(REP.tab === 'low' ? [i.min_stock] : []), ...(v ? [i.purchase_price ?? 0, Math.max(i.stock, 0) * (i.purchase_price || 0)] : [])]);
    if (v) foot = `Total stock value: <b>${money(rows.reduce((s, r) => s + r[r.length - 1], 0))}</b>`;
  } else if (REP.tab === 'itemwise') {
    const data = await rpc('report_items', { p_from: REP.from, p_to: REP.to });
    head = ['Item', 'Unit', 'Qty in', 'Qty out', ...(can('sale_price') ? ['Sale amount'] : []), ...(can('purchase_price') ? ['Purchase amount'] : [])];
    rows = data.map((r) => [r.item, r.unit || '', r.qty_in, r.qty_out, ...(can('sale_price') ? [r.sale_amount] : []), ...(can('purchase_price') ? [r.purchase_amount] : [])]);
  } else {
    head = ['Party', 'Phone', "You'll get", "You'll pay"];
    rows = PARTIES.filter((p) => Math.abs(p.balance || 0) > 0.005).map((p) => [p.name, p.phone || '', Math.max(p.balance, 0), Math.max(-p.balance, 0)]);
    foot = `To receive: <b class="good">${money(rows.reduce((s, r) => s + r[2], 0))}</b> &nbsp; To pay: <b class="bad">${money(rows.reduce((s, r) => s + r[3], 0))}</b>`;
  }
  const cell = (c) => (typeof c === 'number' ? `<td class="r">${qty(c)}</td>` : `<td>${esc(c)}</td>`);
  $('#view').innerHTML = `<div class="panel"><div class="hd"><div class="filters" style="margin-right:auto">${
    tabs.map(([k, v]) => `<button class="btn sm ${REP.tab === k ? 'pri' : 'lite'}" data-rep="${k}">${v}</button>`).join('')}</div>
    ${REP.tab === 'itemwise' ? `<input type="date" id="rf" value="${REP.from}"><span>to</span><input type="date" id="rt" value="${REP.to}">` : ''}
    <button class="btn sm" id="rcsv">EXCEL (CSV)</button></div>${foot ? `<div class="facts"><div>${foot}</div></div>` : ''}
    ${rows.length ? `<div class="tw"><table><thead><tr>${head.map((h, n) => `<th class="${typeof rows[0][n] === 'number' ? 'r' : ''}">${h.toUpperCase()}</th>`).join('')}</tr></thead><tbody>${
      rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing to show</div>'}</div>`;
  $('#rcsv').onclick = () => csv('report_' + REP.tab, head, rows);
  if ($('#rf')) { const go = () => { REP.from = $('#rf').value || REP.from; REP.to = $('#rt').value || REP.to; route(); }; $('#rf').onchange = go; $('#rt').onchange = go; }
};

// ---------- staff ----------
let USERS = [];
VIEWS.staff = async () => {
  $('#title').textContent = 'Staff & Access';
  USERS = await rpc('list_users');
  $('#view').innerHTML = `<div class="panel"><div class="hd"><h2>People who can sign in</h2><span class="mute">New staff create their own account on the sign-in screen, then you switch them on here.</span></div>
    <div class="tw"><table><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>ACCESS</th><th></th></tr></thead><tbody>${
    USERS.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role === 'owner' ? 'Owner' : 'Staff'}</td><td>${u.active ? '<span class="good">On</span>' : '<span class="bad">Off</span>'}</td>
      <td>${u.role === 'owner' ? 'Everything' : PERMS.filter(([k]) => u.perms?.[k]).length + ' of ' + PERMS.length + ' rights'}</td><td>${
      u.role === 'owner' ? '' : `<button class="btn sm ${u.active ? '' : 'pri'}" data-toggle="${u.id}">${u.active ? 'SWITCH OFF' : 'SWITCH ON'}</button> <button class="btn sm buy" data-user="${u.id}">CHANGE RIGHTS</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
};
function userForm(id) {
  const u = USERS.find((x) => x.id === id);
  dialog(`Access — ${u.email}`, `${field('f_name', 'Name', u.name)}<label class="c" style="margin-top:10px"><input type="checkbox" id="f_active" ${u.active ? 'checked' : ''}> <b>Account is on (can sign in)</b></label>
    <p class="mute">Tick only what this person should be able to see or do. Unticked things stay hidden.</p>
    ${PERMS.map(([k, v]) => `<label class="c"><input type="checkbox" data-perm="${k}" ${u.perms?.[k] ? 'checked' : ''}> ${v}</label>`).join('')}`,
  () => {
    const perms = {};
    document.querySelectorAll('[data-perm]').forEach((c) => { perms[c.dataset.perm] = c.checked; });
    return rpc('set_user', { p_id: id, p_name: val('f_name'), p_perms: perms, p_active: $('#f_active').checked });
  });
}

// ---------- clicks ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-new],[data-more],[data-txn],[data-party],[data-item],[data-party-new],[data-party-edit],[data-item-new],[data-item-edit],[data-adjust],[data-adj-del],[data-txn-del],[data-rep],[data-user],[data-toggle]');
  if (!el || !ME) return;
  const d = el.dataset;
  try {
    if (d.adjDel) { e.stopPropagation(); if (confirm('Delete this stock adjustment?')) { await rpc('delete_adjustment', { p_id: Number(d.adjDel) }); await refresh(); toast('Deleted'); } }
    else if (d.txnDel) { if (confirm('Delete this entry? Stock and balance will change back.')) { await rpc('delete_transaction', { p_id: Number(d.txnDel) }); $('#dlg').close(); await refresh(); toast('Deleted'); } }
    else if (d.new) newEntry(d.new, d.for ? Number(d.for) : null);
    else if (d.more) moreMenu();
    else if (d.txn) await txnView(Number(d.txn));
    else if (d.party) { SEL.party = Number(d.party); document.querySelectorAll('#prows .row').forEach((r) => r.classList.toggle('on', r === el)); await partyDetail(); }
    else if (d.item) { SEL.item = Number(d.item); document.querySelectorAll('#irows .row').forEach((r) => r.classList.toggle('on', r === el)); await itemDetail(); }
    else if (d.partyNew) partyForm();
    else if (d.partyEdit) partyForm(PARTIES.find((p) => p.id === Number(d.partyEdit)));
    else if (d.itemNew) itemForm();
    else if (d.itemEdit) itemForm(ITEMS.find((i) => i.id === Number(d.itemEdit)));
    else if (d.adjust) adjustForm(Number(d.adjust));
    else if (d.rep) { REP.tab = d.rep; route(); }
    else if (d.toggle) { const u = USERS.find((x) => x.id === d.toggle); await rpc('set_user', { p_id: u.id, p_name: u.name, p_perms: u.perms, p_active: !u.active }); await route(); toast(u.active ? 'Account switched off' : 'Account switched on'); }
    else if (d.user) userForm(d.user);
  } catch (err) { toast(err.message); }
});

boot();
