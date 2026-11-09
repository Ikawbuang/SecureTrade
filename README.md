# SecureTrade

**SIA101 – Systems Integration and Architecture** · Team Alt-F4

SecureTrade is an escrow platform for gamers who buy and sell in-game items, accounts and currency. The buyer pays into escrow, the seller delivers, the buyer confirms, and only then is the payment released to the seller (minus a 3% service fee). If something goes wrong, either side can open a dispute and an administrator decides.

> **Status:** the app works end to end (accounts, identity verification, trades, escrow flow, chat, disputes, ratings, support, admin panel). **Buyer payments run on Xendit in test mode.** Seller payouts and most refunds are still simulated, so no real money moves, and "held in escrow" is a status in the database. See [Future work](#future-work-and-recommendations).

**UI-only demo (frontend pages, needs the backend to sign in):** https://ikawbuang.github.io/SecureTrade/frontend/login.html

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3 (`global.css` and `style.css`), plain JavaScript, Google Fonts (Chakra Petch, Figtree) |
| Backend | Node.js and Express (REST API) |
| Database | PostgreSQL on Supabase |
| Authentication | JSON Web Tokens, bcrypt password hashing |
| File uploads | multer (dispute evidence, profile photos, ID photos) |
| Email | nodemailer (PINs). In development the PIN is printed in the server terminal |
| Version control | Git and GitHub |

## How it works

```
Browser (HTML, CSS, JS)  ──►  Express REST API (backend/server.js)  ──►  PostgreSQL (Supabase)
                                      │
                                      ├── uploads/  (evidence, avatars, ID photos)
                                      └── email provider (PIN emails, planned: Brevo)
```

**Trade flow:** request sent → partner accepts → buyer pays with GCash into escrow → seller delivers and gives the GCash number to receive the money → buyer confirms → payment released (receipt issued) → both can rate each other.

## Features

| Area | What it does |
|---|---|
| Accounts | Sign up with first name, last name, gamer username, email and password, confirmed by an emailed PIN. Forgot password with PIN. 18+ confirmation. |
| Identity verification | A code, a photo of an ID and a selfie holding it. An admin reviews it (including that the ID shows the person is 18 or older). The pictures are deleted after the decision and no ID number is saved. The name on the ID becomes the account name. |
| Trades | Find a partner (All, Recent, Online, Offline, Favorites), send a request, accept or decline. Both people must be verified. Trade requests appear at the top of the dashboard. |
| Escrow | The buyer pays with GCash, the payment is held, the seller marks the item as delivered, the buyer confirms. If the buyer does nothing, the payment is released automatically 24 hours after delivery. |
| Cancel | The sender can cancel a request. Either person can cancel before payment. After payment only the seller can cancel (with a reason) and the buyer is refunded in full. |
| Chat | In-app chat for every trade (admins can read it). |
| Disputes | Report a problem with screenshots, the other side replies, an admin reads both sides and the chat, then refunds the buyer or pays the seller. |
| Receipts and history | Digital receipts and a history of finished trades. |
| Ratings | Rate the other person after a completed trade. Reviews are **anonymous to the public** (stars, comment, date, buyer or seller). Only admins can see who wrote one. Reviews can be reported and deleted by an admin. |
| Favorites | A star beside a user, with a private note. The other person is never told. |
| Profile | Photo, username (once every 30 days, not while trades are on process), email change (password and PIN), password change, and "My reviews". |
| Support | A chat between a user and the admins. A suspended user can sign in but can only use Support (to appeal). |
| Admin panel | Verifications, support messages, disputes, reported reviews, all trades, and users (suspend, ban, reactivate). The admin can refund the buyer on a held trade that has no dispute, release a delivered trade when an account is suspended or banned, and refund payments that arrived too late ("Payments to review"). |
| Feedback | A link to the Google Form survey in the menu: https://forms.gle/Rex91MrokLRTdjg47 |

## Rules of the system

| Rule | Value |
|---|---|
| Service fee | 3% of the price |
| Payment method | GCash only (to pay in and to receive the money) |
| Minimum age | 18 and older |
| One device per account | A new login signs out the other device, after a warning ("already logged in") |
| Idle sign-out | 15 minutes without real activity (set by `IDLE_MINUTES`) |
| Trade request expiry | 12 hours without an answer |
| Trade price | ₱1 to ₱100,000, with up to 10 requests waiting at a time |
| Auto-release | 24 hours after delivery. It is paused when the buyer or the seller is suspended or banned, or while there is a dispute. An admin decides those trades. |
| Banned account | Cannot sign in |
| Suspended account | Can sign in, but only Support works |

## Run it locally

**Requirements:** Node.js and a Supabase project (PostgreSQL).

1. **Backend**

   ```
   cd backend
   npm install bcryptjs cors dotenv express jsonwebtoken multer nodemailer pg
   ```

   Create `backend/.env`:

   ```
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<host>.pooler.supabase.com:6543/postgres
   PORT=3000
   JWT_SECRET=<a long random text>
   IDLE_MINUTES=15
   DEV_LOG_PIN=true
   ```

   Online payment needs `XENDIT_SECRET_KEY`, `XENDIT_WEBHOOK_TOKEN` and `PUBLIC_URL`. Without them nobody can pay. For local testing only, `ALLOW_SIMULATED_PAYMENTS=true` turns on a fake payment instead.

   Use the **Session pooler** string and **port 6543**. `DEV_LOG_PIN=true` prints PINs in the terminal instead of sending email. Remove it once real email is set up. Never commit `.env`. When you deploy, add `CORS_ORIGINS=https://your-site.com` (comma-separated) so only your own site can call the API; leave it out for local development.

   Download the SSL certificate from Supabase (**Project Settings → Database → SSL Configuration**) and save it as `backend/supabase-ca.crt`. The server will not start without it. It is not in Git, so copy it to every computer that runs the backend.

2. **Database:** create the tables listed below in Supabase (SQL Editor). The server needs all of them.

3. **Start the server:**

   ```
   node server.js
   ```

   Check `http://localhost:3000/api/health`. It should answer `{"status":"ok"}`.

4. **Frontend:** the server hosts the pages too, so open `http://localhost:3000/login.html`. The pages call the API at the same address, so this also works through ngrok or a real domain.

5. **First admin:** sign up normally, then in Supabase run:

   ```sql
   UPDATE users SET role = 'admin', verified_at = now() WHERE email = 'your_email@example.com';
   ```

**To verify a test user without the ID flow (testing only):**

```sql
UPDATE users SET verified_at = now() WHERE username = 'some_username';
```

### Database tables

`users`, `transactions`, `escrow_payments`, `messages`, `disputes`, `evidence`, `receipts`, `ratings`, `activity_log`, `email_pins`, `email_changes`, `verifications`, `favorites`, `trade_attempts`, `rate_dismissals`, `support_messages`, `review_reports`.

## API overview

| Group | Examples |
|---|---|
| Accounts | `POST /api/register/start`, `/api/register/verify`, `/api/login`, `/api/logout`, `/api/password/forgot`, `/api/password/reset` |
| Profile | `GET /api/profile`, `PUT /api/profile/username`, `POST /api/profile/email/start`, `POST /api/profile/avatar` |
| Verification | `GET /api/verification`, `POST /api/verification/code`, `POST /api/verification/submit` |
| People | `GET /api/users`, `GET /api/users/:username`, `PUT /api/favorites/:username` |
| Trades | `POST /api/transactions`, `POST /api/transactions/:id/respond`, `/pay`, `/deliver`, `/confirm`, `/cancel`, `/messages`, `/rating` |
| Disputes | `GET /api/disputes`, `POST /api/transactions/:id/dispute`, `/dispute/reply` |
| Reviews | `GET /api/reviews/mine`, `POST /api/reviews/:ref/report` |
| Support | `GET /api/support`, `POST /api/support` |
| Admin | `/api/admin/overview`, `/verifications`, `/support`, `/disputes`, `/reports`, `/login-alerts`, `/transactions`, `/users` |

## Security measures

- Passwords and PINs are hashed (bcrypt). PINs expire after 10 minutes and allow 5 tries.
- Every database query uses parameters (no SQL injection).
- The admin role is checked in the database on every admin request, not only in the token.
- Only the buyer, the seller and admins can read a trade, its chat and its evidence.
- Trade steps run in database transactions with row locks, so a payment cannot be released or refunded twice.
- ID and selfie photos are private, deleted after the admin decides, and no ID number is stored.
- Mobile numbers are only shown masked. The real name is hidden from other users.
- One device per account, idle sign-out on the server and in the browser, and sign-out of all devices after a password reset.
- Review writers are hidden from the public, with report and delete tools for admins.

**Known limits (this is a school project, not production):** buyer payments run in Xendit test mode while payouts and most refunds are simulated, rate limits are kept in memory, the login token is kept in `localStorage`, uploaded files are on the server's disk, and the ID check depends on the admin's eyes.

## Design Thinking summary

### 1. Empathize

A Google Forms survey was shared with gamers in Cebu. **26 responses** were collected on October 9–10, 2026.

| Who answered | Result |
|---|---|
| Age | 18–24: 19 (73%) · Under 18: 4 (15%) · 25–34: 3 (12%) |
| Occupation | Student: 18 (69%) · Employed: 6 (23%) · Unemployed: 2 (8%) |
| Where they live | Mandaue 17 · Cebu City 5 · Lapu-Lapu 2 · other 2 |
| Main platform | Mobile: 16 (62%) · PC: 9 (35%) · both: 1 (4%) |
| Games they play | Mobile Legends and Roblox (13 each), then Valorant and Dota 2 |

**Key findings**

- **81%** (21 of 26) have bought or sold in-game items, accounts or currency.
- **73%** (19 of 26) have lost money or items (10) or almost been scammed (9).
- Today they protect themselves with a **middleman (50%)** or by **trading only with people they know (46%)**. Only 3 people do nothing special.
- **85%** (22 of 26) would use an app that holds payment until delivery is confirmed (18 yes, 4 maybe).
- **92%** (24 of 26) accept a service fee of about 3% (17 yes, 7 only if it is lower).
- **88%** (23 of 26) prefer GCash.
- The biggest worry is **scams**: 17 of 26 written answers mention scams or scammers.
- Most wanted features (each person picked up to three): transaction history and receipts **65%**, seller ratings and reviews **58%**, automatic refund if the seller does not deliver **58%**, screenshot evidence 35%, admin dispute resolution 31%, payment held in escrow 27%, in-app chat 27%.
- Written suggestions: verify users with a valid ID (4 people), keep the app simple and easy to use (3), lower fees for small trades, and ban repeat scammers.

**What this means.** People care less about the escrow mechanism itself and more about the proof and trust around it: receipts, ratings and getting their money back.

### 2. Define

**Problem statement.** Gamers in Cebu who trade in-game items with strangers need a trusted way to hold payment until delivery is confirmed, because most of them have lost money or nearly been scammed and today rely on middlemen or only trade with people they know.

**How Might We**

- How might we let a buyer and a seller trust a trade without knowing each other?
- How might we give both sides proof of what was agreed and delivered?
- How might we settle disagreements quickly and fairly?
- How might we help users find a reliable trade partner?
- How might we keep the app simple enough for first-time users?

### 3. Ideate

Features were prioritized into must have, should have and future work, using the survey results. The last column shows where each one stands now.

| Feature | Priority | Status in SecureTrade |
|---|---|---|
| Register and sign in | Must | Done (email PIN) |
| Trade request (send, accept, decline) | Must | Done |
| Escrow payment hold | Must | Done (Xendit test mode) |
| Delivery and buyer confirmation | Must | Done |
| Dispute with evidence upload | Must | Done |
| Admin dispute review (refund or pay seller) | Must | Done |
| Transaction history and receipts | Should | Done |
| In-app chat | Should | Done |
| Partner finder with online/offline status | Should | Done (plus Recent and Favorites) |
| Auto-release after 24 hours | Should | Done |
| Seller ratings and reviews | Future work | Done (anonymous reviews, report and delete) |
| Automatic refund when the seller does not deliver | Future work | Partly: the seller can cancel and refund, and an admin can refund. No automatic refund yet. |
| ID verification | Future work | Done (admin reviews ID and selfie) |
| Ban repeat scammers | Future work | Partly: admins can suspend or ban accounts |

**Key decision: one dashboard for both buyers and sellers.** Whoever creates a trade sends a request that appears at the top of the partner's dashboard, where it can be accepted or declined. A user's role (buyer or seller) is set per trade, not per account, and the Active trades table can be filtered by All, Buying or Selling. A "Find a trade partner" panel on the dashboard replaced the separate New trade page.

**Key decision: 18 and older only.** The survey shows that 4 of 26 respondents (15%) are under 18, so many gamers are minors. SecureTrade is for users 18 and older because the app holds money and because contracts with minors are not reliable. This is enforced by a signup confirmation (checked on the server) and by the admin, who checks the ID during verification. Support for minors with parental consent is listed as future work.

**Key decision: GCash only.** 88% of respondents prefer GCash, so the app accepts GCash only, which also keeps the later payment integration simple.

### 4. Prototype

Low-fidelity wireframes were made first, then the pages were coded in HTML, CSS and JavaScript.

| Screen | File |
|---|---|
| Sign in / Create account | `login.html` |
| Dashboard | `dashboard.html` |
| New trade (now a popup on the dashboard) | ~~`create-transaction.html`~~ |
| Trade details | `transaction.html` |
| Report a problem | `dispute.html` |
| History and receipt | `history.html` |
| Admin | `admin-dashboard.html` |

Pages added after the first prototype: `profile.html` (profile, identity verification, my reviews) and `support.html` (chat with the admins).

**Design choices**

- A deep indigo and gold palette: indigo for a serious, trustworthy base, and gold for held funds and main actions.
- Status is always shown with a text label as well as a colour, for example Online or Offline and Payment held.
- The most important number on the dashboard is the amount currently held in escrow.
- Trade requests are shown at the very top of the dashboard, one line each, and the card is hidden when there are none.
- The side menu stays visible while scrolling, and the layout adapts to small screens.

### 5. Test

**Round 1 (UI prototype).** Five people tried the first prototype without help: Ruel, Jesso, Kristel, Tala and Jessel. They were left to explore it freely, with no set tasks. They liked it and said it was clear, easy to read, and less confusing than Binance. No one got stuck, so no changes were needed in that round.

**Round 2 (working app).** To be done with the working app. Suggested checks:

- Sign up with a PIN, verify an identity (admin approves and rejects), and trade between two accounts in two browsers.
- Try the one-device rule (the "already logged in" warning), the idle sign-out, and sign out.
- Run a full trade (pay, deliver, confirm, receipt, rate), a seller cancellation with refund, and a dispute decided by the admin.
- Report an anonymous review and delete it as an admin.
- Suspend a user and check that only Support works. Ban a user and check that sign-in is blocked.
- Suspend a seller while a payment is held and refund the buyer from the admin panel.

**Survey of users (in-app link).** A voluntary and anonymous Google Form is linked from the menu (Feedback). Results will be added here when responses are collected.

## Future work and recommendations

| Topic | Recommendation |
|---|---|
| Real payments | Use a licensed payment provider that holds the money and a payout service to GCash, with webhooks to confirm payments. Check with a lawyer or the regulator before holding other people's money. |
| GCash name match | Match the GCash account name with the verified name before a payout (through the provider, or a screenshot reviewed by an admin). |
| Identity checks | Use a third-party KYC provider instead of relying only on admin review. |
| Data privacy | Comply with the Data Privacy Act (RA 10173): privacy policy, terms and consent, retention rules and a breach plan. |
| Minors | Allow users under 18 only with parental consent, tighter limits and a verified guardian. |
| Security | Shared rate limits that survive a restart, 2FA (required for admins), secure cookies instead of `localStorage`, security testing. |
| Files | Move uploads to private cloud storage (for example Supabase Storage) with backups. |
| Email | Send PINs through a real email provider (planned: Brevo) and remove `DEV_LOG_PIN`. |
| Automation | Automatic refund when a seller does not deliver, and notifications for new requests, payments and status changes. |
| Trust | Limits for new users (for example a lower amount until two trades are completed). |
| Hosting | Host the backend and the frontend online, with environment variables set in the host. |

## Repository layout

```
SecureTrade/
├── README.md
├── frontend/
│   ├── login.html
│   ├── dashboard.html
│   ├── profile.html
│   ├── transaction.html
│   ├── history.html
│   ├── dispute.html
│   ├── support.html
│   ├── admin-dashboard.html
│   ├── css/            (global.css, style.css)
│   └── js/             (data.js, api.js, nav-badge.js, and one file per page)
├── backend/
│   ├── server.js
│   ├── package.json
│   └── uploads/        (created automatically, not in Git)
└── docs/
```

`backend/.env` and `backend/uploads/` are not committed.

## Team Alt-F4
<b>Leader:</b> Almario, Jessen<br>
<b>Member:</b><br>
    1. Anding, Jahn Patrick<br>
    2. Angel, Waren<br>
    3. Mantalaba, Erica<br>
    4. Yusores, Rudolf<br>