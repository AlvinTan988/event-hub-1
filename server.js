require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const mailer = require('./mailer');

const PORT = process.env.PORT || 3000;
// On Render, RENDER_EXTERNAL_URL is the service's public https address; set BASE_URL yourself for a custom domain.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CURRENCY = (process.env.CURRENCY || 'aud').toLowerCase();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const HOLD_MINUTES = 30; // unpaid checkout holds a spot this long
// Customers can cancel their own paid booking (with automatic refund) until this many hours before the event.
const REFUND_CUTOFF_HOURS = Number(process.env.REFUND_CUTOFF_HOURS ?? 24);

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const TEST_MODE = !stripe; // no Stripe key -> payments are simulated

// Refuse to run a public site with unsafe settings
if (IS_PROD) {
  const problems = [];
  if (JWT_SECRET === 'dev-secret-change-me' || JWT_SECRET.length < 32) problems.push('JWT_SECRET must be set to a random string of at least 32 characters.');
  if (!BASE_URL.startsWith('https://')) problems.push(`BASE_URL must be your public https address (currently "${BASE_URL}").`);
  if (problems.length) {
    console.error('\n❌ Cannot start in production:\n - ' + problems.join('\n - ') + '\n');
    process.exit(1);
  }
  if (!ADMIN_EMAILS.length) console.warn('⚠️  ADMIN_EMAILS is empty: in production nobody can be an admin. Set it to your email address.');
  if (TEST_MODE) console.warn('⚠️  Production without STRIPE_SECRET_KEY: bookings are confirmed WITHOUT payment!');
  else if (process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) console.warn('⚠️  Production is using a Stripe TEST key: no real money will be taken.');
  if (stripe && !process.env.STRIPE_WEBHOOK_SECRET) console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set: payments are only confirmed when the buyer returns to the site.');
}

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  early_bird_price_cents INTEGER,
  early_bird_deadline TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, user_id)
);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`);
// Lightweight migration for databases created before refunds existed
const bookingCols = db.prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
if (!bookingCols.includes('stripe_payment_intent')) db.exec('ALTER TABLE bookings ADD COLUMN stripe_payment_intent TEXT');
if (!bookingCols.includes('refunded_at')) db.exec('ALTER TABLE bookings ADD COLUMN refunded_at TEXT');

/* ---------- helpers ---------- */
function currentPrice(ev, now = new Date()) {
  const early = ev.early_bird_price_cents != null && ev.early_bird_deadline &&
    now < new Date(ev.early_bird_deadline);
  return {
    cents: early ? ev.early_bird_price_cents : ev.price_cents,
    isEarlyBird: !!early,
  };
}

function spotsTaken(eventId) {
  const cutoff = new Date(Date.now() - HOLD_MINUTES * 60000).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`
    SELECT COUNT(*) AS n FROM bookings
    WHERE event_id = ? AND (status = 'paid' OR (status = 'pending' AND created_at > ?))
  `).get(eventId, cutoff).n;
}

function publicEvent(ev, userId) {
  const price = currentPrice(ev);
  const taken = spotsTaken(ev.id);
  const out = {
    id: ev.id,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    starts_at: ev.starts_at,
    capacity: ev.capacity,
    spots_left: ev.capacity > 0 ? Math.max(0, ev.capacity - taken) : null,
    price_cents: ev.price_cents,
    early_bird_price_cents: ev.early_bird_price_cents,
    early_bird_deadline: ev.early_bird_deadline,
    current_price_cents: price.cents,
    is_early_bird: price.isEarlyBird,
    cancelled: !!ev.cancelled,
    past: new Date(ev.starts_at) < new Date(),
    currency: CURRENCY,
    refund_cutoff_hours: REFUND_CUTOFF_HOURS,
    can_cancel_for_refund: new Date() <= new Date(new Date(ev.starts_at).getTime() - REFUND_CUTOFF_HOURS * 3600000),
  };
  if (userId) {
    const b = db.prepare('SELECT status FROM bookings WHERE event_id = ? AND user_id = ?').get(ev.id, userId);
    out.my_booking = b ? b.status : null;
  }
  return out;
}

// Marks a booking paid and sends the confirmation email exactly once (only on the pending -> paid change).
function markPaid(bookingId, sessionId, paymentIntent) {
  const info = db.prepare(`UPDATE bookings SET status = 'paid',
      stripe_session_id = COALESCE(?, stripe_session_id),
      stripe_payment_intent = COALESCE(?, stripe_payment_intent)
    WHERE id = ? AND status != 'paid'`).run(sessionId || null, paymentIntent || null, bookingId);
  if (info.changes > 0) {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(b.user_id);
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(b.event_id);
    mailer.sendMail(mailer.bookingConfirmation({ user, event, amountCents: b.amount_cents, currency: CURRENCY }));
  }
}

// Refunds a paid booking: Stripe refund (if it was a real payment), status -> 'refunded', email the customer.
// Throws if Stripe refuses, in which case the booking stays 'paid'.
async function refundBooking(bookingId, reason) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b || b.status !== 'paid') throw new Error('Only paid bookings can be refunded.');

  if (b.amount_cents > 0 && stripe) {
    if (!b.stripe_payment_intent) throw new Error('No Stripe payment is recorded for this booking. Refund it from the Stripe dashboard.');
    await stripe.refunds.create(
      { payment_intent: b.stripe_payment_intent, metadata: { booking_id: String(b.id) } },
      { idempotencyKey: `refund-${b.id}-${b.stripe_payment_intent}` }
    );
  }
  db.prepare("UPDATE bookings SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?").run(b.id);

  const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(b.user_id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(b.event_id);
  mailer.sendMail(mailer.refundNotice({ user, event, amountCents: b.amount_cents, currency: CURRENCY, reason }));
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1); // behind the host's proxy, so req.ip is the real visitor address
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...(IS_PROD ? { 'Strict-Transport-Security': 'max-age=15552000' } : {}),
  });
  next();
});

app.get('/healthz', (_req, res) => {
  try { db.prepare('SELECT 1').get(); res.send('ok'); } catch (_) { res.status(500).send('db error'); }
});

// Simple in-memory rate limiter (fine for a single server instance)
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60000).unref();
function limit(name, max, windowMs, keyFn = req => req.ip) {
  return (req, res, next) => {
    const key = `${name}:${keyFn(req)}`;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}
const emailKey = req => String(req.body && req.body.email || '').trim().toLowerCase();

// Stripe webhook needs the raw body, so it is registered before express.json()
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(400);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    if (s.payment_status === 'paid' && s.metadata && s.metadata.booking_id) {
      markPaid(Number(s.metadata.booking_id), s.id, s.payment_intent);
    }
  }
  // Refund issued from the Stripe dashboard: keep our records in sync (no second refund attempted)
  if (event.type === 'charge.refunded') {
    const ch = event.data.object;
    if (ch.refunded && ch.payment_intent) {
      const b = db.prepare("SELECT * FROM bookings WHERE stripe_payment_intent = ? AND status = 'paid'").get(ch.payment_intent);
      if (b) {
        db.prepare("UPDATE bookings SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?").run(b.id);
        const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(b.user_id);
        const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(b.event_id);
        mailer.sendMail(mailer.refundNotice({ user, event: ev, amountCents: b.amount_cents, currency: CURRENCY }));
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, _res, next) {
  const token = req.cookies.token;
  if (token) {
    try {
      const { id } = jwt.verify(token, JWT_SECRET);
      req.user = db.prepare('SELECT id, name, email, is_admin FROM users WHERE id = ?').get(id);
      // Anyone listed in ADMIN_EMAILS is an admin, even if they signed up before being added to the list
      if (req.user && !req.user.is_admin && ADMIN_EMAILS.includes(req.user.email)) {
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(req.user.id);
        req.user.is_admin = 1;
      }
    } catch (_) { /* ignore bad token */ }
  }
  next();
}
app.use(auth);

const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please log in first.' });
const requireAdmin = (req, res, next) =>
  req.user && req.user.is_admin ? next() : res.status(403).json({ error: 'Admins only.' });

function setSession(res, user) {
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https'), maxAge: 30 * 24 * 3600 * 1000,
  });
}
const userOut = u => ({ id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin });

/* ---------- auth routes ---------- */
app.post('/api/register', limit('register', 10, 3600e3), (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter your name and a valid email.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'That email is already registered.' });
  }
  // Locally the first account becomes admin. On a live site only emails listed in ADMIN_EMAILS can be admins,
  // so a stranger can never claim admin by signing up first.
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const isAdmin = ADMIN_EMAILS.includes(email) || (!IS_PROD && isFirst) ? 1 : 0;
  const info = db.prepare('INSERT INTO users (name, email, password_hash, is_admin) VALUES (?,?,?,?)')
    .run(name, email, bcrypt.hashSync(password, 10), isAdmin);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  setSession(res, user);
  res.json({ user: userOut(user) });
});

app.post('/api/login', limit('login-ip', 30, 15 * 60e3), limit('login-email', 10, 15 * 60e3, emailKey), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  setSession(res, user);
  res.json({ user: userOut(user) });
});

app.post('/api/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

/* ---------- password reset ---------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const lastResetRequest = new Map(); // email -> timestamp, simple throttle: 1 email per minute per address

app.post('/api/forgot-password', limit('forgot', 10, 3600e3), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const last = lastResetRequest.get(email) || 0;
  if (user && Date.now() - last > 60000) {
    lastResetRequest.set(email, Date.now());
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)')
      .run(user.id, sha256(token), new Date(Date.now() + 3600 * 1000).toISOString());
    mailer.sendMail(mailer.passwordReset({ user, token }));
  }
  // Same answer whether or not the email exists, so this can't be used to find who has an account
  res.json({ ok: true });
});

app.post('/api/reset-password', limit('reset', 10, 15 * 60e3), (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(req.body.token || '')));
  if (!row || row.used || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), row.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  setSession(res, user);
  res.json({ user: userOut(user) });
});

const SITE_NAME = process.env.SITE_NAME || 'Courtside Social Club';
const SITE_TAGLINE = process.env.SITE_TAGLINE || 'Find and join social events near you. Book your spot, see who\'s coming, and meet the crew.';

app.get('/api/me', (req, res) => res.json({
  user: req.user ? userOut(req.user) : null, testMode: TEST_MODE, currency: CURRENCY,
  siteName: SITE_NAME, tagline: SITE_TAGLINE,
}));

/* ---------- events ---------- */
app.get('/api/events', (req, res) => {
  const rows = db.prepare('SELECT * FROM events WHERE cancelled = 0 ORDER BY starts_at ASC').all();
  const now = new Date();
  const list = rows.map(e => publicEvent(e, req.user && req.user.id))
    .filter(e => new Date(e.starts_at) > new Date(now.getTime() - 3 * 3600000));
  res.json({ events: list });
});

app.get('/api/events/:id', (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  const out = publicEvent(ev, req.user && req.user.id);
  // Attendee names are shown to logged-in users ("see who's playing")
  if (req.user) {
    out.attendees = db.prepare(`
      SELECT u.name FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.event_id = ? AND b.status = 'paid' ORDER BY b.id`).all(ev.id).map(r => r.name);
  }
  res.json({ event: out });
});

function parseEventBody(b) {
  const title = String(b.title || '').trim();
  const starts = new Date(b.starts_at);
  if (!title) throw new Error('Title is required.');
  if (isNaN(starts)) throw new Error('Start date/time is required.');
  const dollars = v => Math.round(Number(v) * 100);
  const price = dollars(b.price || 0);
  if (!(price >= 0)) throw new Error('Price must be 0 or more.');
  let eb = null, ebDeadline = null;
  if (b.early_bird_price !== '' && b.early_bird_price != null) {
    eb = dollars(b.early_bird_price);
    ebDeadline = new Date(b.early_bird_deadline);
    if (!(eb >= 0)) throw new Error('Early bird price must be 0 or more.');
    if (isNaN(ebDeadline)) throw new Error('Early bird deadline is required when an early bird price is set.');
    if (eb >= price) throw new Error('Early bird price should be lower than the regular price.');
    ebDeadline = ebDeadline.toISOString();
  }
  return {
    title,
    description: String(b.description || '').trim(),
    location: String(b.location || '').trim(),
    starts_at: starts.toISOString(),
    capacity: Math.max(0, parseInt(b.capacity, 10) || 0),
    price_cents: price,
    early_bird_price_cents: eb,
    early_bird_deadline: ebDeadline,
  };
}

app.post('/api/events', requireAdmin, (req, res) => {
  try {
    const e = parseEventBody(req.body);
    const info = db.prepare(`INSERT INTO events
      (title, description, location, starts_at, capacity, price_cents, early_bird_price_cents, early_bird_deadline)
      VALUES (@title,@description,@location,@starts_at,@capacity,@price_cents,@early_bird_price_cents,@early_bird_deadline)`).run(e);
    res.json({ id: info.lastInsertRowid });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/events/:id', requireAdmin, (req, res) => {
  try {
    const e = parseEventBody(req.body);
    db.prepare(`UPDATE events SET title=@title, description=@description, location=@location, starts_at=@starts_at,
      capacity=@capacity, price_cents=@price_cents, early_bird_price_cents=@early_bird_price_cents,
      early_bird_deadline=@early_bird_deadline WHERE id=@id`).run({ ...e, id: req.params.id });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Cancelling an event refunds every paid booking automatically and emails each attendee.
app.delete('/api/events/:id', requireAdmin, async (req, res) => {
  const paid = db.prepare("SELECT id FROM bookings WHERE event_id = ? AND status = 'paid'").all(req.params.id);
  let refunded = 0; const failed = [];
  for (const b of paid) {
    try { await refundBooking(b.id, 'the event has been cancelled'); refunded++; }
    catch (err) { failed.push(b.id); console.error(`Refund failed for booking ${b.id}:`, err.message); }
  }
  // Only hide the event once everyone is refunded; otherwise keep it so the admin can retry
  if (!failed.length) db.prepare('UPDATE events SET cancelled = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: failed.length === 0, refunded, failed: failed.length });
});

// Admin: attendee list
app.get('/api/events/:id/bookings', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, u.name, u.email, b.status, b.amount_cents, b.created_at
    FROM bookings b JOIN users u ON u.id = b.user_id
    WHERE b.event_id = ? AND b.status IN ('paid','pending','refunded') ORDER BY b.id`).all(req.params.id);
  res.json({ bookings: rows });
});

/* ---------- joining & paying ---------- */
app.post('/api/events/:id/join', requireUser, async (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND cancelled = 0').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (new Date(ev.starts_at) < new Date()) return res.status(400).json({ error: 'This event has already started.' });

  const existing = db.prepare('SELECT * FROM bookings WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id);
  if (existing && existing.status === 'paid') return res.status(400).json({ error: "You're already booked in." });

  // Capacity check (ignoring this user's own pending hold)
  if (ev.capacity > 0) {
    const taken = spotsTaken(ev.id) - (existing && existing.status === 'pending' ? 1 : 0);
    if (taken >= ev.capacity) return res.status(400).json({ error: 'Sorry, this event is full.' });
  }

  const price = currentPrice(ev).cents; // always computed server-side
  let booking = existing;
  if (booking) {
    db.prepare(`UPDATE bookings SET status='pending', amount_cents=?, stripe_payment_intent=NULL, refunded_at=NULL,
      created_at=datetime('now') WHERE id=?`).run(price, booking.id);
  } else {
    const info = db.prepare('INSERT INTO bookings (event_id, user_id, status, amount_cents) VALUES (?,?,?,?)')
      .run(ev.id, req.user.id, 'pending', price);
    booking = { id: info.lastInsertRowid };
  }

  // Free events, or test mode (no Stripe key): confirm straight away
  if (price === 0 || TEST_MODE) {
    markPaid(booking.id, null);
    return res.json({ paid: true, testMode: TEST_MODE && price > 0 });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: price,
          product_data: { name: ev.title, description: new Date(ev.starts_at).toUTCString() },
        },
      }],
      metadata: { booking_id: String(booking.id) },
      success_url: `${BASE_URL}/?booking=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?event=${ev.id}`,
      expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60,
    });
    db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(session.id, booking.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(502).json({ error: 'Could not start payment. Please try again.' });
  }
});

// Called when the user returns from Stripe; verifies payment even if the webhook is slow
app.post('/api/bookings/:id/confirm', requireUser, async (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (b.status === 'paid') return res.json({ status: 'paid', event_id: b.event_id });
  if (stripe && b.stripe_session_id) {
    try {
      const s = await stripe.checkout.sessions.retrieve(b.stripe_session_id);
      if (s.payment_status === 'paid') markPaid(b.id, s.id, s.payment_intent);
    } catch (err) { console.error('Stripe retrieve error:', err.message); }
  }
  const fresh = db.prepare('SELECT status, event_id FROM bookings WHERE id = ?').get(b.id);
  res.json({ status: fresh.status, event_id: fresh.event_id });
});

const refundDeadline = ev => new Date(new Date(ev.starts_at).getTime() - REFUND_CUTOFF_HOURS * 3600000);

// Release an unpaid hold, or cancel a paid booking for an automatic refund (before the cutoff).
app.post('/api/events/:id/cancel-booking', requireUser, async (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE event_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!b || !['pending', 'paid'].includes(b.status)) return res.status(404).json({ error: 'No booking found.' });
  if (b.status === 'pending') {
    db.prepare("UPDATE bookings SET status='cancelled' WHERE id = ?").run(b.id);
    return res.json({ ok: true });
  }
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(b.event_id);
  if (new Date() > refundDeadline(ev)) {
    return res.status(400).json({ error: `Bookings can only be cancelled for a refund up to ${REFUND_CUTOFF_HOURS} hours before the event. Please contact the organiser.` });
  }
  try {
    await refundBooking(b.id, 'cancelled at your request');
    res.json({ ok: true, refunded: b.amount_cents });
  } catch (err) {
    console.error('Refund failed:', err.message);
    res.status(502).json({ error: 'The refund could not be processed. Please contact the organiser.' });
  }
});

// Admin: refund any single paid booking (e.g. a no-show exception or a goodwill refund)
app.post('/api/bookings/:id/refund', requireAdmin, async (req, res) => {
  try {
    await refundBooking(Number(req.params.id), 'refunded by the organiser');
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/my-bookings', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT e.id AS event_id, e.title, e.starts_at, e.location, b.amount_cents
    FROM bookings b JOIN events e ON e.id = b.event_id
    WHERE b.user_id = ? AND b.status = 'paid' ORDER BY e.starts_at ASC`).all(req.user.id);
  const out = rows.map(r => ({ ...r, can_cancel: new Date() <= refundDeadline(r) }));
  res.json({ bookings: out, currency: CURRENCY, refund_cutoff_hours: REFUND_CUTOFF_HOURS });
});

app.listen(PORT, () => {
  console.log(`Event hub running at ${BASE_URL}`);
  if (TEST_MODE) console.log('⚠️  No STRIPE_SECRET_KEY set: TEST MODE (payments are simulated).');
  if (JWT_SECRET === 'dev-secret-change-me') console.log('⚠️  Set JWT_SECRET before going live.');
});
