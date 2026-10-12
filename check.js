// Pre-launch checker. Run:  npm run check            (checks your settings)
//                           npm run check -- you@example.com   (also sends a test email)
require('dotenv').config();
const path = require('path');
const mailer = require('./mailer');

const out = [];
const ok = m => out.push(`  ✅ ${m}`);
const warn = m => out.push(`  ⚠️  ${m}`);
const bad = m => { out.push(`  ❌ ${m}`); failures++; };
let failures = 0;

(async () => {
  const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const JWT = process.env.JWT_SECRET || '';

  console.log('\nSite');
  ok(`Node ${process.version}`);
  if (BASE_URL.startsWith('https://')) ok(`BASE_URL is ${BASE_URL}`);
  else warn(`BASE_URL is ${BASE_URL} (fine for testing on your computer; must be your public https address when live)`);
  if (!JWT || JWT === 'dev-secret-change-me' || JWT === 'change-this-to-a-long-random-string') warn('JWT_SECRET is not set to your own value (required when live)');
  else if (JWT.length < 32) warn('JWT_SECRET is shorter than 32 characters');
  else ok('JWT_SECRET is set');
  ok(`Database file: ${path.resolve(process.env.DB_PATH || path.join(__dirname, 'data.db'))}`);
  console.log(out.splice(0).join('\n'));

  console.log('\nStripe');
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) warn('No STRIPE_SECRET_KEY: payments are simulated (test mode). Bookings are confirmed without charging anyone.');
  else {
    const live = key.startsWith('sk_live_') || key.startsWith('rk_live_');
    try {
      const stripe = require('stripe')(key);
      const bal = await stripe.balance.retrieve();
      ok(`Key accepted by Stripe (${bal.livemode ? 'LIVE mode: real money' : 'TEST mode: no real money'})`);
      if (!bal.livemode && BASE_URL.startsWith('https://')) warn('This is a test key but your site is public. Switch to the live key when you are ready to take real payments.');
    } catch (err) { bad(`Stripe rejected the key: ${err.message}`); }
    if (!process.env.STRIPE_WEBHOOK_SECRET) warn('No STRIPE_WEBHOOK_SECRET: payments are only confirmed when the buyer returns to the site, and Stripe-dashboard refunds will not sync');
    else if (!process.env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) bad('STRIPE_WEBHOOK_SECRET should start with whsec_');
    else ok('Webhook signing secret is set');
    if (!live && process.env.STRIPE_WEBHOOK_SECRET) ok('Remember: live and test mode have different webhook secrets');
  }
  console.log(out.splice(0).join('\n'));

  console.log('\nEmail');
  if (mailer.mode === 'console') warn('No email provider set: emails are only printed in the server log. Set RESEND_API_KEY (recommended) or SMTP_HOST.');
  else ok(`Email via ${mailer.mode === 'resend' ? 'Resend (web API)' : 'SMTP'}; sending as ${mailer.FROM}`);
  if (mailer.mode !== 'console' && /@localhost|yourdomain\.com/.test(mailer.FROM)) bad('MAIL_FROM still has a placeholder address. Use an address on a domain you have verified with your email provider.');
  const to = process.argv[2];
  if (to) {
    const r = await mailer.sendMail({ to, subject: 'Test email from your event site', text: 'If you can read this, confirmation emails will work.', html: '<p>If you can read this, confirmation emails will work.</p>' });
    if (r.sent) ok(`Test email sent to ${to}. Check the inbox (and spam folder).`);
    else if (r.logged) warn('Test email only printed above, because no provider is configured.');
    else bad(`Test email failed: ${r.error}`);
  } else if (mailer.mode !== 'console') out.push('  ℹ️  Tip: run  npm run check -- you@example.com  to send yourself a test email.');
  console.log(out.splice(0).join('\n'));

  console.log(failures ? `\n${failures} problem(s) to fix above.\n` : '\nNo blocking problems found.\n');
  process.exit(failures ? 1 : 0);
})();
