# Go live: Stripe, email and hosting

Follow these in order. Total running cost is about **US$7.25/month** for hosting, plus Stripe's per-payment fee and
your domain name. Prices below were checked on the providers' own pages in October 2026, so double-check them
when you sign up.

| Piece | Service | Cost |
|---|---|---|
| Hosting + database disk | Render (Starter instance + 1 GB disk) | US$7/month + US$0.25/month |
| Payments | Stripe | 1.65% + A$0.30 per domestic card payment (GST included), no monthly fee |
| Emails | Resend (free plan) | Free up to 3,000 emails/month and 100/day |
| Domain name (needed for email, nice for the site) | Any registrar | Roughly A$15-30/year |

**Example:** a A$20 ticket paid by an Australian card costs A$0.63 in Stripe fees (A$0.33 + A$0.30), so you keep A$19.37.
If you refund it, Stripe does not give the A$0.63 fee back.

---

## Step 1: Stripe (taking payments)

1. Create an account at **stripe.com** (choose Australia). Complete the activation steps (business details, your
   bank account for payouts). Until you finish, Stripe only lets you use test mode.
2. Stripe now calls its test environment a **sandbox**. Use the account switcher (top-left) to create or select a sandbox
   (older accounts have a **Test mode** switch instead). Open **API keys** (dashboard.stripe.com/apikeys) and copy the
   **Secret key** (starts with `sk_test_`).
3. Keep it safe. Never post it publicly or put it in a screenshot.

You'll add the webhook in Step 4, once your site has an address. Switch to the live key (`sk_live_`) only after your
test payment works (Step 5).

## Step 2: Email (Resend)

The app sends booking confirmations, refund notices and password-reset emails. Use **Resend** (it sends over the
web, which works on every host; many hosts, including Render's free plan and Railway's Hobby plan, block normal
SMTP email).

1. Create an account at **resend.com**.
2. **Domains → Add domain** and enter a domain you own (for example `yourclub.com.au`). Resend shows you DNS records
   to add where you bought the domain. Add them and click Verify. This is what stops your emails landing in spam.
3. **API Keys → Create API key** (permission: *Sending access*). Copy it (starts with `re_`).
4. Decide your sender address, such as `Your Club <bookings@yourclub.com.au>`. It must be on the domain you verified.

## Step 3: Put the code on GitHub, then host it on Render

**3a. GitHub.** Render deploys from a GitHub repository.
1. Create a free account at **github.com**, then create a **private** repository named `event-hub` (don't add a README).
2. Easiest: install **GitHub Desktop** (desktop.github.com), choose *Add an existing repository* → your `event-hub`
   folder → *Publish repository* (keep "Keep this code private" ticked). The included `.gitignore` keeps
   `node_modules`, your `.env` and your database out of GitHub.
   Or use Terminal in your project folder:
   ```
   git init
   git add .
   git commit -m "First version"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/event-hub.git
   git push -u origin main
   ```

**3b. Render.**
1. Create an account at **render.com**.
2. **New → Blueprint**, connect GitHub, and pick your `event-hub` repository. Render reads `render.yaml` and sets up
   the web service **and** the 1 GB disk where the database lives (the disk is why this needs the paid Starter plan:
   free instances lose their files on every restart and can't send email over SMTP).
3. Render asks you to fill in the secret settings. Enter:

   | Setting | What to enter |
   |---|---|
   | `ADMIN_EMAILS` | **Your email address.** Only emails listed here can be admins on the live site |
   | `SITE_NAME`, `SITE_TAGLINE` | Your club name and tagline |
   | `MAIL_FROM` | e.g. `Your Club <bookings@yourclub.com.au>` |
   | `RESEND_API_KEY` | The `re_...` key from Step 2 |
   | `STRIPE_SECRET_KEY` | The `sk_test_...` key from Step 1 (test first!) |
   | `STRIPE_WEBHOOK_SECRET` | Leave blank for now (Step 4) |

   The secure `JWT_SECRET` is generated for you automatically.
4. Click **Apply** and wait for the first deploy to finish (a few minutes). Your site is at
   `https://event-hub-xxxx.onrender.com`.
5. **Right away, open the site and sign up with the email you put in `ADMIN_EMAILS`.** That creates your admin account,
   and nobody else can register that email afterwards.

If a deploy fails, open the service's **Logs** tab. A message starting "Cannot start in production" tells you exactly
which setting is missing.

## Step 4: Connect the Stripe webhook

The webhook is how Stripe tells your site "this payment succeeded" (even if the buyer closes the tab) and "this was refunded".

1. In the Stripe Dashboard (still in your sandbox/test environment), open **Workbench → Webhooks**
   (or go to dashboard.stripe.com/webhooks) and click **Create an event destination**.
2. Choose **Your account**.
3. **Payload format: choose "Snapshot", NOT "Thin".** This app reads classic (snapshot) events. If asked for an API
   version, keep the default.
4. Select these events: **`checkout.session.completed`** and **`charge.refunded`**. Click **Continue**.
5. Choose **Webhook endpoint** as the destination type, click **Continue**, and enter the URL:
   `https://YOUR-SITE-ADDRESS/webhook/stripe` (your Render address from Step 3).
6. On the next page click **Reveal secret** and copy the value that starts with `whsec_`.
7. In Render → your service → **Environment**, set `STRIPE_WEBHOOK_SECRET` to that value and save (it redeploys).

Stripe menus change often; if a button has a slightly different name, look for "webhook" or "event destination".

## Step 5: Test with fake money, then switch to real

1. As admin, create a test event priced at, say, A$5.
2. In a private/incognito window, sign up as a "customer" with a different email and join the event. On Stripe's page
   pay with the test card `4242 4242 4242 4242`, any future expiry, any CVC.
3. Check: you land back on the site as booked in, the **confirmation email arrives** (check spam too), the payment shows
   in Stripe's test payments, and the booking shows as paid in your admin attendee table.
4. Try **Cancel & get a refund** as the customer and confirm the refund email and the refund in Stripe.
5. Test **Forgot your password?** from the login page.
6. When everything works, switch Stripe to **live mode** (on the API keys page, toggle from sandbox to live), click
   **Create secret key** and copy it (`sk_live_...`; Stripe shows it only once, so paste it somewhere safe straight away).
   Create the webhook again in live mode (**Snapshot** again; live and test have separate webhooks and separate signing
   secrets), and update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Render.
7. Do one real small payment (e.g. a A$1 event) with your own card, then refund it, to prove live mode works.

Handy: in Render's **Shell** tab you can run `npm run check -- you@example.com`. It verifies your Stripe key, flags
placeholder settings, and sends you a test email.

## Step 6 (optional): Your own domain for the site

1. Render → your service → **Settings → Custom Domains** → add `www.yourclub.com.au` (or similar) and add the DNS
   record Render shows you at your registrar.
2. In Render **Environment**, add `BASE_URL` = `https://www.yourclub.com.au` (no trailing slash).
3. Update the Stripe webhook URL to the new address.

---

## Good to know

- **Backups:** Render snapshots the disk every 24 hours and keeps them for at least 7 days. Restoring replaces the whole
  disk with that snapshot, so any bookings made after it are lost. Stripe also keeps its own record of every payment.
- **Short blips on deploys:** a service with a disk is briefly unavailable (a few seconds) each time you deploy.
- **One server only:** the app uses a single database file, so it runs on one instance. That's plenty for a club.
- **Resend's free limit is 100 emails a day.** If you cancel an event with more than ~100 paid attendees at once, some
  refund emails could be delayed or fail (the refunds themselves still go through). Upgrade the plan if you grow.
- **Disputes:** Stripe charges A$25 for each card dispute (chargeback) you receive. Clear event details and a clear
  refund policy help.
- **Business basics:** consider adding terms, a refund policy and a privacy policy, and check GST and other
  obligations for charging for events with an accountant. This guide isn't tax or legal advice.
- **Changing the site later:** edit the code, push to GitHub, and Render redeploys automatically.

## Alternative host: Railway

Railway also works (Hobby plan has a US$5/month minimum usage, volumes up to 5 GB). Create a project from your GitHub
repo, add a **Volume** mounted at `/data`, and set the same variables as above plus `NODE_ENV=production`,
`DB_PATH=/data/data.db`, a long random `JWT_SECRET`, and `BASE_URL` set to your Railway https address. Railway doesn't
generate a Blueprint from `render.yaml`, and its Hobby plan blocks SMTP, so use Resend (already the default here).

## Troubleshooting

| Problem | Likely cause |
|---|---|
| Deploy log says "Cannot start in production" | `JWT_SECRET` or `BASE_URL` missing or not https |
| I can't see "+ New event" | Your account's email isn't in `ADMIN_EMAILS` (add it, then reload) |
| Customer paid but booking shows pending | `STRIPE_WEBHOOK_SECRET` missing/wrong, or webhook created in the wrong mode (test vs live) |
| Emails don't arrive | Domain not verified in Resend, `MAIL_FROM` not on that domain, or check the spam folder. Run `npm run check -- you@example.com` |
| "Too many attempts" when logging in | Built-in protection: 10 wrong passwords per email per 15 minutes. Wait and retry |

## Sources (checked October 2026)

- [Stripe pricing, Australia](https://stripe.com/au/pricing)
- [Render pricing](https://render.com/pricing), [free instance limits](https://render.com/docs/free), [persistent disks](https://render.com/docs/disks), [Blueprint spec](https://render.com/docs/blueprint-spec)
- [Resend pricing](https://resend.com/pricing), [Resend API](https://resend.com/docs/api-reference/emails/send-email)
- [Railway pricing](https://railway.com/pricing)
