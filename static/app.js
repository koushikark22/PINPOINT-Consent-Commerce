/* PINPOINT v6 frontend.
 * Contract: talks only to the existing FastAPI endpoints in app/main.py, with the same request
 * bodies, the same X-Demo-Token header, and the same browser-held Ed25519 signing scheme
 * (canonical JSON, base64url, sessionStorage key names) as v5.
 * Rule: no stage, stamp or badge changes without a server or WebCrypto result behind it.
 * "Presenter pace" only delays when a real result is revealed; it never invents one. */
'use strict';

/* ------------------------------------------------------------------ utilities */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVGNS = 'http://www.w3.org/2000/svg';

function icon(name, cls = 'ic') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', '#i-' + name);
  s.appendChild(u); return s;
}
/** Safe element builder: strings become text nodes, never HTML. */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
/** replaceChildren that skips null/false (native replaceChildren would print "null"). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const chip = (text, tone, ic) => h('span', { class: 'chip' + (tone ? ' chip--' + tone : '') }, ic ? icon(ic) : null, text);
const money = (v) => { const n = Number(v); return Number.isFinite(n) ? '$' + n.toFixed(2) : String(v ?? '-'); };
const short = (s, n = 10) => (s ? (s.length > n * 2 ? s.slice(0, n) + '…' + s.slice(-4) : s) : '-');
function parseTime(s) { if (!s) return NaN; let t = String(s).replace(/(\.\d{3})\d+/, '$1'); if (!/(Z|[+-]\d\d:?\d\d)$/.test(t)) t += 'Z'; return Date.parse(t); }
function clock(ms) { const t = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
function ago(s) {
  const t = parseTime(s); if (!Number.isFinite(t)) return '';
  const d = Math.round((Date.now() - t) / 1000);
  if (d < 45) return 'just now'; if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago'; return new Date(t).toLocaleDateString();
}
const timeOf = (s) => { const t = parseTime(s); return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'; };
const humanSku = (sku) => String(sku || '').replace(/[-_]+/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
function download(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------------------------------------------ state */
const state = {
  cfg: null, adminToken: '', policies: [], payments: [], events: [],
  kit: { status: 'idle' }, view: 'home', pace: 'presenter',
  selected: 'legit', running: false, lastRun: null, results: {}, feedFilter: 'all',
  checkoutPolicy: '', checkoutPayment: null, demo: null, ed25519: true,
};
const cfg = () => state.cfg || {};
const isMock = () => cfg().mode === 'mock';
const originHost = () => { try { return new URL(cfg().origin).hostname.toLowerCase(); } catch { return location.hostname; } };
const canAdmin = () => !!cfg().judge_mode || !!state.adminToken;
const policyById = (id) => state.policies.find((p) => p.id === id);
const isExpired = (p) => parseTime(p?.payload?.expires_at) <= Date.now();
const isSigned = (p) => p && p.status !== 'AWAITING_SIGNATURE' && !!p.signature;
const sandboxCap = () => (cfg().mode === 'sandbox' && cfg().judge_mode ? 5 : 10000);

/* ------------------------------------------------------------------ API layer */
class ApiError extends Error { constructor(status, data, message) { super(message); this.status = status; this.data = data; } }
class UserError extends Error {}

function humanError(status, data) {
  if (status === 0) return 'Can’t reach the PINPOINT server. Check that it is running, then try again.';
  if (status === 401) return 'This server needs the demo administrator token. Add it under Environment settings.';
  const d = data || {};
  if (typeof d.detail === 'string') return d.detail;
  if (Array.isArray(d.detail)) return d.detail.map((x) => `${(x.loc || []).slice(-1)[0] || 'input'}: ${x.msg}`).join('; ');
  if (d.reason) return d.reason;
  if (d.error) return d.error + (d.details?.message ? ': ' + d.details.message : d.details?.name ? ': ' + d.details.name : '');
  return `The server returned ${status}.`;
}
/** Low-level call: never throws for HTTP errors (callers that test refusals need the body). */
async function call(path, { method = 'GET', body, admin = false, form } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin && state.adminToken) headers['X-Demo-Token'] = state.adminToken;
  let res;
  try { res = await fetch(path, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) }); }
  catch { return { ok: false, status: 0, data: null }; }
  const raw = await res.text(); let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
  return { ok: res.ok, status: res.status, data };
}
async function api(path, opts) {
  const r = await call(path, opts);
  if (!r.ok) throw new ApiError(r.status, r.data, humanError(r.status, r.data));
  return r.data;
}
function requireAdmin() {
  if (canAdmin()) return;
  openSettings();
  throw new UserError('This server is not in judge mode. Add the demo administrator token under Environment settings.');
}

/* ------------------------------------------------------------------ creator signing (unchanged scheme from v5) */
const judgeKeys = new Map();
async function rememberKey(id, key) { const jwk = await crypto.subtle.exportKey('jwk', key); sessionStorage.setItem('judge_key_' + id, JSON.stringify(jwk)); judgeKeys.set(id, key); }
function rememberPub(id, pub) { sessionStorage.setItem('judge_pub_' + id, pub); }
const knownPub = (id) => sessionStorage.getItem('judge_pub_' + id);
const hasKey = (id) => judgeKeys.has(id) || !!sessionStorage.getItem('judge_key_' + id);
async function fetchJudgeKey(id) {
  if (judgeKeys.has(id)) return judgeKeys.get(id);
  const saved = sessionStorage.getItem('judge_key_' + id); if (!saved) return null;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(saved), 'Ed25519', false, ['sign']);
  judgeKeys.set(id, key); return key;
}
function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64(s) { const t = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
function canonical(value) { const norm = (v) => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v); return JSON.stringify(norm(value)); }
async function signRecord(key, data) { return b64(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(canonical(data)))); }
async function makeJudgeKey() { const k = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { privateKey: k.privateKey, publicKey: b64(await crypto.subtle.exportKey('raw', k.publicKey)) }; }
/** Real client-side verification for policies whose public key this browser knows. */
async function verifyLocal(policy) {
  const pub = knownPub(policy.id);
  if (!pub || !policy.signature) return null;
  try {
    const key = await crypto.subtle.importKey('raw', unb64(pub), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, unb64(policy.signature), new TextEncoder().encode(canonical(policy.payload)));
  } catch { return false; }
}
async function detectEd25519() {
  try { await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ toasts & busy */
function toast(text, tone) {
  const t = h('div', { class: 'toast', 'data-tone': tone || '' }, h('span', { text }), h('button', { type: 'button', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('close')));
  $('toasts').append(t); setTimeout(() => t.remove(), tone === 'error' ? 9000 : 5000);
}
/** Locks a button for the duration of an async action (prevents duplicate payment calls). */
async function busy(btn, fn) {
  if (btn && btn.dataset.busy) return;
  if (btn) { btn.dataset.busy = '1'; btn.classList.add('is-busy'); btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); }
  catch (e) { toast(e.message || String(e), 'error'); }
  finally { if (btn) { delete btn.dataset.busy; btn.classList.remove('is-busy'); btn.disabled = false; btn.removeAttribute('aria-busy'); } }
}

/* ------------------------------------------------------------------ router */
const VIEWS = ['home', 'studio', 'creator', 'checkout', 'security'];
function route() {
  const [path, query] = (location.hash.replace(/^#\/?/, '') || 'home').split('?');
  const view = VIEWS.includes(path) ? path : 'home';
  const first = state.view !== view;
  state.view = view;
  for (const v of VIEWS) $('view-' + v).classList.toggle('is-active', v === view);
  document.querySelectorAll('[data-view]').forEach((a) => (a.dataset.view === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  document.title = (view === 'home' ? '' : $('view-' + view).dataset.title + ' · ') + 'PINPOINT';
  if (first && route.started) { window.scrollTo({ top: 0 }); $('main').focus({ preventScroll: true }); }
  route.started = true;
  const params = new URLSearchParams(query || '');
  if (view === 'studio' && params.get('demo') === '1') startDemo();
  renderView();
}
function renderView() {
  if (state.view === 'creator') renderCreator();
  if (state.view === 'checkout') renderCheckout();
  if (state.view === 'security') renderSecurity();
  if (state.view === 'studio') renderScenarioList();
}

/* ------------------------------------------------------------------ environment */
function renderEnv() {
  const c = cfg(), pill = $('envPill');
  if (!state.cfg) { pill.dataset.mode = 'error'; $('envLabel').textContent = 'Server unreachable'; return; }
  pill.dataset.mode = c.mode;
  $('envLabel').textContent = c.mode === 'mock' ? 'Simulated gateway (MOCK)' : c.mode === 'sandbox' ? 'PayPal Sandbox' : c.mode;
  pill.title = c.warning || '';
  const rows = [
    ['Payment adapter', c.mode === 'mock' ? 'MOCK: simulated gateway, zero PayPal requests' : 'SANDBOX: real PayPal test API'],
    ['Merchant (payee)', c.merchant_id || 'Not configured'],
    ['Checkout origin', c.origin],
    ['Authorization', c.judge_mode ? 'Judge mode: no token needed' : state.adminToken ? 'Administrator token in memory' : 'Administrator token required'],
    ['AI model', c.ai_configured ? 'Configured on server' : 'Not configured: no AI verdicts will be shown'],
    ['Held-order auto-void', (c.review_timeout_seconds ?? '-') + ' s default (each policy signs its own window)'],
    ['Auto-capture worker', c.auto_settle_seconds >= 5 ? c.auto_settle_seconds + ' s after authorization' : 'Off: capture is explicit'],
  ];
  fill($('envDetail'), 
    h('dl', null, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    h('p', { class: 'explain', text: c.mode === 'mock'
      ? 'Results in MOCK mode come from a simulated gateway inside this server. They prove PINPOINT’s decisions, not PayPal’s. Every MOCK result is stamped as simulated.'
      : 'SANDBOX mode creates real PayPal test orders. A buyer must approve each order in PayPal before it can be authorized; this page never approves on your behalf.' }),
  );
  $('tokenForm').hidden = !!c.judge_mode;
  $('aiBoundary').textContent = c.ai_configured
    ? 'This server has an AI model configured. It can flag a misleading ad and place an order on hold. It can never capture money or prove a deepfake.'
    : 'No AI model is configured on this server, so no AI verdicts appear anywhere in this demo. When one is configured, it can only place orders on hold.';
}
function openSettings() { const d = $('settingsDialog'); if (!d.open) d.showModal(); }

/* ------------------------------------------------------------------ data */
async function loadPolicies() { state.policies = await api('/api/policies'); return state.policies; }
async function loadAll() {
  const [p, pay, ev] = await Promise.all([api('/api/policies'), api('/api/payments'), api('/api/events')]);
  state.policies = p; state.payments = pay; state.events = ev;
}

/* ------------------------------------------------------------------ demo kit: auto-prepared signed policies */
const KIT_KEY = 'pinpoint_kit_v6';
// Five signed sample offers for PINPOINT Market. Demo-only, no inventory or fulfillment.
const MARKET_DEMOS = [
  {label:'PINPOINT Demo Creator · Household', sku:'HOME-AROMA-MUG', price:'3.50', minutes:120, claims:'Sample endorsement for Aroma Ceramic Mug. Demo listing only; no real inventory or shipping.'},
  {label:'PINPOINT Demo Creator · Toys', sku:'TOY-PUZZLE-CUBE', price:'2.99', minutes:120, claims:'Sample endorsement for Mini Puzzle Cube. Demo listing only; no real inventory or shipping.'},
  {label:'PINPOINT Demo Creator · Beauty', sku:'BEAUTY-LIP-BALM', price:'3.25', minutes:120, claims:'Sample endorsement for Botanical Lip Balm. Demo listing only; no real inventory or shipping.'},
  {label:'PINPOINT Demo Creator · Tech', sku:'TECH-CABLE-KIT', price:'4.00', minutes:120, claims:'Sample endorsement for Cable Organizer Kit. Demo listing only; no real inventory or shipping.'},
  {label:'PINPOINT Demo Creator · Fitness', sku:'FIT-RESIST-BAND', price:'4.50', minutes:120, claims:'Sample endorsement for Resistance Band. Demo listing only; no real inventory or shipping.'}
];

const DEMO = { label: 'Nova Reyes', sku: 'NOVA-PRESETS-GOLDEN', price: '4.00', claims: 'I only endorse my Golden Hour preset pack for $4.00 from my verified store.' };

async function createSignedPolicy({ label, sku, price, minutes, claims, review = 120 }) {
  requireAdmin();
  const k = await makeJudgeKey();
  const created = await api('/api/policies', { method: 'POST', admin: true, body: {
    creator_label: label, sku, domain: originHost(), max_price_usd: price,
    review_timeout_seconds: review, duration_minutes: minutes, claims, creator_public_key: k.publicKey } });
  const signature = await signRecord(k.privateKey, created.payload);
  const act = await api(`/api/policies/${encodeURIComponent(created.id)}/activate`, { method: 'POST', body: { signature } });
  if (act.status !== 'ACTIVE' || act.signature_valid !== true) throw new Error('The server did not confirm the creator signature.');
  await rememberKey(created.id, k.privateKey); rememberPub(created.id, k.publicKey);
  return { id: created.id, status: 'ACTIVE', payload: created.payload, signature };
}
async function revokePolicy(id, kind, reason, evidence = '') {
  requireAdmin();
  const key = await fetchJudgeKey(id);
  if (!key) throw new UserError('This policy’s signing key isn’t in this browser, so it can’t be revoked from here.');
  const rec = { policy_id: id, kind, reason, evidence, time: new Date().toISOString() };
  return api(`/api/policies/${encodeURIComponent(id)}/revoke`, { method: 'POST', admin: true, body: {
    revocation_class: kind, reason, evidence, creator_time: rec.time, creator_signature: await signRecord(key, rec) } });
}

let kitPromise = null;
function ensureKit(force = false) {
  if (kitPromise && !force) return kitPromise;
  kitPromise = (async () => {
    if (!canAdmin()) { state.kit = { status: 'needs-token' }; renderKit(); return state.kit; }
    state.kit = { ...state.kit, status: 'building' }; renderKit();
    try {
      let saved = {}; try { saved = force ? {} : JSON.parse(sessionStorage.getItem(KIT_KEY) || '{}'); } catch {}
      await loadPolicies();
      const ok = (id, test) => { const p = id && policyById(id); return p && hasKey(id) && test(p); };
      const kit = {
        short: ok(saved.short, (p) => isSigned(p)) ? saved.short : null,
        active: ok(saved.active, (p) => p.status === 'ACTIVE' && parseTime(p.payload.expires_at) > Date.now() + 10 * 60e3) ? saved.active : null,
        terminated: ok(saved.terminated, (p) => p.status === 'TERMINATED') ? saved.terminated : null,
      };
      // Short-lived first so its real one-minute clock starts as early as possible.
      if (!kit.short) kit.short = (await createSignedPolicy({ ...DEMO, label: DEMO.label + ' · launch promo', minutes: 1 })).id;
      if (!kit.active) kit.active = (await createSignedPolicy({ ...DEMO, minutes: 120 })).id;
      if (!kit.terminated) {
        const t = await createSignedPolicy({ ...DEMO, label: DEMO.label + ' · ended partnership', minutes: 120 });
        const r = await revokePolicy(t.id, 'commercial', 'Creator ended this partnership', 'Demo kit');
        if (r.status !== 'TERMINATED') throw new Error('The server did not terminate the demo policy.');
        kit.terminated = t.id;
      }
      // Reuse valid sample policies within this tab; never create unnecessary Sandbox orders.
      const priorProducts = saved.products && typeof saved.products === 'object' ? saved.products : {};
      kit.products = {};
      for (const offer of MARKET_DEMOS) {
        const id = priorProducts[offer.sku];
        const existing = id && policyById(id);
        if (existing && existing.status === 'ACTIVE' && existing.payload?.sku === offer.sku && parseTime(existing.payload.expires_at) > Date.now() + 10 * 60e3) {
          kit.products[offer.sku] = id;
        } else {
          kit.products[offer.sku] = (await createSignedPolicy(offer)).id;
        }
      }
      sessionStorage.setItem(KIT_KEY, JSON.stringify(kit));
      await loadPolicies();
      state.kit = { status: 'ready', ...kit };
      if (!state.checkoutPolicy) state.checkoutPolicy = kit.active;
    } catch (e) {
      state.kit = { status: 'error', message: e.message };
      kitPromise = null;
    }
    renderKit(); renderHeroReceipt(); renderView();
    return state.kit;
  })();
  return kitPromise;
}
async function kitReady() {
  const k = await ensureKit();
  if (k.status === 'needs-token') requireAdmin();
  if (k.status !== 'ready') throw new UserError('The demo kit isn’t ready: ' + (k.message || k.status) + '. Rebuild it from Environment settings.');
  return k;
}
function renderKit() {
  const list = $('kitList'), k = state.kit;
  if (k.status === 'needs-token') { fill(list, h('li', { class: 'kit-item is-error' }, 'Add the administrator token to prepare signed demo policies. ', h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: openSettings, text: 'Open settings' }))); return; }
  if (k.status === 'error') { fill(list, h('li', { class: 'kit-item is-error', text: 'Couldn’t prepare the demo kit: ' + k.message })); return; }
  if (k.status !== 'ready') { fill(list, h('li', { class: 'kit-item is-loading', text: 'Signing demo policies in this browser…' })); return; }
  const item = (kind, title, id, extra) => h('li', { class: 'kit-item', 'data-kind': kind }, h('span', { class: 'tick', 'aria-hidden': 'true' }), h('b', { text: title }), extra);
  const s = policyById(k.short);
  fill(list, 
    item('active', 'Active endorsement', k.active, h('span', { text: 'signed, ' + money(policyById(k.active)?.payload.max_price_usd) + ' ceiling' })),
    item('short', 'One-minute endorsement', k.short, h('span', { 'data-countdown': s?.payload.expires_at, 'data-expired-text': 'now expired', 'data-prefix': 'expires in ' })),
    item('terminated', 'Ended endorsement', k.terminated, h('span', { text: 'revoked by its creator' })),
  );
  tick();
}

/* ------------------------------------------------------------------ the pinned receipt */
/**
 * Renders a signed policy as a receipt. With `attempt`, each pinned field is diffed against what
 * the checkout sent. `culprit` highlights the row the SERVER named; client diffs are explanatory.
 */
async function renderReceipt(box, { policy, attempt, culprit, stamp, sig } = {}) {
  if (!policy) { fill(box, h('div', { class: 'receipt-empty', text: 'The signed policy and the checkout attempt appear here.' })); return; }
  const P = policy.payload;
  const sigState = sig || (isSigned(policy) ? await verifyLocal(policy) : 'unsigned');
  const tried = attempt || null;
  const rows = [
    ['payee', 'Payee', P.payee_id, tried ? (tried.payee ?? P.payee_id + ' (server)') : null, tried ? (tried.payee === undefined || tried.payee === P.payee_id) : null],
    ['sku', 'Product', P.sku, tried?.sku, tried ? tried.sku === P.sku : null],
    ['price', 'Price', 'up to ' + money(P.max_price_usd), tried ? money(tried.amount) : null, tried ? Number(tried.amount) <= Number(P.max_price_usd) : null],
    ['domain', 'Checkout site', P.domain, tried?.domain, tried ? String(tried.domain).toLowerCase() === String(P.domain).toLowerCase() : null],
    ['validity', 'Valid until', new Date(parseTime(P.expires_at)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), tried ? 'checkout at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null, tried ? !isExpired(policy) : null],
    ['status', 'Endorsement', policy.status === 'ACTIVE' ? 'Active' : policy.status === 'TERMINATED' ? 'Ended by creator' : 'Awaiting signature', tried ? (policy.status === 'ACTIVE' ? 'in force' : 'not in force') : null, tried ? policy.status === 'ACTIVE' : null],
  ];
  const table = h('table', { class: 'pins' },
    h('thead', null, h('tr', null, h('th', null, h('span', { class: 'sr-only', text: 'Match' })), h('th', { text: 'Pinned term' }), h('th', { text: 'Creator signed' }), tried ? h('th', { text: 'Checkout sent' }) : null)),
    h('tbody', null, rows.map(([k, label, signed, sent, match]) => h('tr', {
      'data-match': match === null ? null : match ? 'yes' : 'no', 'data-culprit': culprit === k ? 'yes' : null },
    h('td', null, h('span', { class: 'pin-ic' }, icon(match === null ? 'pin' : match ? 'check' : 'x'))),
    h('td', { class: 'k', text: label }), h('td', { class: 'v', text: signed }), tried ? h('td', { class: 'tried', text: sent ?? '-' }) : null))));
  const sigChip = sigState === true ? chip('Signature verified in this browser', 'paid', 'check')
    : sigState === false ? chip('Signature does not verify', 'block', 'x')
    : sigState === 'rejected' ? chip('Impostor signature rejected by server', 'block', 'x')
    : sigState === 'unsigned' ? chip('No valid creator signature', 'block', 'x')
    : chip('Verified by server at activation', 'info', 'shield');
  fill(box, 
    h('div', { class: 'receipt-top' }, h('div', null, h('h3', { text: P.creator_label }), h('p', { class: 'who', text: 'Signed endorsement' })), sigChip),
    h('p', { class: 'receipt-quote', text: '“' + P.claims + '”' }),
    table,
    h('div', { class: 'sigline' },
      h('span', null, 'Ed25519 signature ', h('code', { text: short(policy.signature || '', 8) })),
      knownPub(policy.id) ? h('span', null, 'Creator key ', h('code', { text: short(knownPub(policy.id), 6) })) : null,
      h('span', null, 'Policy ', h('code', { text: policy.id }))),
    stamp ? h('div', { class: 'stamp stamp--' + stamp.kind, role: 'img', 'aria-label': stamp.text + (stamp.small ? ', ' + stamp.small : '') }, stamp.text, stamp.small ? h('small', { text: stamp.small }) : null) : null,
  );
}
async function renderHeroReceipt() {
  const box = $('heroReceipt'); const p = policyById(state.kit.active);
  if (state.kit.status === 'ready' && p) return renderReceipt(box, { policy: p });
  if (state.kit.status === 'building' || state.kit.status === 'idle') return;
  fill(box, h('div', { class: 'receipt-empty' }, h('p', { text: state.kit.status === 'needs-token' ? 'A signed endorsement appears here once the demo kit is prepared.' : 'The demo endorsement isn’t available yet.' })));
}

/* ------------------------------------------------------------------ live countdowns (real clock only) */
function tick() {
  document.querySelectorAll('[data-countdown]').forEach((n) => {
    const left = parseTime(n.dataset.countdown) - Date.now();
    n.textContent = left > 0 ? (n.dataset.prefix || '') + clock(left) : (n.dataset.expiredText || 'expired');
  });
}
setInterval(tick, 1000);

/* ================================================================== SCENARIO STUDIO */
const SCENARIOS = [
  { id: 'legit', group: 'Baseline', icon: 'check', name: 'Legitimate purchase', short: 'Every pinned term matches.',
    desc: 'A buyer arrives from the creator’s real ad and pays the signed price at the signed store. PINPOINT should stay out of the way.',
    expect: () => (isMock() ? 'Captured, confirmed by gateway read-back' : 'Order created; you approve it in PayPal Sandbox; then captured'), policy: 'active', flow: 'capture' },
  { id: 'impersonation', group: 'Stopped before a payment exists', icon: 'user', name: 'Creator impersonation', short: 'An impostor publishes terms under the creator’s key.',
    desc: 'An attacker copies the creator’s public key into a new policy and signs it with their own key. The server must reject the signature, and checkout must refuse the unsigned policy.',
    expect: () => 'Signature rejected (409) and checkout refused (409); no PayPal order', kind: 'impersonation' },
  { id: 'merchant', group: 'Stopped before a payment exists', icon: 'store', name: 'Fake merchant', short: 'Checkout tries to pay a different payee.',
    desc: 'A cloned store keeps the creator’s product and price but names its own PayPal payee.', attack: () => ({ payee: 'ATTACKER-STORE-9931' }),
    expect: () => 'Blocked (409); no PayPal order created', policy: 'active', block: true, culprit: 'payee' },
  { id: 'domain', group: 'Stopped before a payment exists', icon: 'scan', name: 'Look-alike checkout site', short: 'The order claims to come from another domain.',
    desc: 'A look-alike site reuses the endorsement. The server compares the claimed site with its own origin.', attack: () => ({ domain: 'nova-reyes-presets.shop' }),
    expect: () => 'Blocked (409); no PayPal order created', policy: 'active', block: true, culprit: 'domain' },
  { id: 'price', group: 'Stopped before a payment exists', icon: 'alert', name: 'Altered price', short: 'Charges 50¢ above the signed ceiling.',
    desc: 'The checkout quietly charges more than the creator signed. The overage is kept small so it also stays under the public Sandbox $5 cap.', attack: (p) => ({ amount: (Number(p.payload.max_price_usd) + 0.5).toFixed(2) }),
    expect: () => 'Blocked (409); no PayPal order created', policy: 'active', block: true, culprit: 'price' },
  { id: 'sku', group: 'Stopped before a payment exists', icon: 'layers', name: 'Mismatched product', short: 'Sells a different SKU under the endorsement.',
    desc: 'The creator endorsed one product; the checkout swaps in another.', attack: (p) => ({ sku: p.payload.sku + '-XL-BUNDLE' }),
    expect: () => 'Blocked (409); no PayPal order created', policy: 'active', block: true, culprit: 'sku' },
  { id: 'expired', group: 'Stopped before a payment exists', icon: 'clock', name: 'Expired endorsement', short: 'Uses the one-minute policy after it lapses.',
    desc: 'Uses the demo kit’s one-minute policy. If it hasn’t expired yet, the run waits on the real clock; time is never faked.',
    expect: () => 'Blocked (409); no PayPal order created', policy: 'short', block: true, culprit: 'validity' },
  { id: 'revoked', group: 'Stopped before a payment exists', icon: 'x', name: 'Revoked endorsement', short: 'The creator ended the partnership.',
    desc: 'The creator signed a commercial termination. New orders must be refused even though the original signature is still valid.',
    expect: () => 'Blocked (409); no PayPal order created', policy: 'terminated', block: true, culprit: 'status' },
  { id: 'cav', group: 'Protected after authorization', icon: 'shield', name: 'Capture after void', short: 'Creator voids a held order; a late capture is refused.',
    desc: 'An authorized order is held for review, the creator signs a void, and the merchant then tries to capture anyway. In MOCK mode the hold is a labeled test flag, not an AI verdict.',
    expect: () => (isMock() ? 'Held, creator-signed void, then capture refused by the gateway' : 'Capture refused on an existing voided authorization'), policy: 'active', flow: 'hold_void' },
  { id: 'ai', group: 'Protected after authorization', icon: 'scan', name: 'Misleading ad', short: 'A configured AI model compares the ad with the signed claim.',
    desc: 'An authorized order came from an ad that promises a different price. The configured model compares the transcript with the creator’s signed claim; a contradiction holds the order for the creator.',
    expect: () => 'Held for the creator if the model reports a mismatch', policy: 'active', flow: 'ai',
    available: () => (cfg().ai_configured ? null : 'Needs an AI model configured on the server. Not simulated.') },
  { id: 'custom', group: 'Build your own', icon: 'gear', name: 'Custom scenario', short: 'Set every field the checkout sends.',
    desc: 'Choose a signed policy, change what the checkout sends, and pick what happens after. PINPOINT predicts the decision from the signed terms; the server makes the real one.',
    expect: () => 'Matches the prediction below', custom: true },
];
const SCN = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
const unavailable = (s) => (s.available ? s.available() : null) || (s.id === 'cav' && !isMock() && !state.payments.some((p) => p.state === 'VOIDED') ? 'In Sandbox this needs an existing voided order; test holds are MOCK-only.' : null);

function renderScenarioList() {
  const groups = {};
  for (const s of SCENARIOS) (groups[s.group] ||= []).push(s);
  fill($('scenarioList'), ...Object.entries(groups).map(([g, list]) => h('div', { class: 'scenario-group' },
    h('h3', { text: g }),
    list.map((s) => {
      const why = unavailable(s);
      return h('button', { type: 'button', class: 'sc', 'aria-pressed': String(state.selected === s.id), 'aria-disabled': why ? 'true' : null,
        'data-id': s.id, 'data-last': state.results[s.id] || null, onclick: () => selectScenario(s.id) },
      icon(s.icon), h('span', null, h('strong', { text: s.name }), h('small', { text: s.short }), why ? h('small', { text: why }) : null));
    }))));
}
function selectScenario(id) {
  if (state.running) return;
  state.selected = id; const s = SCN[id];
  $('runGroup').textContent = s.group; $('runTitle').textContent = s.name; $('runDesc').textContent = s.desc;
  $('runExpect').textContent = s.expect();
  const why = unavailable(s);
  $('runScenario').disabled = !!why; $('runNote').textContent = why || (isMock() ? 'Simulated gateway. No PayPal request is made.' : 'Real PayPal Sandbox requests.');
  $('customBuilder').hidden = !s.custom;
  if (s.custom) fillCustomPolicies();
  renderScenarioList(); resetStage();
}
function resetStage() {
  tlReset(); $('decisionSlot')?.remove();
  const s = SCN[state.selected];
  showAiAnalysisPanel(s.id === 'ai' || (s.custom && $('cFlow').value === 'ai'));
  aiAnalysisIdle();
  const policy = s.policy && state.kit.status === 'ready' ? policyById(state.kit[s.policy]) : s.custom ? policyById($('cPolicy').value) : null;
  renderReceipt($('receipt'), { policy });
  $('outcome').removeAttribute('data-result');
  fill($('outcome'), h('p', { class: 'outcome-idle', text: 'Press Run scenario. Each stage lights up only when the server answers.' }));
}

/* ---------- live Gemini evidence panel ---------- */
function showAiAnalysisPanel(visible) {
  const panel = $('aiAnalysisPanel');
  panel.hidden = !visible;
  $('timelineAnalysisLayout').classList.toggle('has-ai', visible);
}
function aiAnalysisIdle(message = 'Run Misleading ad to display the actual Gemini response.') {
  $('aiPanelSource').textContent = 'Backend evidence';
  fill($('aiPanelBody'), h('p', { class: 'ai-panel-empty', text: message }));
}
function aiAnalysisLoading() {
  showAiAnalysisPanel(true);
  $('aiPanelSource').textContent = 'Request in progress';
  fill($('aiPanelBody'), h('p', { class: 'ai-panel-empty', text: 'Analyzing creator and advertisement claims using the configured model...' }));
}
function renderAiAnalysis(result) {
  showAiAnalysisPanel(true);
  const reference = result?.reference || {};
  const observed = result?.analysis || {};
  const comparison = result?.comparison || {};
  const real = reference.mode === 'LIVE_LLM' && observed.mode === 'LIVE_LLM';
  const status = real ? (comparison.status || result.content_verdict || 'UNKNOWN') : 'UNAVAILABLE';
  const model = real ? (observed.model || reference.model || 'Configured model') : 'No verified model response';
  $('aiPanelSource').textContent = real ? model + ' | LIVE_LLM' : 'AI unavailable';
  const price = (v) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 'Not extracted' : money(Number(v));
  const signedPrice = reference.claims?.price_usd;
  const adPrice = observed.claims?.price_usd;
  const reasons = Array.isArray(comparison.reasons) ? comparison.reasons : [];
  const stateValue = result.state || (result.held ? 'HELD_FOR_REVIEW' : 'No hold reported');
  fill($('aiPanelBody'),
    h('div', { class: 'ai-panel-prices' },
      h('div', { class: 'ai-panel-price' }, h('span', { class: 'label', text: 'Creator signed claim' }), h('strong', { text: real ? price(signedPrice) : 'Unavailable' })),
      h('div', { class: 'ai-panel-price', 'data-kind': real && status === 'MISMATCH' ? 'ad-mismatch' : 'ad' },
        h('span', { class: 'label', text: 'Analyzed advertisement' }), h('strong', { text: real ? price(adPrice) : 'Unavailable' }))),
    h('div', { class: 'ai-panel-verdict', 'data-status': status, text: real ? 'AI comparison: ' + status : 'No live AI verdict' }),
    real && reasons.length ? h('ul', { class: 'ai-panel-reasons' }, ...reasons.map((reason) => h('li', { text: String(reason) }))) :
      h('p', { class: 'ai-panel-note', text: real ? 'No contradiction reasons returned.' : String(result.warning || observed.reason || reference.reason || 'The model did not return a verified inference. No mismatch is inferred.') }),
    real ? h('p', { class: 'ai-panel-meta', text: 'Signed product: ' + (reference.claims?.product || 'not extracted') }) : null,
    real ? h('p', { class: 'ai-panel-meta', text: 'Advertisement product: ' + (observed.claims?.product || 'not extracted') }) : null,
    h('p', { class: 'ai-panel-state', text: 'Backend payment state: ' + stateValue }),
    h('p', { class: 'ai-panel-note', text: 'AI supplies review evidence only. The backend and creator decision determine payment actions. Full API responses remain in Evidence JSON.' })
  );
}

/* ---------- timeline ---------- */
const STAGES = [
  ['endorse', 'Creator endorsement'], ['sign', 'Signed policy'], ['checkout', 'Buyer checkout'],
  ['analysis', 'Security analysis'], ['authorize', 'Authorization'], ['decision', 'Creator decision'], ['outcome', 'Verified outcome'],
];
const NODE_IC = { pass: 'check', block: 'x', held: 'pause', wait: 'clock', skip: 'minus', notreached: 'minus' };
function tlReset() {
  fill($('timeline'), ...STAGES.map(([k, n], i) => h('li', { class: 'tl', 'data-k': k, 'data-state': 'idle' },
    h('span', { class: 'tl-node' }, h('span', { text: String(i + 1), style: 'font-size:12px;font-weight:700' })),
    h('p', { class: 'tl-name', text: n }), h('p', { class: 'tl-detail' }), h('span', { class: 'tl-tag' }))));
}
function tl(k, st, detail, tag) {
  const li = $('timeline').querySelector(`[data-k="${k}"]`); if (!li) return;
  li.dataset.state = st;
  const node = li.querySelector('.tl-node');
  if (NODE_IC[st]) fill(node, icon(NODE_IC[st]));
  else if (st === 'run') fill(node, h('span', { style: 'width:8px;height:8px;border-radius:50%;background:currentColor' }));
  if (detail !== undefined) li.querySelector('.tl-detail').textContent = detail;
  fill(li.querySelector('.tl-tag'), tag || '');
  const label = { run: 'in progress', pass: 'complete', block: 'stopped', held: 'on hold', wait: 'waiting for you', skip: 'not needed', notreached: 'not reached' }[st];
  li.setAttribute('aria-label', `${li.querySelector('.tl-name').textContent}: ${label || 'not started'}. ${detail || ''}`);
}
const pace = (ms = 650) => sleep(state.pace === 'presenter' ? ms : 60);

/* ---------- evidence recorder ---------- */
async function rec(run, step, path, opts = {}) {
  const r = await call(path, opts);
  run.log.push({ at: new Date().toISOString(), step, request: { method: opts.method || 'GET', path, body: opts.body ?? (opts.form ? '[multipart upload]' : undefined), admin_header_sent: !!(opts.admin && state.adminToken) }, response: { http_status: r.status, body: r.data } });
  $('evidenceJson').textContent = JSON.stringify(run, null, 2);
  $('evidenceCount').textContent = `(${run.log.length} API calls)`;
  return r;
}
const must = (r) => { if (!r.ok) throw new ApiError(r.status, r.data, humanError(r.status, r.data)); return r.data; };

/* ---------- outcome card ---------- */
function renderOutcome(run) {
  const o = $('outcome'); o.dataset.result = run.result;
  const label = { PASS: 'Protected as expected', FAIL: 'Unexpected result', PENDING: 'Waiting', OBSERVED: 'Observed', SKIPPED: 'Not run' }[run.result] || run.result;
  const prov = run.gateway === 'none'
    ? chip('No gateway call: stopped before an order existed', 'info', 'shield')
    : isMock() ? chip('Simulated gateway (MOCK): zero PayPal requests', 'sim') : chip('PayPal Sandbox API: real test transaction', 'sandbox', 'check');
  fill(o, 
    h('p', { class: 'label', text: label }),
    h('p', { class: 'verdict', text: run.headline }),
    h('p', { class: 'why', text: run.why }),
    h('dl', { class: 'facts' }, Object.entries(run.facts || {}).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])),
    run.action || null,
    h('div', { class: 'provenance' }, prov, run.paymentId ? h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => openPayment(run.paymentId), text: 'Open in Security Center' }) : null),
  );
}

/* ---------- user waits (Sandbox approval, creator decision, real-clock expiry) ---------- */
function waitPanel(content) {
  const o = $('outcome'); o.dataset.result = 'PENDING'; fill(o, ...content);
}
function waitForSandboxApproval(run, created) {
  return new Promise((resolve, reject) => {
    const link = h('a', { class: 'btn btn-ink', href: created.approval_url || '#', target: '_blank', rel: 'noopener noreferrer' }, 'Approve in PayPal Sandbox');
    const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => resolve() }, 'I’ve approved it, continue');
    const stop = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => reject(new UserError('Run stopped before authorization. The Sandbox order stays unauthorized.')) }, 'Stop here');
    waitPanel([h('p', { class: 'label', text: 'Your turn' }), h('p', { class: 'verdict', text: 'Approve the order in PayPal Sandbox.' }),
      h('p', { class: 'why', text: 'PINPOINT can’t approve a real PayPal order for you. Approve it in the new tab as the Sandbox buyer, then come back.' }),
      h('div', { class: 'btn-row' }, link, go, stop), h('div', { class: 'provenance' }, chip('PayPal Sandbox API: real test transaction', 'sandbox', 'check'))]);
  });
}
function waitForExpiry(policy) {
  return new Promise((resolve, reject) => {
    const until = parseTime(policy.payload.expires_at) + 1500;
    const n = h('span', { 'data-countdown': new Date(until).toISOString(), 'data-expired-text': '0:00' });
    waitPanel([h('p', { class: 'label', text: 'Waiting on the real clock' }), h('p', { class: 'verdict' }, 'Expires in ', n),
      h('p', { class: 'why', text: 'This endorsement was signed with a one-minute window. The run continues automatically once it has truly expired.' }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { clearInterval(t); reject(new UserError('Stopped while waiting for the endorsement to expire.')); }, text: 'Stop waiting' }))]);
    tick();
    const t = setInterval(() => { if (Date.now() >= until) { clearInterval(t); resolve(); } }, 250);
  });
}
/** Creator decision card: real Ed25519 signature over {payment_id, policy_id, action, reason, time}. */
function creatorDecision({ payment, policy, reason, auto, slotParent, onDone }) {
  return new Promise((resolve) => {
    const window_s = Number(policy.payload.review_timeout_seconds || cfg().review_timeout_seconds || 120);
    const deadline = new Date(Date.now() + window_s * 1000).toISOString();
    const card = h('div', { class: 'decision', id: slotParent ? 'decisionSlot' : null, role: 'region', 'aria-label': 'Creator decision' });
    const why = reason === 'SYNTHETIC_MOCK_TEST' ? 'Test hold placed by Scenario Studio (MOCK only). No AI inference ran.'
      : reason === 'AI_CLAIM_MISMATCH' ? 'The configured AI model found that the ad contradicts your signed claim.' : 'This order is on hold for your review.';
    const decide = async (action) => {
      clearInterval(timer);
      card.querySelector('.actions').replaceChildren(chip(action === 'VOID' ? 'Void signed by creator' : 'Approval signed by creator', action === 'VOID' ? 'void' : 'paid', 'key'));
      card.setAttribute('data-done', ''); resolve(action);
    };
    const voidBtn = h('button', { class: 'btn btn-void', type: 'button', onclick: () => decide('VOID') }, 'Void and sign');
    const okBtn = h('button', { class: 'btn btn-paid', type: 'button', onclick: () => decide('APPROVE') }, 'Approve and sign');
    card.append(
      h('div', null,
        h('h3', { text: `${policy.payload.creator_label}, an order using your endorsement is on hold` }),
        h('p', { text: why }),
        h('p', { class: 'meta' }, `${money(payment.amount)} for ${payment.sku}. `, 'Server voids it automatically in ',
          h('span', { class: 'count', 'data-countdown': deadline, 'data-expired-text': '0:00' }), ' if you don’t answer.')),
      h('div', { class: 'actions' }, voidBtn, okBtn));
    if (slotParent) { $('decisionSlot')?.remove(); slotParent.after(card); } else onDone?.(card);
    tick();
    const timer = setInterval(() => { if (Date.now() >= parseTime(deadline)) { clearInterval(timer); card.setAttribute('data-done', ''); resolve('TIMEOUT'); } }, 500);
    if (auto) setTimeout(() => { if (!card.hasAttribute('data-done')) { card.querySelector('.meta').append(' Autopilot chose void.'); decide('VOID'); } }, state.pace === 'presenter' ? 1400 : 150);
    card.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}
async function submitDecision(run, paymentId, policyId, action, reason) {
  const key = await fetchJudgeKey(policyId);
  if (!key) throw new UserError('This creator’s signing key isn’t in this browser.');
  const r = { payment_id: paymentId, policy_id: policyId, action, reason, time: new Date().toISOString() };
  const body = { action, reason, creator_time: r.time, creator_signature: await signRecord(key, r) };
  return run ? rec(run, 'creator-review', `/api/payments/${encodeURIComponent(paymentId)}/creator-review`, { method: 'POST', admin: true, body })
    : call(`/api/payments/${encodeURIComponent(paymentId)}/creator-review`, { method: 'POST', admin: true, body });
}
async function waitForServerState(run, id, notState, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rec(run, 'poll payment', `/api/payments/${encodeURIComponent(id)}`);
    if (r.ok && r.data.payment.state !== notState) return r.data;
    await sleep(2000);
  }
  return null;
}

/* ---------- the engine ---------- */
function newRun(s) {
  return { scenario: s.id, name: s.name, mode: cfg().mode, started_at: new Date().toISOString(), expected: s.expect(), log: [], result: 'PENDING', facts: {} };
}
function buildOffer(s, policy, custom) {
  const P = policy.payload;
  if (custom) {
    const o = { policy_id: policy.id, amount: custom.amount, sku: custom.sku, domain: custom.domain, content_id: custom.content_id || undefined };
    if (custom.payee) o.payee = custom.payee;
    return o;
  }
  return { policy_id: policy.id, amount: P.max_price_usd, sku: P.sku, domain: P.domain, content_id: `${s.id}-ad-${Date.now().toString(36)}`, ...(s.attack ? s.attack(policy) : {}) };
}
function culpritFrom(reason = '') {
  const r = reason.toLowerCase();
  if (r.includes('payee')) return 'payee'; if (r.includes('domain')) return 'domain'; if (r.includes('sku')) return 'sku';
  if (r.includes('price') || r.includes('ceiling')) return 'price'; if (r.includes('expired')) return 'validity';
  if (r.includes('termination')) return 'status'; if (r.includes('signature')) return 'status'; return null;
}

async function runScenario(id = state.selected, { auto = false } = {}) {
  const s = SCN[id];
  if (state.running) return null;
  const why = unavailable(s); if (why) { toast(why, 'error'); return null; }
  state.running = true; document.body.classList.add('is-running');
  const runBtn = $('runScenario'); runBtn.disabled = true; runBtn.classList.add('is-busy'); $('runSuite').disabled = true;
  const run = newRun(s); state.lastRun = run;
  tlReset(); $('decisionSlot')?.remove();
  showAiAnalysisPanel(s.id === 'ai' || (s.custom && $('cFlow').value === 'ai'));
  aiAnalysisIdle('Waiting for authorization before requesting AI analysis.');
  fill($('outcome'), h('p', { class: 'outcome-idle', text: 'Running…' }));
  $('evidenceJson').textContent = JSON.stringify(run, null, 2);
  try {
    const kit = await kitReady();
    let custom = null, policy;
    if (s.custom) {
      custom = readCustom();
      policy = policyById(custom.policy_id);
      if (!policy) throw new UserError('Choose a signed policy for the custom scenario.');
      run.expected = custom.prediction.text; run.custom = custom;
    } else policy = policyById(kit[s.policy || 'active']);
    if (!policy) throw new UserError('The demo policy is missing. Rebuild the demo kit from Environment settings.');

    /* 1. endorsement */
    tl('endorse', 'run', 'Loading the creator’s terms…'); await renderReceipt($('receipt'), { policy }); await pace(450);
    tl('endorse', 'pass', `${policy.payload.creator_label}: ${policy.payload.sku}, up to ${money(policy.payload.max_price_usd)}`);

    if (s.kind === 'impersonation') return await runImpersonation(run, policy);

    /* 2. signature */
    tl('sign', 'run', 'Verifying the Ed25519 signature…');
    const v = await verifyLocal(policy); await pace(500);
    if (v === false) { tl('sign', 'block', 'Signature does not verify in this browser'); }
    else tl('sign', 'pass', v ? 'Verified in this browser with the creator’s public key' : 'Verified by the server when it was activated');

    /* 3. checkout */
    const offer = buildOffer(s, policy, custom);
    if (id === 'expired' && !isExpired(policy)) {
      if (auto) { return finish(run, { result: 'SKIPPED', headline: 'Not expired yet', why: `The one-minute endorsement still has ${clock(parseTime(policy.payload.expires_at) - Date.now())} left. Run it on its own once it lapses.`, gateway: 'none' }); }
      tl('checkout', 'wait', 'Waiting for the endorsement to lapse on the real clock');
      await waitForExpiry(policy);
    }
    tl('checkout', 'run', 'Buyer submits the checkout');
    await renderReceipt($('receipt'), { policy, attempt: offer }); await pace(700);
    tl('checkout', 'pass', `${money(offer.amount)} for ${offer.sku} at ${offer.domain}${offer.payee ? ', payee ' + offer.payee : ''}`);

    /* 4. analysis (server-side pin checks; AI only if configured and used) */
    tl('analysis', 'run', 'Server compares every pinned term with the signature…');
    const co = await rec(run, 'checkout', '/api/checkouts', { method: 'POST', body: offer });
    await pace(700);
    const expectBlock = s.block || (custom && custom.prediction.kind === 'block');
    if (!co.ok) {
      const d = co.data || {};
      const blocked = co.status === 409 && (d.decision === 'BLOCK' || typeof d.detail === 'string');
      if (!blocked) throw new ApiError(co.status, d, humanError(co.status, d));
      const reason = d.reason || d.detail;
      const culprit = culpritFrom(reason) || s.culprit;
      tl('analysis', 'block', reason);
      tl('authorize', 'notreached', 'No PayPal order was created'); tl('decision', 'notreached', 'Nothing to decide'); tl('outcome', 'block', 'Refused before payment');
      await renderReceipt($('receipt'), { policy, attempt: offer, culprit, stamp: { kind: 'blocked', text: 'BLOCKED', small: 'before payment' } });
      return finish(run, {
        result: expectBlock ? 'PASS' : 'FAIL', gateway: 'none',
        headline: expectBlock ? 'Blocked before a payment existed.' : 'Blocked, but this offer was expected to pass.',
        why: `Server reason: “${reason}”. ${d.paypal_order_created === false ? 'The response confirms no PayPal order was created.' : ''}`,
        facts: { 'HTTP status': co.status, Decision: d.decision || 'refused', 'PayPal order created': d.paypal_order_created === false ? 'No' : 'Not reported', Phase: d.phase || 'pre-authorization' },
      });
    }
    const created = co.data;
    run.paymentId = created.payment_id;
    tl('analysis', 'pass', 'All pinned terms match the signature', cfg().ai_configured && (s.flow === 'ai' || custom?.flow === 'ai') ? chip('AI review follows', 'info') : chip(cfg().ai_configured ? 'AI not used here' : 'No AI configured', null));
    if (expectBlock) {
      tl('authorize', 'skip', 'Stopped: the order should not exist'); tl('outcome', 'block', 'Unexpected acceptance');
      return finish(run, { result: 'FAIL', headline: 'The server accepted an offer this test expected it to block.', why: 'Check the server configuration and the audit log before relying on this result.', facts: { 'HTTP status': co.status, 'Payment ID': created.payment_id, 'PayPal order': created.order_id } });
    }

    /* 5. authorization */
    let auth;
    if (isMock()) {
      tl('authorize', 'run', 'Simulated buyer approval (no PayPal request)…');
      must(await rec(run, 'simulated buyer approval', `/api/mock-approve/${encodeURIComponent(created.payment_id)}`, { method: 'POST', body: {} }));
      await pace(500);
    } else {
      tl('authorize', 'wait', 'Approve the order in PayPal Sandbox');
      for (;;) {
        await waitForSandboxApproval(run, created);
        const peek = await rec(run, 'authorize', `/api/payments/${encodeURIComponent(created.payment_id)}/authorize`, { method: 'POST', body: {} });
        if (peek.ok) { auth = peek.data; break; }
        toast(humanError(peek.status, peek.data), 'error');
      }
    }
    tl('authorize', 'run', 'Authorizing: funds held, not captured…');
    if (!auth) auth = must(await rec(run, 'authorize', `/api/payments/${encodeURIComponent(created.payment_id)}/authorize`, { method: 'POST', body: {} }));
    await pace(500);
    const flow = custom ? custom.flow : s.flow;
    tl('authorize', auth.state === 'HELD_FOR_REVIEW' ? 'held' : 'pass', auth.state === 'HELD_FOR_REVIEW' ? 'Authorized and held: an earlier content verdict applies' : `Authorized ${short(auth.authorization_id, 8)}; nothing captured yet`);
    const payment = { id: created.payment_id, amount: offer.amount, sku: offer.sku };

    if (flow === 'authorize') {
      tl('decision', 'skip', 'Not requested'); tl('outcome', 'skip', 'Left authorized');
      return finish(run, { result: custom ? 'PASS' : 'OBSERVED', headline: 'Authorized. Nothing has been captured.', why: 'The order is waiting for merchant enforcement. Run it from the Security Center when you’re ready.', facts: { 'Payment state': auth.state, 'Payment ID': created.payment_id } });
    }

    /* 6. creator decision (only when something holds the order) */
    let held = auth.state === 'HELD_FOR_REVIEW', holdReason = held ? 'AI_CLAIM_MISMATCH' : null;
    if (flow === 'hold_void') {
      requireAdmin();
      tl('decision', 'run', 'Placing a labeled test hold (MOCK only)…');
      must(await rec(run, 'synthetic test hold', `/api/mock/lab/${encodeURIComponent(created.payment_id)}/flag-review`, { method: 'POST', admin: true }));
      held = true; holdReason = 'SYNTHETIC_MOCK_TEST'; await pace(450);
    } else if (flow === 'ai' && !held) {
      requireAdmin();
      tl('decision', 'run', 'Configured AI model compares the ad with the signed claim…');
      const transcript = custom ? custom.transcript : 'Get Nova’s Golden Hour presets now, only ninety nine dollars!';
      aiAnalysisLoading();
      const ar = must(await rec(run, 'AI content review', `/api/payments/${encodeURIComponent(created.payment_id)}/analyze-review`, { method: 'POST', admin: true, body: { content_id: offer.content_id, transcript } }));
      renderAiAnalysis(ar);
      if (ar.reason === 'AI_UNAVAILABLE') {
        tl('decision', 'skip', 'Model unavailable: no verdict'); tl('outcome', 'skip', 'Authorized, unreviewed');
        return finish(run, { result: 'OBSERVED', headline: 'No AI verdict was produced.', why: 'The server reported the model as unavailable, so PINPOINT shows nothing it didn’t receive. The order stays authorized.', facts: { 'Payment state': 'AUTHORIZED' } });
      }
      held = ar.state === 'HELD_FOR_REVIEW'; holdReason = 'AI_CLAIM_MISMATCH';
      if (!held) {
        tl('decision', 'skip', `Model verdict: ${ar.content_verdict || ar.comparison?.status || 'no mismatch'}`); tl('outcome', 'skip', 'Authorized');
        return finish(run, { result: 'OBSERVED', headline: 'The model found no contradiction.', why: 'The order stays authorized; the creator isn’t interrupted.', facts: { Verdict: ar.content_verdict || '-', 'Payment ID': created.payment_id } });
      }
    }

    if (!held) {
      tl('decision', 'skip', 'No hold, so the creator isn’t interrupted');
    } else {
      tl('decision', 'wait', 'Waiting for the creator’s signed decision', holdReason === 'SYNTHETIC_MOCK_TEST' ? chip('Test hold, not AI', 'sim') : chip('AI hold', 'held'));
      const action = await creatorDecision({ payment, policy, reason: holdReason, auto, slotParent: $('timeline') });
      if (action === 'TIMEOUT') {
        tl('decision', 'held', 'No answer in time; the server’s timer takes over');
        const after = await waitForServerState(run, created.payment_id, 'HELD_FOR_REVIEW');
        const st = after?.payment.state || 'HELD_FOR_REVIEW';
        tl('outcome', st === 'VOIDED' ? 'pass' : 'held', st === 'VOIDED' ? 'Auto-voided by the server' : 'Still waiting on the server');
        $('decisionSlot')?.setAttribute('data-done', '');
        return finish(run, { result: st === 'VOIDED' ? 'PASS' : 'PENDING', headline: st === 'VOIDED' ? 'The creator didn’t answer, so the server voided the order.' : 'The review window passed; the server hasn’t voided yet.', why: 'Unanswered holds are voided by the server’s background worker after the signed review window.', facts: { 'Payment state': st, 'Gateway read-back': after?.paypal_readback?.status || '-' }, paymentId: created.payment_id });
      }
      tl('decision', 'run', `Signing ${action === 'VOID' ? 'a void' : 'an approval'} with the creator’s key…`);
      const dr = await submitDecision(run, created.payment_id, policy.id, action, action === 'VOID' ? 'Creator rejected this order: the ad misrepresented the offer' : 'Creator confirmed this order is genuine');
      $('decisionSlot')?.setAttribute('data-done', '');
      if (!dr.ok) {
        const after = await waitForServerState(run, created.payment_id, 'HELD_FOR_REVIEW', 2000);
        throw new ApiError(dr.status, dr.data, humanError(dr.status, dr.data) + (after ? ` The order is now ${after.payment.state}.` : ''));
      }
      tl('decision', 'pass', `${action === 'VOID' ? 'Void' : 'Approval'} signed and accepted (state ${dr.data.state})`);
      if (action === 'APPROVE') {
        const rb = must(await rec(run, 'gateway read-back', `/api/payments/${encodeURIComponent(created.payment_id)}`));
        tl('outcome', dr.data.state === 'CAPTURED' ? 'pass' : 'held', `Gateway reports ${rb.paypal_readback?.status || '-'}`);
        await renderReceipt($('receipt'), { policy, attempt: offer, stamp: dr.data.state === 'CAPTURED' ? { kind: 'paid', text: 'PAID', small: isMock() ? 'simulated gateway' : 'sandbox read-back' } : null });
        return finish(run, { result: s.id === 'cav' ? 'OBSERVED' : 'PASS', headline: 'The creator approved, so the order was captured.', why: 'The scenario expected a void; you chose to approve. That path works too.', facts: { 'Payment state': dr.data.state, 'Gateway read-back': rb.paypal_readback?.status }, paymentId: created.payment_id });
      }
      /* voided: try to capture anyway */
      tl('outcome', 'run', 'Merchant attempts a capture after the void…');
      const probe = must(await rec(run, 'capture-after-void probe', `/api/lab/${encodeURIComponent(created.payment_id)}/capture-after-void`, { method: 'POST', admin: true }));
      await pace(500);
      const refused = probe.expected_refusal === true && !probe.unexpected_success;
      const rbStatus = probe.authorization_readback?.status;
      tl('outcome', refused ? 'pass' : 'block', refused ? `Capture refused (HTTP ${probe.http_status}); authorization reads ${rbStatus}` : 'Capture was NOT refused');
      await renderReceipt($('receipt'), { policy, attempt: offer, stamp: { kind: 'void', text: 'VOID', small: refused ? 'late capture refused' : 'check read-back' } });
      return finish(run, { result: refused && rbStatus === 'VOIDED' ? 'PASS' : 'FAIL',
        headline: refused ? 'Voided, and the late capture was refused.' : 'The gateway accepted a capture after void.',
        why: refused ? 'The creator’s signed void stands: the gateway refused the capture and still reports the authorization as voided.' : 'Investigate the gateway read-back immediately.',
        facts: { 'Payment state': dr.data.state, 'Capture attempt': refused ? `refused, HTTP ${probe.http_status}` : 'succeeded', 'Gateway read-back': rbStatus || '-' }, paymentId: created.payment_id });
    }

    /* 7. merchant enforcement + read-back */
    requireAdmin();
    tl('outcome', 'run', 'Merchant enforcement re-checks the signature, then captures or voids…');
    const st = must(await rec(run, 'merchant enforcement (settle)', `/api/payments/${encodeURIComponent(created.payment_id)}/settle`, { method: 'POST', admin: true }));
    const rb = must(await rec(run, 'gateway read-back', `/api/payments/${encodeURIComponent(created.payment_id)}`));
    await pace(500);
    const finalState = st.state, gw = rb.paypal_readback?.status;
    tl('outcome', finalState === 'CAPTURED' ? 'pass' : 'block', `${finalState}${st.idempotent ? ' (already settled by the server worker)' : ''}; gateway reads ${gw || '-'}`);
    await renderReceipt($('receipt'), { policy, attempt: offer, stamp: finalState === 'CAPTURED' ? { kind: 'paid', text: 'PAID', small: isMock() ? 'simulated gateway' : 'sandbox read-back' } : finalState === 'VOIDED' ? { kind: 'void', text: 'VOID', small: st.reason || '' } : { kind: 'pending', text: 'CHECK', small: finalState } });
    const expectCapture = !custom || custom.prediction.kind === 'pass';
    return finish(run, { result: finalState === 'CAPTURED' && expectCapture ? 'PASS' : 'FAIL',
      headline: finalState === 'CAPTURED' ? 'Paid. The capture matches the signed terms.' : `Ended as ${finalState}.`,
      why: finalState === 'CAPTURED' ? 'Merchant enforcement re-verified the creator’s signature, captured, and the gateway read-back agrees.' : (st.reason || 'See the evidence for the gateway response.'),
      facts: { Action: st.action || 'already settled', 'Payment state': finalState, 'Gateway read-back': gw || '-', 'PayPal order': created.order_id }, paymentId: created.payment_id });
  } catch (e) {
    const msg = e.message || String(e);
    if (!$('aiAnalysisPanel').hidden && $('aiPanelSource').textContent === 'Request in progress') {
      $('aiPanelSource').textContent = 'AI request failed';
      fill($('aiPanelBody'), h('p', { class: 'ai-panel-empty', text: 'No verified Gemini result was received: ' + msg }));
    }
    const li = [...$('timeline').querySelectorAll('.tl')].find((x) => ['run', 'wait'].includes(x.dataset.state));
    if (li) tl(li.dataset.k, 'block', msg);
    return finish(run, { result: e instanceof UserError ? 'PENDING' : 'FAIL', headline: e instanceof UserError ? 'Run stopped.' : 'The run hit an error.', why: msg, facts: e.status ? { 'HTTP status': e.status } : {}, gateway: run.paymentId ? undefined : 'none', paymentId: run.paymentId });
  } finally {
    state.running = false; document.body.classList.remove('is-running');
    runBtn.classList.remove('is-busy'); runBtn.disabled = !!unavailable(SCN[state.selected]); $('runSuite').disabled = false;
    loadAll().then(() => { renderScenarioList(); if (state.view === 'security') renderSecurity(); }).catch(() => {});
  }
}

async function runImpersonation(run, genuine) {
  requireAdmin();
  const victimPub = knownPub(genuine.id);
  if (!victimPub) throw new UserError('The genuine creator’s public key isn’t in this browser. Rebuild the demo kit.');
  tl('sign', 'run', 'Impostor enrolls a policy under the creator’s public key…');
  const attacker = await makeJudgeKey();
  const P = genuine.payload;
  const enrol = must(await rec(run, 'impostor enrolment', '/api/policies', { method: 'POST', admin: true, body: {
    creator_label: P.creator_label, sku: P.sku, domain: P.domain, max_price_usd: P.max_price_usd, duration_minutes: 30,
    claims: 'Official Nova Reyes reseller: same presets, sold through our store.', creator_public_key: victimPub } }));
  const forged = await signRecord(attacker.privateKey, enrol.payload);
  const act = await rec(run, 'impostor activation', `/api/policies/${encodeURIComponent(enrol.id)}/activate`, { method: 'POST', body: { signature: forged } });
  await pace(700);
  const sigRefused = act.status === 409;
  tl('sign', sigRefused ? 'block' : 'pass', sigRefused ? `Signature rejected: “${humanError(act.status, act.data)}”` : 'Server accepted the forged signature');
  const fake = { id: enrol.id, status: 'AWAITING_SIGNATURE', payload: enrol.payload, signature: forged };
  const offer = { policy_id: enrol.id, amount: P.max_price_usd, sku: P.sku, domain: P.domain };
  tl('checkout', 'run', 'Impostor’s store sends a checkout using its unsigned policy');
  await renderReceipt($('receipt'), { policy: fake, attempt: offer, sig: sigRefused ? 'rejected' : null }); await pace(600);
  tl('checkout', 'pass', `${money(offer.amount)} for ${offer.sku}`);
  tl('analysis', 'run', 'Server re-verifies the policy signature…');
  const co = await rec(run, 'checkout with impostor policy', '/api/checkouts', { method: 'POST', body: offer });
  await pace(600);
  const coRefused = co.status === 409;
  tl('analysis', coRefused ? 'block' : 'pass', coRefused ? humanError(co.status, co.data) : 'Checkout accepted');
  tl('authorize', 'notreached', 'No PayPal order was created'); tl('decision', 'notreached', 'Nothing to decide');
  tl('outcome', coRefused && sigRefused ? 'block' : 'pass', coRefused ? 'Refused before payment' : 'Order created');
  await renderReceipt($('receipt'), { policy: fake, attempt: offer, culprit: 'status', sig: 'rejected', stamp: coRefused ? { kind: 'blocked', text: 'BLOCKED', small: 'forged signature' } : null });
  return finish(run, { result: sigRefused && coRefused ? 'PASS' : 'FAIL', gateway: 'none',
    headline: sigRefused && coRefused ? 'Impostor rejected. The signature didn’t verify.' : 'The impostor got further than expected.',
    why: 'Copying a creator’s public key is useless without their private key: activation verifies the Ed25519 signature, and checkout re-verifies it on every order.',
    facts: { 'Activation': `HTTP ${act.status}`, 'Checkout': `HTTP ${co.status}`, 'PayPal order created': co.ok ? 'Yes' : 'No', 'Impostor policy': enrol.id } });
}

function finish(run, r) {
  Object.assign(run, r, { finished_at: new Date().toISOString() });
  // Update only from the backend-confirmed payment state already recorded in this run.
  if (!$('aiAnalysisPanel').hidden && $('aiPanelSource').textContent.includes('LIVE_LLM')) {
    const finalState = run.facts?.['Payment state'];
    const stateNode = $('aiPanelBody').querySelector('.ai-panel-state');
    if (stateNode && typeof finalState === 'string' && finalState) {
      stateNode.textContent = 'Backend payment state: ' + finalState;
      stateNode.dataset.state = finalState;
    }
  }
  state.results[run.scenario] = run.result === 'PASS' || run.result === 'FAIL' ? run.result : state.results[run.scenario];
  renderOutcome(run);
  $('evidenceJson').textContent = JSON.stringify(run, null, 2);
  if (!state.suiteRunning) $('outcome').focus({ preventScroll: true });
  return run;
}

/* ---------- attack suite ---------- */
async function runSuite() {
  if (state.running) return;
  const ids = ['impersonation', 'merchant', 'domain', 'price', 'sku', 'expired', 'revoked', 'cav'].filter((i) => !unavailable(SCN[i]));
  const prevPace = state.pace; state.suiteRunning = true; state.pace = 'instant';
  $('suite').hidden = false; fill($('suiteBody'), ); $('suiteSummary').textContent = 'Running…';
  const results = [];
  try {
    for (const id of ids) {
      selectScenario(id);
      const row = h('tr', { class: 'is-running' }, h('td', { text: SCN[id].name }), h('td', { text: SCN[id].expect() }), h('td', { text: 'running…' }), h('td', null, chip('Running', 'info')));
      $('suiteBody').append(row);
      const run = await runScenario(id, { auto: true });
      if (!run) break;
      results.push(run);
      const resp = run.log.filter((l) => /checkout|probe|activation/.test(l.step)).map((l) => (/probe/.test(l.step)
        ? `late capture: gateway ${l.response.body?.expected_refusal ? 'refused' : 'ACCEPTED'} (HTTP ${l.response.body?.http_status ?? '-'}), reads ${l.response.body?.authorization_readback?.status || '-'}`
        : `${l.step}: HTTP ${l.response.http_status}`)).join('; ') || run.headline;
      row.className = ''; row.replaceChildren(h('td', { text: SCN[id].name }), h('td', { text: SCN[id].expect() }), h('td', { text: resp }),
        h('td', null, run.result === 'PASS' ? chip('Stopped', 'paid', 'check') : run.result === 'SKIPPED' ? chip('Skipped', null) : chip(run.result === 'FAIL' ? 'Not stopped' : run.result, 'block', 'x')));
    }
  } finally { state.pace = prevPace; state.suiteRunning = false; }
  const ran = results.filter((r) => r.result !== 'SKIPPED'), pass = ran.filter((r) => r.result === 'PASS').length;
  const skipped = results.length - ran.length;
  $('suiteSummary').textContent = `${pass} of ${ran.length} attacks stopped${skipped ? `, ${skipped} skipped` : ''}${ids.length < 8 ? ` (${8 - ids.length} unavailable here)` : ''}`;
  state.lastSuite = { mode: cfg().mode, finished_at: new Date().toISOString(), summary: $('suiteSummary').textContent, runs: results };
  $('evidenceJson').textContent = JSON.stringify(state.lastSuite, null, 2);
  $('evidenceCount').textContent = `(${results.reduce((n, r) => n + r.log.length, 0)} API calls across ${results.length} runs)`;
  $('suite').scrollIntoView({ block: 'nearest' });
}

/* ---------- custom builder ---------- */
function fillCustomPolicies() {
  const sel = $('cPolicy'); const prev = sel.value;
  const list = state.policies.filter(isSigned);
  fill(sel, ...list.map((p) => h('option', { value: p.id, text: `${p.payload.creator_label} (${p.status === 'TERMINATED' ? 'ended' : isExpired(p) ? 'expired' : 'active'}, ${money(p.payload.max_price_usd)})` })));
  sel.value = list.some((p) => p.id === prev) ? prev : state.kit.active || list[0]?.id || '';
  if (!prev) customReset(); else predict();
  [...$('cFlow').options].forEach((o) => { o.disabled = (o.value === 'hold_void' && !isMock()) || (o.value === 'ai' && !cfg().ai_configured); });
}
function customReset() {
  const p = policyById($('cPolicy').value); if (!p) return;
  $('cAmount').value = p.payload.max_price_usd; $('cSku').value = p.payload.sku; $('cDomain').value = p.payload.domain; $('cPayee').value = '';
  predict(); resetStage();
}
/** Mirrors the server’s check order to explain the expected decision. The server is authoritative. */
function predict() {
  const p = policyById($('cPolicy').value); const out = $('cPredict');
  if (!p) { out.textContent = ''; return null; }
  const amt = Number($('cAmount').value), sku = $('cSku').value.trim(), dom = $('cDomain').value.trim().toLowerCase(), payee = $('cPayee').value.trim();
  let r = null;
  if (!(amt > 0) || amt > 10000) r = { kind: 'error', text: 'Server will reject the amount as invalid (400)' };
  else if (amt > sandboxCap()) r = { kind: 'error', text: 'Public Sandbox caps orders at $5.00 (403)' };
  else if (dom !== originHost()) r = { kind: 'block', text: 'Block: checkout site differs from this server' };
  else if (payee && payee !== p.payload.payee_id) r = { kind: 'block', text: 'Block: payee differs from the signed merchant' };
  else if (isExpired(p)) r = { kind: 'block', text: 'Block: endorsement expired' };
  else if (p.status === 'TERMINATED') r = { kind: 'block', text: 'Block: creator ended this endorsement' };
  else if (sku !== p.payload.sku) r = { kind: 'block', text: 'Block: product differs from the signed SKU' };
  else if (amt > Number(p.payload.max_price_usd)) r = { kind: 'block', text: 'Block: price exceeds the signed ceiling' };
  else r = { kind: 'pass', text: 'Accept: every pinned term matches' };
  out.dataset.kind = r.kind; out.textContent = 'Prediction: ' + r.text + '. The server makes the real decision.';
  $('cTranscriptWrap').hidden = $('cFlow').value !== 'ai';
  return r;
}
function readCustom() {
  const prediction = predict();
  if (prediction.kind === 'error') throw new UserError(prediction.text + '. Adjust the amount and try again.');
  return { name: $('cName').value.trim() || 'Custom scenario', policy_id: $('cPolicy').value, amount: $('cAmount').value.trim(), sku: $('cSku').value.trim(),
    domain: $('cDomain').value.trim(), payee: $('cPayee').value.trim(), flow: $('cFlow').value, content_id: $('cContent').value.trim(), transcript: $('cTranscript').value, prediction };
}

/* ---------- guided 90-second demo ---------- */
const DEMO_STEPS = [
  { id: 'legit', say: 'A genuine purchase. Every pinned term matches, so PINPOINT gets out of the way.' },
  { id: 'merchant', say: 'Same product, same price, but a cloned store names its own payee. Watch the payee row.' },
  { id: 'cav', say: 'After authorization: the creator voids a held order, then the merchant tries to capture anyway.' },
  { id: 'suite', say: 'Now every attack in one pass, each with the server’s actual response.' },
];
function startDemo() {
  history.replaceState(null, '', '#/studio');
  state.demo = 0; showGuide();
}
function showGuide() {
  $('demoGuide')?.remove();
  if (state.demo === null) return;
  const step = DEMO_STEPS[state.demo];
  if (step.id !== 'suite') selectScenario(step.id);
  const next = state.demo < DEMO_STEPS.length - 1;
  const g = h('div', { class: 'guide', id: 'demoGuide', role: 'region', 'aria-label': 'Guided demo' },
    h('span', { class: 'guide-step', text: `Demo ${state.demo + 1} of ${DEMO_STEPS.length}` }),
    h('p', { text: step.say }),
    h('div', { class: 'guide-actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { if (step.id === 'suite') await runSuite(); else await runScenario(step.id); }) }, icon('play'), step.id === 'suite' ? 'Run every attack' : 'Run this step'),
      next ? h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => { state.demo++; showGuide(); } }, 'Next step') : null,
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => { state.demo = null; showGuide(); } }, 'End demo')));
  $('stage').prepend(g);
}

/* ================================================================== CREATOR PORTAL */
function renderCreator() {
  $('npDomain').value = originHost();
  const list = $('creatorPolicies');
  const pols = state.policies.filter(isSigned);
  if (!pols.length) fill(list, h('p', { class: 'empty', text: 'No signed endorsements yet. Sign your first one with the form.' }));
  else fill(list, ...pols.map(policyCard));
  renderInbox(); tick();
}
function statusChip(p) {
  if (p.status === 'TERMINATED') return chip('Ended', 'void');
  if (p.status === 'AWAITING_SIGNATURE') return chip('Unsigned', 'block');
  if (isExpired(p)) return chip('Expired', 'held', 'clock');
  return chip('Active', 'paid', 'check');
}
function policyCard(p) {
  const P = p.payload, mine = hasKey(p.id), live = p.status === 'ACTIVE' && !isExpired(p);
  const actions = h('div', { class: 'actions' });
  if (live) actions.append(h('a', { class: 'btn btn-sm btn-quiet', href: '#/checkout', onclick: () => { state.checkoutPolicy = p.id; } }, 'Open in checkout'));
  if (live && mine) {
    const end = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'End endorsement');
    end.addEventListener('click', () => {
      if (end.dataset.armed !== '1') { end.dataset.armed = '1'; end.textContent = 'Confirm: block new orders'; setTimeout(() => { if (end.isConnected) { end.dataset.armed = ''; end.textContent = 'End endorsement'; } }, 5000); return; }
      busy(end, async () => { const r = await revokePolicy(p.id, 'commercial', 'Creator ended this endorsement'); toast(r.status === 'TERMINATED' ? 'Endorsement ended. New orders will be refused.' : r.status, 'ok'); await loadAll(); renderCreator(); });
    });
    const report = h('details', { class: 'report' }, h('summary', { class: 'btn btn-sm btn-quiet', text: 'Report misuse' }),
      h('form', { class: 'report-form', onsubmit: (e) => { e.preventDefault(); const btn = e.currentTarget.querySelector('button'); const reason = e.currentTarget.querySelector('textarea').value.trim();
        busy(btn, async () => { if (!reason) throw new UserError('Describe what you saw so a reviewer can act on it.'); const r = await revokePolicy(p.id, 'fraud', reason, 'Creator report'); toast('Report signed and filed for review. It doesn’t void existing orders.', 'ok'); await loadAll(); renderCreator(); }); } },
      h('label', { class: 'field' }, h('span', { text: 'What did you see?' }), h('textarea', { rows: '2', maxlength: '400', text: 'A store is running my endorsement with a different product.' })),
      h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Sign and file report'),
      h('p', { class: 'hint', text: 'Fraud reports are reviewed. They don’t void other buyers’ orders on their own.' })));
    actions.append(end, report);
  }
  return h('article', { class: 'pcard', 'data-status': p.status, 'data-expired': String(isExpired(p)) },
    h('div', null, h('h3', { text: P.creator_label }),
      h('div', { class: 'terms' },
        h('span', null, 'Product ', h('b', { text: P.sku })), h('span', null, 'Up to ', h('b', { text: money(P.max_price_usd) })),
        h('span', null, 'Site ', h('b', { text: P.domain })),
        h('span', null, isExpired(p) ? 'Expired ' : 'Expires in ', h('b', { 'data-countdown': isExpired(p) ? null : P.expires_at, 'data-expired-text': 'now', text: isExpired(p) ? timeOf(P.expires_at) : '' }))),
      h('p', { class: 'id' }, h('code', { text: p.id }))),
    h('div', { class: 'chips' }, statusChip(p), mine ? chip('Key in this browser', 'info', 'key') : chip('Signed elsewhere', null)),
    actions.childNodes.length ? actions : null);
}
function renderInbox() {
  const box = $('creatorInbox');
  const held = state.payments.filter((x) => x.state === 'HELD_FOR_REVIEW');
  const mine = held.filter((x) => hasKey(x.policy_id));
  fill(box, );
  if (!held.length) return;
  box.append(h('h2', { class: 'h-sec', text: `Orders waiting for your decision (${mine.length})` }));
  for (const pay of mine) {
    const policy = policyById(pay.policy_id); if (!policy) continue;
    creatorDecision({ payment: pay, policy, reason: pay.review_reason, onDone: (card) => box.append(card) }).then(async (action) => {
      if (action === 'TIMEOUT') { await loadAll(); return renderCreator(); }
      const r = await submitDecision(null, pay.id, policy.id, action, action === 'VOID' ? 'Creator rejected this order from the inbox' : 'Creator approved this order from the inbox');
      if (r.ok) toast(`${action === 'VOID' ? 'Void' : 'Approval'} signed. Order is now ${r.data.state}.`, 'ok'); else toast(humanError(r.status, r.data), 'error');
      await loadAll(); renderCreator();
    });
  }
  if (held.length > mine.length) box.append(h('p', { class: 'hint', text: `${held.length - mine.length} other held orders belong to creators whose keys aren’t in this browser.` }));
}

/* ================================================================== CHECKOUT */
async function renderCheckout() {
  const sel = $('checkoutPolicy');
  const list = state.policies.filter(isSigned);
  fill(sel, ...list.map((p) => h('option', { value: p.id, text: `${p.payload.creator_label} (${p.status === 'TERMINATED' ? 'ended' : isExpired(p) ? 'expired' : 'active'})` })));
  if (!list.length) { fill($('productCard'), h('p', { class: 'empty', text: 'No signed endorsements yet. Sign one in the Creator portal, or wait for the demo kit.' })); $('payBtn').disabled = true; return; }
  if (!list.some((p) => p.id === state.checkoutPolicy)) state.checkoutPolicy = state.kit.active && policyById(state.kit.active) ? state.kit.active : list[0].id;
  sel.value = state.checkoutPolicy; $('payBtn').disabled = false;
  const p = policyById(state.checkoutPolicy), P = p.payload;
  const v = await verifyLocal(p);
  const badge = p.status === 'TERMINATED' ? chip('Creator ended this endorsement', 'void', 'x')
    : isExpired(p) ? chip('Endorsement expired', 'held', 'clock')
    : v === true ? chip('Creator signature verified in your browser', 'paid', 'check')
    : v === false ? chip('Signature does not verify', 'block', 'x') : chip('Signature checked by the server at payment', 'info', 'shield');
  fill($('productCard'), 
    h('div', { class: 'product-art', role: 'img', 'aria-label': 'Product artwork' }, h('span', { class: 'tag', text: 'Golden Hour' })),
    h('div', { class: 'product-body' },
      h('h2', { text: humanSku(P.sku) }), h('p', { class: 'price', text: money(P.max_price_usd) }),
      h('div', { class: 'endorse' },
        h('div', { class: 'endorse-head' }, h('strong', { text: `Endorsed by ${P.creator_label}` }), badge),
        h('blockquote', { text: '“' + P.claims + '”' }),
        h('p', { class: 'why', text: `This endorsement only covers ${P.sku} up to ${money(P.max_price_usd)}, paid to ${P.payee_id} at ${P.domain}.` }))));
  if (!$('tAmount').dataset.policy || $('tAmount').dataset.policy !== p.id) {
    $('tAmount').dataset.policy = p.id; $('tAmount').value = P.max_price_usd; $('tSku').value = P.sku; $('tDomain').value = P.domain; $('tPayee').value = '';
  }
  renderSummary();
  $('payBtn').textContent = isMock() ? 'Continue to simulated PayPal' : 'Continue to PayPal Sandbox';
  $('payHint').textContent = isMock() ? 'MOCK mode: approval is simulated on this page and no PayPal request is made.' : 'Opens a real PayPal Sandbox approval in a new tab.';
  if (state.checkoutPayment) renderTracker();
}
function renderSummary() {
  const p = policyById(state.checkoutPolicy); if (!p) return;
  const tampered = $('tAmount').value !== p.payload.max_price_usd || $('tSku').value !== p.payload.sku || $('tDomain').value !== p.payload.domain || $('tPayee').value.trim();
  fill($('orderSummary'), 
    h('dt', { text: 'Item' }), h('dd', { text: $('tSku').value }),
    h('dt', { text: 'Paid to' }), h('dd', { text: $('tPayee').value.trim() || p.payload.payee_id }),
    h('dt', { text: 'Store' }), h('dd', { text: $('tDomain').value }),
    h('dt', { class: 'total', text: 'Total' }), h('dd', { class: 'total', text: money($('tAmount').value) }));
  $('tamperPanel').querySelector('summary .hint-inline').textContent = tampered ? 'checkout altered' : 'security test';
}
async function checkoutPay() {
  const p = policyById(state.checkoutPolicy); if (!p) throw new UserError('Choose an endorsement first.');
  const amt = $('tAmount').value.trim();
  if (!(Number(amt) > 0)) { $('tAmount').setAttribute('aria-invalid', 'true'); $('tamperPanel').open = true; throw new UserError('Enter an amount above zero.'); }
  $('tAmount').removeAttribute('aria-invalid');
  const body = { policy_id: p.id, amount: amt, sku: $('tSku').value.trim(), domain: $('tDomain').value.trim(), content_id: $('tContent').value.trim() || undefined };
  if ($('tPayee').value.trim()) body.payee = $('tPayee').value.trim();
  const r = await call('/api/checkouts', { method: 'POST', body });
  if (!r.ok && r.status !== 409) throw new ApiError(r.status, r.data, humanError(r.status, r.data));
  state.checkoutPayment = r.ok ? { ...r.data, state: 'ORDER_CREATED', amount: amt, sku: body.sku } : { refused: true, reason: r.data?.reason || r.data?.detail, status: r.status };
  renderTracker();
}
function renderTracker() {
  const t = state.checkoutPayment; $('tracker').hidden = !t; if (!t) return;
  const steps = $('trackerSteps'), act = $('trackerActions'), msg = $('trackerMsg');
  const step = (s, title, sub) => h('li', { 'data-s': s }, h('span', { class: 'dot' }, icon(s === 'bad' ? 'x' : s === 'held' ? 'pause' : s === 'done' ? 'check' : 'minus')), h('div', null, h('b', { text: title }), sub ? h('small', { text: sub }) : null));
  fill(act, );
  if (t.refused) {
    $('trackerId').textContent = '';
    fill(steps, step('bad', 'Checkout refused by PINPOINT', t.reason), step('todo', 'No PayPal order was created', 'Nothing to approve, nothing charged.'));
    msg.textContent = `HTTP ${t.status}. The offer doesn’t match what ${policyById(state.checkoutPolicy)?.payload.creator_label} signed.`;
    act.append(h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => { state.checkoutPayment = null; renderTracker(); }, text: 'Start over' }));
    return;
  }
  $('trackerId').textContent = t.payment_id;
  const s = t.state;
  const approved = ['APPROVED', 'AUTHORIZED', 'HELD_FOR_REVIEW', 'CAPTURED', 'VOIDED', 'RECONCILE_REQUIRED'].includes(s);
  const authorized = ['AUTHORIZED', 'HELD_FOR_REVIEW', 'CAPTURED', 'VOIDED', 'RECONCILE_REQUIRED'].includes(s);
  const settled = ['CAPTURED', 'VOIDED', 'RECONCILE_REQUIRED'].includes(s);
  fill(steps, 
    step('done', 'Offer matches the signed endorsement', `PayPal order ${t.order_id}`),
    step(approved ? 'done' : 'now', 'Buyer approval', isMock() ? 'Simulated in MOCK mode' : 'In PayPal Sandbox'),
    step(s === 'HELD_FOR_REVIEW' ? 'held' : authorized ? 'done' : 'todo', s === 'HELD_FOR_REVIEW' ? 'Authorized and on hold for the creator' : 'Funds authorized', 'Held, not captured'),
    step(settled ? (s === 'CAPTURED' ? 'done' : 'bad') : 'todo', settled ? (s === 'CAPTURED' ? 'Captured' : s === 'VOIDED' ? 'Voided' : 'Needs reconciliation') : 'Merchant enforcement', t.readback ? `Gateway read-back: ${t.readback}` : 'Re-checks the signature, then captures or voids'));
  msg.textContent = t.message || '';
  const b = (label, cls, fn) => h('button', { class: 'btn btn-sm ' + cls, type: 'button', onclick: (e) => busy(e.currentTarget, fn) }, label);
  if (!approved && isMock()) {
    act.append(h('div', { class: 'sim-sheet' }, h('h3', { text: 'Simulated PayPal approval' }),
      h('p', { text: 'MOCK mode: this stands in for the PayPal buyer screen. No PayPal request is made.' }),
      h('div', { class: 'btn-row' }, b('Approve payment', 'btn-primary', async () => {
        await api(`/api/mock-approve/${encodeURIComponent(t.payment_id)}`, { method: 'POST', body: {} });
        const a = await api(`/api/payments/${encodeURIComponent(t.payment_id)}/authorize`, { method: 'POST', body: {} });
        Object.assign(t, { state: a.state, message: a.state === 'HELD_FOR_REVIEW' ? 'An earlier AI verdict on this ad applies, so the order waits for the creator.' : 'Authorized. The merchant captures after re-checking the signature.' });
        renderTracker(); }))));
  }
  if (!approved && !isMock()) {
    act.append(h('a', { class: 'btn btn-sm btn-ink', href: t.approval_url || '#', target: '_blank', rel: 'noopener noreferrer' }, 'Approve in PayPal Sandbox'),
      b('I’ve approved it, authorize', 'btn-primary', async () => {
        const a = await api(`/api/payments/${encodeURIComponent(t.payment_id)}/authorize`, { method: 'POST', body: {} });
        Object.assign(t, { state: a.state, message: 'Authorized in PayPal Sandbox.' }); renderTracker(); }));
  }
  if (s === 'AUTHORIZED') act.append(b('Run merchant enforcement', 'btn-primary', async () => {
    requireAdmin();
    const st = await api(`/api/payments/${encodeURIComponent(t.payment_id)}/settle`, { method: 'POST', admin: true });
    const rb = await api(`/api/payments/${encodeURIComponent(t.payment_id)}`);
    Object.assign(t, { state: st.state, readback: rb.paypal_readback?.status, message: st.reason ? `Voided: ${st.reason}` : st.state === 'CAPTURED' ? 'Captured and confirmed by the gateway.' : '' });
    renderTracker(); }));
  if (s === 'HELD_FOR_REVIEW') act.append(h('a', { class: 'btn btn-sm btn-quiet', href: '#/creator' }, 'Decide as the creator'));
  if (authorized) act.append(b('Read back from gateway', 'btn-quiet', async () => {
    const rb = await api(`/api/payments/${encodeURIComponent(t.payment_id)}`);
    Object.assign(t, { state: rb.payment.state, readback: rb.paypal_readback?.status }); renderTracker(); }));
  act.append(h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => openPayment(t.payment_id), text: 'Details' }),
    h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => { state.checkoutPayment = null; renderTracker(); }, text: 'New order' }));
}

/* ================================================================== SECURITY CENTER */
const STATE_TONE = { CAPTURED: 'paid', VOIDED: 'void', HELD_FOR_REVIEW: 'held', RECONCILE_REQUIRED: 'block', AUTHORIZED: 'info', ORDER_CREATED: null, AUTHORIZING: 'info', CAPTURE_PENDING: 'info', VOID_PENDING: 'held' };
const STATE_LABEL = { CAPTURED: 'Captured', VOIDED: 'Voided', HELD_FOR_REVIEW: 'Held for creator', RECONCILE_REQUIRED: 'Reconcile', AUTHORIZED: 'Authorized', ORDER_CREATED: 'Awaiting buyer', AUTHORIZING: 'Authorizing', CAPTURE_PENDING: 'Capturing', VOID_PENDING: 'Voiding' };
const stateChip = (s) => chip(STATE_LABEL[s] || s, STATE_TONE[s]);
const EVENT_TEXT = {
  POLICY_ENROLLED: ['Creator policy enrolled', 'creator'], POLICY_SIGNED: ['Creator signature verified and policy activated', 'creator', 'paid'],
  UNTRUSTED_PAYEE_CLAIM: ['Checkout named an untrusted payee: blocked', 'block', 'block'], PRE_AUTH_BLOCK: ['Checkout blocked before payment', 'block', 'block'],
  ORDER_CREATED: ['PayPal order created', 'payment'], AUTHORIZED: ['Payment authorized', 'payment'],
  AUTHORIZED_HELD_FROM_CONTENT_VERDICT: ['Authorized and held by an earlier content verdict', 'ai', 'held'], AUTHORIZE_FAILED: ['Authorization failed', 'payment', 'block'],
  REVOCATION_EFFECTIVE: ['Creator ended an endorsement', 'creator', 'block'], REVOCATION_REVIEW_REQUIRED: ['Creator filed a misuse report for review', 'creator', 'held'],
  MOCK_SYNTHETIC_REVIEW_HOLD: ['Test hold placed (MOCK, no AI)', 'ai', 'held'], AI_REVIEW_HOLD: ['AI verdict placed an order on hold', 'ai', 'held'],
  CONTENT_AI_VERDICT: ['AI content verdict recorded', 'ai'], CREATOR_REVIEW_SIGNED: ['Creator signed a review decision', 'creator'],
  REVIEW_TIMEOUT_VOID: ['Review window elapsed: server voiding', 'ai', 'block'], PAYPAL_READBACK: ['Gateway read-back recorded', 'payment', 'paid'],
  REVIEW_VOID_UNCERTAIN: ['Void outcome uncertain: reconcile', 'payment', 'block'], CAPTURE_AFTER_VOID_PROBE: ['Capture-after-void probe', 'payment'],
  DECISION_LOCKED: ['Merchant enforcement locked a decision', 'payment'], AUTH_AMOUNT_MISMATCH: ['Gateway amount drift detected', 'block', 'block'],
  VOID_DECISION_CONFIRMED: ['Enforcement chose void', 'payment', 'block'], SETTLEMENT_UNCERTAIN: ['Settlement uncertain: reconcile', 'payment', 'block'],
  RECONCILED: ['Reconciled with the gateway', 'payment'], AUTO_VOID_ERROR: ['Auto-void error', 'payment', 'block'], AUTO_SETTLE_ERROR: ['Auto-capture error', 'payment', 'block'], WORKER_ERROR: ['Background worker error', 'payment', 'block'],
};
function describeEvent(e) {
  const [title, cat, tone] = EVENT_TEXT[e.kind] || [e.kind.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), 'payment'];
  const d = e.details || {}; let extra = '';
  if (e.kind === 'PRE_AUTH_BLOCK') extra = d.reason;
  else if (e.kind === 'UNTRUSTED_PAYEE_CLAIM') extra = `claimed ${d.claimed}`;
  else if (e.kind === 'PAYPAL_READBACK') { extra = `${d.action}: gateway reads ${d.readback?.status}`; }
  else if (e.kind === 'CAPTURE_AFTER_VOID_PROBE') extra = d.expected_refusal ? `refused (HTTP ${d.http_status})` : 'capture SUCCEEDED';
  else if (e.kind === 'CREATOR_REVIEW_SIGNED') extra = `${d.record?.action}: ${d.record?.reason}`;
  else if (e.kind === 'DECISION_LOCKED' || e.kind === 'VOID_DECISION_CONFIRMED') extra = d.reason || d.action;
  else if (e.kind === 'REVOCATION_EFFECTIVE' || e.kind === 'REVOCATION_REVIEW_REQUIRED') extra = d.record?.reason;
  else if (d.error || d.message) extra = d.error || d.message;
  const probeTone = e.kind === 'CAPTURE_AFTER_VOID_PROBE' ? (d.expected_refusal ? 'paid' : 'block') : tone;
  return { title, cat, tone: probeTone, extra };
}
function renderSecurity() {
  const pay = state.payments, ev = state.events;
  const blocked = ev.filter((e) => e.kind === 'PRE_AUTH_BLOCK' || e.kind === 'UNTRUSTED_PAYEE_CLAIM').length;
  const k = (n, label, tone) => h('div', { class: 'kpi', 'data-tone': tone || null }, h('b', { text: String(n) }), h('span', { text: label }));
  fill($('kpis'), 
    k(blocked, 'Checkouts blocked (logged)', 'block'), k(pay.filter((p) => p.state === 'CAPTURED').length, 'Captured', 'paid'),
    k(pay.filter((p) => p.state === 'VOIDED').length, 'Voided'), k(pay.filter((p) => p.state === 'HELD_FOR_REVIEW').length, 'Held for the creator', 'held'),
    k(pay.filter((p) => p.state === 'RECONCILE_REQUIRED').length, 'Need reconciliation', 'block'));
  const tx = $('txList');
  if (!pay.length) fill(tx, h('p', { class: 'empty', style: 'border:0', text: 'No payments yet. Run a scenario in the Studio and its orders appear here.' }));
  else fill(tx, ...pay.map((p) => h('button', { class: 'tx', type: 'button', onclick: () => openPayment(p.id) },
    h('span', null, h('code', { text: p.id }), h('span', { class: 'sub2', text: timeOf(p.created_at) })),
    h('span', { class: 'c-sku' }, policyById(p.policy_id)?.payload.creator_label || p.policy_id, h('span', { class: 'sub2', text: p.sku })),
    h('span', { class: 'amt', text: money(p.amount) }),
    h('span', null, stateChip(p.state), p.review_reason ? h('span', { class: 'sub2', text: p.review_reason === 'SYNTHETIC_MOCK_TEST' ? 'test hold, no AI' : p.review_reason }) : null),
    h('span', { class: 'when', text: ago(p.updated_at) }))));
  const items = ev.map((e) => ({ e, d: describeEvent(e) })).filter(({ d }) => state.feedFilter === 'all' || d.cat === state.feedFilter);
  fill($('eventFeed'), ...(items.length ? items.slice(0, 120).map(({ e, d }) => h('li', { 'data-tone': d.tone || null },
    h('b', { text: d.title }), d.extra ? h('span', { text: ': ' + d.extra }) : null,
    h('div', { class: 'meta' }, h('span', { text: timeOf(e.created_at) }), e.payment_id ? h('code', { text: e.payment_id }) : null, e.policy_id ? h('code', { text: e.policy_id }) : null)))
    : [h('li', { text: 'Nothing here yet.' })]),
  h('li', { class: 'hint', text: 'Domain mismatches and rejected signatures are refused by the server but not written to this log by the current backend.' }));
  renderReview();
  const cl = $('clPolicy'), prev = cl.value;
  fill(cl, h('option', { value: '', text: 'No policy (evidence only)' }), ...state.policies.filter(isSigned).map((p) => h('option', { value: p.id, text: `${p.payload.creator_label}: ${p.payload.sku}` })));
  cl.value = prev || state.kit.active || '';
  if (!$('clSku').value) $('clSku').value = DEMO.sku;
}
function renderReview() {
  const on = !!cfg().ai_configured;
  $('aiState').dataset.on = String(on);
  fill($('aiState'), on
    ? h('p', null, h('strong', { text: 'AI model configured. ' }), 'A mismatch between an ad and the creator’s signed claim places attributed orders on hold. The model never captures, refunds or proves identity.')
    : h('p', null, h('strong', { text: 'No AI model is configured on this server. ' }), 'Content analysis is unavailable here, and PINPOINT shows no AI verdicts it didn’t receive. Use the Capture after void scenario for the review flow with a labeled test hold.'));
  const sel = $('rvPayment'), prev = sel.value;
  const eligible = state.payments.filter((p) => p.state === 'AUTHORIZED' && p.content_id);
  fill(sel, ...(eligible.length ? eligible.map((p) => h('option', { value: p.id, text: `${p.id} (${money(p.amount)}, ${p.content_id})` })) : [h('option', { value: '', text: 'No authorized orders with a content ID' })]));
  if (eligible.some((p) => p.id === prev)) sel.value = prev;
  const p = eligible.find((x) => x.id === sel.value); if (p) $('rvContent').value = p.content_id;
  [...$('reviewForm').elements].forEach((el) => (el.disabled = !on));
}
async function openPayment(id) {
  const d = $('paymentDrawer'), body = $('drawerBody');
  fill(body, h('p', { class: 'hint', text: 'Reading the payment and the gateway’s current view…' }));
  if (!d.open) d.showModal();
  const load = async () => {
    const r = await api(`/api/payments/${encodeURIComponent(id)}`);
    const p = r.payment, rb = r.paypal_readback, policy = policyById(p.policy_id);
    $('drawerTitle').textContent = `${money(p.amount)} for ${p.sku}`;
    const actions = h('div', { class: 'btn-row' });
    const b = (label, cls, fn) => h('button', { class: 'btn btn-sm ' + cls, type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await fn(); await loadAll(); renderView(); await load(); }) }, label);
    if (p.state === 'AUTHORIZED') {
      actions.append(b('Run merchant enforcement', 'btn-primary', async () => { requireAdmin(); const s = await api(`/api/payments/${encodeURIComponent(id)}/settle`, { method: 'POST', admin: true }); toast(`${s.action || 'Settled'}: ${s.state}`, s.state === 'CAPTURED' ? 'ok' : null); }));
      if (isMock()) actions.append(b('Place test hold (MOCK, no AI)', 'btn-quiet', async () => { requireAdmin(); await api(`/api/mock/lab/${encodeURIComponent(id)}/flag-review`, { method: 'POST', admin: true }); toast('Test hold placed. The creator can now decide.'); }));
    }
    if (p.state === 'HELD_FOR_REVIEW' && hasKey(p.policy_id)) {
      for (const action of ['VOID', 'APPROVE']) actions.append(b(action === 'VOID' ? 'Void and sign as creator' : 'Approve and sign as creator', action === 'VOID' ? 'btn-void' : 'btn-paid', async () => {
        const r2 = await submitDecision(null, id, p.policy_id, action, action === 'VOID' ? 'Creator rejected this order in the Security Center' : 'Creator approved this order in the Security Center');
        if (!r2.ok) throw new ApiError(r2.status, r2.data, humanError(r2.status, r2.data)); toast(`Order is now ${r2.data.state}.`, 'ok'); }));
    }
    if (p.state === 'VOIDED') actions.append(b('Try to capture this voided authorization', 'btn-danger', async () => { requireAdmin(); const x = await api(`/api/lab/${encodeURIComponent(id)}/capture-after-void`, { method: 'POST', admin: true }); toast(x.expected_refusal ? `Capture refused (HTTP ${x.http_status}). Authorization reads ${x.authorization_readback?.status}.` : 'Capture was NOT refused. Investigate.', x.expected_refusal ? 'ok' : 'error'); }));
    if (p.authorization_id) actions.append(b('Reconcile with gateway', 'btn-quiet', async () => { requireAdmin(); const x = await api(`/api/payments/${encodeURIComponent(id)}/reconcile`, { method: 'POST', admin: true }); toast(`Reconciled: ${x.state}`); }));
    actions.append(b('Refresh read-back', 'btn-quiet', async () => {}));
    const path = ['ORDER_CREATED', 'AUTHORIZED', p.review_reason ? 'HELD_FOR_REVIEW' : null, p.state].filter((x, i, a) => x && a.indexOf(x) === i);
    fill(body, 
      h('div', { class: 'state-path' }, ...path.flatMap((s, i) => [i ? h('span', { class: 'sep', text: '→', 'aria-hidden': 'true' }) : null, stateChip(s)])),
      h('div', { class: 'env-detail' }, h('dl', null, ...[
        ['Payment', p.id], ['Creator', policy?.payload.creator_label || p.policy_id], ['PayPal order', p.order_id], ['Authorization', p.authorization_id || '-'],
        ['Payee', p.payee], ['Checkout site', p.domain], ['Attributed ad', p.content_id || '-'],
        ['Hold reason', p.review_reason === 'SYNTHETIC_MOCK_TEST' ? 'Test hold (MOCK, no AI ran)' : p.review_reason || '-'],
        ['Gateway read-back', rb ? (rb.status || (rb.readback_error ? 'read-back error' : '-')) : 'No authorization yet'],
        ['Adapter', isMock() ? 'Simulated gateway (MOCK)' : 'PayPal Sandbox'],
      ].flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]))),
      actions,
      h('h3', { text: 'Gateway read-back' }), h('pre', { class: 'code', text: JSON.stringify(rb, null, 2) }),
      h('h3', { text: 'Stored gateway responses' }), h('pre', { class: 'code', text: JSON.stringify(r.stored_api_response, null, 2) }));
  };
  try { await load(); } catch (e) { fill(body, h('p', { class: 'empty', text: e.message })); }
}

/* ================================================================== wiring */
function wire() {
  window.addEventListener('hashchange', route);
  $('settingsBtn').addEventListener('click', openSettings);
  $('envPill').addEventListener('click', openSettings);
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });
  $('tokenForm').addEventListener('submit', (e) => {
    e.preventDefault(); state.adminToken = $('adminToken').value.trim(); $('adminToken').value = '';
    renderEnv(); toast(state.adminToken ? 'Token held in memory for this page.' : 'Token cleared.');
    if (state.adminToken) { $('settingsDialog').close(); ensureKit(true); }
  });
  $('tokenClear').addEventListener('click', () => { state.adminToken = ''; renderEnv(); toast('Token forgotten.'); });
  $('kitRebuild').addEventListener('click', (e) => busy(e.currentTarget, async () => { const k = await ensureKit(true); if (k.status === 'ready') toast('Demo kit re-signed.', 'ok'); }));

  document.querySelectorAll('[data-pace]').forEach((b) => b.addEventListener('click', () => {
    state.pace = b.dataset.pace;
    document.querySelectorAll('[data-pace]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }));
  $('runScenario').addEventListener('click', () => runScenario());
  $('runSuite').addEventListener('click', () => runSuite());
  $('exportEvidence').addEventListener('click', () => {
    const data = state.lastSuite && (!state.lastRun || state.lastSuite.finished_at >= (state.lastRun.finished_at || '')) ? state.lastSuite : state.lastRun;
    if (!data) return toast('Run a scenario first; its API calls become the evidence.');
    download(`pinpoint-evidence-${data.scenario || 'suite'}-${Date.now()}.json`, data);
  });
  ['cPolicy', 'cAmount', 'cSku', 'cDomain', 'cPayee', 'cFlow'].forEach((id) => $(id).addEventListener('input', () => { if (id === 'cPolicy') customReset(); else predict(); }));
  $('cReset').addEventListener('click', customReset);
  $('cSave').addEventListener('click', () => { try { localStorage.setItem('pinpoint_custom_scenario_v2', JSON.stringify(Object.fromEntries(['cName', 'cPolicy', 'cAmount', 'cSku', 'cDomain', 'cPayee', 'cFlow', 'cContent', 'cTranscript'].map((i) => [i, $(i).value])))); toast('Custom scenario saved in this browser.'); } catch (e) { toast('Couldn’t save: ' + e.message, 'error'); } });
  $('cLoad').addEventListener('click', () => {
    try { const v = JSON.parse(localStorage.getItem('pinpoint_custom_scenario_v2') || 'null'); if (!v) return toast('Nothing saved yet.');
      for (const [k, val] of Object.entries(v)) if ($(k) && typeof val === 'string') { if (k === 'cPolicy' && !policyById(val)) continue; $(k).value = val; }
      predict(); toast('Custom scenario loaded.'); } catch (e) { toast('Couldn’t load: ' + e.message, 'error'); }
  });

  $('newPolicyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('createPolicy'), async () => {
      const price = $('npPrice').value.trim(), label = $('npLabel').value.trim(), sku = $('npSku').value.trim();
      const bad = (id, m) => { $(id).setAttribute('aria-invalid', 'true'); $(id).focus(); throw new UserError(m); };
      ['npPrice', 'npLabel', 'npSku'].forEach((i) => $(i).removeAttribute('aria-invalid'));
      if (!label) bad('npLabel', 'Add the creator name buyers will see.');
      if (!sku) bad('npSku', 'Add the product SKU you’re endorsing.');
      if (!(Number(price) > 0) || Number(price) > sandboxCap()) bad('npPrice', `Enter a price above $0 and at most ${money(sandboxCap())}.`);
      const p = await createSignedPolicy({ label, sku, price, minutes: Number($('npMinutes').value), review: Number($('npReview').value), claims: $('npClaims').value.trim() || `I endorse ${sku}.` });
      toast('Endorsement signed and published.', 'ok'); state.checkoutPolicy = p.id;
      await loadAll(); renderCreator();
    });
  });

  $('checkoutPolicy').addEventListener('change', (e) => { state.checkoutPolicy = e.target.value; state.checkoutPayment = null; renderTracker(); renderCheckout(); });
  ['tAmount', 'tSku', 'tDomain', 'tPayee'].forEach((id) => $(id).addEventListener('input', renderSummary));
  $('payBtn').addEventListener('click', (e) => busy(e.currentTarget, checkoutPay));

  $('secRefresh').addEventListener('click', (e) => busy(e.currentTarget, async () => { await loadAll(); renderSecurity(); }));
  const tabs = [...document.querySelectorAll('.tabs [role=tab]')];
  const selectTab = (t) => { tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; $(x.getAttribute('aria-controls')).hidden = !on; }); };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; selectTab(n); n.focus(); } });
  });
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    state.feedFilter = b.dataset.filter; document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('is-on', x === b)); renderSecurity();
  }));
  $('rvPayment').addEventListener('change', () => { const p = state.payments.find((x) => x.id === $('rvPayment').value); if (p) $('rvContent').value = p.content_id || ''; });
  $('reviewForm').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('rvAnalyze'), async () => {
      requireAdmin(); const id = $('rvPayment').value; if (!id) throw new UserError('Choose an authorized order that has a content ID.');
      const r = await api(`/api/payments/${encodeURIComponent(id)}/analyze-review`, { method: 'POST', admin: true, body: { content_id: $('rvContent').value.trim(), transcript: $('rvTranscript').value } });
      const verdict = r.reason === 'AI_UNAVAILABLE' ? 'No verdict: the model was unavailable.' : r.state === 'HELD_FOR_REVIEW' ? 'Mismatch: order held for the creator.' : `Verdict ${r.content_verdict || 'MATCH'}: order stays authorized.`;
      fill($('rvResult'), h('h4', { text: verdict }), r.cached ? h('p', { class: 'hint', text: r.warning }) : null, h('pre', { class: 'code', text: JSON.stringify(r.comparison || r, null, 2) }));
      await loadAll(); renderSecurity();
    });
  });
  let lastClaims = null;
  $('claimForm').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('clRun'), async () => {
      const r = await api('/api/evidence/claims', { method: 'POST', body: { transcript: $('clTranscript').value, policy_id: $('clPolicy').value || null, checkout_sku: $('clSku').value, checkout_amount: $('clPrice').value, checkout_merchant_name: $('clMerchant').value } });
      lastClaims = r;
      const live = r.ai?.mode === 'LIVE_LLM';
      fill($('clResult'), 
        h('h4', { text: live ? `Ad vs offer: ${r.claim_vs_offer?.status}` : `No model ran (mode: ${r.ai?.mode || 'unknown'}). The report holds signed-policy facts only.` }),
        r.evidence?.policy_id ? h('p', { text: `Signed claim: “${r.evidence.creator_signed_claim}”, SKU ${r.evidence.signed_sku}, ceiling ${money(r.evidence.signed_ceiling)}.` }) : h('p', { class: 'hint', text: r.evidence?.warning || '' }),
        h('p', { class: 'hint', text: r.disclaimer }), h('pre', { class: 'code', text: JSON.stringify(r, null, 2) }));
    });
  });
  $('clSave').addEventListener('click', () => (lastClaims ? download('pinpoint-claim-evidence.json', lastClaims) : toast('Build a report first.')));
  $('videoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('vCompare'), async () => {
      requireAdmin(); const a = $('vOriginal').files[0], b = $('vSuspect').files[0];
      if (!a || !b) throw new UserError('Choose both MP4 files.');
      const form = new FormData(); form.append('original', a); form.append('suspected', b);
      toast('Comparing videos. The first local-model run can take a while.');
      const r = await api('/api/evidence/compare-videos', { method: 'POST', admin: true, form });
      fill($('vResult'), h('h4', { text: r.interpretation || 'Comparison complete' }), h('pre', { class: 'code', text: JSON.stringify(r, null, 2) }));
    });
  });
  $('vFingerprint').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const a = $('vOriginal').files[0]; if (!a) throw new UserError('Choose the original MP4 first.');
    const form = new FormData(); form.append('file', a);
    const r = await api('/api/evidence/video-fingerprint', { method: 'POST', form });
    fill($('vResult'), h('h4', { text: `${r.method}: SHA-256 ${short(r.sha256, 12)}` }), h('pre', { class: 'code', text: JSON.stringify(r, null, 2) }));
  }));

  // Light polling where server-side timers matter (auto-void, auto-capture).
  setInterval(async () => {
    if (document.hidden || state.running || !['security', 'creator'].includes(state.view)) return;
    if (document.querySelector('dialog[open]') || document.activeElement?.closest('form,.decision,details')) return;
    try { await loadAll(); renderView(); } catch {}
  }, 7000);
}

async function boot() {
  wire();
  state.ed25519 = await detectEd25519();
  if (!state.ed25519) {
    const b = $('systemBanner'); b.hidden = false;
    b.textContent = 'This browser can’t create Ed25519 signatures (WebCrypto). Use a current Chrome, Edge, Firefox or Safari to sign creator policies; read-only views still work.';
  }
  try { state.cfg = await api('/api/config'); }
  catch (e) {
    renderEnv(); const b = $('systemBanner'); b.hidden = false;
    b.replaceChildren('PINPOINT can’t load its configuration: ' + e.message + ' ', h('button', { class: 'btn btn-sm', type: 'button', onclick: () => location.reload(), text: 'Retry' }));
    route(); return;
  }
  renderEnv();
  try { await loadAll(); } catch (e) { toast(e.message, 'error'); }
  selectScenario('legit');
  route();
  if (state.ed25519) ensureKit().then(() => { if (state.view === 'studio') resetStage(); });
  else { state.kit = { status: 'error', message: 'Ed25519 unavailable in this browser' }; renderKit(); renderHeroReceipt(); }
}
boot();
