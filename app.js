/**
 * Tiny Tycoons — single-file marketplace application.
 *
 * A UK-first multi-vendor marketplace where children/students sell products
 * under parent/guardian and school supervision.
 *
 * This entire app (server, routes, HTML views, and data access) lives in this
 * one file so it can be hosted anywhere that runs Node.js with nothing more
 * than `npm install && npm start`. Data is persisted to a local `data.json`
 * file — no database server or Docker required.
 *
 * Run:
 *   cp .env.example .env   (edit values)
 *   npm install
 *   npm start
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const multer = require('multer');

// ============================================================================
// ENV LOADING (no dotenv dependency — tiny manual .env parser)
// ============================================================================

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

// ============================================================================
// CONFIG
// ============================================================================

const PORT = parseInt(process.env.PORT || '4000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[tiny-tycoons] WARNING: JWT_SECRET is not set. Using a random secret for ' +
      'this process only — all logged-in sessions will be invalidated on restart. ' +
      'Set JWT_SECRET in your .env for a stable production deployment.'
  );
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
if (!stripe) {
  console.warn('[tiny-tycoons] STRIPE_SECRET_KEY is not set — checkout & payouts are disabled until configured.');
}

const COOKIE_NAME = 'tt_token';
const DATA_FILE = path.join(__dirname, 'data.json');
const PRODUCT_IMAGES_DIR = path.join(__dirname, 'product_images');
if (!fs.existsSync(PRODUCT_IMAGES_DIR)) {
  fs.mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
}

// ============================================================================
// SMALL UTILITIES
// ============================================================================

function uuid() {
  return crypto.randomUUID();
}

function h(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents) {
  return (Math.round(cents || 0) / 100).toFixed(2);
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'item'
  );
}

function uniqueSlug(base, existingSlugs) {
  let slug = base;
  let i = 2;
  while (existingSlugs.includes(slug)) {
    slug = `${base}-${i}`;
    i++;
  }
  return slug;
}

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 12);
}

function verifyPassword(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const CONTACT_PHONE_RE = /(\+?\d[\d\s-]{7,}\d)/;
function containsContactDetails(text) {
  return CONTACT_EMAIL_RE.test(text) || CONTACT_PHONE_RE.test(text);
}

function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getBaseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ============================================================================
// DATA STORE (JSON-file backed — no database server required)
// ============================================================================

function seedDb() {
  const now = new Date().toISOString();
  const adminId = uuid();
  const buyerId = uuid();
  const guardianId = uuid();
  const creatorId = uuid();
  const orgRepId = uuid();
  const catJewelry = uuid();
  const catArt = uuid();
  const catBaked = uuid();
  const store1 = uuid();
  const store2 = uuid();

  return {
    users: [
      { id: adminId, email: 'admin@tinytycoons.test', passwordHash: hashPassword('Admin123!'), name: 'Platform Admin', isAdmin: true, createdAt: now },
      { id: buyerId, email: 'buyer@tinytycoons.test', passwordHash: hashPassword('Buyer123!'), name: 'Bella Buyer', isAdmin: false, createdAt: now },
      { id: guardianId, email: 'guardian@tinytycoons.test', passwordHash: hashPassword('Guardian123!'), name: 'Grace Guardian', isAdmin: false, createdAt: now },
      { id: creatorId, email: 'saban@tinytycoons.test', passwordHash: hashPassword('Creator123!'), name: 'Saban', isAdmin: false, createdAt: now },
      { id: orgRepId, email: 'coordinator@younghigh.test', passwordHash: hashPassword('OrgOwner123!'), name: 'Young High Coordinator', isAdmin: false, createdAt: now },
    ],
    guardianRelationships: [{ id: uuid(), guardianUserId: guardianId, creatorUserId: creatorId, createdAt: now }],
    guardianConsents: [
      { id: uuid(), guardianUserId: guardianId, creatorUserId: creatorId, consentType: 'SELLER_REGISTRATION', version: '1.0', ipAddress: 'seed', status: 'GRANTED', createdAt: now },
    ],
    categories: [
      { id: catJewelry, name: 'Jewelry & Accessories', slug: 'jewelry-accessories' },
      { id: catArt, name: 'Art & Crafts', slug: 'art-crafts' },
      { id: catBaked, name: 'Baked Goods', slug: 'baked-goods' },
    ],
    stores: [
      {
        id: store1, ownerUserId: creatorId, guardianUserId: guardianId, type: 'INDIVIDUAL',
        name: 'CRK Jewelers', slug: 'crk-jewelers',
        description: 'Handmade beaded jewelry crafted by a young entrepreneur.',
        status: 'APPROVED', commissionRateOverride: null, stripeAccountId: null, createdAt: now,
      },
      {
        id: store2, ownerUserId: orgRepId, guardianUserId: null, type: 'ORGANIZATION',
        name: 'Young Canvas', slug: 'young-canvas',
        description: 'Student art collective from Young High School.',
        status: 'APPROVED', commissionRateOverride: null, stripeAccountId: null, createdAt: now,
      },
    ],
    products: [
      { id: uuid(), storeId: store1, title: 'Beaded Sunset Bracelet', slug: 'beaded-sunset-bracelet', description: 'A handmade beaded bracelet in warm sunset colors.', priceCents: 1200, stock: 25, categoryId: catJewelry, images: [], status: 'APPROVED', createdAt: now },
      { id: uuid(), storeId: store1, title: 'Ocean Wave Earrings', slug: 'ocean-wave-earrings', description: 'Blue and white beaded earrings inspired by ocean waves.', priceCents: 900, stock: 15, categoryId: catJewelry, images: [], status: 'APPROVED', createdAt: now },
      { id: uuid(), storeId: store2, title: 'Watercolor Postcard Set', slug: 'watercolor-postcard-set', description: 'Set of 5 original watercolor postcards painted by students.', priceCents: 1500, stock: 10, categoryId: catArt, images: [], status: 'APPROVED', createdAt: now },
    ],
    carts: {},
    orders: [],
    sellerOrders: [],
    returns: [],
    conversations: [],
    messages: [],
    commissionConfig: { rate: 0.1 },
  };
}

let db;
if (fs.existsSync(DATA_FILE)) {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} else {
  db = seedDb();
  persist();
  console.log('[tiny-tycoons] No data.json found — seeded demo data (see README for demo logins).');
}

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ---- domain accessors ------------------------------------------------------

function getUserByEmail(email) {
  return db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
}
function getUserById(id) {
  return db.users.find((u) => u.id === id);
}
function getStoreBySlug(slug) {
  return db.stores.find((s) => s.slug === slug);
}
function getStoreById(id) {
  return db.stores.find((s) => s.id === id);
}
function getManagedStoreForUser(userId) {
  return db.stores.find((s) => s.ownerUserId === userId);
}
function getCommissionRateForStore(store) {
  return typeof store.commissionRateOverride === 'number' ? store.commissionRateOverride : db.commissionConfig.rate;
}
function getProductBySlug(slug) {
  return db.products.find((p) => p.slug === slug);
}
function getProductById(id) {
  return db.products.find((p) => p.id === id);
}
function getCategoryById(id) {
  return db.categories.find((c) => c.id === id);
}
function isProductPublic(p) {
  if (!p || p.status !== 'APPROVED') return false;
  const store = getStoreById(p.storeId);
  return !!store && store.status === 'APPROVED';
}

function computeCartTotals(userId) {
  const rawItems = db.carts[userId] || [];
  const items = [];
  let totalCents = 0;
  const byStore = new Map();
  for (const entry of rawItems) {
    const product = getProductById(entry.productId);
    if (!product) continue;
    const store = getStoreById(product.storeId);
    const lineTotalCents = product.priceCents * entry.qty;
    totalCents += lineTotalCents;
    items.push({ product, store, qty: entry.qty, lineTotalCents });
    if (!byStore.has(product.storeId)) byStore.set(product.storeId, { store, items: [], subtotalCents: 0 });
    const bucket = byStore.get(product.storeId);
    bucket.items.push({ product, qty: entry.qty, lineTotalCents });
    bucket.subtotalCents += lineTotalCents;
  }
  return { items, totalCents, byStore };
}

// ============================================================================
// APP SETUP
// ============================================================================

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
        frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
        connectSrc: ["'self'", 'https://api.stripe.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
  })
);
app.use(cookieParser());
app.use(morganLite());
app.use('/product_images', express.static(PRODUCT_IMAGES_DIR));

// Stripe webhook needs the RAW body for signature verification, so it must be
// registered before any body-parsing middleware that would consume the stream.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), ah(stripeWebhookHandler));

app.use(express.urlencoded({ extended: true }));

function morganLite() {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (NODE_ENV !== 'test') {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
      }
    });
    next();
  };
}

// ---- auth middleware --------------------------------------------------------

function attachUser(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  req.user = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = getUserById(payload.sub) || null;
    } catch (e) {
      req.user = null;
    }
  }
  next();
}
app.use(attachUser);

// Lightweight CSRF defense: for authenticated, state-changing requests using
// our cookie session, require the Origin/Referer host to match our own host.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/webhooks/stripe') return next();
  const hasSessionCookie = req.cookies && req.cookies[COOKIE_NAME];
  const origin = req.get('origin') || req.get('referer');
  if (hasSessionCookie && origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== req.get('host')) {
        return res.status(403).send('Cross-site request blocked.');
      }
    } catch (e) {
      // ignore malformed origin/referer, fall through
    }
  }
  next();
});

function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });
}
function setAuthCookie(res, user) {
  res.cookie(COOKIE_NAME, signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).send(layout(req, res, { title: 'Forbidden', body: `<h1>403</h1><p>Admins only.</p>` }));
  }
  next();
}
function requireStore(req, res, next) {
  const store = getManagedStoreForUser(req.user.id);
  if (!store) return res.redirect('/register/seller');
  req.store = store;
  next();
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use(['/login', '/register', '/register/seller/individual', '/register/seller/organization'], authLimiter);

// ---- flash helpers -----------------------------------------------------------

function flashUrl(url, type, msg) {
  const u = new URL(url, 'http://internal.local');
  u.searchParams.set('flash', msg);
  u.searchParams.set('flashType', type);
  return u.pathname + u.search;
}
function getFlash(req) {
  if (!req.query.flash) return null;
  return { type: req.query.flashType === 'error' ? 'error' : 'success', msg: String(req.query.flash) };
}

// ============================================================================
// VIEWS
// ============================================================================

const CSS = `
:root {
  --brand: #d3082b;
  --brand-strong: #b00022;
  --brand-dark: #7a0519;
  --brand-soft: rgba(211, 8, 43, 0.12);
  --accent: #21d4fd;
  --accent-deep: #0eb7dc;
  --ink: #f5f7fb;
  --muted: #c0c9d6;
  --surface: #0d1117;
  --panel: rgba(17, 24, 39, 0.82);
  --panel-alt: rgba(20, 30, 45, 0.9);
  --card-bg: rgba(15, 23, 42, 0.8);
  --card-bg-strong: rgba(15, 23, 42, 0.96);
  --table-head: rgba(148, 163, 184, 0.08);
  --border: rgba(122, 142, 171, 0.28);
  --border-strong: rgba(33, 212, 253, 0.38);
  --shadow: 0 18px 42px rgba(0, 0, 0, 0.26);
  --success-bg: rgba(14, 182, 120, 0.12);
  --success-text: #82f7c5;
  --warning-bg: rgba(255, 214, 102, 0.12);
  --warning-text: #ffd76a;
  --danger-bg: rgba(211, 8, 43, 0.12);
  --danger-text: #ffb0be;
  --footer-bg: #070b12;
  --bg-1: #070b12;
  --bg-2: #0f1725;
  --bg-3: #120b14;
  --header-bg-1: rgba(10, 14, 22, 0.96);
  --header-bg-2: rgba(12, 18, 29, 0.92);
  --muted-card: rgba(255,255,255,0.05);
  --input-bg: rgba(15, 23, 42, 0.35);
  --page-bg: #0c1018;
}
:root[data-theme="light"] {
  --brand: #d3082b;
  --brand-strong: #b00022;
  --brand-dark: #740615;
  --brand-soft: rgba(211, 8, 43, 0.1);
  --accent: #0ea5e9;
  --accent-deep: #0284c7;
  --ink: #111827;
  --muted: #526079;
  --surface: #edf2f7;
  --panel: rgba(255,255,255,0.82);
  --panel-alt: rgba(246,249,252,0.94);
  --card-bg: rgba(255, 255, 255, 0.86);
  --card-bg-strong: rgba(255, 255, 255, 0.96);
  --table-head: #f7f5f2;
  --border: rgba(98, 116, 146, 0.24);
  --border-strong: rgba(14, 165, 233, 0.26);
  --shadow: 0 18px 42px rgba(15, 23, 42, 0.08);
  --success-bg: rgba(13, 148, 136, 0.08);
  --success-text: #0f766e;
  --warning-bg: rgba(245, 158, 11, 0.08);
  --warning-text: #b45309;
  --danger-bg: rgba(220, 38, 38, 0.08);
  --danger-text: #b91c1c;
  --footer-bg: #111827;
  --bg-1: #f3f6fb;
  --bg-2: #edf4fb;
  --bg-3: #f9f3f5;
  --header-bg-1: rgba(255,255,255,0.88);
  --header-bg-2: rgba(241,245,249,0.94);
  --muted-card: rgba(17,24,39,0.02);
  --input-bg: rgba(255,255,255,0.9);
  --page-bg: #f6f8fb;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(211, 8, 43, 0.18), transparent 20%),
    radial-gradient(circle at top right, rgba(33, 212, 253, 0.14), transparent 26%),
    linear-gradient(180deg, var(--bg-1) 0%, var(--bg-2) 38%, var(--bg-3) 100%);
  letter-spacing: -0.01em;
  min-height: 100vh;
}
body.page-loading {
  overflow: hidden;
}
a { color: var(--ink); text-decoration: none; }
a:hover { text-decoration: underline; }
.container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
#page-loader {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 18px;
  background: rgba(7, 11, 18, 0.86);
  backdrop-filter: blur(12px);
  transition: opacity 0.45s ease, visibility 0.45s ease;
}
#page-loader.is-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
.loader-ring {
  position: relative;
  width: 76px;
  height: 76px;
  border-radius: 50%;
  border: 3px solid rgba(255,255,255,0.12);
  border-top-color: var(--accent);
  border-right-color: var(--brand);
  animation: spin 0.9s linear infinite;
  box-shadow: 0 0 0 12px rgba(33, 212, 253, 0.08), 0 0 26px rgba(211, 8, 43, 0.2);
}
.loader-ring::after {
  content: "";
  position: absolute;
  inset: 12px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.1);
}
.loader-text {
  color: #f8fafc;
  font-size: 0.8rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  font-weight: 700;
}
@keyframes spin { to { transform: rotate(360deg); } }
.main-content {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.35s ease, transform 0.35s ease;
}
body.page-loaded .main-content {
  opacity: 1;
}
.site-header {
  background: linear-gradient(180deg, var(--header-bg-1), var(--header-bg-2));
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
  position: sticky;
  top: 0;
  z-index: 30;
  backdrop-filter: blur(10px);
}
.header-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  flex-wrap: nowrap;
}
.logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  font-size: 1.18rem;
  letter-spacing: -0.05em;
  color: #f8fafc;
  text-decoration: none;
}
.logo-mark {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--brand), #ff4d6d);
  color: #fff;
  font-size: 0.78rem;
  font-weight: 900;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 0 18px rgba(211, 8, 43, 0.42);
}
.search-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 180px;
  max-width: 520px;
}
.search-form input {
  flex: 1;
  padding: 11px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--input-bg);
  color: var(--ink);
  min-width: 0;
}
.search-form input::placeholder {
  color: var(--muted);
}
.search-form button {
  padding: 11px 16px;
  border: none;
  background: linear-gradient(135deg, var(--brand), #ff4d6d);
  color: #fff;
  border-radius: 12px;
  cursor: pointer;
  font-weight: 800;
  box-shadow: 0 10px 20px rgba(211, 8, 43, 0.26);
}
.nav-links {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  margin-left: auto;
}
.mobile-nav-menu-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  min-width: 46px;
  height: 42px;
  min-height: 42px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: linear-gradient(135deg, rgba(211, 8, 43, 0.22), rgba(33, 212, 253, 0.12));
  color: var(--ink);
  cursor: pointer;
  font-size: 1.55rem;
  line-height: 1;
  padding: 0 10px;
  box-shadow: 0 10px 20px rgba(15, 23, 42, 0.14);
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.mobile-nav-menu-toggle:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 24px rgba(15, 23, 42, 0.18);
  border-color: rgba(33, 212, 253, 0.38);
}
.nav-link,
.nav-user,
.nav-logout,
.nav-theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 0.88rem;
  font-weight: 600;
  transition: all 0.18s ease;
}
.nav-link {
  color: var(--ink);
  text-decoration: none;
  background: rgba(148, 163, 184, 0.08);
  border: 1px solid rgba(148, 163, 184, 0.14);
}
.nav-link:hover {
  background: rgba(33, 212, 253, 0.08);
  border-color: rgba(33, 212, 253, 0.38);
  color: var(--ink);
  text-decoration: none;
}
.nav-link.nav-cta,
.nav-cta {
  background: linear-gradient(135deg, var(--brand), #ff4d6d);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 10px 20px rgba(211, 8, 43, 0.26);
}
.nav-link.nav-cta:hover,
.nav-cta:hover {
  color: #fff;
  text-decoration: none;
}
.nav-user {
  color: var(--ink);
  background: var(--muted-card);
  border: 1px solid var(--border);
}
.nav-logout,
.nav-theme-toggle {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--ink);
  cursor: pointer;
}
.nav-theme-toggle {
  gap: 8px;
}
.theme-icon { font-size: 0.9rem; }
.link-btn {
  background: none;
  border: none;
  color: var(--brand-dark);
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: underline;
}
.logout-form {
  display: inline-flex;
  align-items: center;
  margin: 0;
}
.btn-primary-sm {
  background: linear-gradient(135deg, var(--brand), #f2b45d);
  color: #fff !important;
  padding: 9px 16px;
  border-radius: 999px;
  box-shadow: 0 8px 18px rgba(217, 119, 6, 0.24);
}
.inline-form { display: inline; }
.flash { padding: 12px 0 0; }
.flash .container {
  padding: 12px 18px;
  border-radius: 12px;
  border: 1px solid transparent;
}
.flash-success .container { background: var(--success-bg); color: var(--success-text); border-color: rgba(31, 107, 68, 0.15); }
.flash-error .container { background: var(--danger-bg); color: var(--danger-text); border-color: rgba(154, 35, 35, 0.15); }
.main-content { padding: 30px 20px 60px; min-height: 60vh; }
.two-col {
  display: grid;
  grid-template-columns: 1.08fr 0.92fr;
  gap: 30px;
  align-items: stretch;
  margin-top: 8px;
}
.product-media,
.product-detail-panel {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 22px;
  box-shadow: 0 16px 30px rgba(15, 23, 42, 0.04);
}
.form-card {
  background: var(--card-bg-strong);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 28px;
  max-width: 520px;
  margin: 0 auto;
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.04);
}
.form-card.wide { max-width: 760px; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-weight: 700; margin-bottom: 6px; font-size: 0.9rem; }
.form-group .hint { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
input[type=text], input[type=email], input[type=password], input[type=number], input[type=url], textarea, select {
  width: 100%;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 0.95rem;
  font-family: inherit;
  background: var(--input-bg);
  color: var(--ink);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: rgba(33, 212, 253, 0.6);
  box-shadow: 0 0 0 4px rgba(33, 212, 253, 0.12);
}
textarea { min-height: 94px; }
.checkbox-row { display: flex; align-items: flex-start; gap: 8px; }
.checkbox-row input { width: auto; margin-top: 4px; }
.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 12px 24px rgba(17, 24, 39, 0.03);
}
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 16px;
  box-shadow: 0 12px 24px rgba(17, 24, 39, 0.04);
}
.sidebar a {
  display: block;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 0.9rem;
  color: var(--ink);
  margin-bottom: 4px;
}
.sidebar a:hover, .sidebar a.active {
  background: var(--brand-soft);
  color: var(--brand-dark);
  text-decoration: none;
}
.table-wrap {
  overflow-x: auto;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--card-bg);
  box-shadow: 0 12px 24px rgba(17, 24, 39, 0.03);
}
.table-wrap table {
  width: 100%;
  border-collapse: collapse;
}
th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
th { background: var(--table-head); font-weight: 700; }
tr:last-child td { border-bottom: none; }
.product-media {
  padding: 18px;
}
.product-detail-panel {
  padding: 28px;
}
.detail-kicker {
  display: inline-block;
  padding: 7px 10px;
  background: var(--brand-soft);
  color: var(--brand-dark);
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.product-detail-panel h1 {
  margin: 14px 0 8px;
  font-size: clamp(2rem, 3vw, 2.8rem);
  line-height: 1.02;
  letter-spacing: -0.06em;
}
.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 14px 0 16px;
}
.meta-pill {
  display: inline-flex;
  align-items: center;
  padding: 7px 10px;
  border-radius: 999px;
  background: #f8fafc;
  border: 1px solid rgba(148, 163, 184, 0.25);
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 600;
}
.product-detail-panel .price {
  font-size: 1.5rem;
  margin: 0 0 12px;
}
.product-detail-panel p {
  color: var(--muted);
  line-height: 1.7;
}
.product-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 20px;
}
.hint {
  font-size: 0.82rem;
  color: var(--muted);
  margin: 6px 0 0;
}
.hero {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(17, 24, 39, 0.98) 0%, rgba(20, 21, 35, 0.96) 30%, rgba(28, 11, 18, 0.96) 100%);
  border: 1px solid rgba(122, 142, 171, 0.2);
  border-radius: 28px;
  padding: 42px 42px 30px;
  margin: 12px 0 30px;
  box-shadow: 0 24px 50px rgba(0, 0, 0, 0.2);
}
.hero::before {
  content: "";
  position: absolute;
  right: -36px;
  top: -26px;
  width: 280px;
  height: 280px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(211,8,43,0.42), rgba(33,212,253,0.12) 32%, rgba(15,23,42,0));
}
.hero::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(120deg, rgba(255,255,255,0.03), rgba(255,255,255,0), rgba(255,255,255,0.03));
  pointer-events: none;
}
.hero-inner { position: relative; z-index: 1; }
.hero-badge {
  display: inline-flex;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 0.72rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  background: rgba(211, 8, 43, 0.12);
  color: #ffd9e1;
  border: 1px solid rgba(211, 8, 43, 0.38);
  margin-bottom: 18px;
}
.hero h1 {
  color: #f8fafc;
  font-size: clamp(2.3rem, 5vw, 4rem);
  line-height: 0.98;
  margin: 0 0 12px;
  letter-spacing: -0.07em;
  max-width: 720px;
}
.hero p {
  color: rgba(226, 232, 240, 0.8);
  max-width: 680px;
  margin: 0 0 24px;
  font-size: 1.08rem;
  line-height: 1.65;
}
.cta-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.btn {
  display: inline-block;
  padding: 12px 20px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  font-size: 0.96rem;
  font-weight: 800;
  transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
}
.btn:hover { transform: translateY(-1px); text-decoration: none; }
.btn-primary {
  background: linear-gradient(135deg, var(--brand), #ff4d6d);
  color: #fff;
  box-shadow: 0 16px 30px rgba(211, 8, 43, 0.32);
}
.btn-secondary {
  background: rgba(33, 212, 253, 0.08);
  color: #dffbff;
  border: 1px solid rgba(33, 212, 253, 0.25);
}
.btn-danger { background: #dc2626; color: #fff; }
.btn-small { padding: 7px 12px; font-size: 0.82rem; }
.hero-metrics {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  padding-top: 18px;
  border-top: 1px solid rgba(148, 163, 184, 0.2);
}
.hero-metrics div {
  min-width: 120px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hero-metrics strong {
  color: #fff;
  font-size: 1.5rem;
  letter-spacing: -0.05em;
}
.hero-metrics span {
  color: rgba(226, 232, 240, 0.72);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.products-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 22px;
  margin-top: 18px;
}
.product-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 20px;
  overflow: hidden;
  display: block;
  color: inherit;
  box-shadow: 0 14px 24px rgba(17, 24, 39, 0.05);
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.product-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 20px 32px rgba(0, 0, 0, 0.18);
  border-color: rgba(33, 212, 253, 0.28);
  text-decoration: none;
}
.product-card-img {
  height: 170px;
  background: linear-gradient(135deg, rgba(211, 8, 43, 0.14), rgba(33, 212, 253, 0.14));
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}
.product-card-img img { width: 100%; height: 100%; object-fit: cover; }
.placeholder-img { font-size: 2.8rem; }
.product-card-body { padding: 16px 16px 18px; }
.product-card-body h3 {
  font-size: 1.08rem;
  margin: 0 0 8px;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.store-name { color: var(--muted); font-size: 0.8rem; margin: 0 0 10px; }
.price {
  font-weight: 800;
  color: var(--brand-dark);
  margin: 0;
  font-size: 1.08rem;
}
.section-title {
  font-size: 1.55rem;
  margin: 26px 0 8px;
  letter-spacing: -0.05em;
  color: var(--ink);
  display: flex;
  align-items: center;
  gap: 12px;
}
.section-title::before {
  content: "";
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--brand), var(--accent));
  box-shadow: 0 0 0 6px rgba(33, 212, 253, 0.12);
}
.filters {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.filters a {
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.82rem;
  background: var(--muted-card);
  color: var(--ink);
  font-weight: 600;
}
.filters a.active {
  background: linear-gradient(135deg, var(--brand), var(--accent));
  color: #fff;
  border-color: transparent;
  box-shadow: 0 10px 20px rgba(33, 212, 253, 0.18);
}
.site-footer {
  background: var(--footer-bg);
  color: rgba(226, 232, 240, 0.8);
  padding: 22px 0;
  border-top: 1px solid var(--border);
  margin-top: 40px;
}
.empty-state {
  background: var(--muted-card);
  border: 1px dashed rgba(148, 163, 184, 0.45);
  border-radius: 18px;
  padding: 26px 20px;
  color: var(--muted);
}
.form-card {
  background: var(--card-bg-strong);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 28px;
  max-width: 500px;
  margin: 0 auto;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.04);
}
.form-card.wide { max-width: 720px; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-weight: 700; margin-bottom: 6px; font-size: 0.9rem; }
.form-group .hint { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
input[type=text], input[type=email], input[type=password], input[type=number], input[type=url], textarea, select {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 0.95rem;
  font-family: inherit;
  background: var(--input-bg);
  color: var(--ink);
}
textarea { min-height: 94px; }
.checkbox-row { display: flex; align-items: flex-start; gap: 8px; }
.checkbox-row input { width: auto; margin-top: 4px; }
table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card-bg-strong);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.04);
}
th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
th { background: var(--table-head); font-weight: 700; }
tr:last-child td { border-bottom: none; }
.badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 700; }
.badge-pending, .badge-pending_review { background: var(--warning-bg); color: var(--warning-text); }
.badge-approved, .badge-paid, .badge-completed, .badge-granted, .badge-refunded { background: var(--success-bg); color: var(--success-text); }
.badge-rejected, .badge-failed, .badge-suspended, .badge-cancelled { background: var(--danger-bg); color: var(--danger-text); }
.badge-draft, .badge-requested, .badge-awaiting_fulfillment, .badge-awaiting_payment { background: #edf2ff; color: #3855c5; }
.badge-shipped { background: #e8f3ff; color: #2358a0; }
.dashboard-layout { display: flex; gap: 24px; align-items: flex-start; }
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.04);
}
.sidebar a {
  display: block;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 0.9rem;
  color: var(--ink);
  margin-bottom: 4px;
}
.sidebar a:hover, .sidebar a.active {
  background: var(--brand-soft);
  color: var(--brand-dark);
  text-decoration: none;
}
.dashboard-content { flex: 1; min-width: 0; }
.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.03);
}
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 20px; }
.stat-box {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.03);
}
.stat-box .num { font-size: 1.6rem; font-weight: 800; color: var(--brand-dark); }
.stat-box .label { color: var(--muted); font-size: 0.8rem; }
.alert-banner {
  background: var(--warning-bg);
  color: var(--warning-text);
  border-radius: 12px;
  padding: 14px 18px;
  margin-bottom: 20px;
  border: 1px solid rgba(138, 90, 0, 0.12);
  font-size: 0.9rem;
}
.msg-thread { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
.msg-bubble {
  background: var(--card-bg-strong);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 14px;
  max-width: 70%;
}
.msg-bubble.mine {
  align-self: flex-end;
  background: var(--brand-soft);
  border-color: rgba(217,119,6,0.2);
}
.msg-meta { font-size: 0.75rem; color: var(--muted); margin-bottom: 4px; }
.msg-flag { color: #b91c1c; font-size: 0.75rem; font-weight: 700; }
.site-footer {
  background: linear-gradient(180deg, rgba(7, 11, 18, 0.94), rgba(9, 14, 22, 1));
  color: rgba(255,255,255,0.8);
  border-top: 1px solid var(--border);
  padding: 34px 0 36px;
  font-size: 0.85rem;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}
.site-footer .container {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.site-footer .footer-callout {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 22px 24px;
  border: 1px solid rgba(122, 142, 171, 0.24);
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(211, 8, 43, 0.12), rgba(33, 212, 253, 0.08));
}
.site-footer .footer-callout strong {
  display: block;
  font-size: 1.05rem;
  color: #fff;
  letter-spacing: -0.03em;
  margin-bottom: 4px;
}
.site-footer .footer-callout span {
  color: rgba(255,255,255,0.7);
}
.site-footer .footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.site-footer .brand-mark {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 1.05rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: #fff;
}
.site-footer .brand-mark::before {
  content: "TT";
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--brand), #ff4d6d);
  color: #fff;
  font-size: 0.68rem;
  font-weight: 900;
}
.site-footer .legal-links {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: center;
}
.site-footer a {
  color: #eafcff;
}
.site-footer .footer-callout strong,
.site-footer .brand-mark,
.site-footer .brand-mark::before,
.site-footer .footer-callout span,
.site-footer .legal-links a,
.site-footer .legal-links a:hover {
  color: #fff;
}
.empty-state { text-align: center; padding: 50px 20px; color: var(--muted); }
.two-col { display: grid; grid-template-columns: 1.2fr 1fr; gap: 30px; align-items: start; }
.qty-form { display: flex; gap: 6px; align-items: center; }
.qty-form input { width: 70px; }

@media (max-width: 900px) {
  .container { padding: 0 12px; }
  .main-content { padding: 12px 12px 28px; }
  .site-header { position: sticky; }
  .header-inner {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px 10px;
    padding: 10px 12px;
  }
  .logo {
    width: auto;
    justify-content: flex-start;
    font-size: 1.02rem;
    letter-spacing: -0.04em;
    grid-column: 1;
    grid-row: 1;
  }
  .search-form {
    grid-column: 1 / -1;
    grid-row: 2;
    width: 100%;
    max-width: none;
    min-width: 0;
    gap: 6px;
    margin: 2px 0 0;
    padding: 4px 0 0;
  }
  .search-form input {
    padding: 11px 12px;
    font-size: 0.92rem;
    min-height: 44px;
  }
  .search-form button {
    padding: 11px 12px;
    font-size: 0.8rem;
    min-height: 44px;
  }
  .nav-links {
    display: none;
    width: 100%;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    margin-left: 0;
    padding: 12px;
    border-radius: 22px;
    border: 1px solid rgba(122, 142, 171, 0.22);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.97), rgba(17, 28, 39, 0.92));
    backdrop-filter: blur(16px);
    box-shadow: 0 18px 34px rgba(15, 23, 42, 0.22);
    grid-column: 1 / -1;
  }
  .nav-links.is-open {
    display: flex;
  }
  .mobile-nav-menu-toggle {
    display: inline-flex;
    align-self: center;
    justify-self: end;
    margin-left: 0;
    font-size: 1.7rem;
    font-weight: 700;
    flex-shrink: 0;
    grid-column: 2;
    grid-row: 1;
    min-width: 46px;
    border-radius: 14px;
  }
  .nav-link,
  .nav-user,
  .nav-logout,
  .nav-theme-toggle,
  .logout-form {
    width: 100%;
    border-radius: 12px;
    min-height: 38px;
  }
  .nav-link,
  .nav-theme-toggle,
  .nav-user,
  .nav-logout {
    justify-content: center;
    padding: 0 12px;
    font-size: 0.76rem;
    letter-spacing: 0.01em;
  }
  .nav-link {
    background: rgba(148, 163, 184, 0.05);
    border: 1px solid rgba(148, 163, 184, 0.12);
  }
  .nav-link,
  .nav-user,
  .nav-logout,
  .nav-theme-toggle {
    min-height: 32px;
    padding: 0 10px;
    font-size: 0.72rem;
    white-space: nowrap;
    width: 100%;
    justify-content: center;
  }
  .nav-theme-toggle {
    min-width: 0;
  }
  .nav-link,
  .nav-user,
  .nav-logout,
  .nav-theme-toggle,
  .logout-form {
    width: 100%;
  }
  .logout-form {
    display: flex;
  }
  .hero {
    padding: 18px 14px 16px;
    border-radius: 22px;
    margin: 6px 0 18px;
  }
  .hero::before {
    width: 170px;
    height: 170px;
    right: -28px;
    top: -16px;
    opacity: 0.9;
  }
  .hero-badge {
    margin-bottom: 12px;
    letter-spacing: 0.08em;
    font-size: 0.58rem;
    padding: 8px 10px;
  }
  .hero h1 {
    font-size: clamp(2.1rem, 9vw, 3rem);
    margin-bottom: 10px;
    line-height: 1.02;
    max-width: 100%;
  }
  .hero p {
    font-size: 0.96rem;
    line-height: 1.58;
    margin-bottom: 18px;
  }
  .cta-row {
    flex-direction: column;
    align-items: stretch;
    margin: 14px 0 18px;
    gap: 8px;
  }
  .btn {
    min-height: 48px;
    font-size: 0.98rem;
  }
  .btn,
  .btn-primary,
  .btn-secondary,
  .btn-danger,
  .nav-link,
  .nav-cta {
    width: 100%;
    justify-content: center;
    text-align: center;
  }
  .hero-metrics {
    gap: 8px;
    justify-content: space-between;
    padding-top: 12px;
  }
  .hero-metrics div {
    min-width: 0;
    flex: 1;
  }
  .hero-metrics strong {
    font-size: 1.08rem;
  }
  .hero-metrics span {
    font-size: 0.64rem;
    letter-spacing: 0.05em;
  }
  .products-grid {
    grid-template-columns: 1fr;
    gap: 14px;
    margin-top: 12px;
  }
  .product-card {
    border-radius: 18px;
    box-shadow: 0 12px 22px rgba(17, 24, 39, 0.06);
  }
  .product-card-img {
    height: 158px;
  }
  .product-card-body {
    padding: 12px 12px 14px;
  }
  .product-card-body h3 {
    font-size: 1rem;
    margin-bottom: 6px;
  }
  .store-name {
    font-size: 0.75rem;
    margin-bottom: 8px;
  }
  .price {
    font-size: 1rem;
  }
  .two-col,
  .dashboard-layout {
    grid-template-columns: 1fr;
    display: grid;
  }
  .sidebar {
    width: 100%;
  }
  .dashboard-layout {
    gap: 14px;
  }
  .site-footer {
    padding-top: 16px;
  }
  .site-footer .container {
    gap: 14px;
  }
  .site-footer .footer-callout {
    align-items: flex-start;
    padding: 14px 14px;
    gap: 10px;
    border-radius: 16px;
  }
  .site-footer .footer-callout strong {
    font-size: 0.98rem;
  }
  .site-footer .footer-callout span {
    display: block;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .site-footer .footer-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding-top: 10px;
  }
  .site-footer .brand-mark {
    font-size: 0.95rem;
  }
  .site-footer .legal-links {
    gap: 8px 12px;
    font-size: 0.8rem;
  }
  .product-detail-panel,
  .form-card,
  .card,
  .stat-box,
  .sidebar {
    border-radius: 14px;
  }
  .product-detail-actions {
    flex-direction: column;
  }
  .product-detail-actions .btn,
  .qty-form {
    width: 100%;
  }
  .qty-form {
    justify-content: space-between;
    gap: 6px;
  }
  .qty-form input {
    flex: 1;
    width: auto;
  }
  .form-card,
  .form-card.wide {
    padding: 18px 14px;
    max-width: 100%;
  }
  .section-title {
    font-size: 1.15rem;
  }
}
`;

function nav(req) {
  const user = req.user;
  const store = user ? getManagedStoreForUser(user.id) : null;
  if (!user) {
    return `
      <button type="button" class="nav-theme-toggle" data-theme-toggle>
        <span class="theme-icon">☀️</span>
        <span class="theme-label">Light</span>
      </button>
      <a class="nav-link" href="/products">Browse</a>
      <a class="nav-link" href="/register/seller">Sell</a>
      <a class="nav-link" href="/login">Log in</a>
      <a class="nav-link nav-cta" href="/register">Join</a>`;
  }
  return `
    <button type="button" class="nav-theme-toggle" data-theme-toggle>
      <span class="theme-icon">☀️</span>
      <span class="theme-label">Light</span>
    </button>
    <a class="nav-link" href="/products">Browse</a>
    <a class="nav-link" href="/cart">Cart</a>
    <a class="nav-link" href="/dashboard">Orders</a>
    <a class="nav-link" href="/messages">Inbox</a>
    ${store ? `<a class="nav-link" href="/dashboard/seller">Seller</a>` : `<a class="nav-link" href="/register/seller">Sell</a>`}
    ${user.isAdmin ? `<a class="nav-link" href="/dashboard/admin">Admin</a>` : ''}
    <span class="nav-user">Hi, ${h(user.name)}</span>
    <form method="post" action="/logout" class="logout-form"><button type="submit" class="nav-logout">Log out</button></form>`;
}

function layout(req, res, { title, body }) {
  const flash = getFlash(req);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${h(title)} · Tiny Tycoons</title>
<style>${CSS}</style>
</head>
<body class="page-loading">
<div id="page-loader" aria-live="polite">
  <div class="loader-ring"></div>
  <div class="loader-text">Loading Tiny Tycoons</div>
</div>
<header class="site-header">
  <div class="container header-inner">
    <a href="/" class="logo"><span class="logo-mark">TT</span> Tiny Tycoons</a>
    <form action="/products" method="get" class="search-form">
      <input type="text" name="q" placeholder="Search products..." value="${h(req.query.q || '')}">
      <button type="submit">Search</button>
    </form>
    <button type="button" class="mobile-nav-menu-toggle" aria-label="Open menu" aria-expanded="false" data-mobile-nav-toggle>⋯</button>
    <nav class="nav-links">${nav(req)}</nav>
  </div>
</header>
${flash ? `<div class="flash flash-${h(flash.type)}"><div class="container">${h(flash.msg)}</div></div>` : ''}
<main class="container main-content">
${body}
</main>
<footer class="site-footer">
  <div class="container">
    <div class="footer-callout">
      <div>
        <strong>Young founders. Trusted sales. Real experience.</strong>
        <span>Built for safe, supervised learning and entrepreneurial growth.</span>
      </div>
      <a href="/register/seller" class="btn btn-primary btn-small">Start selling</a>
    </div>
    <div class="footer-row">
      <div class="brand-mark">Tiny Tycoons</div>
      <div class="legal-links">
        <a href="/products">Browse</a>
        <a href="/register/seller">Sell with us</a>
        <a href="/login">Log in</a>
      </div>
      <div>© ${new Date().getFullYear()} Tiny Tycoons — a UK-first marketplace for young entrepreneurs, run under parent/guardian &amp; school supervision.</div>
    </div>
  </div>
</footer>
<script>
  (function () {
    const loader = document.getElementById('page-loader');
    const themeButtons = document.querySelectorAll('[data-theme-toggle]');
    const mobileMenuButtons = document.querySelectorAll('[data-mobile-nav-toggle]');
    const navMenus = document.querySelectorAll('.nav-links');

    const APPLY_THEME = function (theme) {
      const resolved = theme === 'light' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', resolved);
      localStorage.setItem('tinytycoons-theme', resolved);
      themeButtons.forEach(function (button) {
        const icon = button.querySelector('.theme-icon');
        const label = button.querySelector('.theme-label');
        if (icon) icon.textContent = resolved === 'light' ? '☀️' : '🌙';
        if (label) label.textContent = resolved === 'light' ? 'Light' : 'Dark';
      });
    };

    const toggleMobileNav = function (button) {
      const nav = button.parentElement && button.parentElement.querySelector('.nav-links');
      if (!nav) return;
      const isOpen = nav.classList.toggle('is-open');
      button.setAttribute('aria-expanded', String(isOpen));
    };

    const currentTheme = localStorage.getItem('tinytycoons-theme');
    const preferred = currentTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    APPLY_THEME(preferred);

    const hideLoader = function () {
      document.body.classList.remove('page-loading');
      document.body.classList.add('page-loaded');
      if (loader) {
        loader.classList.add('is-hidden');
      }
    };
    if (document.readyState === 'complete') {
      setTimeout(hideLoader, 220);
    } else {
      window.addEventListener('load', function () {
        setTimeout(hideLoader, 220);
      }, { once: true });
    }

    themeButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        const nextTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        APPLY_THEME(nextTheme);
      });
    });

    mobileMenuButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        toggleMobileNav(button);
      });
    });

    document.addEventListener('click', function (event) {
      const target = event.target;
      const isMenuButton = target.closest('[data-mobile-nav-toggle]');
      const isNavLink = target.closest('.nav-link');
      if (!isMenuButton && !isNavLink) {
        navMenus.forEach(function (nav) {
          nav.classList.remove('is-open');
          const trigger = nav.parentElement && nav.parentElement.querySelector('[data-mobile-nav-toggle]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
        });
      }
      const link = target.closest('a');
      if (!link || link.target || link.hash || !link.href || !link.href.startsWith(window.location.origin)) return;
      const path = link.getAttribute('href') || '';
      if (!path || path.startsWith('/api')) return;
      if (loader) {
        document.body.classList.add('page-loading');
        loader.classList.remove('is-hidden');
      }
    });
  })();
</script>
</body>
</html>`;
}

function renderPage(req, res, opts) {
  res.send(layout(req, res, opts));
}

function productCard(p) {
  const store = getStoreById(p.storeId);
  return `<a class="product-card" href="/products/${h(p.slug)}">
    <div class="product-card-img">${p.images && p.images[0] ? `<img src="${h(p.images[0])}" alt="${h(p.title)}">` : `<div class="placeholder-img">🧵</div>`}</div>
    <div class="product-card-body">
      <h3>${h(p.title)}</h3>
      <p class="store-name">by ${h(store ? store.name : 'Unknown store')}</p>
      <p class="price">£${money(p.priceCents)}</p>
    </div>
  </a>`;
}

function badge(status) {
  const cls = String(status).toLowerCase();
  return `<span class="badge badge-${h(cls)}">${h(status)}</span>`;
}

function sellerSidebar(req, active) {
  const items = [
    ['/dashboard/seller', 'Overview'],
    ['/dashboard/seller/products', 'Products'],
    ['/dashboard/seller/orders', 'Orders'],
    ['/dashboard/seller/returns', 'Returns'],
    ['/messages', 'Messages'],
    ['/dashboard/seller/store', 'Store settings'],
  ];
  return `<div class="sidebar">${items
    .map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`)
    .join('')}</div>`;
}

function adminSidebar(active) {
  const items = [
    ['/dashboard/admin', 'Overview'],
    ['/dashboard/admin/stores', 'Stores'],
    ['/dashboard/admin/products', 'Product moderation'],
    ['/dashboard/admin/categories', 'Categories'],
    ['/dashboard/admin/commission', 'Commission'],
  ];
  return `<div class="sidebar">${items
    .map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`)
    .join('')}</div>`;
}

function customerSidebar(active) {
  const items = [
    ['/dashboard', 'Orders'],
    ['/messages', 'Messages'],
  ];
  return `<div class="sidebar">${items
    .map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`)
    .join('')}</div>`;
}

// ============================================================================
// PUBLIC ROUTES
// ============================================================================

app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/', ah(async (req, res) => {
  const featured = db.products.filter(isProductPublic).slice(-6).reverse();
  const body = `
    <div class="hero">
      <div class="hero-inner">
        <div class="hero-badge">UK-first marketplace</div>
        <h1>Build confidence. Sell with purpose.</h1>
        <p>Every store on Tiny Tycoons is run by a child or student, supervised by a parent, guardian, or school — creating a safer, more trusted way to learn enterprise and grow online.</p>
        <div class="cta-row">
          <a href="/products" class="btn btn-primary">Browse the marketplace</a>
          <a href="/register/seller" class="btn btn-secondary">Start selling</a>
        </div>
        <div class="hero-metrics">
          <div>
            <strong>3k+</strong>
            <span>young creators</span>
          </div>
          <div>
            <strong>150+</strong>
            <span>verified stores</span>
          </div>
          <div>
            <strong>24/7</strong>
            <span>safe moderation</span>
          </div>
        </div>
      </div>
    </div>
    <h2 class="section-title">Featured products</h2>
    <div class="products-grid">${featured.map(productCard).join('') || `<div class="empty-state">No products yet — check back soon!</div>`}</div>
  `;
  renderPage(req, res, { title: 'Home', body });
}));

app.get('/products', ah(async (req, res) => {
  const q = (req.query.q || '').toString().toLowerCase().trim();
  const categoryId = (req.query.category || '').toString();
  let results = db.products.filter(isProductPublic);
  if (q) results = results.filter((p) => p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  if (categoryId) results = results.filter((p) => p.categoryId === categoryId);

  const filterLinks = db.categories
    .map((c) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      params.set('category', c.id);
      return `<a href="/products?${params.toString()}" class="${categoryId === c.id ? 'active' : ''}">${h(c.name)}</a>`;
    })
    .join('');
  const allParams = new URLSearchParams();
  if (q) allParams.set('q', q);

  const body = `
    <h1 class="section-title">Browse products</h1>
    <div class="filters">
      <a href="/products?${allParams.toString()}" class="${!categoryId ? 'active' : ''}">All</a>
      ${filterLinks}
    </div>
    <div class="products-grid">${results.map(productCard).join('') || `<div class="empty-state">No products match your search.</div>`}</div>
  `;
  renderPage(req, res, { title: 'Browse products', body });
}));

app.get('/products/:slug', ah(async (req, res) => {
  const product = getProductBySlug(req.params.slug);
  const isOwnerOrAdmin =
    req.user && product && (req.user.isAdmin || getStoreById(product.storeId)?.ownerUserId === req.user.id);
  if (!product || (!isProductPublic(product) && !isOwnerOrAdmin)) {
    throw new HttpError(404, 'Product not found');
  }
  const store = getStoreById(product.storeId);
  const category = getCategoryById(product.categoryId);
  const body = `
    <div class="two-col">
      <div class="product-media">
        <div class="product-card-img" style="height:420px;border-radius:18px;">
          ${product.images && product.images[0] ? `<img src="${h(product.images[0])}" alt="${h(product.title)}">` : `<div class="placeholder-img" style="font-size:5rem;">🧵</div>`}
        </div>
      </div>
      <div class="product-detail-panel">
        <div class="detail-kicker">${category ? h(category.name) : 'Featured item'}</div>
        <h1>${h(product.title)}</h1>
        <div class="detail-meta">
          <span class="meta-pill">by <a href="/stores/${h(store.slug)}">${h(store.name)}</a></span>
          <span class="meta-pill">${product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}</span>
        </div>
        <p class="price">£${money(product.priceCents)}</p>
        <p>${h(product.description)}</p>
        <div class="product-detail-actions">
          ${
            product.stock > 0
              ? `<form method="post" action="/cart/add" class="qty-form">
                  <input type="hidden" name="productId" value="${h(product.id)}">
                  <input type="hidden" name="redirectTo" value="/products/${h(product.slug)}">
                  <input type="number" name="qty" value="1" min="1" max="${product.stock}">
                  <button type="submit" class="btn btn-primary">Add to cart</button>
                </form>`
              : '<span class="meta-pill">Sold out</span>'
          }
        </div>
        <p class="hint"><a href="/messages/new?store=${h(store.slug)}">Contact seller</a></p>
      </div>
    </div>
  `;
  renderPage(req, res, { title: product.title, body });
}));

app.get('/stores/:slug', ah(async (req, res) => {
  const store = getStoreBySlug(req.params.slug);
  const isOwnerOrAdmin = req.user && store && (req.user.isAdmin || store.ownerUserId === req.user.id);
  if (!store || (store.status !== 'APPROVED' && !isOwnerOrAdmin)) throw new HttpError(404, 'Store not found');
  const products = db.products.filter((p) => p.storeId === store.id && (isProductPublic(p) || isOwnerOrAdmin));
  const body = `
    <h1>${h(store.name)}</h1>
    <p class="store-name">${store.type === 'ORGANIZATION' ? 'School / organization store' : 'Individual creator store'}</p>
    <p>${h(store.description)}</p>
    <p><a href="/messages/new?store=${h(store.slug)}">Contact this seller</a></p>
    <h2 class="section-title">Products</h2>
    <div class="products-grid">${products.map(productCard).join('') || `<div class="empty-state">This store has no products yet.</div>`}</div>
  `;
  renderPage(req, res, { title: store.name, body });
}));

// ============================================================================
// AUTH ROUTES
// ============================================================================

function authFormLayout(title, formHtml) {
  return `<div class="form-card">${formHtml}</div>`;
}

app.get('/register', (req, res) => {
  const body = authFormLayout('Sign up', `
    <h1>Create your account</h1>
    <form method="post" action="/register">
      <div class="form-group"><label>Full name</label><input type="text" name="name" required maxlength="80"></div>
      <div class="form-group"><label>Email</label><input type="email" name="email" required maxlength="120"></div>
      <div class="form-group"><label>Password</label><input type="password" name="password" required minlength="8"></div>
      <button type="submit" class="btn btn-primary">Sign up</button>
    </form>
    <p class="hint">Already have an account? <a href="/login">Log in</a></p>
  `);
  renderPage(req, res, { title: 'Sign up', body });
});

app.post('/register', ah(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8 || !EMAIL_FORMAT_RE.test(email)) {
    return res.redirect(flashUrl('/register', 'error', 'Please fill in all fields with a valid email and a password of at least 8 characters.'));
  }
  if (getUserByEmail(email)) {
    return res.redirect(flashUrl('/register', 'error', 'An account with that email already exists.'));
  }
  const user = { id: uuid(), email: email.toLowerCase(), passwordHash: hashPassword(password), name, isAdmin: false, createdAt: new Date().toISOString() };
  db.users.push(user);
  persist();
  setAuthCookie(res, user);
  res.redirect('/');
}));

app.get('/login', (req, res) => {
  const body = authFormLayout('Log in', `
    <h1>Log in</h1>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${h(req.query.next || '')}">
      <div class="form-group"><label>Email</label><input type="email" name="email" required></div>
      <div class="form-group"><label>Password</label><input type="password" name="password" required></div>
      <button type="submit" class="btn btn-primary">Log in</button>
    </form>
    <p class="hint">No account? <a href="/register">Sign up</a> or <a href="/register/seller">start selling</a>.</p>
  `);
  renderPage(req, res, { title: 'Log in', body });
});

app.post('/login', ah(async (req, res) => {
  const { email, password, next } = req.body;
  const user = email && getUserByEmail(email);
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return res.redirect(flashUrl('/login', 'error', 'Invalid email or password.'));
  }
  setAuthCookie(res, user);
  const dest = typeof next === 'string' && next.startsWith('/') ? next : '/';
  res.redirect(dest);
}));

app.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/');
});

app.get('/register/seller', (req, res) => {
  const body = `
    <div class="form-card wide" style="text-align:center;">
      <h1>Start selling on Tiny Tycoons</h1>
      <p class="hint">Choose the option that fits you:</p>
      <div style="display:flex;gap:20px;justify-content:center;margin-top:20px;flex-wrap:wrap;">
        <a href="/register/seller/individual" class="btn btn-primary">I'm a young creator (with a parent/guardian)</a>
        <a href="/register/seller/organization" class="btn btn-secondary">I'm registering a school / organization store</a>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Sell with us', body });
});

app.get('/register/seller/individual', (req, res) => {
  const body = authFormLayout('Individual creator sign up', `
    <h1>Register as a young creator</h1>
    <p class="hint">A parent or guardian must consent before your store can be approved.</p>
    <form method="post" action="/register/seller/individual">
      <div class="form-group"><label>Store name</label><input type="text" name="storeName" required maxlength="80"></div>
      <hr>
      <h3>Creator (you)</h3>
      <div class="form-group"><label>Your name</label><input type="text" name="creatorName" required maxlength="80"></div>
      <div class="form-group"><label>Your email</label><input type="email" name="creatorEmail" required></div>
      <div class="form-group"><label>Your password</label><input type="password" name="creatorPassword" required minlength="8"></div>
      <hr>
      <h3>Parent / guardian</h3>
      <div class="form-group"><label>Guardian name</label><input type="text" name="guardianName" required maxlength="80"></div>
      <div class="form-group"><label>Guardian email</label><input type="email" name="guardianEmail" required></div>
      <div class="form-group"><label>Guardian password <span class="hint">(only used if this is a new guardian account)</span></label><input type="password" name="guardianPassword" minlength="8"></div>
      <div class="form-group checkbox-row">
        <input type="checkbox" name="consent" id="consent" required>
        <label for="consent" style="margin:0;">I am the parent/guardian of the creator above and I consent to them selling on Tiny Tycoons under my supervision.</label>
      </div>
      <button type="submit" class="btn btn-primary">Create store application</button>
    </form>
  `);
  renderPage(req, res, { title: 'Individual creator sign up', body });
});

app.post('/register/seller/individual', ah(async (req, res) => {
  const { storeName, creatorName, creatorEmail, creatorPassword, guardianName, guardianEmail, guardianPassword, consent } = req.body;
  if (!storeName || !creatorName || !creatorEmail || !creatorPassword || !guardianName || !guardianEmail) {
    return res.redirect(flashUrl('/register/seller/individual', 'error', 'Please fill in all required fields.'));
  }
  if (!consent) {
    return res.redirect(flashUrl('/register/seller/individual', 'error', 'Guardian consent is required to create a creator store.'));
  }
  if (creatorPassword.length < 8 || !EMAIL_FORMAT_RE.test(creatorEmail) || !EMAIL_FORMAT_RE.test(guardianEmail)) {
    return res.redirect(flashUrl('/register/seller/individual', 'error', 'Please provide valid emails and a password of at least 8 characters.'));
  }
  if (getUserByEmail(creatorEmail)) {
    return res.redirect(flashUrl('/register/seller/individual', 'error', 'An account with the creator email already exists.'));
  }

  const now = new Date().toISOString();
  const creator = { id: uuid(), email: creatorEmail.toLowerCase(), passwordHash: hashPassword(creatorPassword), name: creatorName, isAdmin: false, createdAt: now };
  db.users.push(creator);

  let guardian = getUserByEmail(guardianEmail);
  if (!guardian) {
    guardian = {
      id: uuid(), email: guardianEmail.toLowerCase(),
      passwordHash: hashPassword(guardianPassword && guardianPassword.length >= 8 ? guardianPassword : crypto.randomBytes(12).toString('hex')),
      name: guardianName, isAdmin: false, createdAt: now,
    };
    db.users.push(guardian);
  }

  db.guardianRelationships.push({ id: uuid(), guardianUserId: guardian.id, creatorUserId: creator.id, createdAt: now });
  db.guardianConsents.push({
    id: uuid(), guardianUserId: guardian.id, creatorUserId: creator.id,
    consentType: 'SELLER_REGISTRATION', version: '1.0', ipAddress: req.ip, status: 'GRANTED', createdAt: now,
  });

  const baseSlug = slugify(storeName);
  const slug = uniqueSlug(baseSlug, db.stores.map((s) => s.slug));
  db.stores.push({
    id: uuid(), ownerUserId: creator.id, guardianUserId: guardian.id, type: 'INDIVIDUAL',
    name: storeName, slug, description: '', status: 'PENDING', commissionRateOverride: null, stripeAccountId: null, createdAt: now,
  });

  persist();
  setAuthCookie(res, creator);
  res.redirect(flashUrl('/dashboard/seller', 'success', 'Your store application has been submitted and is pending admin approval.'));
}));

app.get('/register/seller/organization', (req, res) => {
  const body = authFormLayout('Organization sign up', `
    <h1>Register a school / organization store</h1>
    <form method="post" action="/register/seller/organization">
      <div class="form-group"><label>Store / organization name</label><input type="text" name="storeName" required maxlength="80"></div>
      <div class="form-group"><label>Description</label><textarea name="description" maxlength="500"></textarea></div>
      <hr>
      <h3>Coordinator / representative</h3>
      <div class="form-group"><label>Your name</label><input type="text" name="repName" required maxlength="80"></div>
      <div class="form-group"><label>Your email</label><input type="email" name="repEmail" required></div>
      <div class="form-group"><label>Your password</label><input type="password" name="repPassword" required minlength="8"></div>
      <button type="submit" class="btn btn-primary">Create store application</button>
    </form>
  `);
  renderPage(req, res, { title: 'Organization sign up', body });
});

app.post('/register/seller/organization', ah(async (req, res) => {
  const { storeName, description, repName, repEmail, repPassword } = req.body;
  if (!storeName || !repName || !repEmail || !repPassword) {
    return res.redirect(flashUrl('/register/seller/organization', 'error', 'Please fill in all required fields.'));
  }
  if (repPassword.length < 8 || !EMAIL_FORMAT_RE.test(repEmail)) {
    return res.redirect(flashUrl('/register/seller/organization', 'error', 'Please provide a valid email and a password of at least 8 characters.'));
  }
  if (getUserByEmail(repEmail)) {
    return res.redirect(flashUrl('/register/seller/organization', 'error', 'An account with that email already exists.'));
  }
  const now = new Date().toISOString();
  const rep = { id: uuid(), email: repEmail.toLowerCase(), passwordHash: hashPassword(repPassword), name: repName, isAdmin: false, createdAt: now };
  db.users.push(rep);
  const baseSlug = slugify(storeName);
  const slug = uniqueSlug(baseSlug, db.stores.map((s) => s.slug));
  db.stores.push({
    id: uuid(), ownerUserId: rep.id, guardianUserId: null, type: 'ORGANIZATION',
    name: storeName, slug, description: description || '', status: 'PENDING', commissionRateOverride: null, stripeAccountId: null, createdAt: now,
  });
  persist();
  setAuthCookie(res, rep);
  res.redirect(flashUrl('/dashboard/seller', 'success', 'Your store application has been submitted and is pending admin approval.'));
}));

// ============================================================================
// CART & CHECKOUT
// ============================================================================

app.get('/cart', requireAuth, ah(async (req, res) => {
  const { items, totalCents } = computeCartTotals(req.user.id);
  const rows = items
    .map(
      (it) => `<tr>
        <td><a href="/products/${h(it.product.slug)}">${h(it.product.title)}</a><br><span class="hint">${h(it.store.name)}</span></td>
        <td>£${money(it.product.priceCents)}</td>
        <td>
          <form method="post" action="/cart/update" class="qty-form">
            <input type="hidden" name="productId" value="${h(it.product.id)}">
            <input type="number" name="qty" value="${it.qty}" min="1" max="${it.product.stock}">
            <button type="submit" class="btn btn-secondary btn-small">Update</button>
          </form>
        </td>
        <td>£${money(it.lineTotalCents)}</td>
        <td><form method="post" action="/cart/remove"><input type="hidden" name="productId" value="${h(it.product.id)}"><button type="submit" class="link-btn">Remove</button></form></td>
      </tr>`
    )
    .join('');
  const body = `
    <h1>Your cart</h1>
    ${items.length === 0 ? `<div class="empty-state">Your cart is empty. <a href="/products">Browse products</a></div>` : `
      <table>
        <thead><tr><th>Product</th><th>Price</th><th>Qty</th><th>Subtotal</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="card" style="margin-top:20px;max-width:340px;">
        <p><strong>Total: £${money(totalCents)}</strong></p>
        <a href="/checkout" class="btn btn-primary">Proceed to checkout</a>
      </div>
    `}
  `;
  renderPage(req, res, { title: 'Cart', body });
}));

app.post('/cart/add', requireAuth, ah(async (req, res) => {
  const { productId, qty, redirectTo } = req.body;
  const product = getProductById(productId);
  const dest = typeof redirectTo === 'string' && redirectTo.startsWith('/') ? redirectTo : '/products';
  if (!product || !isProductPublic(product)) {
    return res.redirect(flashUrl(dest, 'error', 'That product is not available.'));
  }
  const quantity = Math.max(1, parseInt(qty, 10) || 1);
  if (!db.carts[req.user.id]) db.carts[req.user.id] = [];
  const existing = db.carts[req.user.id].find((i) => i.productId === productId);
  if (existing) existing.qty = Math.min(product.stock, existing.qty + quantity);
  else db.carts[req.user.id].push({ productId, qty: Math.min(product.stock, quantity) });
  persist();
  res.redirect(flashUrl(dest, 'success', 'Added to cart.'));
}));

app.post('/cart/update', requireAuth, ah(async (req, res) => {
  const { productId, qty } = req.body;
  const cart = db.carts[req.user.id] || [];
  const item = cart.find((i) => i.productId === productId);
  const quantity = parseInt(qty, 10) || 0;
  if (item) {
    if (quantity <= 0) db.carts[req.user.id] = cart.filter((i) => i.productId !== productId);
    else item.qty = quantity;
    persist();
  }
  res.redirect('/cart');
}));

app.post('/cart/remove', requireAuth, ah(async (req, res) => {
  db.carts[req.user.id] = (db.carts[req.user.id] || []).filter((i) => i.productId !== req.body.productId);
  persist();
  res.redirect('/cart');
}));

app.get('/checkout', requireAuth, ah(async (req, res) => {
  const { items, totalCents } = computeCartTotals(req.user.id);
  if (items.length === 0) return res.redirect('/cart');
  if (!stripe) {
    return renderPage(req, res, {
      title: 'Checkout',
      body: `<div class="alert-banner">Payments are not configured on this server yet. Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET in .env to enable checkout.</div>`,
    });
  }
  const body = `
    <h1>Checkout</h1>
    <div class="two-col">
      <div class="card">
        <h3>Shipping address</h3>
        <form id="shipping-form">
          <div class="form-group"><textarea id="shippingAddress" placeholder="Full name, address line, city, postcode" required></textarea></div>
        </form>
        <h3>Payment</h3>
        <div id="payment-element"></div>
        <button id="pay-button" class="btn btn-primary" style="margin-top:16px;">Pay £${money(totalCents)}</button>
        <p id="checkout-error" style="color:#b91c1c;margin-top:10px;"></p>
      </div>
      <div class="card">
        <h3>Order summary</h3>
        ${items.map((it) => `<p>${h(it.product.title)} × ${it.qty} — £${money(it.lineTotalCents)}</p>`).join('')}
        <hr><p><strong>Total: £${money(totalCents)}</strong></p>
      </div>
    </div>
    <script src="https://js.stripe.com/v3/"></script>
    <script>
      (async function () {
        const stripe = Stripe(${JSON.stringify(STRIPE_PUBLISHABLE_KEY)});
        const errorEl = document.getElementById('checkout-error');
        let clientSecret, orderId;
        try {
          const shippingAddress = document.getElementById('shippingAddress').value;
          const resp = await fetch('/api/checkout/intent', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shippingAddress: '' }),
          });
          const data = await resp.json();
          if (!resp.ok) { errorEl.textContent = data.error || 'Could not start checkout.'; return; }
          clientSecret = data.clientSecret; orderId = data.orderId;
        } catch (e) { errorEl.textContent = 'Could not start checkout.'; return; }
        const elements = stripe.elements({ clientSecret });
        const paymentElement = elements.create('payment');
        paymentElement.mount('#payment-element');
        document.getElementById('pay-button').addEventListener('click', async (e) => {
          e.preventDefault();
          const shippingAddress = document.getElementById('shippingAddress').value;
          if (!shippingAddress.trim()) { errorEl.textContent = 'Please enter a shipping address.'; return; }
          await fetch('/api/checkout/shipping', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: orderId, shippingAddress: shippingAddress }),
          });
          const { error } = await stripe.confirmPayment({
            elements,
            confirmParams: { return_url: window.location.origin + '/checkout/complete?order=' + orderId },
          });
          if (error) errorEl.textContent = error.message;
        });
      })();
    </script>
  `;
  renderPage(req, res, { title: 'Checkout', body });
}));

app.post('/api/checkout/intent', requireAuth, express.json(), ah(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured on this server.' });
  const { items, totalCents, byStore } = computeCartTotals(req.user.id);
  if (items.length === 0) return res.status(400).json({ error: 'Your cart is empty.' });
  for (const it of items) {
    if (it.qty > it.product.stock) return res.status(400).json({ error: `Not enough stock for ${it.product.title}.` });
  }

  const now = new Date().toISOString();
  const order = {
    id: uuid(), buyerUserId: req.user.id, createdAt: now, status: 'PENDING_PAYMENT',
    totalCents, paymentIntentId: null, shippingAddress: '', sellerOrderIds: [],
  };
  db.orders.push(order);

  for (const [storeId, bucket] of byStore) {
    const rate = getCommissionRateForStore(bucket.store);
    const commissionCents = Math.round(bucket.subtotalCents * rate);
    const payoutCents = bucket.subtotalCents - commissionCents;
    const sellerOrder = {
      id: uuid(), orderId: order.id, storeId, status: 'AWAITING_PAYMENT',
      items: bucket.items.map((i) => ({ productId: i.product.id, title: i.product.title, priceCents: i.product.priceCents, qty: i.qty })),
      subtotalCents: bucket.subtotalCents, commissionCents, payoutCents, transferId: null, createdAt: now,
    };
    db.sellerOrders.push(sellerOrder);
    order.sellerOrderIds.push(sellerOrder.id);
    for (const i of bucket.items) {
      const product = getProductById(i.product.id);
      product.stock = Math.max(0, product.stock - i.qty);
    }
  }
  persist();

  try {
    const pi = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: { orderId: order.id, buyerUserId: req.user.id },
    });
    order.paymentIntentId = pi.id;
    persist();
    res.json({ clientSecret: pi.client_secret, orderId: order.id });
  } catch (e) {
    console.error('Stripe PaymentIntent creation failed', e);
    res.status(500).json({ error: 'Could not initialize payment.' });
  }
}));

app.post('/api/checkout/shipping', requireAuth, express.json(), ah(async (req, res) => {
  const { orderId, shippingAddress } = req.body;
  const order = db.orders.find((o) => o.id === orderId && o.buyerUserId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.shippingAddress = String(shippingAddress || '').slice(0, 500);
  persist();
  res.json({ ok: true });
}));

app.get('/checkout/complete', requireAuth, ah(async (req, res) => {
  const order = db.orders.find((o) => o.id === req.query.order && o.buyerUserId === req.user.id);
  if (!order) throw new HttpError(404, 'Order not found');
  const body = `
    <div class="card" style="max-width:500px;margin:0 auto;text-align:center;">
      <h1>Thank you!</h1>
      <p>Your order is ${order.status === 'PAID' ? 'confirmed' : 'being processed'}. Status: ${badge(order.status)}</p>
      <a href="/dashboard" class="btn btn-primary">View my orders</a>
    </div>
  `;
  renderPage(req, res, { title: 'Order confirmation', body });
}));

// ---- stripe webhook handler --------------------------------------------------

async function stripeWebhookHandler(req, res) {
  if (!stripe) return res.status(503).send('Stripe not configured');
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      console.warn('[tiny-tycoons] STRIPE_WEBHOOK_SECRET not set — skipping signature verification (dev only).');
      event = JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const order = db.orders.find((o) => o.paymentIntentId === pi.id);
    if (order && order.status !== 'PAID') {
      order.status = 'PAID';
      for (const soId of order.sellerOrderIds) {
        const sellerOrder = db.sellerOrders.find((s) => s.id === soId);
        sellerOrder.status = 'AWAITING_FULFILLMENT';
        const store = getStoreById(sellerOrder.storeId);
        if (store && store.stripeAccountId) {
          try {
            const transfer = await stripe.transfers.create({
              amount: sellerOrder.payoutCents, currency: 'gbp', destination: store.stripeAccountId, transfer_group: order.id,
            });
            sellerOrder.transferId = transfer.id;
          } catch (e) {
            console.error('Transfer creation failed for seller order', sellerOrder.id, e.message);
          }
        }
      }
      db.carts[order.buyerUserId] = [];
      persist();
    }
  } else if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const order = db.orders.find((o) => o.paymentIntentId === pi.id);
    if (order && order.status === 'PENDING_PAYMENT') {
      order.status = 'FAILED';
      for (const soId of order.sellerOrderIds) {
        const sellerOrder = db.sellerOrders.find((s) => s.id === soId);
        sellerOrder.status = 'CANCELLED';
        for (const item of sellerOrder.items) {
          const product = getProductById(item.productId);
          if (product) product.stock += item.qty;
        }
      }
      persist();
    }
  }
  res.json({ received: true });
}

// ============================================================================
// CUSTOMER DASHBOARD
// ============================================================================

app.get('/dashboard', requireAuth, ah(async (req, res) => {
  const orders = db.orders.filter((o) => o.buyerUserId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const orderBlocks = orders
    .map((o) => {
      const sellerOrders = o.sellerOrderIds.map((id) => db.sellerOrders.find((s) => s.id === id));
      return `<div class="card">
        <p><strong>Order</strong> · ${new Date(o.createdAt).toLocaleString('en-GB')} · ${badge(o.status)} · Total £${money(o.totalCents)}</p>
        ${sellerOrders
          .map((so) => {
            const store = getStoreById(so.storeId);
            return `<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px;">
              <p><strong>${h(store.name)}</strong> ${badge(so.status)}</p>
              ${so.items.map((i) => `<p class="hint">${h(i.title)} × ${i.qty} — £${money(i.priceCents * i.qty)}</p>`).join('')}
              ${
                ['AWAITING_FULFILLMENT', 'SHIPPED', 'COMPLETED'].includes(so.status)
                  ? `<form method="post" action="/dashboard/returns/new">
                      <input type="hidden" name="sellerOrderId" value="${h(so.id)}">
                      <input type="text" name="reason" placeholder="Reason for return" required maxlength="300" style="width:auto;display:inline-block;margin-right:6px;">
                      <button type="submit" class="btn btn-secondary btn-small">Request return</button>
                    </form>`
                  : ''
              }
            </div>`;
          })
          .join('')}
      </div>`;
    })
    .join('');
  const body = `
    <div class="dashboard-layout">
      ${customerSidebar('/dashboard')}
      <div class="dashboard-content">
        <h1>My orders</h1>
        ${orders.length === 0 ? `<div class="empty-state">No orders yet. <a href="/products">Start shopping</a></div>` : orderBlocks}
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'My orders', body });
}));

app.post('/dashboard/returns/new', requireAuth, ah(async (req, res) => {
  const { sellerOrderId, reason } = req.body;
  const sellerOrder = db.sellerOrders.find((s) => s.id === sellerOrderId);
  const order = sellerOrder && db.orders.find((o) => o.id === sellerOrder.orderId && o.buyerUserId === req.user.id);
  if (!sellerOrder || !order) throw new HttpError(404, 'Order not found');
  db.returns.push({ id: uuid(), sellerOrderId, reason: String(reason || '').slice(0, 300), status: 'REQUESTED', createdAt: new Date().toISOString() });
  persist();
  res.redirect(flashUrl('/dashboard', 'success', 'Return request submitted.'));
}));

// ============================================================================
// MESSAGING
// ============================================================================

app.get('/messages', requireAuth, ah(async (req, res) => {
  const myStore = getManagedStoreForUser(req.user.id);
  const convos = db.conversations
    .filter((c) => c.buyerUserId === req.user.id || (myStore && c.storeId === myStore.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = convos
    .map((c) => {
      const store = getStoreById(c.storeId);
      const other = c.buyerUserId === req.user.id ? store.name : getUserById(c.buyerUserId)?.name || 'Buyer';
      return `<tr><td><a href="/messages/${h(c.id)}">${h(c.subject)}</a></td><td>${h(other)}</td><td>${new Date(c.createdAt).toLocaleDateString('en-GB')}</td></tr>`;
    })
    .join('');
  const body = `
    <h1>Messages</h1>
    <table><thead><tr><th>Subject</th><th>With</th><th>Started</th></tr></thead><tbody>${rows || `<tr><td colspan="3">No conversations yet.</td></tr>`}</tbody></table>
  `;
  renderPage(req, res, { title: 'Messages', body });
}));

app.get('/messages/new', requireAuth, ah(async (req, res) => {
  const store = getStoreBySlug(String(req.query.store || ''));
  if (!store) throw new HttpError(404, 'Store not found');
  const body = authFormLayout('New message', `
    <h1>Contact ${h(store.name)}</h1>
    <p class="hint">For safety, please don't share contact details (email/phone) — all in-app communication is monitored.</p>
    <form method="post" action="/messages/new">
      <input type="hidden" name="storeId" value="${h(store.id)}">
      <div class="form-group"><label>Subject</label><input type="text" name="subject" required maxlength="120"></div>
      <div class="form-group"><label>Message</label><textarea name="body" required maxlength="1000"></textarea></div>
      <button type="submit" class="btn btn-primary">Send</button>
    </form>
  `);
  renderPage(req, res, { title: 'New message', body });
}));

app.post('/messages/new', requireAuth, ah(async (req, res) => {
  const { storeId, subject, body: text } = req.body;
  const store = getStoreById(storeId);
  if (!store || !subject || !text) throw new HttpError(400, 'Missing fields');
  const now = new Date().toISOString();
  const convo = { id: uuid(), buyerUserId: req.user.id, storeId, subject: String(subject).slice(0, 120), createdAt: now };
  db.conversations.push(convo);
  db.messages.push({ id: uuid(), conversationId: convo.id, senderUserId: req.user.id, body: String(text).slice(0, 1000), isFlagged: containsContactDetails(text), createdAt: now });
  persist();
  res.redirect(`/messages/${convo.id}`);
}));

function canAccessConversation(req, convo) {
  if (!convo) return false;
  if (convo.buyerUserId === req.user.id) return true;
  const myStore = getManagedStoreForUser(req.user.id);
  return !!myStore && myStore.id === convo.storeId;
}

app.get('/messages/:id', requireAuth, ah(async (req, res) => {
  const convo = db.conversations.find((c) => c.id === req.params.id);
  if (!canAccessConversation(req, convo)) throw new HttpError(404, 'Conversation not found');
  const msgs = db.messages.filter((m) => m.conversationId === convo.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const store = getStoreById(convo.storeId);
  const bubbles = msgs
    .map((m) => {
      const sender = getUserById(m.senderUserId);
      const mine = m.senderUserId === req.user.id;
      return `<div class="msg-bubble ${mine ? 'mine' : ''}">
        <div class="msg-meta">${h(sender ? sender.name : 'Unknown')} · ${new Date(m.createdAt).toLocaleString('en-GB')} ${m.isFlagged ? '<span class="msg-flag">⚠ flagged for review</span>' : ''}</div>
        ${h(m.body)}
      </div>`;
    })
    .join('');
  const body = `
    <h1>${h(convo.subject)}</h1>
    <p class="hint">Conversation with ${h(store.name)}</p>
    <div class="msg-thread">${bubbles}</div>
    <form method="post" action="/messages/${h(convo.id)}/reply">
      <div class="form-group"><textarea name="body" required maxlength="1000" placeholder="Write a reply..."></textarea></div>
      <button type="submit" class="btn btn-primary">Reply</button>
    </form>
  `;
  renderPage(req, res, { title: convo.subject, body });
}));

app.post('/messages/:id/reply', requireAuth, ah(async (req, res) => {
  const convo = db.conversations.find((c) => c.id === req.params.id);
  if (!canAccessConversation(req, convo)) throw new HttpError(404, 'Conversation not found');
  const text = req.body.body;
  if (!text) throw new HttpError(400, 'Message body required');
  db.messages.push({
    id: uuid(), conversationId: convo.id, senderUserId: req.user.id,
    body: String(text).slice(0, 1000), isFlagged: containsContactDetails(text), createdAt: new Date().toISOString(),
  });
  persist();
  res.redirect(`/messages/${convo.id}`);
}));

// ============================================================================
// SELLER DASHBOARD
// ============================================================================

const sellerRouter = express.Router();
sellerRouter.use(requireAuth, requireStore);

sellerRouter.get('/', ah(async (req, res) => {
  const store = req.store;
  const products = db.products.filter((p) => p.storeId === store.id);
  const sellerOrders = db.sellerOrders.filter((s) => s.storeId === store.id);
  const pendingOrders = sellerOrders.filter((s) => s.status === 'AWAITING_FULFILLMENT').length;
  const lifetimeRevenue = sellerOrders.filter((s) => ['AWAITING_FULFILLMENT', 'SHIPPED', 'COMPLETED'].includes(s.status)).reduce((sum, s) => sum + s.payoutCents, 0);
  const banner =
    store.status === 'PENDING'
      ? `<div class="alert-banner">Your store is pending admin approval. You can prepare products, but your store won't be publicly visible until approved.</div>`
      : store.status === 'REJECTED'
      ? `<div class="alert-banner">Your store application was rejected. Contact the platform admin for details.</div>`
      : store.status === 'SUSPENDED'
      ? `<div class="alert-banner">Your store has been suspended by an admin.</div>`
      : '';
  const body = `
    <div class="dashboard-layout">
      ${sellerSidebar(req, '/dashboard/seller')}
      <div class="dashboard-content">
        <h1>${h(store.name)} ${badge(store.status)}</h1>
        ${banner}
        <div class="stat-grid">
          <div class="stat-box"><div class="num">${products.length}</div><div class="label">Products</div></div>
          <div class="stat-box"><div class="num">${pendingOrders}</div><div class="label">Orders to fulfil</div></div>
          <div class="stat-box"><div class="num">£${money(lifetimeRevenue)}</div><div class="label">Lifetime payout</div></div>
        </div>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Seller dashboard', body });
}));

sellerRouter.get('/products', ah(async (req, res) => {
  const products = db.products.filter((p) => p.storeId === req.store.id);
  const rows = products
    .map(
      (p) => `<tr>
        <td>${h(p.title)}</td><td>£${money(p.priceCents)}</td><td>${p.stock}</td><td>${badge(p.status)}</td>
        <td>
          <a href="/dashboard/seller/products/${h(p.id)}/edit">Edit</a>
          ${p.status === 'DRAFT' ? ` · <form class="inline-form" method="post" action="/dashboard/seller/products/${h(p.id)}/submit"><button type="submit" class="link-btn">Submit for review</button></form> · <form class="inline-form" method="post" action="/dashboard/seller/products/${h(p.id)}/delete"><button type="submit" class="link-btn">Delete</button></form>` : ''}
        </td>
      </tr>`
    )
    .join('');
  const body = `
    <div class="dashboard-layout">
      ${sellerSidebar(req, '/dashboard/seller/products')}
      <div class="dashboard-content">
        <h1>Products</h1>
        <p><a href="/dashboard/seller/products/new" class="btn btn-primary btn-small">+ New product</a></p>
        <table><thead><tr><th>Title</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5">No products yet.</td></tr>`}</tbody></table>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Products', body });
}));

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, PRODUCT_IMAGES_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeBase = slugify(path.basename(file.originalname, ext)).slice(0, 30) || 'image';
    const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    cb(null, `${unique}-${safeBase}${ext}`);
  },
});

const uploadProductImage = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image type. Please upload a JPG, PNG, WebP, or GIF image.'));
    }
  },
});

function handleProductImageUpload(req, res, next) {
  uploadProductImage.single('imageFile')(req, res, (err) => {
    if (err) {
      const msg =
        err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? 'Uploaded image must be under 5MB.'
          : (err.message || 'Image upload failed.');
      const redirectTarget = req.params && req.params.id
        ? `/dashboard/seller/products/${req.params.id}/edit`
        : '/dashboard/seller/products/new';
      return res.redirect(flashUrl(redirectTarget, 'error', msg));
    }
    next();
  });
}

function productFormFields(p) {
  const categoryOptions = db.categories.map((c) => `<option value="${h(c.id)}" ${p && p.categoryId === c.id ? 'selected' : ''}>${h(c.name)}</option>`).join('');
  const currentImage = p && p.images && p.images[0] ? p.images[0] : null;
  return `
    <div class="form-group"><label>Title</label><input type="text" name="title" required maxlength="120" value="${p ? h(p.title) : ''}"></div>
    <div class="form-group"><label>Description</label><textarea name="description" required maxlength="1000">${p ? h(p.description) : ''}</textarea></div>
    <div class="form-group"><label>Price (£)</label><input type="number" name="price" step="0.01" min="0.01" required value="${p ? (p.priceCents / 100).toFixed(2) : ''}"></div>
    <div class="form-group"><label>Stock</label><input type="number" name="stock" min="0" required value="${p ? p.stock : ''}"></div>
    <div class="form-group"><label>Category</label><select name="categoryId" required><option value="">Select...</option>${categoryOptions}</select></div>
    ${
      currentImage
        ? `<div class="form-group">
            <label>Current image</label>
            <div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
              <img src="${h(currentImage)}" alt="Current product image" style="width:72px;height:72px;border-radius:10px;object-fit:cover;border:1px solid var(--border);">
              <span class="hint">${h(currentImage)}</span>
            </div>
          </div>`
        : ''
    }
    <div class="form-group">
      <label>Upload image from computer</label>
      <input type="file" name="imageFile" accept="image/png,image/jpeg,image/webp,image/gif">
      <p class="hint">Supports JPG, PNG, WebP, GIF up to 5MB.</p>
    </div>
    <div class="form-group">
      <label>Or image URL <span class="hint">(optional)</span></label>
      <input type="text" name="imageUrl" placeholder="https://... or /product_images/..." value="${p && p.images[0] ? h(p.images[0]) : ''}">
    </div>
  `;
}

sellerRouter.get('/products/new', ah(async (req, res) => {
  const body = authFormLayout('New product', `<h1>New product</h1><form method="post" action="/dashboard/seller/products/new" enctype="multipart/form-data">${productFormFields(null)}<button type="submit" class="btn btn-primary">Create (draft)</button></form>`);
  renderPage(req, res, { title: 'New product', body });
}));

sellerRouter.post('/products/new', handleProductImageUpload, ah(async (req, res) => {
  const { title, description, price, stock, categoryId, imageUrl } = req.body;
  const priceCents = Math.round(parseFloat(price) * 100);
  const stockNum = parseInt(stock, 10);
  if (!title || !description || isNaN(priceCents) || priceCents <= 0 || isNaN(stockNum) || stockNum < 0 || !getCategoryById(categoryId)) {
    return res.redirect(flashUrl('/dashboard/seller/products/new', 'error', 'Please fill in all fields with valid values.'));
  }
  let finalImage = null;
  if (req.file) {
    finalImage = `/product_images/${req.file.filename}`;
  } else if (imageUrl && imageUrl.trim()) {
    finalImage = imageUrl.trim();
  }
  const slug = uniqueSlug(slugify(title), db.products.map((p) => p.slug));
  db.products.push({
    id: uuid(), storeId: req.store.id, title, slug, description, priceCents, stock: stockNum, categoryId,
    images: finalImage ? [finalImage] : [], status: 'DRAFT', createdAt: new Date().toISOString(),
  });
  persist();
  res.redirect(flashUrl('/dashboard/seller/products', 'success', 'Product created as a draft.'));
}));

sellerRouter.get('/products/:id/edit', ah(async (req, res) => {
  const p = getProductById(req.params.id);
  if (!p || p.storeId !== req.store.id) throw new HttpError(404, 'Product not found');
  const body = authFormLayout('Edit product', `<h1>Edit product</h1><form method="post" action="/dashboard/seller/products/${h(p.id)}/edit" enctype="multipart/form-data">${productFormFields(p)}<button type="submit" class="btn btn-primary">Save</button></form>`);
  renderPage(req, res, { title: 'Edit product', body });
}));

sellerRouter.post('/products/:id/edit', handleProductImageUpload, ah(async (req, res) => {
  const p = getProductById(req.params.id);
  if (!p || p.storeId !== req.store.id) throw new HttpError(404, 'Product not found');
  const { title, description, price, stock, categoryId, imageUrl } = req.body;
  const priceCents = Math.round(parseFloat(price) * 100);
  const stockNum = parseInt(stock, 10);
  if (!title || !description || isNaN(priceCents) || priceCents <= 0 || isNaN(stockNum) || stockNum < 0 || !getCategoryById(categoryId)) {
    return res.redirect(flashUrl(`/dashboard/seller/products/${p.id}/edit`, 'error', 'Please fill in all fields with valid values.'));
  }
  let finalImage = p.images && p.images[0] ? p.images[0] : null;
  if (req.file) {
    finalImage = `/product_images/${req.file.filename}`;
  } else if (imageUrl !== undefined && imageUrl.trim()) {
    finalImage = imageUrl.trim();
  }
  Object.assign(p, { title, description, priceCents, stock: stockNum, categoryId, images: finalImage ? [finalImage] : [] });
  persist();
  res.redirect(flashUrl('/dashboard/seller/products', 'success', 'Product updated.'));
}));

sellerRouter.post('/products/:id/submit', ah(async (req, res) => {
  const p = getProductById(req.params.id);
  if (!p || p.storeId !== req.store.id) throw new HttpError(404, 'Product not found');
  if (req.store.status !== 'APPROVED') {
    return res.redirect(flashUrl('/dashboard/seller/products', 'error', 'Your store must be approved before submitting products for review.'));
  }
  if (p.status !== 'DRAFT') return res.redirect(flashUrl('/dashboard/seller/products', 'error', 'Only draft products can be submitted.'));
  p.status = 'PENDING_REVIEW';
  persist();
  res.redirect(flashUrl('/dashboard/seller/products', 'success', 'Product submitted for review.'));
}));

sellerRouter.post('/products/:id/delete', ah(async (req, res) => {
  const p = getProductById(req.params.id);
  if (!p || p.storeId !== req.store.id) throw new HttpError(404, 'Product not found');
  if (p.status !== 'DRAFT') return res.redirect(flashUrl('/dashboard/seller/products', 'error', 'Only draft products can be deleted.'));
  db.products = db.products.filter((x) => x.id !== p.id);
  persist();
  res.redirect(flashUrl('/dashboard/seller/products', 'success', 'Product deleted.'));
}));

sellerRouter.get('/orders', ah(async (req, res) => {
  const sellerOrders = db.sellerOrders.filter((s) => s.storeId === req.store.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = sellerOrders
    .map((so) => {
      const order = db.orders.find((o) => o.id === so.orderId);
      const buyer = getUserById(order.buyerUserId);
      return `<tr>
        <td>${new Date(so.createdAt).toLocaleDateString('en-GB')}</td>
        <td>${h(buyer ? buyer.name : 'Buyer')}</td>
        <td>${so.items.map((i) => `${h(i.title)} ×${i.qty}`).join(', ')}</td>
        <td>£${money(so.payoutCents)}</td>
        <td>${badge(so.status)}</td>
        <td>
          ${so.status === 'AWAITING_FULFILLMENT' ? `<form class="inline-form" method="post" action="/dashboard/seller/orders/${h(so.id)}/ship"><button type="submit" class="link-btn">Mark shipped</button></form>` : ''}
          ${so.status === 'SHIPPED' ? `<form class="inline-form" method="post" action="/dashboard/seller/orders/${h(so.id)}/complete"><button type="submit" class="link-btn">Mark completed</button></form>` : ''}
        </td>
      </tr>`;
    })
    .join('');
  const body = `
    <div class="dashboard-layout">
      ${sellerSidebar(req, '/dashboard/seller/orders')}
      <div class="dashboard-content">
        <h1>Orders</h1>
        <table><thead><tr><th>Date</th><th>Buyer</th><th>Items</th><th>Payout</th><th>Status</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">No orders yet.</td></tr>`}</tbody></table>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Orders', body });
}));

sellerRouter.post('/orders/:id/ship', ah(async (req, res) => {
  const so = db.sellerOrders.find((s) => s.id === req.params.id && s.storeId === req.store.id);
  if (!so) throw new HttpError(404, 'Order not found');
  so.status = 'SHIPPED';
  persist();
  res.redirect(flashUrl('/dashboard/seller/orders', 'success', 'Order marked as shipped.'));
}));

sellerRouter.post('/orders/:id/complete', ah(async (req, res) => {
  const so = db.sellerOrders.find((s) => s.id === req.params.id && s.storeId === req.store.id);
  if (!so) throw new HttpError(404, 'Order not found');
  so.status = 'COMPLETED';
  persist();
  res.redirect(flashUrl('/dashboard/seller/orders', 'success', 'Order marked as completed.'));
}));

sellerRouter.get('/returns', ah(async (req, res) => {
  const myReturns = db.returns.filter((r) => {
    const so = db.sellerOrders.find((s) => s.id === r.sellerOrderId);
    return so && so.storeId === req.store.id;
  });
  const rows = myReturns
    .map((r) => {
      const so = db.sellerOrders.find((s) => s.id === r.sellerOrderId);
      return `<tr>
        <td>${new Date(r.createdAt).toLocaleDateString('en-GB')}</td>
        <td>${h(r.reason)}</td>
        <td>£${money(so.subtotalCents)}</td>
        <td>${badge(r.status)}</td>
        <td>
          ${r.status === 'REQUESTED' ? `
            <form class="inline-form" method="post" action="/dashboard/seller/returns/${h(r.id)}/approve"><button type="submit" class="link-btn">Approve &amp; refund</button></form> ·
            <form class="inline-form" method="post" action="/dashboard/seller/returns/${h(r.id)}/reject"><button type="submit" class="link-btn">Reject</button></form>` : ''}
        </td>
      </tr>`;
    })
    .join('');
  const body = `
    <div class="dashboard-layout">
      ${sellerSidebar(req, '/dashboard/seller/returns')}
      <div class="dashboard-content">
        <h1>Returns</h1>
        <table><thead><tr><th>Date</th><th>Reason</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5">No return requests.</td></tr>`}</tbody></table>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Returns', body });
}));

sellerRouter.post('/returns/:id/approve', ah(async (req, res) => {
  const ret = db.returns.find((r) => r.id === req.params.id);
  const so = ret && db.sellerOrders.find((s) => s.id === ret.sellerOrderId && s.storeId === req.store.id);
  if (!ret || !so) throw new HttpError(404, 'Return not found');
  const order = db.orders.find((o) => o.id === so.orderId);
  if (stripe && order.paymentIntentId) {
    try {
      await stripe.refunds.create({ payment_intent: order.paymentIntentId, amount: so.subtotalCents });
      if (so.transferId) {
        await stripe.transfers.createReversal(so.transferId, { amount: so.payoutCents });
      }
    } catch (e) {
      console.error('Refund failed', e.message);
      return res.redirect(flashUrl('/dashboard/seller/returns', 'error', 'Refund failed: ' + e.message));
    }
  }
  ret.status = 'REFUNDED';
  so.status = 'CANCELLED';
  persist();
  res.redirect(flashUrl('/dashboard/seller/returns', 'success', 'Return approved and refunded.'));
}));

sellerRouter.post('/returns/:id/reject', ah(async (req, res) => {
  const ret = db.returns.find((r) => r.id === req.params.id);
  const so = ret && db.sellerOrders.find((s) => s.id === ret.sellerOrderId && s.storeId === req.store.id);
  if (!ret || !so) throw new HttpError(404, 'Return not found');
  ret.status = 'REJECTED';
  persist();
  res.redirect(flashUrl('/dashboard/seller/returns', 'success', 'Return request rejected.'));
}));

sellerRouter.get('/store', ah(async (req, res) => {
  const store = req.store;
  const body = `
    <div class="dashboard-layout">
      ${sellerSidebar(req, '/dashboard/seller/store')}
      <div class="dashboard-content">
        <h1>Store settings</h1>
        <div class="card">
          <form method="post" action="/dashboard/seller/store">
            <div class="form-group"><label>Store name</label><input type="text" name="name" required maxlength="80" value="${h(store.name)}"></div>
            <div class="form-group"><label>Description</label><textarea name="description" maxlength="500">${h(store.description)}</textarea></div>
            <button type="submit" class="btn btn-primary">Save</button>
          </form>
        </div>
        <div class="card">
          <h3>Payouts</h3>
          ${
            store.stripeAccountId
              ? `<p class="hint">Stripe Connect account linked (${h(store.stripeAccountId)}). Payouts will be sent automatically after each sale.</p>`
              : `<p class="hint">Connect a Stripe account to receive payouts from sales.</p><a href="/dashboard/seller/store/connect" class="btn btn-secondary">Connect payouts with Stripe</a>`
          }
        </div>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Store settings', body });
}));

sellerRouter.post('/store', ah(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.redirect(flashUrl('/dashboard/seller/store', 'error', 'Store name is required.'));
  req.store.name = name;
  req.store.description = description || '';
  persist();
  res.redirect(flashUrl('/dashboard/seller/store', 'success', 'Store settings saved.'));
}));

sellerRouter.get('/store/connect', ah(async (req, res) => {
  if (!stripe) return res.redirect(flashUrl('/dashboard/seller/store', 'error', 'Payments are not configured on this server.'));
  const store = req.store;
  if (!store.stripeAccountId) {
    const account = await stripe.accounts.create({
      type: 'express', country: 'GB', email: req.user.email,
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    });
    store.stripeAccountId = account.id;
    persist();
  }
  const baseUrl = getBaseUrl(req);
  const accountLink = await stripe.accountLinks.create({
    account: store.stripeAccountId,
    refresh_url: `${baseUrl}/stripe/connect/refresh`,
    return_url: `${baseUrl}/stripe/connect/return`,
    type: 'account_onboarding',
  });
  res.redirect(accountLink.url);
}));

app.use('/dashboard/seller', sellerRouter);

app.get('/stripe/connect/return', requireAuth, requireStore, (req, res) => {
  res.redirect(flashUrl('/dashboard/seller/store', 'success', 'Stripe onboarding complete.'));
});
app.get('/stripe/connect/refresh', requireAuth, requireStore, (req, res) => {
  res.redirect('/dashboard/seller/store/connect');
});

// ============================================================================
// ADMIN DASHBOARD
// ============================================================================

const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/', ah(async (req, res) => {
  const totalUsers = db.users.length;
  const storesByStatus = db.stores.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  const totalOrders = db.orders.filter((o) => o.status === 'PAID').length;
  const totalRevenue = db.orders.filter((o) => o.status === 'PAID').reduce((sum, o) => sum + o.totalCents, 0);
  const totalCommission = db.sellerOrders.reduce((sum, s) => sum + (s.status !== 'CANCELLED' ? s.commissionCents : 0), 0);
  const body = `
    <div class="dashboard-layout">
      ${adminSidebar('/dashboard/admin')}
      <div class="dashboard-content">
        <h1>Admin overview</h1>
        <div class="stat-grid">
          <div class="stat-box"><div class="num">${totalUsers}</div><div class="label">Users</div></div>
          <div class="stat-box"><div class="num">${storesByStatus.PENDING || 0}</div><div class="label">Stores pending approval</div></div>
          <div class="stat-box"><div class="num">${totalOrders}</div><div class="label">Paid orders</div></div>
          <div class="stat-box"><div class="num">£${money(totalRevenue)}</div><div class="label">Gross revenue</div></div>
          <div class="stat-box"><div class="num">£${money(totalCommission)}</div><div class="label">Platform commission</div></div>
        </div>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Admin overview', body });
}));

adminRouter.get('/stores', ah(async (req, res) => {
  const rows = db.stores
    .map((s) => {
      const owner = getUserById(s.ownerUserId);
      return `<tr>
        <td><a href="/stores/${h(s.slug)}">${h(s.name)}</a></td>
        <td>${s.type}</td>
        <td>${h(owner ? owner.name : '')}</td>
        <td>${badge(s.status)}</td>
        <td>
          ${s.status !== 'APPROVED' ? `<form class="inline-form" method="post" action="/dashboard/admin/stores/${h(s.id)}/approve"><button type="submit" class="link-btn">Approve</button></form> · ` : ''}
          ${s.status !== 'REJECTED' ? `<form class="inline-form" method="post" action="/dashboard/admin/stores/${h(s.id)}/reject"><button type="submit" class="link-btn">Reject</button></form> · ` : ''}
          ${s.status !== 'SUSPENDED' ? `<form class="inline-form" method="post" action="/dashboard/admin/stores/${h(s.id)}/suspend"><button type="submit" class="link-btn">Suspend</button></form>` : ''}
        </td>
      </tr>`;
    })
    .join('');
  const body = `
    <div class="dashboard-layout">
      ${adminSidebar('/dashboard/admin/stores')}
      <div class="dashboard-content">
        <h1>Stores</h1>
        <table><thead><tr><th>Name</th><th>Type</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Stores', body });
}));

for (const action of ['approve', 'reject', 'suspend']) {
  adminRouter.post(`/stores/:id/${action}`, ah(async (req, res) => {
    const store = getStoreById(req.params.id);
    if (!store) throw new HttpError(404, 'Store not found');
    store.status = action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'SUSPENDED';
    persist();
    res.redirect(flashUrl('/dashboard/admin/stores', 'success', `Store ${action}d.`));
  }));
}

adminRouter.get('/products', ah(async (req, res) => {
  const pending = db.products.filter((p) => p.status === 'PENDING_REVIEW');
  const rows = pending
    .map((p) => {
      const store = getStoreById(p.storeId);
      return `<tr>
        <td>${h(p.title)}</td><td>${h(store.name)}</td><td>£${money(p.priceCents)}</td>
        <td>
          <form class="inline-form" method="post" action="/dashboard/admin/products/${h(p.id)}/approve"><button type="submit" class="link-btn">Approve</button></form> ·
          <form class="inline-form" method="post" action="/dashboard/admin/products/${h(p.id)}/reject"><button type="submit" class="link-btn">Reject</button></form>
        </td>
      </tr>`;
    })
    .join('');
  const body = `
    <div class="dashboard-layout">
      ${adminSidebar('/dashboard/admin/products')}
      <div class="dashboard-content">
        <h1>Product moderation</h1>
        <table><thead><tr><th>Title</th><th>Store</th><th>Price</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="4">No products awaiting review.</td></tr>`}</tbody></table>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Product moderation', body });
}));

adminRouter.post('/products/:id/approve', ah(async (req, res) => {
  const p = getProductById(req.params.id);
  if (!p) throw new HttpError(404, 'Product not found');
  p.status = 'APPROVED';
  persist();
  res.redirect(flashUrl('/dashboard/admin/products', 'success', 'Product approved.'));
}));
adminRouter.post('/products/:id/reject', ah(async (req, res) => {
  const p = getProductById(req.params.id);
  if (!p) throw new HttpError(404, 'Product not found');
  p.status = 'REJECTED';
  persist();
  res.redirect(flashUrl('/dashboard/admin/products', 'success', 'Product rejected.'));
}));

adminRouter.get('/categories', ah(async (req, res) => {
  const rows = db.categories.map((c) => `<tr><td>${h(c.name)}</td><td><form class="inline-form" method="post" action="/dashboard/admin/categories/${h(c.id)}/delete"><button type="submit" class="link-btn">Delete</button></form></td></tr>`).join('');
  const body = `
    <div class="dashboard-layout">
      ${adminSidebar('/dashboard/admin/categories')}
      <div class="dashboard-content">
        <h1>Categories</h1>
        <table><thead><tr><th>Name</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div class="card" style="max-width:400px;margin-top:16px;">
          <form method="post" action="/dashboard/admin/categories">
            <div class="form-group"><label>New category name</label><input type="text" name="name" required maxlength="60"></div>
            <button type="submit" class="btn btn-primary">Add category</button>
          </form>
        </div>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Categories', body });
}));

adminRouter.post('/categories', ah(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.redirect(flashUrl('/dashboard/admin/categories', 'error', 'Category name is required.'));
  const slug = uniqueSlug(slugify(name), db.categories.map((c) => c.slug));
  db.categories.push({ id: uuid(), name, slug });
  persist();
  res.redirect(flashUrl('/dashboard/admin/categories', 'success', 'Category added.'));
}));

adminRouter.post('/categories/:id/delete', ah(async (req, res) => {
  db.categories = db.categories.filter((c) => c.id !== req.params.id);
  persist();
  res.redirect(flashUrl('/dashboard/admin/categories', 'success', 'Category deleted.'));
}));

adminRouter.get('/commission', ah(async (req, res) => {
  const rate = db.commissionConfig.rate;
  const body = `
    <div class="dashboard-layout">
      ${adminSidebar('/dashboard/admin/commission')}
      <div class="dashboard-content">
        <h1>Platform commission</h1>
        <div class="card" style="max-width:400px;">
          <form method="post" action="/dashboard/admin/commission">
            <div class="form-group"><label>Commission rate (%)</label><input type="number" name="ratePercent" min="0" max="50" step="1" value="${Math.round(rate * 100)}"></div>
            <button type="submit" class="btn btn-primary">Save rate</button>
          </form>
        </div>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Commission', body });
}));

adminRouter.post('/commission', ah(async (req, res) => {
  const pct = parseFloat(req.body.ratePercent);
  if (isNaN(pct) || pct < 0 || pct > 50) {
    return res.redirect(flashUrl('/dashboard/admin/commission', 'error', 'Please enter a rate between 0 and 50.'));
  }
  db.commissionConfig.rate = pct / 100;
  persist();
  res.redirect(flashUrl('/dashboard/admin/commission', 'success', 'Commission rate updated.'));
}));

app.use('/dashboard/admin', adminRouter);

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((req, res) => {
  res.status(404).send(layout(req, res, { title: 'Not found', body: `<div class="empty-state"><h1>404</h1><p>Page not found.</p><a href="/">Go home</a></div>` }));
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  const message = status < 500 ? err.message : 'An unexpected error occurred.';
  res.status(status).send(layout(req, res, { title: 'Error', body: `<div class="empty-state"><h1>${status}</h1><p>${h(message)}</p><a href="/">Go home</a></div>` }));
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`[tiny-tycoons] Server listening on http://localhost:${PORT}`);
});
