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
// A bill line that is only text (goods that are not an item): it is saved on this one service item, with the typed words as the line note, so no stock moves.
const FREE_NAME = 'Other (no stock)';
const freeItem = () => ITEMS.find((i) => i.is_service && i.name === FREE_NAME);
const lineName = (l) => (l.description && l.item === FREE_NAME ? l.description : l.item);
const PERMS = [
  ['sale_price', 'Can see sale price and sale amounts'],
  ['purchase_price', 'Can see purchase price, purchase amounts and stock value'],
  ['party_balance', 'Can see party balances and payments'],
  ['reports', 'Can open reports'],
  ['manage_items', 'Can add and edit items'],
  ['manage_parties', 'Can add and edit parties'],
  ['entries', 'Can make entries (sale, purchase, stock)'],
  ['edit_entries', 'Can edit saved entries (only those whose amounts they can see)'],
  ['delete_entries', 'Can delete entries (they go to the Recycle Bin, only the owner can restore)'],
  ['delete_items', 'Can delete inactive items (they go to the Recycle Bin, only the owner can restore)'],
  ['adjust_stock', 'Can adjust stock by hand (ADJUST STOCK button)'],
  ['adjust_inactive', 'Can adjust stock of INACTIVE items only'],
];

let ME = null, ITEMS = [], PARTIES = [], CATS = [], LABEL = new Map(), BYLABEL = new Map(), BUNDLES = [];
let HAS_BIN = false, HAS_EDIT = false, HAS_ACCT = false, HAS_ITEMDEL = false, ACCOUNTS = [];
const isOwn = (p) => (CFG.ownParties || []).some((n) => n.toLowerCase() === String(p.name || '').trim().toLowerCase());
// Each account gets its own colour (by its place in the alphabetical list), the same everywhere.
const ACCT_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#c026d3', '#65a30d', '#ea580c', '#475569', '#be185d', '#0f766e', '#e11d48'];
const acctColor = (a) => { const i = ACCOUNTS.indexOf(a); return i < 0 ? '#13204b' : ACCT_COLORS[i % ACCT_COLORS.length]; };
const acctTag = (a) => (a ? `<span class="tag acct" style="background:${acctColor(a)}">${esc(a)}</span>` : '');
// A CEP / DCEP logo is billed on its own line but is part of the same piece as its Black / White base,
// so its quantity is not counted again in "Total quantity".
const isLogoPart = (name) => /^d?cep-.*-logo$/i.test(String(name || '').trim());
const can = (p) => ME?.perms?.[p] === true;
const owner = () => ME?.role === 'owner';
const canAdjust = () => owner() || can('adjust_stock');
const canDelete = () => owner() || can('delete_entries');
const binNote = (what) => (owner() ? (HAS_BIN ? `It will move to the Recycle Bin. ${what} You can restore it later.` : `${what} It cannot be brought back.`) : `It will move to the Recycle Bin. ${what} Only the owner can bring it back.`);
const canEdit = (type) => HAS_EDIT && type !== 'other' && (owner() || can('edit_entries')) && sees(type);
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
  HAS_BIN = ME?.role === 'owner' && !(await sb.from('v_recycle_bin').select('id').limit(1)).error;
  HAS_EDIT = !(await sb.from('v_transactions').select('edited_at').limit(1)).error;
  // is the delete-item function in the database yet? (id -1 never exists, so nothing is deleted)
  HAS_ITEMDEL = (ME?.role === 'owner' || can('delete_items')) && (await sb.rpc('delete_item', { p_id: -1 })).error?.code === 'P0001';
  HAS_ACCT = !(await sb.from('v_transactions').select('account').limit(1)).error;
  ACCOUNTS = HAS_ACCT ? ((await sb.rpc('list_accounts')).data || []) : [];
  const seen = new Map();
  for (const i of ITEMS) seen.set(i.name, (seen.get(i.name) || 0) + 1);
  LABEL = new Map(); BYLABEL = new Map();
  for (const i of ITEMS) { const l = seen.get(i.name) > 1 ? `${i.name} #${i.id}` : i.name; LABEL.set(i.id, l); BYLABEL.set(l.toLowerCase(), i); }
  // CEP + DCEP of the same design are sold together: one pick adds both lines.
  const fam = (p) => new Map(ITEMS.filter((i) => i.active && i.name.toUpperCase().startsWith(p + '-')).map((i) => [i.name.slice(p.length + 1).trim().toLowerCase(), i]));
  const cep = fam('CEP'), dcep = fam('DCEP');
  // A logo piece is always billed together with its plain base piece (Black or White) in the same quantity.
  // The base piece is the plain Black or White item of the same family (CEP-Black, CEP-White, DCEP-Black, DCEP-White).
  const side = (word, m) => {
    const base = (colour) => ITEMS.find((i) => i.name.trim().toLowerCase() === `${word}-${colour}`.toLowerCase());
    return { word, logos: [...m.values()].filter((i) => /-logo$/i.test(i.name.trim())).sort((x, y) => x.name.localeCompare(y.name)), bases: [base('Black'), base('White')].filter(Boolean) };
  };
  BUNDLES = [side('CEP', cep), side('DCEP', dcep)].filter((g) => g.logos.length && g.bases.length);
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
  const menu = [['home', 'Dashboard', '🏠'], ['parties', 'Parties', '👥'], ['items', 'Items', '📦'], ['sale', 'Sale', '🧾'], ['purchase', 'Purchase', '🛒'], ['credit', 'Credit Note', '↩️'], ['entries', 'All Transactions', '📒']];
  if (can('reports')) menu.push(['reports', 'Reports', '📊']);
  if (owner() && HAS_BIN) menu.push(['bin', 'Recycle Bin', '🗑️']);
  if (owner()) menu.push(['staff', 'Staff & Access', '⚙️']);
  $('#menu').innerHTML = menu.map(([k, v, ic]) => `<a href="#${k}" data-k="${k}"><i>${ic}</i>${v}</a>`).join('');
  route();
}
window.onhashchange = () => ME && route();

const VIEWS = {};
let SEL = { party: null, item: null }, ADJ = new Map();
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
const payStatus = (t) => (t.total == null || isOwn({ name: t.party }) ? '' : t.type === 'payment_in' || t.type === 'payment_out' ? '' : (t.balance || 0) <= 0.005 ? 'Paid' : (t.paid || 0) <= 0.005 ? 'Unpaid' : 'Partial');
function txnTable(rows, { party = true, pay = false, acct = false } = {}) {
  if (!rows.length) return '<div class="empty">No transactions found</div>';
  const st = { Paid: 'payment_in', Unpaid: 'sale', Partial: 'sale_return' };
  return `<div class="tw"><table><thead><tr><th>DATE</th><th>TYPE</th>${party ? '<th>PARTY</th>' : ''}${acct ? '<th>ACCOUNT</th>' : ''}${pay ? '<th>PAYMENT TYPE</th>' : ''}<th class="r">TOTAL</th>${pay ? '<th class="r">PAID</th>' : ''}<th class="r">BALANCE</th>${pay ? '<th>STATUS</th>' : ''}</tr></thead><tbody>${
    rows.map((t) => { const ps = payStatus(t); return `<tr class="click" data-txn="${t.id}"><td>${fdate(t.date)}</td><td><span class="tag ${t.type}">${TYPE[t.type]}</span></td>${
      party ? `<td>${esc(t.party || 'Cash')}</td>` : ''}${acct ? `<td>${acctTag(t.account)}</td>` : ''}${pay ? `<td>${esc(t.payment_type || '')}</td>` : ''}<td class="r">${money(t.total)}</td>${pay ? `<td class="r">${money(t.paid)}</td>` : ''}<td class="r">${money(t.balance)}</td>${
      pay ? `<td>${ps ? `<span class="tag ${st[ps]}">${ps}</span>` : ''}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>`;
}
function csv(name, head, rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv' }));
  a.download = `${name}_${today()}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// ---------- WhatsApp message (one click) ----------
// After an entry is saved for a party that has a mobile number, a ready message is shown;
// one click opens WhatsApp with the number and text filled in. Nothing is sent without that click.
let WA_AFTER = null;
function waPhone(p) {
  let d = String(p?.phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) d = '91' + d;
  return d.length === 12 && d.startsWith('91') ? d : null;
}
const waParty = (t) => PARTIES.find((p) => p.id === t.party_id);
const waCan = (t) => { const p = waParty(t); return !!p && !isOwn(p) && !!waPhone(p) && t.type !== 'other' && t.total != null && can('party_balance'); };
function waText(t, p, edited, lines = []) {
  const firm = CFG.firmName || CFG.appName, rs = (n) => '₹ ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const L = [`Greetings from ${firm},`, edited ? 'Please find the updated details of your transaction.' : 'We are pleased to have you as a valuable customer. Please find the details of your transaction.', ''];
  L.push(`*${TYPE[t.type]}*`, `Date: ${fdate(t.date)}`);
  if (t.type === 'payment_in') L.push(`Received: ${rs(t.total)}`);
  else if (t.type === 'payment_out') L.push(`Paid: ${rs(t.total)}`);
  else {
    const out = t.type === 'purchase' || t.type === 'sale_return';   // money goes from us to the party
    L.push(`${t.type === 'sale' ? 'Invoice Amount' : t.type === 'purchase' ? 'Bill Amount' : 'Amount'}: ${rs(t.total)}`, `${out ? 'Paid' : 'Received'}: ${rs(t.paid)}`, `Balance: ${rs(t.balance)}`);
  }
  if (lines.length) {
    // the goods on this bill, so the party can check them (kept short enough for a WhatsApp link)
    const num = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
    L.push('', `*Items (${lines.length})*`);
    let used = 0, shown = 0, q = 0;
    for (const l of lines) if (!isLogoPart(l.item)) q += Number(l.qty || 0);
    for (const l of lines) {
      const row = `${shown + 1}. ${lineName(l)} - ${num(l.qty)} x ${rs(l.price)} = ${rs(l.total)}`;
      if (used + row.length > 2600) break;
      L.push(row); used += row.length + 1; shown++;
    }
    if (shown < lines.length) L.push(`...and ${lines.length - shown} more items`);
    L.push(`Total quantity: ${num(q)}`, '');
  }
  const b = Number(p.balance || 0);
  L.push(Math.abs(b) < 0.005 ? 'Total Balance: ₹ 0' : b > 0 ? `Total Balance: ${rs(b)}` : `Total Balance: ${rs(-b)} (advance with us)`);
  L.push('', 'Thanks for doing business with us.', '', 'Regards,', firm);
  return L.join('\n');
}
async function waOffer(id, edited) {
  const { data: t, error } = await sb.from('v_transactions').select('*').eq('id', id).single();
  if (error || !t || !waCan(t)) return;
  const p = waParty(t), phone = waPhone(p);
  const lines = t.type === 'payment_in' || t.type === 'payment_out' ? [] : await all('v_line_items', (q) => q.eq('txn_id', id).order('id'));
  const link = (txt) => `https://wa.me/${phone}?text=${encodeURIComponent(txt)}`;
  dialog('Send on WhatsApp?', `<p style="margin-top:0">To <b>${esc(p.name)}</b> · +${phone.slice(0, 2)} ${phone.slice(2)}</p>
    <label class="f">Message (you can change it before sending)<textarea id="wa_txt" rows="13" style="font-size:14px;line-height:1.45"></textarea></label>
    <p class="mute" style="margin-bottom:0">WhatsApp opens with this message ready. Press Send there.</p>`,
  null, { extra: '<button class="btn lite" type="button" id="wa_no">NOT NOW</button><a class="btn wa" id="wa_go" target="_blank" rel="noopener">SEND ON WHATSAPP</a>' });
  $('#wa_txt').value = waText(t, p, edited, lines);
  const set = () => { $('#wa_go').href = link($('#wa_txt').value); };
  set(); $('#wa_txt').oninput = set;
  $('#wa_no').onclick = () => $('#dlg').close();
  $('#wa_go').onclick = () => setTimeout(() => $('#dlg').close(), 200);
}

// ---------- confirm popup ----------
function ask(title, message, okText = 'YES', tone = 'pri') {
  return new Promise((resolve) => {
    const d = $('#askdlg');
    $('#asktitle').textContent = title; $('#askmsg').textContent = message;
    const okb = $('#askok'); okb.textContent = okText; okb.className = 'btn ' + tone;
    const done = (v) => { d.onclose = null; okb.onclick = null; $('#askno').onclick = null; if (d.open) d.close(); resolve(v); };
    okb.onclick = () => done(true); $('#askno').onclick = () => done(false); d.onclose = () => done(false);
    d.showModal(); $('#askno').focus();
  });
}

// keeps the table heading stuck just under the fixed top row inside a dialog
const sumFit = () => { const b = $('#sumbar'); if (b) $('#dbody').style.setProperty('--sumh', b.offsetHeight + 'px'); };

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
  try { WA_AFTER = null; await onSave(); $('#dlg').close(); await refresh(); toast('Saved'); if (WA_AFTER) { const w = WA_AFTER; WA_AFTER = null; waOffer(w.id, w.edited).catch((e) => toast(e.message)); } }
  catch (err) { $('#derr').textContent = err.message; }
  $('#dsave').disabled = false;
};
const val = (id) => { const v = $('#' + id)?.value?.trim(); return v === '' || v == null ? null : v; };
const numv = (id) => { const v = val(id); return v == null ? null : Number(v); };
const field = (id, label, value = '', attrs = '') => `<label class="f">${label}<input id="${id}" value="${esc(value ?? '')}" ${attrs}></label>`;

// ---------- home ----------
const lowItems = () => ITEMS.filter((i) => i.active && !i.is_service && i.min_stock > 0 && i.stock <= i.min_stock).sort((x, y) => x.stock - y.stock);
const rs = (n) => money(Math.round(n));   // whole rupees on the dashboard
VIEWS.home = async () => {
  $('#title').textContent = 'Dashboard';
  const { data: recent, error } = await sb.from('v_transactions').select('*').order('date', { ascending: false }).order('id', { ascending: false }).limit(15);
  if (error) throw new Error(error.message);
  const goods = ITEMS.filter((i) => i.active && !i.is_service);
  const low = lowItems().length;
  const cards = [];   // [label, value, small line, click attribute, icon, colour]
  if (can('sale_price')) {
    const m = await all('v_transactions', (q) => q.in('type', ['sale', 'sale_return']).gte('date', monthStart()).lte('date', today()).order('id'));
    const sales = m.filter((t) => t.type === 'sale'), cn = m.filter((t) => t.type === 'sale_return');
    const tot = (list) => list.reduce((s, t) => s + (t.total || 0), 0);
    cards.push([`Sale this month (${new Date().toLocaleString('en-IN', { month: 'long' })})`, rs(tot(sales)),
      `${sales.length} bills · credit notes ${rs(tot(cn))} · net ${rs(tot(sales) - tot(cn))}`, 'data-go="sale"', '📈', 'hero']);
  }
  if (can('party_balance')) {
    const mine = PARTIES.filter((p) => !isOwn(p));
    cards.push(['To receive', rs(mine.reduce((s, p) => s + Math.max(p.balance || 0, 0), 0)), 'Parties owe you', 'data-go="parties"', '⬇️', 'green']);
    cards.push(['To pay', rs(mine.reduce((s, p) => s + Math.max(-(p.balance || 0), 0), 0)), 'You owe parties', 'data-go="parties"', '⬆️', 'rose']);
  }
  const sval = (on) => ITEMS.filter((i) => !i.is_service && i.active === on).reduce((s, i) => s + Math.max(i.stock, 0) * (i.purchase_price || 0), 0);
  if (can('purchase_price')) cards.push(['Stock value (total)', rs(sval(true) + sval(false)), `Active ${rs(sval(true))}<br>Inactive ${rs(sval(false))}`, '', '💰', 'gold']);
  cards.push(['Items', goods.length.toLocaleString('en-IN'), 'Active items', 'data-go="items"', '📦', 'blue'],
    ['Low stock items', low, low ? 'Click to see the list' : 'All items are fine', 'data-low="1"', '⚠️', low ? 'amber' : 'green']);
  $('#view').innerHTML = `<div class="kpis">${cards.map(([k, v, sub, attr, ic, c]) => `<div class="kpi ${c} ${attr ? 'tap' : ''}" ${attr}><div class="ic">${ic}</div><div class="tx"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${attr ? '<div class="go">›</div>' : ''}</div>`).join('')}</div>
    <div class="panel"><div class="hd"><h2>Recent transactions</h2><a class="btn sm buy" href="#entries">See all</a></div>${txnTable(recent)}</div>`;
};
function lowDialog() {
  const list = lowItems();
  dialog(`Low stock items (${list.length})`, list.length ? `<p class="mute" style="margin-top:0">Stock is at or below the alert level. Click an item to open it.</p>
    <div class="tw"><table><thead><tr><th>ITEM</th><th>CATEGORY</th><th class="r">STOCK</th><th class="r">ALERT AT</th><th class="r">SHORT BY</th></tr></thead><tbody>${
    list.map((i) => `<tr class="click" data-goitem="${i.id}"><td>${esc(i.name)}</td><td>${esc(i.category || '')}</td><td class="r ${i.stock <= 0 ? 'bad' : 'warn'}">${qty(i.stock)}</td><td class="r">${qty(i.min_stock)}</td><td class="r">${qty(i.min_stock - i.stock)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No item is low on stock</div>', null,
    { extra: list.length ? '<button class="btn" type="button" id="lowcsv">EXCEL (CSV)</button>' : '' });
  if ($('#lowcsv')) $('#lowcsv').onclick = () => csv('low_stock', ['Item', 'Category', 'Stock', 'Unit', 'Alert at', 'Short by'], list.map((i) => [i.name, i.category || '', i.stock, i.unit || '', i.min_stock, i.min_stock - i.stock]));
}

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
      `<div class="row ${p.id === SEL.party ? 'on' : ''}" data-party="${p.id}"><span class="n">${esc(p.name)}</span><span>${isOwn(p) ? '<span class="mute">—</span>' : balHtml(p.balance)}</span></div>`).join('') || '<div class="empty">No party found</div>';
  };
  $('#psearch').oninput = draw; draw();
  await partyDetail();
};
async function partyDetail() {
  const p = PARTIES.find((x) => x.id === SEL.party);
  if (!p) { $('#pdet').innerHTML = '<div class="panel"><div class="empty">Add your first party</div></div>'; return; }
  const rows = await all('v_transactions', (q) => q.eq('party_id', p.id).order('date', { ascending: false }).order('id', { ascending: false }));
  const pay = can('entries') && can('party_balance');
  // totals of each kind of entry for this party (amount shown only if this user may see it)
  const KINDS = [['sale', 'Sale bills', '🧾', 'purple'], ['sale_return', 'Credit notes', '↩️', 'gold'], ['purchase', 'Purchase bills', '🛒', 'blue'],
    ['purchase_return', 'Debit notes', '↪️', 'gold'], ['payment_in', 'Payment-In', '⬇️', 'green'], ['payment_out', 'Payment-Out', '⬆️', 'red']];
  const totals = KINDS.map(([type, label, ic, c]) => { const r = rows.filter((t) => t.type === type); return { label, ic, c, n: r.length, amt: r.some((t) => t.total != null) ? r.reduce((s, t) => s + (t.total || 0), 0) : null }; }).filter((k) => k.n);
  $('#pdet').innerHTML = `<div class="panel hero"><div class="hd"><div class="ttl"><h2>${esc(p.name)}</h2><div class="chips">${
    [isOwn(p) && 'No balance counted for this party', p.phone && `📞 ${esc(p.phone)}`, p.gstin && `GSTIN ${esc(p.gstin)}`, p.state && `📍 ${esc(p.state)}`].filter(Boolean).map((c) => `<span class="chip">${c}</span>`).join('')}</div></div>${
    pay ? `<button class="btn sm" data-new="payment_in" data-for="${p.id}">+ PAYMENT-IN</button><button class="btn sm" data-new="payment_out" data-for="${p.id}">+ PAYMENT-OUT</button>` : ''}${
    can('manage_parties') ? `<button class="btn sm" data-party-edit="${p.id}">EDIT</button>` : ''}</div>
    <div class="stats">${p.balance == null || isOwn(p) ? '' : `<div class="stat ${p.balance < -0.005 ? 'red' : 'green'}"><i>💰</i><div><span>${balWord(p.balance)}</span><b>${money(Math.abs(p.balance))}</b></div></div>`}
    ${totals.map((k) => `<div class="stat ${k.c}"><i>${k.ic}</i><div><span>${k.label} (${k.n})</span><b>${k.amt == null ? k.n : money(k.amt)}</b></div></div>`).join('')}
    <div class="stat blue"><i>📋</i><div><span>Transactions</span><b>${rows.length}</b></div></div>${
    rows[0] ? `<div class="stat purple"><i>📅</i><div><span>Last entry</span><b>${fdate(rows[0].date)}</b></div></div>` : ''}${
    p.address ? `<div class="stat gold"><i>🏠</i><div><span>Address</span><b class="wrap">${esc(p.address)}</b></div></div>` : ''}</div></div>
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
let ITEM_SHOW = 'active';   // active | inactive | all
let ITEM_SEL = new Set();   // ticked items (for doing one thing to many items)
let ITEM_SORT = 'name_asc';   // name_asc | name_desc | stock_asc | stock_desc
let ITEM_BAR = null;         // redraws the tick counter and the buttons that act on the ticked items
// what the ticked items can have done to them on this tab: Active -> mark inactive, Inactive -> delete
const bulkMode = () => (ITEM_SHOW === 'active' && can('manage_items') ? 'off' : ITEM_SHOW === 'inactive' && HAS_ITEMDEL ? 'del' : '');
VIEWS.items = async () => {
  $('#title').textContent = 'Items';
  const nA = ITEMS.filter((i) => i.active).length, nI = ITEMS.length - nA;
  const list = ITEMS.filter((i) => ITEM_SHOW === 'all' || i.active === (ITEM_SHOW === 'active'));
  if (!list.find((i) => i.id === SEL.item)) SEL.item = list[0]?.id ?? null;
  const mode = bulkMode(), ids = new Set(list.map((i) => i.id));
  ITEM_SEL = new Set([...ITEM_SEL].filter((id) => mode && ids.has(id)));
  $('#view').innerHTML = `<div class="split"><div class="panel list"><div class="hd"><input class="search" id="isearch" placeholder="Search item or code">${
    can('manage_items') ? '<button class="btn pri sm" data-item-new="1">+ ADD ITEM</button>' : ''}</div>
    <div class="seg">${[['active', `Active (${nA})`], ['inactive', `Inactive (${nI})`], ['all', `All (${ITEMS.length})`]].map(([k, v]) => `<button type="button" class="${ITEM_SHOW === k ? 'on' : ''}" data-itemshow="${k}">${v}</button>`).join('')}</div>
    ${mode ? `<div class="selbar"><label class="c"><input type="checkbox" id="iall"> <span id="icount">Select all</span></label>
      <button class="btn sm ${mode === 'del' ? 'danger' : 'lite'}" id="ibulk" disabled>${mode === 'del' ? 'DELETE SELECTED' : 'MARK INACTIVE'}</button></div>` : ''}
    <div class="lhead"><button type="button" id="sname" title="Sort by name"></button><button type="button" id="sstock" title="Sort by stock"></button></div>
    <div class="rows" id="irows"></div></div><div class="det" id="idet"></div></div>`;
  let hit = [];
  const canEditItem = can('manage_items');
  const bar = () => {
    if (!mode) return;
    const n = ITEM_SEL.size, shown = hit.filter((i) => ITEM_SEL.has(i.id)).length;
    $('#icount').textContent = n ? `${n} selected` : `Select all (${hit.length})`;
    $('#iall').checked = hit.length > 0 && shown === hit.length; $('#iall').indeterminate = shown > 0 && shown < hit.length;
    const label = (mode === 'del' ? 'DELETE SELECTED' : 'MARK INACTIVE') + (n ? ` (${n})` : '');
    $('#ibulk').disabled = !n; $('#ibulk').textContent = label;
    $('.selbar').classList.toggle('active', n > 0);
    // While items are ticked, the buttons beside the open item act on ALL ticked items,
    // so nobody deletes just the one open item by mistake.
    const hd = $('#idet .hd');
    if (hd) {
      hd.querySelectorAll('[data-item-del],[data-item-toggle],[data-adjust],[data-item-edit]').forEach((b) => b.classList.toggle('hide', n > 0));
      let big = hd.querySelector('#ibulk2');
      if (n > 0 && !big) { hd.insertAdjacentHTML('beforeend', '<button class="btn danger" type="button" id="ibulk2"></button>'); big = hd.querySelector('#ibulk2'); big.onclick = () => $('#ibulk').click(); }
      if (big) { big.classList.toggle('hide', !n); big.textContent = label; }
    }
  };
  ITEM_BAR = mode ? bar : null;
  const draw = () => {
    const s = $('#isearch').value.toLowerCase();
    hit = list.filter((i) => i.name.toLowerCase().includes(s) || (i.code || '').toLowerCase().includes(s));
    const [by, dir] = ITEM_SORT.split('_'), sign = dir === 'desc' ? -1 : 1;
    hit.sort((a, b) => (by === 'stock' ? (Number(a.stock) - Number(b.stock)) * sign || a.name.localeCompare(b.name) : a.name.localeCompare(b.name) * sign));
    $('#sname').textContent = 'ITEM' + (by === 'name' ? (dir === 'asc' ? '  A → Z ▲' : '  Z → A ▼') : '');
    $('#sstock').textContent = 'STOCK' + (by === 'stock' ? (dir === 'asc' ? '  low → high ▲' : '  high → low ▼') : '  ⇅');
    $('#sname').classList.toggle('on', by === 'name'); $('#sstock').classList.toggle('on', by === 'stock');
    $('#irows').innerHTML = hit.map((i) => {
      const low = !i.is_service && (i.stock < 0 || (i.active && i.min_stock > 0 && i.stock <= i.min_stock));
      return `<div class="row ${i.id === SEL.item ? 'on' : ''} ${i.active ? '' : 'off'}" data-item="${i.id}">${mode ? `<input type="checkbox" class="isel" data-sel="${i.id}" ${ITEM_SEL.has(i.id) ? 'checked' : ''}>` : ''}<span class="n">${esc(i.name)}${i.active ? '' : ' <em>Inactive</em>'}</span><span class="${low ? 'bad' : 'good'}">${i.is_service ? '' : qty(i.stock)}</span></div>`;
    }).join('') || '<div class="empty">No item found</div>';
    bar();
  };
  $('#isearch').oninput = draw; draw();
  $('#sname').onclick = () => { ITEM_SORT = ITEM_SORT === 'name_asc' ? 'name_desc' : 'name_asc'; draw(); $('#irows').scrollTop = 0; };
  $('#sstock').onclick = () => { ITEM_SORT = ITEM_SORT === 'stock_asc' ? 'stock_desc' : 'stock_asc'; draw(); $('#irows').scrollTop = 0; };
  if (canEditItem) $('#irows').ondblclick = (e) => { const row = e.target.closest('[data-item]'); if (!row || e.target.closest('.isel,.redit')) return; const it = ITEMS.find((x) => x.id === Number(row.dataset.item)); if (it) itemForm(it); };
  if (mode) {
    $('#irows').addEventListener('change', (e) => { if (!e.target.classList.contains('isel')) return; const id = Number(e.target.dataset.sel); if (e.target.checked) ITEM_SEL.add(id); else ITEM_SEL.delete(id); bar(); });
    $('#iall').onchange = () => { for (const i of hit) { if ($('#iall').checked) ITEM_SEL.add(i.id); else ITEM_SEL.delete(i.id); } draw(); };
    $('#ibulk').onclick = () => bulkItems(mode).catch((err) => toast(err.message));
  }
  await itemDetail();
};
// One action on every ticked item, a few at a time, with a running count.
async function bulkItems(mode) {
  const picked = ITEMS.filter((i) => ITEM_SEL.has(i.id)), n = picked.length;
  if (!n) return;
  const del = mode === 'del';
  if (!(await ask(del ? `Delete ${n} item${n === 1 ? '' : 's'}?` : `Mark ${n} item${n === 1 ? '' : 's'} inactive?`,
    del ? 'They move to the Recycle Bin and disappear from every item list. Old bills still show their names. ' + (owner() ? 'You can restore them later.' : 'Only the owner can bring them back.')
      : 'They will be hidden from bills and from the Active list. Their old entries and stock stay as they are.',
    del ? `YES, DELETE ${n}` : `YES, MARK ${n} INACTIVE`, del ? 'danger' : 'pri'))) return;
  let done = 0; const failed = [];
  const one = async (i) => {
    try {
      if (del) await rpc('delete_item', { p_id: i.id });
      else await rpc('save_item', { p: { id: i.id, name: i.name, code: i.code, category_id: i.category_id, unit: i.unit, hsn: i.hsn, tax_rate: i.tax_rate, min_stock: i.min_stock,
        location: i.location, description: i.description, sale_price: i.sale_price, purchase_price: i.purchase_price, mrp: i.mrp, active: false } });
    } catch (err) { failed.push(`${i.name}: ${err.message}`); }
    done++; const t = `${done} / ${n}…`; if ($('#ibulk')) $('#ibulk').textContent = t; if ($('#ibulk2')) $('#ibulk2').textContent = t;
  };
  $('#ibulk').disabled = true; if ($('#ibulk2')) $('#ibulk2').disabled = true;
  const queue = picked.slice();
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await one(queue.shift()); }));
  ITEM_SEL = new Set(); SEL.item = null;
  await refresh();
  if (failed.length) dialog(`${n - failed.length} done, ${failed.length} not done`, `<p style="margin-top:0">These could not be ${del ? 'deleted' : 'changed'}:</p><ul>${failed.slice(0, 50).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`, null);
  else toast(del ? `${n} item${n === 1 ? '' : 's'} moved to Recycle Bin` : `${n} item${n === 1 ? '' : 's'} marked inactive`);
}
async function itemDetail() {
  const i = ITEMS.find((x) => x.id === SEL.item);
  if (!i) { $('#idet').innerHTML = '<div class="panel"><div class="empty">Add your first item</div></div>'; return; }
  const [lines, adj] = await Promise.all([
    sb.from('v_line_items').select('*').eq('item_id', i.id).order('date', { ascending: false }).order('id', { ascending: false }).limit(300),
    sb.from('v_adjustments').select('*').eq('item_id', i.id).order('date', { ascending: false }).order('id', { ascending: false }).limit(300),
  ]);
  if (lines.error || adj.error) throw new Error((lines.error || adj.error).message);
  const KIND = { opening: 'Opening Stock', add: 'Add Stock', reduce: 'Reduce Stock' };
  ADJ = new Map(adj.data.map((a) => [a.id, a]));
  const rows = [
    ...lines.data.map((l) => ({ date: l.date, type: TYPE[l.type], cls: l.type, txn: l.txn_id, qty: (l.type === 'purchase' || l.type === 'sale_return' ? 1 : l.type === 'other' ? 0 : -1) * l.qty, raw: l.qty, price: l.price, note: l.description })),
    ...adj.data.map((a) => ({ date: a.date, type: KIND[a.kind], cls: '', adj: a.id, qty: (a.kind === 'reduce' ? -1 : 1) * a.qty, raw: a.qty, price: a.at_price, note: a.description })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const low = !i.is_service && (i.stock < 0 || (i.active && i.min_stock > 0 && i.stock <= i.min_stock));
  const facts = [];
  if (!i.is_service) facts.push(['📦', 'Stock quantity', qty(i.stock), low ? 'red' : 'green']);
  if (can('sale_price')) facts.push(['🏷️', 'Sale price', money(i.sale_price), 'purple']);
  if (can('purchase_price')) facts.push(['🛒', 'Purchase price', money(i.purchase_price), 'blue']);
  if (can('purchase_price') && !i.is_service) facts.push(['💰', 'Stock value', money(Math.max(i.stock, 0) * (i.purchase_price || 0)), 'gold']);
  const chips = [i.category && `📁 ${esc(i.category)}`, i.code && `# ${esc(i.code)}`, i.location && `📍 ${esc(i.location)}`,
    i.active && i.min_stock > 0 && `Alert at ${qty(i.min_stock)}`].filter(Boolean).map((c) => `<span class="chip">${c}</span>`).join('')
    + (low ? `<span class="chip lowchip">${i.stock < 0 ? 'NEGATIVE STOCK' : 'LOW STOCK'}</span>` : '')
    + (i.active ? '' : '<span class="chip offchip">INACTIVE · hidden from bills</span>');
  $('#idet').innerHTML = `<div class="panel hero near"><div class="hd"><div class="ttl"><h2>${esc(i.name)}</h2>${chips ? `<div class="chips">${chips}</div>` : ''}</div>${
    can('manage_items') ? `<button class="btn sm buy" data-item-edit="${i.id}">✏️ EDIT</button>` : ''}${
    (canAdjust() || (can('adjust_inactive') && !i.active)) && !i.is_service ? `<button class="btn sm pri" data-adjust="${i.id}">ADJUST STOCK</button>` : ''}${
    can('manage_items') ? `<button class="btn sm lite" data-item-toggle="${i.id}">${i.active ? 'MARK INACTIVE' : 'MARK ACTIVE'}</button>` : ''}${HAS_ITEMDEL && !i.active ? `<button class="btn sm danger" data-item-del="${i.id}">DELETE</button>` : ''}</div>
    <div class="stats">${facts.map(([ic, k, v, c]) => `<div class="stat ${c}"><i>${ic}</i><div><span>${k}</span><b>${v}</b></div></div>`).join('')}</div></div>
    <div class="panel"><div class="hd"><h2>Stock movement</h2><span class="mute">latest ${rows.length}</span></div>${rows.length ? `<div class="tw"><table><thead><tr><th>DATE</th><th>TYPE</th><th class="r">QUANTITY</th><th class="r">PRICE / UNIT</th><th>NOTE</th><th></th></tr></thead><tbody>${
      rows.map((r) => `<tr ${r.txn ? `class="click" data-txn="${r.txn}"` : ''}><td>${fdate(r.date)}</td><td><span class="tag ${r.cls}">${r.type}</span></td><td class="r ${r.qty < 0 ? 'bad' : r.qty > 0 ? 'good' : ''}">${r.qty > 0 ? '+' : r.qty < 0 ? '−' : ''}${qty(r.raw)}</td><td class="r">${money(r.price)}</td><td>${esc(r.note || '')}</td><td>${
        (r.adj && HAS_EDIT && canAdjust() && (owner() || can('edit_entries')) ? `<button class="btn sm buy" data-adj-edit="${r.adj}">EDIT</button> ` : '') + (r.adj && canAdjust() && canDelete() ? `<button class="btn sm danger" data-adj-del="${r.adj}">DELETE</button>` : '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No movement yet</div>'}</div>`;
  if (ITEM_BAR) ITEM_BAR();
}

function itemForm(i = {}) {
  dialog(i.id ? 'Edit item' : 'Add item', `<div class="grid">${field('f_name', 'Item name *', i.name, 'required')}${field('f_code', 'Item code', i.code)}
    <label class="f">Category<input id="f_cat" list="catlist" value="${esc(i.category || '')}"><datalist id="catlist">${CATS.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
    ${field('f_unit', 'Unit (Pcs, Kg, Box…)', i.unit)}${field('f_tax', 'Tax %', i.tax_rate ?? 0, 'type="number" step="any" min="0"')}
    ${can('sale_price') ? field('f_sale', 'Sale price', i.sale_price, 'type="number" step="any" min="0"') : ''}
    ${can('purchase_price') ? field('f_buy', 'Purchase price', i.purchase_price, 'type="number" step="any" min="0"') : ''}
    ${i.id ? '' : field('f_open', 'Opening stock', '', 'type="number" step="any"')}
    ${field('f_min', 'Low stock alert at', i.min_stock ?? 0, 'type="number" step="any" min="0"')}${field('f_loc', 'Location', i.location)}</div>
    ${i.id ? `<label class="c"><input type="checkbox" id="f_active" ${i.active ? 'checked' : ''}> Active</label>` : ''}`,
  async () => {
    const cat = val('f_cat');
    const category_id = cat ? await rpc('save_category', { p_name: cat }) : null;
    SEL.item = await rpc('save_item', { p: { id: i.id ?? null, name: val('f_name'), code: val('f_code'), category_id, unit: val('f_unit'), hsn: i.hsn ?? null,
      tax_rate: numv('f_tax') ?? 0, sale_price: numv('f_sale'), purchase_price: numv('f_buy'), opening_stock: numv('f_open'), min_stock: numv('f_min') ?? 0,
      location: val('f_loc'), description: i.description ?? null, mrp: i.mrp ?? null, is_service: i.is_service ?? false, active: i.id ? $('#f_active').checked : true } });
  });
}
function adjustForm(id, a = null) {
  const i = ITEMS.find((x) => x.id === id), opening = a?.kind === 'opening';
  dialog(`${a ? 'Edit' : 'Adjust'} stock — ${i.name}`, `<div class="grid">${opening ? '<label class="f">Type<input value="Opening stock" disabled></label>'
    : `<label class="f">Type<select id="f_kind"><option value="add" ${a?.kind === 'add' ? 'selected' : ''}>Add stock</option><option value="reduce" ${a?.kind === 'reduce' ? 'selected' : ''}>Reduce stock</option></select></label>`}
    ${field('f_qty', 'Quantity *', a ? a.qty : '', 'type="number" step="any" min="0" required')}${field('f_date', 'Date', a ? a.date : today(), 'type="date"')}
    ${can('purchase_price') ? field('f_at', 'At price', (a ? a.at_price : i.purchase_price) ?? '', 'type="number" step="any" min="0"') : ''}${field('f_note', 'Note', a?.description || '')}</div>
    <p class="mute">Current stock: ${qty(i.stock)}</p>`,
  () => rpc(a ? 'update_adjustment' : 'save_adjustment', { p: { id: a?.id, item_id: id, kind: opening ? 'opening' : val('f_kind'), qty: numv('f_qty'), date: val('f_date'), at_price: numv('f_at'), description: val('f_note') } }));
}

// ---------- transactions ----------
let FILTER = { type: '', period: 'month', from: '', to: '', party: '', status: '', account: '', q: '' };
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'],
  ['year', 'This year'], ['lastyear', 'Last year'], ['all', 'All time'], ['custom', 'Custom dates']];
function periodDates(p) {
  const iso = (d) => d.toLocaleDateString('en-CA'), n = new Date(), y = n.getFullYear(), m = n.getMonth();
  if (p === 'today') return [iso(n), iso(n)];
  if (p === 'week') { const d = new Date(n); d.setDate(n.getDate() - ((n.getDay() + 6) % 7)); const e = new Date(d); e.setDate(d.getDate() + 6); return [iso(d), iso(e)]; }
  if (p === 'lastmonth') return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
  if (p === 'quarter') return [iso(new Date(y, Math.floor(m / 3) * 3, 1)), iso(new Date(y, Math.floor(m / 3) * 3 + 3, 0))];
  if (p === 'year') return [iso(new Date(y, 0, 1)), iso(new Date(y, 11, 31))];
  if (p === 'lastyear') return [iso(new Date(y - 1, 0, 1)), iso(new Date(y - 1, 11, 31))];
  if (p === 'all') return ['2000-01-01', '2099-12-31'];
  return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];   // whole month, so entries dated ahead (appointments) show too
}
// One list screen, used for "all entries" and for the Sale / Purchase / Credit Note menu tabs.
async function entriesView(fixed, title) {
  $('#title').textContent = title;
  if (FILTER.period !== 'custom' || !FILTER.from) [FILTER.from, FILTER.to] = periodDates(FILTER.period);
  const type = fixed || FILTER.type;
  const fetched = await all('v_transactions', (q) => {
    q = q.gte('date', FILTER.from).lte('date', FILTER.to).order('date', { ascending: false }).order('id', { ascending: false });
    if (type) q = q.eq('type', type);
    if (FILTER.party === 'cash') q = q.is('party_id', null); else if (FILTER.party) q = q.eq('party_id', Number(FILTER.party));
    return q;
  });
  const amounts = fixed ? sees(fixed) : (can('sale_price') || can('purchase_price'));
  const acct = HAS_ACCT && (!fixed || fixed === 'sale' || fixed === 'sale_return');
  const addBtn = fixed && can('entries') ? `<button class="btn sm ${fixed === 'purchase' ? 'buy' : fixed === 'sale_return' ? 'gold' : 'pri'}" data-new="${fixed}">+ ADD ${title.toUpperCase()}</button>` : '';
  $('#view').innerHTML = `<div class="panel"><div class="hd"><h2 id="ecount"></h2>${addBtn}</div>
    <div class="fbar">
      <label class="f">Period<select id="fp">${PERIODS.map(([k, v]) => `<option value="${k}" ${FILTER.period === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="f">From<input type="date" id="ff" value="${FILTER.period === 'all' ? '' : FILTER.from}"></label>
      <label class="f">To<input type="date" id="fto" value="${FILTER.period === 'all' ? '' : FILTER.to}"></label>
      ${fixed ? '' : `<label class="f">Type<select id="ft"><option value="">All types</option>${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${FILTER.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`}
      <label class="f">Party<select id="fparty"><option value="">All parties</option><option value="cash" ${FILTER.party === 'cash' ? 'selected' : ''}>Cash (no party)</option>${
        PARTIES.map((p) => `<option value="${p.id}" ${String(p.id) === FILTER.party ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      ${amounts ? `<label class="f">Payment status<select id="fs">${['', 'Paid', 'Unpaid', 'Partial'].map((v) => `<option value="${v}" ${FILTER.status === v ? 'selected' : ''}>${v || 'All'}</option>`).join('')}</select></label>` : ''}
      ${acct ? `<label class="f">Account<select id="fa"><option value="">All accounts</option><option value="-" ${FILTER.account === '-' ? 'selected' : ''}>No account</option>${ACCOUNTS.map((a) => `<option ${FILTER.account === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>` : ''}
      <label class="f grow">Search<input id="fq" placeholder="Party, account, amount or note" value="${esc(FILTER.q)}"></label>
      <button class="btn sm lite" id="fclear">CLEAR</button><button class="btn sm" id="fcsv">EXCEL (CSV)</button>
    </div><div id="etiles"></div><div id="eacct"></div><div id="etable"></div></div>`;
  let rows = [];
  const draw = () => {
    const q = FILTER.q.trim().toLowerCase();
    const base = fetched.filter((t) => (!FILTER.status || payStatus(t) === FILTER.status)
      && (!q || [t.party || 'cash', t.description, t.total, t.payment_type, t.account].some((v) => String(v ?? '').toLowerCase().includes(q))));
    const fa = acct ? FILTER.account : '';
    rows = base.filter((t) => !fa || (fa === '-' ? !t.account : t.account === fa));
    if (acct) {   // one chip per account for what is on screen; click to filter
      const by = new Map();
      for (const t of base) { if (!t.account) continue; const o = by.get(t.account) || { n: 0, total: 0 }; o.n++; o.total += (t.type === 'sale_return' ? -1 : 1) * (t.total || 0); by.set(t.account, o); }
      $('#eacct').innerHTML = by.size ? `<div class="achips"><b>By account</b>${[...by].sort().map(([a, o]) => `<button type="button" class="${fa === a ? 'on' : ''}" style="--ac:${acctColor(a)}" data-acct="${esc(a)}"><i></i>${esc(a)}<small>${o.n} ${o.n === 1 ? 'bill' : 'bills'}${amounts ? ' · ' + money(Math.round(o.total)) : ''}</small></button>`).join('')}${fa ? '<button type="button" data-acct="">Show all</button>' : ''}</div>` : '';
    }
    const sum = (t, f = 'total') => rows.filter((r) => !t || r.type === t).reduce((s, r) => s + (r[f] || 0), 0);
    const tiles = [];
    if (fixed && amounts) {
      tiles.push(['🧾', `${title} total`, money(sum(fixed)), 'purple'], ['💵', fixed === 'purchase' ? 'Paid' : fixed === 'sale_return' ? 'Paid back' : 'Received', money(sum(fixed, 'paid')), 'green']);
      const others = rows.filter((r) => r.type === fixed && !isOwn({ name: r.party }));
      if (others.length || !rows.length) tiles.push(['⏳', 'Unpaid balance', money(others.reduce((s, r) => s + (r.balance || 0), 0)), 'gold']);
    } else if (!fixed) {
      if (can('sale_price')) tiles.push(['🧾', 'Sale', money(sum('sale')), 'purple'], ['↩️', 'Credit notes', money(sum('sale_return')), 'gold']);
      if (can('purchase_price')) tiles.push(['🛒', 'Purchase', money(sum('purchase')), 'blue']);
    }
    $('#ecount').textContent = `${rows.length} ${fixed ? title.toLowerCase() + (rows.length === 1 ? ' entry' : ' entries') : 'entries'}`;
    $('#etiles').innerHTML = tiles.length ? `<div class="stats">${tiles.map(([ic, k, v, c]) => `<div class="stat ${c}"><i>${ic}</i><div><span>${k}</span><b>${v}</b></div></div>`).join('')}</div>` : '';
    $('#etable').innerHTML = txnTable(rows, { pay: amounts, acct });
  };
  draw();
  $('#fp').onchange = () => { FILTER.period = $('#fp').value; if (FILTER.period !== 'custom') route(); };
  const dates = () => { FILTER.period = 'custom'; FILTER.from = $('#ff').value || FILTER.from; FILTER.to = $('#fto').value || FILTER.to; route(); };
  $('#ff').onchange = dates; $('#fto').onchange = dates;
  if ($('#ft')) $('#ft').onchange = () => { FILTER.type = $('#ft').value; route(); };
  $('#fparty').onchange = () => { FILTER.party = $('#fparty').value; route(); };
  if ($('#fs')) $('#fs').onchange = () => { FILTER.status = $('#fs').value; draw(); };
  if ($('#fa')) $('#fa').onchange = () => { FILTER.account = $('#fa').value; draw(); };
  $('#eacct').onclick = (e) => { const b = e.target.closest('[data-acct]'); if (!b) return; FILTER.account = b.dataset.acct; if ($('#fa')) $('#fa').value = FILTER.account; draw(); };
  $('#fq').oninput = () => { FILTER.q = $('#fq').value; draw(); };
  $('#fclear').onclick = () => { FILTER = { type: '', period: 'month', from: '', to: '', party: '', status: '', account: '', q: '' }; route(); };
  $('#fcsv').onclick = () => csv(fixed || 'transactions', ['Date', 'Type', 'Party', 'Account', 'Payment type', 'Total', 'Paid', 'Balance', 'Status'],
    rows.map((t) => [fdate(t.date), TYPE[t.type], t.party || 'Cash', t.account || '', t.payment_type, t.total, t.paid, t.balance, payStatus(t)]));
}
VIEWS.entries = () => entriesView('', 'All Transactions');
VIEWS.sale = () => entriesView('sale', 'Sale');
VIEWS.purchase = () => entriesView('purchase', 'Purchase');
VIEWS.credit = () => entriesView('sale_return', 'Credit Note');
let OPEN_TXN = null;
async function txnView(id) {
  const [{ data: t, error }, lines] = await Promise.all([
    sb.from('v_transactions').select('*').eq('id', id).single(),
    all('v_line_items', (q) => q.eq('txn_id', id).order('id')),
  ]);
  if (error) throw new Error(error.message);
  OPEN_TXN = { t, lines };
  const when = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const totalQty = lines.reduce((n, l) => n + (isLogoPart(l.item) ? 0 : Number(l.qty || 0)), 0);
  const sf = (k, v, cls = '') => `<div class="sf ${cls}"><span>${k}</span><b>${v}</b></div>`;
  dialog(`${TYPE[t.type]} · ${fdate(t.date)}`, `<div class="sumbar" id="sumbar">
      ${sf('Date', fdate(t.date))}${sf('Party', esc(t.party || 'Cash'))}${t.account ? sf('Account', acctTag(t.account)) : ''}
      ${lines.length ? sf('Items', lines.length) + sf('Total quantity', qty(totalQty), 'hi') : ''}
      ${sf('Total', money(t.total), 'key')}${sf('Paid', money(t.paid))}${isOwn({ name: t.party }) ? '' : sf('Balance', money(t.balance))}
      ${t.edited_at ? sf('Last edited', esc(`${t.edited_by_name || ''} · ${when(t.edited_at)}`), 'sm') : t.created_by_name ? sf('Entered by', esc(t.created_by_name), 'sm') : ''}
    </div>${t.description ? `<p>${esc(t.description)}</p>` : ''}
    ${lines.length ? `<table class="stick"><thead><tr><th>#</th><th>ITEM</th><th class="r">QTY</th><th class="r">PRICE</th><th class="r">AMOUNT</th></tr></thead><tbody>${
      lines.map((l, n) => `<tr><td>${n + 1}</td><td>${esc(lineName(l))}</td><td class="r">${qty(l.qty)}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.total)}</td></tr>`).join('')}</tbody></table>` : ''}`,
  null, { extra: (waCan(t) ? `<button class="btn wa" type="button" data-wa="${id}">WHATSAPP</button>` : '') + (canEdit(t.type) ? `<button class="btn buy" type="button" data-txn-edit="${id}">EDIT</button>` : '') + (canDelete() ? `<button class="btn danger" type="button" data-txn-del="${id}">DELETE</button>` : '') });
  sumFit();
}
function paymentForm(type, partyId, edit = null) {
  const t = edit?.t, pid = t ? t.party_id : partyId;
  dialog(t ? `Edit ${TYPE[type]} · ${fdate(t.date)}` : TYPE[type], `<div class="grid"><label class="f">Party *<select id="f_party" required><option value="">Choose</option>${
    PARTIES.filter((p) => p.active || p.id === pid).map((p) => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    ${field('f_date', 'Date', t ? t.date : today(), 'type="date"')}${field('f_amt', type === 'payment_in' ? 'Amount received *' : 'Amount paid *', t ? t.total : '', 'type="number" step="any" min="0" required')}
    <label class="f">Mode<select id="f_mode">${[...new Set(['Cash', 'Bank', 'UPI', 'Cheque', t?.payment_type].filter(Boolean))].map((m) => `<option ${t?.payment_type === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>${field('f_note', 'Note', t?.description || '')}</div>`,
  async () => { const id = await rpc(t ? 'update_transaction' : 'save_transaction', { p: { id: t?.id, type, party_id: Number(val('f_party')), date: val('f_date'), amount: numv('f_amt'), payment_type: val('f_mode'), description: val('f_note') } }); WA_AFTER = { id, edited: !!t }; });
}
function billForm(type, edit = null) {
  const see = sees(type), sale = type === 'sale' || type === 'sale_return';
  const free = freeItem();
  const line = () => `<tr><td class="no"></td><td><input class="li" autocomplete="off" placeholder="Type item name or code"><div class="lmiss hide">Not in the item list${free ? ' <button class="btn sm" type="button" data-astext="1">BILL AS TEXT (NO STOCK)</button>' : ''}</div><div class="lfree hide">Text only. Stock will not change.</div></td><td style="width:110px"><input class="lq" type="number" step="any" min="0" value="1"></td>${
    see ? '<td style="width:130px"><input class="lp" type="number" step="any" min="0"></td><td class="r la" style="width:120px"></td>' : ''}<td style="width:36px"><button class="btn sm" type="button" data-rm="1">✕</button></td></tr>`;
  dialog(edit ? `Edit ${TYPE[type]} · ${fdate(edit.t.date)}` : type === 'sale_return' ? 'Credit Note (Sale Return)' : type === 'purchase_return' ? 'Debit Note (Purchase Return)' : TYPE[type], `<div class="sumbar" id="sumbar"><div class="sf"><span>Date</span><b id="s_date"></b></div><div class="sf"><span>Party</span><b id="s_party"></b></div><div class="sf"><span>Items</span><b id="s_items">0</b></div><div class="sf hi"><span>Total quantity</span><b id="s_qty">0</b></div>${see ? '<div class="sf key"><span>Total</span><b id="s_total"></b></div>' : ''}</div>${type === 'sale_return' && !edit ? '<p class="mute" style="margin-top:0">Items come back into stock and the party balance goes down.</p>' : ''}<div class="grid"><label class="f">Party *<select id="f_party"><option value="">Choose party</option><option value="cash" ${edit && edit.t.party_id == null ? 'selected' : ''}>Cash (no party)</option>${
    PARTIES.filter((p) => p.active || (edit && edit.t.party_id === p.id)).map((p) => `<option value="${p.id}" ${edit && edit.t.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    ${field('f_date', 'Date', edit ? edit.t.date : today(), 'type="date"')}${HAS_ACCT && sale ? `<label class="f">Account (where the goods go)<select id="f_acct"><option value="">No account</option>${[...new Set([...ACCOUNTS, edit?.t.account].filter(Boolean))].map((a) => `<option ${edit?.t.account === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}<option value="__new">+ New account…</option></select>
      <input id="f_acct_new" class="hide" placeholder="Type the new account name" style="text-transform:uppercase;margin-top:6px"></label>` : ''}</div>
    <div id="ipick" class="hide"></div>
    <table class="lines stick" style="margin-top:14px"><thead><tr><th>#</th><th>ITEM</th><th>QTY</th>${see ? '<th>PRICE / UNIT</th><th class="r">AMOUNT</th>' : ''}<th></th></tr></thead><tbody id="lbody">${line()}${line()}</tbody></table>
    <button class="btn sm" type="button" id="ladd">+ ADD ROW</button>
    ${BUNDLES.length ? `<div class="bundle"><div class="btitle">Logo + Black / White (one ADD puts both lines on the bill)</div>${BUNDLES.map((g, n) => `
      <div class="bgrp ${g.word.toLowerCase()}"><span class="btag">${g.word}</span>
        <label class="f">${g.word} logo<select id="b_i${n}"><option value="">Choose logo</option>${g.logos.map((i) => `<option value="${i.id}">${esc(i.name)} (stock ${qty(i.stock)})</option>`).join('')}</select></label>
        <label class="f">With<select id="b_b${n}">${g.bases.map((i) => `<option value="${i.id}">${esc(i.name)} (stock ${qty(i.stock)})</option>`).join('')}</select></label>
        <label class="f">Qty<input id="b_q${n}" type="number" step="any" min="0" value="1" style="width:74px"></label><button class="btn sm ${n ? 'buy' : 'pri'}" type="button" data-badd="${n}">+ ADD</button></div>`).join('')}
      <span class="mute" id="b_msg"></span></div>` : ''}
    <div class="totals">${see ? `<span>Total: <b id="ltotal">${money(0)}</b></span>${edit ? '<label class="f">Round off<input id="f_round" type="number" step="any" style="width:110px"></label>' : ''}<label class="f" id="paidWrap">${edit ? 'Paid' : 'Paid now'}<input id="f_paid" type="number" step="any" min="0" style="width:140px"></label>`
      : '<span class="mute">Prices are filled automatically from the item.</span>'}</div>
    <label class="f" style="margin-top:10px">Note<input id="f_note"></label>`,
  async () => {
    const lines = [];
    for (const tr of $('#lbody').children) {
      const name = $('.li', tr).value.trim(); if (!name) continue;
      const it = BYLABEL.get(name.toLowerCase()), asText = !it && free && tr.dataset.free === '1';
      if (!it && !asText) throw new Error(`Item not found: ${name}`);
      const q = Number($('.lq', tr).value); if (!(q > 0)) throw new Error(`Enter quantity for ${name}`);
      const l = asText ? { item_id: free.id, qty: q, description: name } : { item_id: it.id, qty: q };
      if (see && $('.lp', tr).value !== '') l.price = Number($('.lp', tr).value);
      lines.push(l);
    }
    if (!lines.length) throw new Error('Add at least one item');
    const pv = val('f_party');
    if (!pv) { $('#f_party').focus(); throw new Error('Choose a party first'); }
    const party = pv === 'cash' ? null : pv;
    if (edit) { await rpc('update_transaction', { p: { id: edit.t.id, party_id: party ? Number(party) : null, date: val('f_date'), ref_no: val('f_ref'), lines, paid: numv('f_paid'), round_off: numv('f_round') ?? 0, description: val('f_note'), ...(HAS_ACCT && sale ? { account: acctVal() } : {}) } }); WA_AFTER = { id: edit.t.id, edited: true }; }
    else WA_AFTER = { id: await rpc('save_transaction', { p: { type, party_id: party ? Number(party) : null, date: val('f_date'), ref_no: val('f_ref'), lines, paid: numv('f_paid'), description: val('f_note'), ...(HAS_ACCT && sale ? { account: acctVal() } : {}) } }), edited: false };
  });
  const acctVal = () => { const v = val('f_acct') || ''; if (v !== '__new') return v; const n = val('f_acct_new'); if (!n) throw new Error('Type the new account name'); return n; };
  if ($('#f_acct')) $('#f_acct').onchange = () => { const isNew = $('#f_acct').value === '__new'; $('#f_acct_new').classList.toggle('hide', !isNew); if (isNew) $('#f_acct_new').focus(); };
  const calc = () => {
    // one empty row always waits at the bottom, so ADD ROW is never needed
    const lastRow = $('#lbody').lastElementChild;
    if (!lastRow || $('.li', lastRow).value.trim()) $('#lbody').insertAdjacentHTML('beforeend', line());
    let total = 0, n = 0, q = 0;
    for (const tr of $('#lbody').children) {
      const name = $('.li', tr).value.trim(), it = BYLABEL.get(name.toLowerCase()), lq = Number($('.lq', tr).value || 0);
      if (name) { n++; if (!isLogoPart(it ? it.name : name)) q += lq; }
      const asText = !!name && !it && !!free && tr.dataset.free === '1';
      const miss = !!name && !it && !asText && document.activeElement !== $('.li', tr);
      $('.li', tr).classList.toggle('bad', miss); $('.lmiss', tr).classList.toggle('hide', !miss); $('.lfree', tr).classList.toggle('hide', !asText);
      if (!see) continue;
      const a = lq * Number($('.lp', tr).value || 0);
      const amt = a + (it ? a * (it.tax_rate || 0) / 100 : 0);
      $('.la', tr).textContent = amt ? money(amt) : ''; total += amt;
    }
    $('#s_items').textContent = n; $('#s_qty').textContent = qty(q);
    const pv = $('#f_party').value; $('#s_party').textContent = pv ? $('#f_party').selectedOptions[0].textContent : 'Not chosen'; $('#s_party').parentElement.classList.toggle('need', !pv); $('#f_party').classList.toggle('need', !pv); $('#s_date').textContent = fdate($('#f_date').value);
    if (see) {
      total += Number($('#f_round')?.value || 0);
      $('#ltotal').textContent = money(total); $('#s_total').textContent = money(total);
      $('#paidWrap').classList.toggle('hide', !pv || pv === 'cash');
    }
    sumFit();
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
  $('#lbody').onclick = (e) => {
    if (e.target.dataset.rm) { e.target.closest('tr').remove(); calc(); }
    if (e.target.dataset.astext) { const tr = e.target.closest('tr'); tr.dataset.free = '1'; calc(); $('.lq', tr).focus(); $('.lq', tr).select(); }
  };
  $('#ladd').onclick = () => $('#lbody').insertAdjacentHTML('beforeend', line());
  // Item picker: a list under the box with price and stock, like a billing screen.
  const pick = $('#ipick'), actives = ITEMS.filter((i) => i.active && i !== free);
  const showSale = can('sale_price'), showBuy = can('purchase_price');
  let pickFor = null, pickList = [], pickAt = 0;
  const closePick = () => { pick.classList.add('hide'); pickFor = null; };
  const drawPick = () => {
    pick.innerHTML = `<div class="ph"><span>ITEM</span>${showSale ? '<span class="r">SALE PRICE</span>' : ''}${showBuy ? '<span class="r">PURCHASE PRICE</span>' : ''}<span class="r">STOCK</span></div>`
      + (pickList.length ? pickList.map((i, n) => `<div class="pr ${n === pickAt ? 'on' : ''}" data-n="${n}"><span class="pn">${esc(LABEL.get(i.id))}${i.code ? ` <small>${esc(i.code)}</small>` : ''}</span>${
        showSale ? `<span class="r">${i.sale_price == null ? '' : qty(i.sale_price)}</span>` : ''}${showBuy ? `<span class="r">${i.purchase_price == null ? '' : qty(i.purchase_price)}</span>` : ''}<span class="r ${i.stock <= 0 ? 'bad' : 'good'}">${i.is_service ? '' : qty(i.stock)}</span></div>`).join('')
        : '<div class="pe">No item found</div>');
    pick.style.setProperty('--pc', 1 + (showSale ? 1 : 0) + (showBuy ? 1 : 0));
    const on = pick.querySelector('.pr.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const openPick = (input) => {
    pickFor = input;
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const first = words[0] || '';
    // every match is listed; names that start with what was typed come first, then word starts, then the rest
    const rank = (i) => { const n = i.name.toLowerCase(); return !first ? 2 : n.startsWith(first) ? 0 : n.split(/[^a-z0-9]+/).some((part) => part.startsWith(first)) ? 1 : 2; };
    pickList = actives.filter((i) => { const hay = (i.name + ' ' + (i.code || '')).toLowerCase(); return words.every((w) => hay.includes(w)); })
      .map((i) => [rank(i), i]).sort((x, y) => x[0] - y[0] || x[1].name.localeCompare(y[1].name)).map((x) => x[1]);
    pickAt = 0;
    const r = input.getBoundingClientRect(), w = Math.min(Math.max(r.width, 620), window.innerWidth - 16), h = 300;
    pick.style.width = w + 'px';
    pick.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    if (window.innerHeight - r.bottom < h + 12 && r.top > h) { pick.style.top = ''; pick.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { pick.style.bottom = ''; pick.style.top = (r.bottom + 4) + 'px'; }
    pick.classList.remove('hide'); drawPick();
  };
  const choose = (it) => {
    const input = pickFor; if (!input || !it) return;
    const tr = input.closest('tr');
    input.value = LABEL.get(it.id);
    if (see) $('.lp', tr).value = (sale ? it.sale_price : it.purchase_price) ?? '';
    closePick();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closePick();
    $('.lq', tr).focus(); $('.lq', tr).select();
  };
  $('#lbody').addEventListener('focusin', (e) => { if (e.target.classList.contains('li')) openPick(e.target); });
  $('#lbody').addEventListener('input', (e) => { if (e.target.classList.contains('li') && e.isTrusted !== false && document.activeElement === e.target) openPick(e.target); });
  $('#lbody').addEventListener('focusout', (e) => { if (e.target.classList.contains('li')) setTimeout(() => { if (pickFor === e.target && document.activeElement !== e.target) closePick(); if (document.body.contains(e.target)) calc(); }, 150); });
  $('#lbody').addEventListener('keydown', (e) => {
    // Enter in quantity or price jumps to the next row's item box
    if (e.key === 'Enter' && (e.target.classList.contains('lq') || e.target.classList.contains('lp'))) {
      e.preventDefault(); calc();
      const nx = e.target.closest('tr').nextElementSibling; if (nx) $('.li', nx).focus();
      return;
    }
    if (!e.target.classList.contains('li')) return;
    const open = !pick.classList.contains('hide');
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openPick(e.target); else { pickAt = Math.min(pickAt + 1, pickList.length - 1); drawPick(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) { pickAt = Math.max(pickAt - 1, 0); drawPick(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (open && pickList[pickAt]) choose(pickList[pickAt]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); closePick(); }
  });
  pick.onmousedown = (e) => { e.preventDefault(); const row = e.target.closest('.pr'); if (row) choose(pickList[Number(row.dataset.n)]); };
  $('#dbody').addEventListener('scroll', closePick, { passive: true });
  const fill = (it, q) => {
    let tr = [...$('#lbody').children].find((r) => !$('.li', r).value.trim());
    if (!tr) { $('#lbody').insertAdjacentHTML('beforeend', line()); tr = $('#lbody').lastElementChild; }
    $('.li', tr).value = LABEL.get(it.id); $('.lq', tr).value = q;
    if (see) $('.lp', tr).value = (sale ? it.sale_price : it.purchase_price) ?? '';
  };
  if ($('#b_msg')) {
    // One ADD puts two lines on the bill: the logo piece and its base piece, same quantity.
    const addPair = (n) => {
      const g = BUNDLES[n], find = (id) => ITEMS.find((i) => i.id === Number($(id).value));
      const logo = find('#b_i' + n), base = find('#b_b' + n), q = Number($('#b_q' + n).value);
      if (!logo) { $('#b_msg').textContent = `Choose the ${g.word} logo`; return; }
      if (!(q > 0)) { $('#b_msg').textContent = 'Enter the quantity'; return; }
      fill(logo, q); fill(base, q);
      if ($('.li', $('#lbody').lastElementChild).value.trim()) $('#lbody').insertAdjacentHTML('beforeend', line());
      $('#b_msg').textContent = `Added 2 lines: ${logo.name} × ${q} and ${base.name} × ${q}`;
      $('#b_i' + n).value = ''; $('#b_q' + n).value = 1; $('#b_b' + n).selectedIndex = 0;
      calc();
    };
    document.querySelectorAll('[data-badd]').forEach((b) => { b.onclick = () => addPair(Number(b.dataset.badd)); });
    BUNDLES.forEach((g, n) => $('#b_q' + n).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPair(n); } }));
  }
  if (edit) {
    $('#lbody').innerHTML = edit.lines.map(() => line()).join('') + line();
    edit.lines.forEach((l, n) => {
      const tr = $('#lbody').children[n];
      if (free && l.item_id === free.id && l.description) { $('.li', tr).value = l.description; tr.dataset.free = '1'; } else $('.li', tr).value = LABEL.get(l.item_id) || l.item;
      $('.lq', tr).value = l.qty;
      if (see) $('.lp', tr).value = l.price ?? '';
    });
    $('#f_paid').value = edit.t.paid ?? ''; $('#f_round').value = edit.t.round_off || 0; $('#f_note').value = edit.t.description || '';
    if ($('#f_round')) $('#f_round').oninput = calc;
  }
  $('#f_party').onchange = calc; $('#f_date').onchange = calc; calc();
}
function newEntry(type, partyId, edit = null) {
  if (type === 'payment_in' || type === 'payment_out') paymentForm(type, partyId, edit); else billForm(type, edit);
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
    let list = ITEMS.filter((i) => (i.active || REP.tab === 'stock') && !i.is_service);
    if (REP.tab === 'low') list = list.filter((i) => i.stock < 0 || (i.min_stock > 0 && i.stock <= i.min_stock));
    const v = can('purchase_price');
    head = ['Item', 'Code', 'Category', 'Stock', 'Unit', ...(REP.tab === 'low' ? ['Alert at'] : []), ...(v ? ['Purchase price', 'Stock value'] : [])];
    rows = list.map((i) => [i.active ? i.name : `${i.name} (inactive)`, i.code || '', i.category || '', i.stock, i.unit || '', ...(REP.tab === 'low' ? [i.min_stock] : []), ...(v ? [i.purchase_price ?? 0, Math.max(i.stock, 0) * (i.purchase_price || 0)] : [])]);
    if (v) { const sv = (f) => list.filter(f).reduce((s, i) => s + Math.max(i.stock, 0) * (i.purchase_price || 0), 0), act = sv((i) => i.active), ina = sv((i) => !i.active);
      foot = REP.tab === 'stock' ? `Active: <b>${money(act)}</b> &nbsp; Inactive: <b>${money(ina)}</b> &nbsp; Total stock value: <b>${money(act + ina)}</b>` : `Total stock value: <b>${money(act)}</b>`; }
  } else if (REP.tab === 'itemwise') {
    const data = await rpc('report_items', { p_from: REP.from, p_to: REP.to });
    head = ['Item', 'Unit', 'Qty in', 'Qty out', ...(can('sale_price') ? ['Sale amount'] : []), ...(can('purchase_price') ? ['Purchase amount'] : [])];
    rows = data.map((r) => [r.item, r.unit || '', r.qty_in, r.qty_out, ...(can('sale_price') ? [r.sale_amount] : []), ...(can('purchase_price') ? [r.purchase_amount] : [])]);
  } else {
    head = ['Party', 'Phone', "You'll get", "You'll pay"];
    rows = PARTIES.filter((p) => !isOwn(p) && Math.abs(p.balance || 0) > 0.005).map((p) => [p.name, p.phone || '', Math.max(p.balance, 0), Math.max(-p.balance, 0)]);
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

// ---------- recycle bin ----------
VIEWS.bin = async () => {
  $('#title').textContent = 'Recycle Bin';
  const { data, error } = await sb.from('v_recycle_bin').select('*').order('deleted_at', { ascending: false }).limit(1000);
  if (error) throw new Error(/v_recycle_bin/.test(error.message) ? 'Recycle Bin is not set up in the database yet.' : error.message);
  const KIND = { opening: 'Opening Stock', add: 'Add Stock', reduce: 'Reduce Stock' };
  const when = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('#view').innerHTML = `<div class="panel"><div class="hd"><h2>${data.length} deleted ${data.length === 1 ? 'thing' : 'things'}</h2>
    <span class="mute">Deleted entries stay here until you restore them or delete them forever. They do not count in stock or balances.</span></div>${
    data.length ? `<div class="tw"><table><thead><tr><th>DELETED ON</th><th>DELETED BY</th><th>TYPE</th><th>ENTRY DATE</th><th>PARTY / ITEM</th><th class="r">AMOUNT / QTY</th><th></th></tr></thead><tbody>${
      data.map((r) => `<tr><td>${when(r.deleted_at)}</td><td>${esc(r.deleted_by_name || '')}${r.deleted_by_role === 'staff' ? ' <span class="tag sale_return">STAFF</span>' : r.deleted_by_role === 'owner' ? ' <span class="tag payment_in">OWNER</span>' : ''}</td><td><span class="tag ${r.kind === 'txn' ? r.type : r.kind === 'item' ? 'purchase' : ''}">${r.kind === 'txn' ? TYPE[r.type] : r.kind === 'item' ? 'Item' : KIND[r.type]}</span></td>
        <td>${fdate(r.date)}</td><td>${esc(r.kind === 'txn' ? (r.party || 'Cash') + (r.lines ? ` (${r.lines} items)` : '') : r.kind === 'item' ? r.item + (r.lines ? ` (used in ${r.lines} entries)` : ' (never used)') : r.item)}</td>
        <td class="r">${r.kind === 'txn' ? money(r.total) : r.kind === 'item' ? 'stock ' + qty(r.qty) : qty(r.qty)}</td>
        <td><button class="btn sm buy" data-restore="${r.kind}:${r.id}">RESTORE</button> <button class="btn sm" data-purge="${r.kind}:${r.id}">DELETE FOREVER</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Recycle Bin is empty</div>'}</div>`;
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
  const el = e.target.closest('[data-new],[data-more],[data-txn],[data-party],[data-item],[data-party-new],[data-party-edit],[data-item-new],[data-item-edit],[data-adjust],[data-adj-del],[data-txn-del],[data-rep],[data-user],[data-toggle],[data-restore],[data-purge],[data-low],[data-go],[data-goitem],[data-itemshow],[data-item-toggle],[data-txn-edit],[data-adj-edit],[data-item-del],[data-wa]');
  if (!el || !ME) return;
  const d = el.dataset;
  try {
    if (d.adjEdit) { e.stopPropagation(); adjustForm(SEL.item, ADJ.get(Number(d.adjEdit))); }
    else if (d.txnEdit) { const o = OPEN_TXN; if (o && o.t.id === Number(d.txnEdit)) newEntry(o.t.type, o.t.party_id, o); }
    else if (d.adjDel) { e.stopPropagation(); if (await ask('Delete stock adjustment?', binNote('Stock will change back.'), 'YES, DELETE', 'danger')) { await rpc('delete_adjustment', { p_id: Number(d.adjDel) }); await refresh(); toast(HAS_BIN || !owner() ? 'Moved to Recycle Bin' : 'Deleted'); } }
    else if (d.txnDel) { if (await ask('Delete this entry?', binNote('Stock and balance will change back.'), 'YES, DELETE', 'danger')) { await rpc('delete_transaction', { p_id: Number(d.txnDel) }); $('#dlg').close(); await refresh(); toast(HAS_BIN || !owner() ? 'Moved to Recycle Bin' : 'Deleted'); } }
    else if (d.new) newEntry(d.new, d.for ? Number(d.for) : null);
    else if (d.more) moreMenu();
    else if (d.txn) await txnView(Number(d.txn));
    else if (d.party) { SEL.party = Number(d.party); document.querySelectorAll('#prows .row').forEach((r) => r.classList.toggle('on', r === el)); await partyDetail(); }
    else if (d.item && e.target.classList.contains('isel')) { /* tick box: handled by the list itself */ }
    else if (d.item) { SEL.item = Number(d.item); document.querySelectorAll('#irows .row').forEach((r) => r.classList.toggle('on', r === el)); await itemDetail(); }
    else if (d.partyNew) partyForm();
    else if (d.partyEdit) partyForm(PARTIES.find((p) => p.id === Number(d.partyEdit)));
    else if (d.itemNew) itemForm();
    else if (d.itemEdit) itemForm(ITEMS.find((i) => i.id === Number(d.itemEdit)));
    else if (d.adjust) adjustForm(Number(d.adjust));
    else if (d.rep) { REP.tab = d.rep; route(); }
    else if (d.toggle) { const u = USERS.find((x) => x.id === d.toggle); if (!(await ask(u.active ? 'Switch this account off?' : 'Switch this account on?', u.active ? `${u.name} will not be able to sign in.` : `${u.name} will be able to sign in with the rights you have ticked.`, u.active ? 'YES, SWITCH OFF' : 'YES, SWITCH ON'))) return; await rpc('set_user', { p_id: u.id, p_name: u.name, p_perms: u.perms, p_active: !u.active }); await route(); toast(u.active ? 'Account switched off' : 'Account switched on'); }
    else if (d.itemshow) { ITEM_SHOW = d.itemshow; ITEM_SEL = new Set(); await route(); }
    else if (d.itemToggle) {
      const i = ITEMS.find((x) => x.id === Number(d.itemToggle));
      if (await ask(i.active ? 'Mark this item inactive?' : 'Mark this item active?', i.active ? `"${i.name}" will be hidden from bills and from the Active list. Its old entries and stock stay as they are.` : `"${i.name}" will show in bills and in the Active list again.`, i.active ? 'YES, MARK INACTIVE' : 'YES, MARK ACTIVE')) {
        await rpc('save_item', { p: { id: i.id, name: i.name, code: i.code, category_id: i.category_id, unit: i.unit, hsn: i.hsn, tax_rate: i.tax_rate, min_stock: i.min_stock,
          location: i.location, description: i.description, sale_price: i.sale_price, purchase_price: i.purchase_price, mrp: i.mrp, active: !i.active } });
        if (ITEM_SHOW === 'all') SEL.item = i.id;
        await refresh(); toast(i.active ? 'Marked inactive' : 'Marked active');
      }
    }
    else if (d.itemDel) {
      const i = ITEMS.find((x) => x.id === Number(d.itemDel));
      if (await ask('Delete this item?', `"${i.name}" will move to the Recycle Bin and disappear from every item list. Old bills still show its name. ${owner() ? 'You can restore it later.' : 'Only the owner can bring it back.'}`, 'YES, DELETE', 'danger')) {
        await rpc('delete_item', { p_id: i.id }); SEL.item = null; await refresh(); toast('Item moved to Recycle Bin');
      }
    }
    else if (d.wa) await waOffer(Number(d.wa), false);
    else if (d.low) lowDialog();
    else if (d.go) location.hash = d.go;
    else if (d.goitem) { SEL.item = Number(d.goitem); $('#dlg').close(); if (location.hash === '#items') await route(); else location.hash = 'items'; }
    else if (d.restore) { const [k, id] = d.restore.split(':'); if (!(await ask(k === 'item' ? 'Restore this item?' : 'Restore this entry?', k === 'item' ? 'It will come back into the Inactive list. Mark it active there if you want to use it in bills.' : 'It will come back into the lists, and stock and balance will count it again.', 'YES, RESTORE', 'buy'))) return; await rpc('restore_entry', { p_kind: k, p_id: Number(id) }); await refresh(); toast('Restored'); }
    else if (d.purge) { const [k, id] = d.purge.split(':'); if (await ask('Delete forever?', k === 'item' ? 'This works only for an item that was never used in any entry. It cannot be brought back.' : 'This entry will be removed completely. It cannot be brought back.', 'YES, DELETE FOREVER', 'danger')) { await rpc('purge_entry', { p_kind: k, p_id: Number(id) }); await route(); toast('Deleted forever'); } }
    else if (d.user) userForm(d.user);
  } catch (err) { toast(err.message); }
});

boot();

// version beside the app name: read from this file's own ?v= tag, so it always shows the latest update
{ const v = (document.querySelector('script[src*="app.js"]')?.src.match(/[?&]v=(\d+)/) || [])[1]; if (v) document.querySelectorAll('.ver').forEach((e) => { e.textContent = 'v' + v; }); }
