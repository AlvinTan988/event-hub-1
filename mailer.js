// Email sending. Uses SMTP if configured, otherwise prints emails to the console (dev mode).
const nodemailer = require('nodemailer');

const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const TZ = process.env.EVENT_TIMEZONE || 'Australia/Melbourne';
const SITE_NAME = process.env.SITE_NAME || 'Courtside Social Club';
const FROM = process.env.MAIL_FROM || `${SITE_NAME} <no-reply@localhost>`;

const configured = !!process.env.SMTP_HOST;
const transport = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString('en-AU', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
const money = (cents, cur) => cents === 0 ? 'Free'
  : new Intl.NumberFormat('en-AU', { style: 'currency', currency: (cur || 'aud').toUpperCase() }).format(cents / 100);

// Preferred: Resend's HTTPS API. It works on every host, whereas many hosts block outgoing SMTP ports.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const mode = RESEND_API_KEY ? 'resend' : configured ? 'smtp' : 'console';

// Never throws: a failed email must not break a booking or refund.
async function sendMail({ to, subject, text, html }) {
  if (RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = `Resend rejected the email (${res.status}): ${body.message || JSON.stringify(body)}`;
        console.error('Email failed:', msg);
        return { error: msg };
      }
      return { sent: true, id: body.id };
    } catch (err) {
      console.error('Email failed:', err.message);
      return { error: err.message };
    }
  }
  if (!transport) {
    console.log(`\n📧 [email not configured: printing instead]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return { logged: true };
  }
  try {
    await transport.sendMail({ from: FROM, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    console.error('Email failed:', err.message);
    return { error: err.message };
  }
}

function layout(title, bodyHtml) {
  return `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#2a2230">
  <h2 style="color:#e0556b">${esc(SITE_NAME)}</h2><h3>${esc(title)}</h3>${bodyHtml}
  <hr style="border:0;border-top:1px solid #eadfe0;margin:24px 0"><p style="color:#7a6f82;font-size:12px">${esc(SITE_NAME)} · ${esc(BASE_URL)}</p></div>`;
}

function bookingConfirmation({ user, event, amountCents, currency }) {
  const link = `${BASE_URL}/#/event/${event.id}`;
  const lines = [
    `Hi ${user.name},`, '',
    `You're booked in for ${event.title}.`, '',
    `When: ${when(event.starts_at)}`,
    event.location ? `Where: ${event.location}` : null,
    `Paid: ${money(amountCents, currency)}`, '',
    `Event page: ${link}`,
  ].filter(l => l !== null);
  const html = layout("You're booked in!", `<p>Hi ${esc(user.name)}, you're booked in for <b>${esc(event.title)}</b>.</p>
    <p>📅 ${esc(when(event.starts_at))}<br>${event.location ? '📍 ' + esc(event.location) + '<br>' : ''}💳 ${esc(money(amountCents, currency))}</p>
    <p><a href="${esc(link)}">View event</a></p>`);
  return { to: user.email, subject: `Booking confirmed: ${event.title}`, text: lines.join('\n'), html };
}

function refundNotice({ user, event, amountCents, currency, reason }) {
  const refundable = amountCents > 0;
  const lines = [
    `Hi ${user.name},`, '',
    `Your booking for ${event.title} (${when(event.starts_at)}) has been cancelled${reason ? ': ' + reason : '.'}`,
    refundable ? `A refund of ${money(amountCents, currency)} has been issued to your original payment method. It usually appears within 5-10 business days.` : '',
  ].filter(l => l !== '');
  const html = layout('Booking cancelled', `<p>Hi ${esc(user.name)}, your booking for <b>${esc(event.title)}</b> (${esc(when(event.starts_at))}) has been cancelled${reason ? ': ' + esc(reason) : '.'}</p>
    ${refundable ? `<p>A refund of <b>${esc(money(amountCents, currency))}</b> has been issued to your original payment method. It usually appears within 5-10 business days.</p>` : ''}`);
  return { to: user.email, subject: `Booking cancelled: ${event.title}`, text: lines.join('\n'), html };
}

function passwordReset({ user, token }) {
  const link = `${BASE_URL}/#/reset/${token}`;
  const text = `Hi ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, you can ignore this email.`;
  const html = layout('Reset your password', `<p>Hi ${esc(user.name)}, click below to choose a new password. The link is valid for 1 hour.</p>
    <p><a href="${esc(link)}" style="background:#e0556b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Reset password</a></p>
    <p style="color:#7a6f82">If you didn't ask for this, you can ignore this email.</p>`);
  return { to: user.email, subject: 'Reset your password', text, html };
}

module.exports = { sendMail, bookingConfirmation, refundNotice, passwordReset, emailConfigured: configured || !!RESEND_API_KEY, mode, FROM };
