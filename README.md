# Event Hub

A small event site: sign up / log in, browse events, join and pay with Stripe, early bird pricing,
confirmation emails, password reset, and automatic refunds.
Node.js + Express + SQLite. No build step.

**Ready to launch for real? Follow [GO_LIVE.md](GO_LIVE.md)** (Stripe, email and hosting, step by step).

## Run it on your computer

```bash
npm install
cp .env.example .env      # then edit it
npm start                 # http://localhost:3000
```

With no `STRIPE_SECRET_KEY`, the app runs in **test mode**: joining an event is confirmed instantly and
no card is charged (refunds are simulated too). With no `SMTP_HOST`, emails are printed in the terminal
instead of being sent. Use this to click around first.

**On your computer, the first person to sign up becomes the admin.** On a live site (`NODE_ENV=production`) only emails
listed in `ADMIN_EMAILS` can be admins, so strangers can't claim it. Admins see "+ New event", the attendee list,
refund buttons and edit/cancel buttons.

## Change the club name, tagline and logo

- **Name and tagline:** set `SITE_NAME` and `SITE_TAGLINE` in `.env`, then restart. They appear in the header,
  the home page banner, the login pages, the browser tab and in emails.
- **Logo:** replace `public/logo.svg` with your own (an SVG, or edit the `<img src="/logo.svg">` references
  in `public/index.html` and `public/app.js` to point at a PNG). Square images work best.
- **Colours:** the main colours are at the top of `public/style.css` (`--brand`, `--brand-dark`) and the banner
  gradients further down.

## Turn on real payments (Stripe)

1. Create a Stripe account at stripe.com and copy your **secret key** (start with the `sk_test_...` key).
2. Put it in `.env` as `STRIPE_SECRET_KEY`, and set `BASE_URL` to your public site address.
3. Webhook (recommended): in Stripe Dashboard → Developers → Webhooks, add the endpoint
   `https://YOUR-SITE/webhook/stripe` and select the events `checkout.session.completed` and
   `charge.refunded`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
   - `checkout.session.completed` confirms bookings even if the buyer closes the tab after paying.
   - `charge.refunded` keeps the site in sync if you refund someone directly from the Stripe dashboard.
4. Pay with Stripe's test card `4242 4242 4242 4242` (any future expiry, any CVC) to check everything works,
   then switch to your `sk_live_...` key.

## Turn on real emails

The app sends three emails: **booking confirmation**, **refund/cancellation notice** and **password reset**.

**Recommended: Resend** (resend.com). Verify your domain, create an API key, then set `RESEND_API_KEY` and
`MAIL_FROM` (an address on your verified domain) in `.env`. It sends over HTTPS, so it works on every host. Many
hosts block normal SMTP email (Render's free plan, Railway's Hobby plan), which is why it's the default choice.

**Alternative:** any SMTP provider via the `SMTP_*` settings (only if your host allows outgoing SMTP).

Use `npm run check -- you@example.com` to send yourself a test email and verify your settings.
A failed email never breaks a booking or refund; it is just logged.

## Refunds

- **Customers** can cancel their own booking from the event page or "My bookings" and are refunded
  automatically to their original payment method, up to `REFUND_CUTOFF_HOURS` (default 24) before the event.
  After that, the button disappears and they need to contact you.
- **You (admin)** can refund any single booking from the attendee table on the event page, at any time.
- **Cancelling an event** refunds every paid attendee automatically and emails each of them. If any refund
  fails, the event stays visible so you can retry or handle the rest in Stripe.
- Refunds are always for the full amount actually paid (so early bird buyers get back the early bird price).
  Stripe does not return its processing fee on refunds, so that cost is yours.
- A refunded person can book again later if there is space.

## Password reset

"Forgot your password?" on the login page emails a single-use link that is valid for 1 hour. The site gives
the same answer whether or not the email has an account, and limits requests to one email per minute per address.

## Put it online

See **[GO_LIVE.md](GO_LIVE.md)** for the full walkthrough. In short: put the code on GitHub, create a Render
account, deploy with the included `render.yaml` (web service + persistent disk for the database), add your Stripe
and Resend keys, connect the Stripe webhook, test with fake money, then switch to live keys. `npm run check`
verifies your settings at any time.

## How pricing works

Each event has a regular price and an optional early bird price + deadline. The price is always calculated on
the server at the moment someone clicks Join, so it can't be tampered with. Once the deadline passes the
event switches to the regular price automatically. Capacity is enforced, and an unpaid checkout holds a
spot for 30 minutes.

## Not included (easy to add later)

Reminder emails before an event, partial refunds, recurring weekly sessions, waitlists.
