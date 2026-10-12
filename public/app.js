/* Tiny single-page app: hash routing, no build step */
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const state = { user: null, testMode: false, currency: 'aud', siteName: 'Events', tagline: '' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => c === 0 ? 'Free' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: state.currency.toUpperCase() }).format(c / 100);
const fmtDate = iso => new Date(iso).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtShort = iso => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const toLocalInput = iso => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function renderNav() {
  const u = state.user;
  $nav.innerHTML = u
    ? `${u.is_admin ? '<a href="#/new">+ New event</a>' : ''}
       <a href="#/mine">My bookings</a>
       <button id="logout">Log out (${esc(u.name.split(' ')[0])})</button>`
    : `<a href="#/login">Log in</a><a href="#/register">Sign up</a>`;
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => { await api('/logout', { method: 'POST' }); state.user = null; renderNav(); location.hash = '#/'; route(); };
  document.getElementById('banner').classList.toggle('hidden', !state.testMode);
  document.getElementById('banner').textContent = 'Test mode: no Stripe key set, so payments are simulated and no card is charged.';
}

/* ---------- views ---------- */
function priceBlock(e) {
  if (e.is_early_bird) {
    return `<div class="price"><s>${money(e.price_cents)}</s><div class="now">${money(e.current_price_cents)}</div><span class="tag">Early bird</span></div>`;
  }
  return `<div class="price"><div class="now">${money(e.current_price_cents)}</div></div>`;
}

function heroHtml() {
  const cta = state.user
    ? '<a class="primary" href="#/mine">My bookings</a>'
    : '<a class="primary" href="#/register">Join the club</a><a class="hero-link" href="#/login">I already have an account</a>';
  return `<section class="hero">
    <img class="hero-logo" src="/logo.svg" alt="" width="72" height="72">
    <h1>${esc(state.siteName)}</h1>
    <p>${esc(state.tagline)}</p>
    <div class="hero-actions">
      <button class="primary" onclick="document.getElementById('events').scrollIntoView({behavior:'smooth'})">Browse events</button>
      ${cta}
    </div>
  </section>`;
}

// Wraps the login-style card in a branded split-screen layout (brand panel on the left, form on the right)
function wrapAuth() {
  const card = $app.querySelector('.auth');
  if (!card) return;
  const wrap = document.createElement('div');
  wrap.className = 'auth-split';
  wrap.innerHTML = `<aside class="auth-brand">
      <img src="/logo.svg" alt="" width="64" height="64">
      <h2>${esc(state.siteName)}</h2>
      <p>${esc(state.tagline)}</p>
    </aside><div class="auth-form"></div>`;
  wrap.querySelector('.auth-form').appendChild(card);
  $app.innerHTML = '';
  $app.appendChild(wrap);
}

async function viewHome() {
  $app.innerHTML = heroHtml() + '<h1 id="events">Upcoming events</h1><p class="meta">Loading…</p>';
  const { events } = await api('/events');
  if (!events.length) { $app.innerHTML = heroHtml() + '<h1 id="events">Upcoming events</h1><div class="card meta">No events yet. Check back soon!</div>'; return; }
  $app.innerHTML = heroHtml() + '<h1 id="events">Upcoming events</h1>' + events.map(e => `
    <div class="card event-card" data-id="${e.id}">
      <div>
        <h3>${esc(e.title)}</h3>
        <div class="meta">📅 ${fmtDate(e.starts_at)}${e.location ? ' · 📍 ' + esc(e.location) : ''}</div>
        ${e.spots_left === 0 ? '<span class="tag red">Full</span>' : e.spots_left != null ? `<span class="tag grey">${e.spots_left} spots left</span>` : ''}
        ${e.my_booking === 'paid' ? '<span class="tag">You\'re in ✓</span>' : ''}
      </div>
      ${priceBlock(e)}
    </div>`).join('');
  $app.querySelectorAll('.event-card').forEach(c => c.onclick = () => location.hash = '#/event/' + c.dataset.id);
}

async function viewEvent(id) {
  const { event: e } = await api('/events/' + id);
  const full = e.spots_left === 0;
  let action;
  if (e.past) action = '<span class="tag grey">This event has started</span>';
  else if (e.my_booking === 'paid') action = `<span class="tag">You're booked in ✓</span>
    ${e.can_cancel_for_refund
      ? '<button class="ghost danger" id="cancel-refund">Cancel &amp; get a refund</button>'
      : '<span class="meta">Refunds are closed. Contact the organiser if you can\'t make it.</span>'}`;
  else if (!state.user) action = '<a class="primary" href="#/login">Log in to join</a>';
  else if (full) action = '<span class="tag red">Sorry, this event is full</span>';
  else action = `<button class="primary" id="join">${e.current_price_cents === 0 ? 'Join for free' : 'Join & pay ' + money(e.current_price_cents)}</button>`;

  let earlyInfo = '';
  if (e.early_bird_price_cents != null) {
    earlyInfo = e.is_early_bird
      ? `<p class="meta">🐦 Early bird price ends ${fmtDate(e.early_bird_deadline)}. Regular price is ${money(e.price_cents)}.</p>`
      : `<p class="meta">Early bird (${money(e.early_bird_price_cents)}) has ended.</p>`;
  }

  $app.innerHTML = `
    <a class="back" href="#/">← All events</a>
    <div class="card">
      <h1>${esc(e.title)}</h1>
      <div class="meta">📅 ${fmtDate(e.starts_at)}${e.location ? '<br>📍 ' + esc(e.location) : ''}</div>
      <p class="desc">${esc(e.description)}</p>
      <div class="big-price">${money(e.current_price_cents)} ${e.is_early_bird ? '<span class="tag">Early bird</span>' : ''}</div>
      ${earlyInfo}
      ${e.spots_left != null ? `<p class="meta">${e.spots_left} of ${e.capacity} spots left</p>` : ''}
      ${e.current_price_cents > 0 && e.refund_cutoff_hours > 0 ? `<p class="meta">↩️ Cancel for a full refund up to ${e.refund_cutoff_hours} hours before the event.</p>` : ''}
      <div class="actions">${action}
        ${e.my_booking === 'pending' ? '<button class="ghost" id="cancel-hold">Release my held spot</button>' : ''}
      </div>
      <div class="error" id="err"></div>
    </div>
    ${e.attendees ? `<div class="card"><h2 style="margin-top:0">Who's going (${e.attendees.length})</h2>
      ${e.attendees.length ? '<ul class="people">' + e.attendees.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>' : '<p class="meta">Be the first to join!</p>'}</div>` : ''}
    ${state.user && state.user.is_admin ? '<div id="admin"></div>' : ''}`;

  const join = document.getElementById('join');
  if (join) join.onclick = async () => {
    join.disabled = true;
    try {
      const r = await api(`/events/${id}/join`, { method: 'POST' });
      if (r.url) { location.href = r.url; return; }
      toast(r.testMode ? 'Booked! (test mode: no payment taken)' : "You're in! 🎉");
      viewEvent(id);
    } catch (err) { document.getElementById('err').textContent = err.message; join.disabled = false; }
  };
  const cr = document.getElementById('cancel-refund');
  if (cr) cr.onclick = async () => {
    if (!confirm('Cancel your booking? ' + (e.current_price_cents > 0 ? 'You will be refunded to your original payment method.' : ''))) return;
    cr.disabled = true;
    try {
      const r = await api(`/events/${id}/cancel-booking`, { method: 'POST' });
      toast(r.refunded > 0 ? `Booking cancelled. ${money(r.refunded)} refunded.` : 'Booking cancelled.');
      viewEvent(id);
    } catch (err) { document.getElementById('err').textContent = err.message; cr.disabled = false; }
  };
  const ch = document.getElementById('cancel-hold');
  if (ch) ch.onclick = async () => { await api(`/events/${id}/cancel-booking`, { method: 'POST' }); viewEvent(id); };
  if (state.user && state.user.is_admin) renderAdminPanel(e);
}

async function renderAdminPanel(e) {
  const { bookings } = await api(`/events/${e.id}/bookings`);
  const paid = bookings.filter(b => b.status === 'paid');
  const total = paid.reduce((s, b) => s + b.amount_cents, 0);
  document.getElementById('admin').innerHTML = `
    <div class="card"><h2 style="margin-top:0">Admin</h2>
      <p class="meta">${paid.length} paid · ${money(total)} collected</p>
      ${bookings.length ? `<table><tr><th>Name</th><th>Email</th><th>Status</th><th>Paid</th><th></th></tr>
        ${bookings.map(b => `<tr><td>${esc(b.name)}</td><td>${esc(b.email)}</td><td>${b.status}</td><td>${b.status === 'paid' ? money(b.amount_cents) : '-'}</td>
          <td>${b.status === 'paid' ? `<button class="ghost danger refund" data-id="${b.id}" data-name="${esc(b.name)}">Refund</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="meta">No bookings yet.</p>'}
      <div class="actions"><a class="ghost" style="text-decoration:none;color:inherit" href="#/edit/${e.id}"><button class="ghost">Edit event</button></a>
      <button class="ghost danger" id="del">Cancel event &amp; refund everyone</button></div></div>`;
  document.querySelectorAll('.refund').forEach(btn => btn.onclick = async () => {
    if (!confirm(`Refund ${btn.dataset.name} and remove them from the event?`)) return;
    btn.disabled = true;
    try { await api(`/bookings/${btn.dataset.id}/refund`, { method: 'POST' }); toast('Refunded.'); viewEvent(e.id); }
    catch (err) { toast(err.message); btn.disabled = false; }
  });
  document.getElementById('del').onclick = async () => {
    if (!confirm(`Cancel this event? All ${paid.length} paid attendee(s) will be refunded automatically and emailed.`)) return;
    try {
      const r = await api('/events/' + e.id, { method: 'DELETE' });
      if (r.ok) { toast(`Event cancelled. ${r.refunded} refund(s) issued.`); location.hash = '#/'; }
      else { toast(`${r.refunded} refunded, ${r.failed} failed. Event kept: try again or refund in Stripe.`); viewEvent(e.id); }
    } catch (err) { toast(err.message); }
  };
}

function viewAuth(mode) {
  const reg = mode === 'register';
  $app.innerHTML = `<div class="card auth"><h1>${reg ? 'Create account' : 'Log in'}</h1>
    <form id="f">
      ${reg ? '<label>Name</label><input name="name" required autocomplete="name">' : ''}
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Password</label><input name="password" type="password" required minlength="8" autocomplete="${reg ? 'new-password' : 'current-password'}">
      <div class="error" id="err"></div>
      <p><button class="primary" style="width:100%">${reg ? 'Sign up' : 'Log in'}</button></p>
    </form>
    <p class="meta">${reg ? 'Already have an account? <a href="#/login">Log in</a>' : 'New here? <a href="#/register">Create an account</a><br><a href="#/forgot">Forgot your password?</a>'}</p></div>`;
  document.getElementById('f').onsubmit = async ev => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    try {
      const { user } = await api(reg ? '/register' : '/login', { method: 'POST', body });
      state.user = user; renderNav();
      location.hash = sessionStorage.getItem('after-login') || '#/';
      sessionStorage.removeItem('after-login');
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

function viewForgot() {
  $app.innerHTML = `<div class="card auth"><h1>Forgot password</h1>
    <p class="meta">Enter your email and we'll send you a link to choose a new password.</p>
    <form id="f"><label>Email</label><input name="email" type="email" required autocomplete="email">
    <div class="error" id="err"></div>
    <p><button class="primary" style="width:100%">Send reset link</button></p></form>
    <p class="meta"><a href="#/login">Back to log in</a></p></div>`;
  document.getElementById('f').onsubmit = async ev => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    try {
      await api('/forgot-password', { method: 'POST', body });
      $app.innerHTML = `<div class="card auth"><h1>Check your email</h1>
        <p>If an account exists for <b>${esc(body.email)}</b>, a reset link is on its way. It's valid for 1 hour.</p>
        <p class="meta"><a href="#/login">Back to log in</a></p></div>`;
      wrapAuth();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

function viewReset(token) {
  $app.innerHTML = `<div class="card auth"><h1>Choose a new password</h1>
    <form id="f"><label>New password</label><input name="password" type="password" required minlength="8" autocomplete="new-password">
    <div class="error" id="err"></div>
    <p><button class="primary" style="width:100%">Save password</button></p></form></div>`;
  document.getElementById('f').onsubmit = async ev => {
    ev.preventDefault();
    const body = { token, password: new FormData(ev.target).get('password') };
    try {
      const { user } = await api('/reset-password', { method: 'POST', body });
      state.user = user; renderNav(); toast('Password updated. You\'re logged in.');
      location.hash = '#/';
    } catch (err) { document.getElementById('err').innerHTML = esc(err.message) + ' <a href="#/forgot">Request a new link</a>'; }
  };
}

async function viewEventForm(id) {
  if (!state.user || !state.user.is_admin) { $app.innerHTML = '<div class="card">Admins only.</div>'; return; }
  let e = { title: '', description: '', location: '', starts_at: '', capacity: 0, price_cents: 0, early_bird_price_cents: null, early_bird_deadline: '' };
  if (id) e = (await api('/events/' + id)).event;
  const d = c => c == null ? '' : (c / 100).toFixed(2);
  $app.innerHTML = `<a class="back" href="#/">← Back</a><div class="card"><h1>${id ? 'Edit' : 'New'} event</h1>
    <form id="f">
      <label>Title</label><input name="title" required value="${esc(e.title)}">
      <label>Description</label><textarea name="description">${esc(e.description)}</textarea>
      <div class="row">
        <div><label>Starts</label><input name="starts_at" type="datetime-local" required value="${e.starts_at ? toLocalInput(e.starts_at) : ''}"></div>
        <div><label>Location</label><input name="location" value="${esc(e.location)}"></div>
      </div>
      <div class="row">
        <div><label>Regular price (${state.currency.toUpperCase()}, 0 = free)</label><input name="price" type="number" min="0" step="0.01" required value="${d(e.price_cents)}"></div>
        <div><label>Capacity (0 = unlimited)</label><input name="capacity" type="number" min="0" value="${e.capacity}"></div>
      </div>
      <h2>Early bird (optional)</h2>
      <div class="row">
        <div><label>Early bird price</label><input name="early_bird_price" type="number" min="0" step="0.01" value="${d(e.early_bird_price_cents)}"></div>
        <div><label>Early bird ends</label><input name="early_bird_deadline" type="datetime-local" value="${e.early_bird_deadline ? toLocalInput(e.early_bird_deadline) : ''}"></div>
      </div>
      <div class="error" id="err"></div>
      <p><button class="primary">${id ? 'Save changes' : 'Create event'}</button></p>
    </form></div>`;
  document.getElementById('f').onsubmit = async ev => {
    ev.preventDefault();
    const b = Object.fromEntries(new FormData(ev.target));
    b.starts_at = new Date(b.starts_at).toISOString();
    b.early_bird_deadline = b.early_bird_deadline ? new Date(b.early_bird_deadline).toISOString() : '';
    try {
      const r = await api(id ? '/events/' + id : '/events', { method: id ? 'PUT' : 'POST', body: b });
      location.hash = '#/event/' + (id || r.id);
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

async function viewMine() {
  if (!state.user) { location.hash = '#/login'; return; }
  const { bookings } = await api('/my-bookings');
  $app.innerHTML = '<h1>My bookings</h1>' + (bookings.length ? bookings.map(b => `
    <div class="card event-card" onclick="location.hash='#/event/${b.event_id}'"><div><h3>${esc(b.title)}</h3>
    <div class="meta">📅 ${fmtDate(b.starts_at)}${b.location ? ' · 📍 ' + esc(b.location) : ''}</div></div>
    <div class="price"><div class="now">${money(b.amount_cents)}</div><span class="tag">Paid</span>
    ${b.can_cancel ? `<div><button class="ghost danger cancel-b" data-id="${b.event_id}" style="margin-top:6px;padding:4px 10px">Cancel &amp; refund</button></div>` : ''}</div></div>`).join('')
    : '<div class="card meta">You haven\'t joined any events yet.</div>');
  document.querySelectorAll('.cancel-b').forEach(btn => btn.onclick = async ev => {
    ev.stopPropagation();   // don't open the event page
    if (!confirm('Cancel this booking and get a refund?')) return;
    try { await api(`/events/${btn.dataset.id}/cancel-booking`, { method: 'POST' }); toast('Booking cancelled and refunded.'); viewMine(); }
    catch (err) { toast(err.message); }
  });
}

/* ---------- router ---------- */
async function route() {
  const h = location.hash || '#/';
  // Login-style pages use the full width for the split layout
  $app.classList.toggle('wide', /^#\/(login|register|forgot|reset\/)/.test(h));
  window.scrollTo(0, 0);
  try {
    let m;
    if (h === '#/' || h === '') await viewHome();
    else if ((m = h.match(/^#\/event\/(\d+)/))) {
      if (!state.user) sessionStorage.setItem('after-login', h);
      await viewEvent(m[1]);
    }
    else if (h === '#/login') { viewAuth('login'); wrapAuth(); }
    else if (h === '#/register') { viewAuth('register'); wrapAuth(); }
    else if (h === '#/forgot') { viewForgot(); wrapAuth(); }
    else if ((m = h.match(/^#\/reset\/([a-f0-9]+)$/))) { viewReset(m[1]); wrapAuth(); }
    else if (h === '#/new') await viewEventForm();
    else if ((m = h.match(/^#\/edit\/(\d+)/))) await viewEventForm(m[1]);
    else if (h === '#/mine') await viewMine();
    else await viewHome();
  } catch (err) { $app.innerHTML = `<div class="card error">${esc(err.message)}</div>`; }
}

async function init() {
  const me = await api('/me');
  Object.assign(state, { user: me.user, testMode: me.testMode, currency: me.currency, siteName: me.siteName, tagline: me.tagline });
  document.title = state.siteName;
  document.getElementById('brand-name').textContent = state.siteName;
  renderNav();

  // Returning from Stripe Checkout
  const q = new URLSearchParams(location.search);
  if (q.get('booking')) {
    history.replaceState({}, '', '/');
    try {
      let r;
      for (let i = 0; i < 5; i++) {            // webhook can lag a moment
        r = await api(`/bookings/${q.get('booking')}/confirm`, { method: 'POST' });
        if (r.status === 'paid') break;
        await new Promise(res => setTimeout(res, 1500));
      }
      toast(r.status === 'paid' ? "Payment received. You're in! 🎉" : 'Payment is still processing. Check My bookings shortly.');
      location.hash = '#/event/' + r.event_id;
    } catch (err) { toast(err.message); }
  } else if (q.get('event')) {
    const id = q.get('event'); history.replaceState({}, '', '/'); location.hash = '#/event/' + id;
  }
  window.addEventListener('hashchange', route);
  route();
}
init();
