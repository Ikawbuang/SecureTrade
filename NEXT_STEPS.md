# SecureTrade: what to do next

Written on 17 Nov 2026, after the QA audit. The site runs in **test mode**: no real money moves.
Live site: https://securetrade-production.up.railway.app (Railway, branch `xendit-test-payments`).

## Do first (you, about 10 minutes)

- [ ] **Set up two-step sign-in on the `blahblah` admin account.** Sign in as it, scan the QR code,
      save its 8 recovery codes. Until then its password alone is enough to do that setup.
- [ ] **Give `blahblah` a strong password**, different from `ikaw_buang`'s (My profile).
- [ ] **Keep both sets of recovery codes somewhere safe**, not only on the phone.
- [ ] **Run one full test trade on the live site**: request, accept, pay (test GCash), deliver, confirm.
      This confirms the new database rules do not block a real trade.

## Before inviting testers

- [ ] **Read and finish the Terms and Privacy pages** (`frontend/terms.html`, `frontend/privacy.html`).
      They are drafts. Say plainly that this is a test and no real money moves. Testers upload real IDs,
      so the privacy page matters even in a test.
- [ ] **Railway is on trial credit.** Check the days and credit left, and upgrade before it runs out,
      or the site goes offline.

## Small improvements (ask Claude: "go" on any of these)

| # | Audit item | What it is |
|---|---|---|
| ~~1~~ | Test-mode clarity | **Done 20 Nov 2026.** Yellow test-mode bar on every page, [TEST] in email subjects, refund and payout messages say no real money moved. |
| ~~2~~ | M9 | **Done 20 Nov 2026.** A failed trade email is retried once, then shown on the admin overview. |
| 3 | M4 | The server connects to the database with a limited account, not the owner. Needs SQL in Supabase and a new `DATABASE_URL`. Do it carefully, last. |
| ~~4~~ | L8 | **Done 20 Nov 2026.** New uploads lose their hidden data (location, phone model). Pictures uploaded before that still have it; a one-time cleanup script is possible. |
| ~~5~~ | L10, L12 | **Done 20 Nov 2026.** Both sides can add screenshots until the admin decides. Report dismissals and admins opening a trade's chat are logged. |
| 6 | M8 | Tests that run against a real test database, including two requests at the same moment. |
| 7 | L11 | Split the largest files (`routes/admin.js`, the exports of `lib/core.js`). |

## Parked until you decide to accept real money

These are the two CRITICAL audit items. Today a refund or a payout only changes the database.

- **C1** Automatic refunds to the buyer through Xendit.
- **C2** Payouts to the seller through Xendit.
- **H2** A money ledger, with refund and payout references, to match the database against Xendit.
- **M2** The admin refund must not call Xendit while a database transaction is open.
- **H3** Decide the delivery policy: proof is any picture, and money auto-releases after 24 hours
  (7 days for game accounts) with no dispute afterwards.

Before any of this:

- Xendit must verify your business and approve payouts. Start early; it takes time.
- Check what licence holding other people's money needs in the Philippines (BSP), and the
  Data Privacy Act rules for storing IDs.
- The server refuses live Xendit keys unless `XENDIT_ALLOW_LIVE=true` is set. Leave it unset.

## Already done (for reference)

- Exposed secrets replaced (database password, Brevo key). Email on the live site goes through
  Brevo's web API (`BREVO_API_KEY`), because Railway blocks SMTP.
- Sign-in hardening: lockout counts in the database, reset-PIN daily limit, easy passwords refused,
  startup checks for unsafe settings.
- Database rules (migration 006): trades only move along allowed steps, a trade and its payment
  must agree, money records cannot be deleted, the activity log is append-only.
- Two-step sign-in for admins (migration 007), with a fresh code for refunds and releases.
- New pages and layout: Find partner page, pop-up cards, picture viewer, phone layout.

## Useful commands (run in `backend/`)

| What | Command |
|---|---|
| Run the tests | `npm test` |
| Start the site on this computer | `node server.js` (stop it with Ctrl+C when done) |
| Lost phone and recovery codes | `node scripts/reset-admin-2fa.js <admin email>` |
| Dry-run the database rules | `node scripts/dry-run-006.js` (nothing is saved) |

## Rules to keep

- Never commit `backend/.env`, and never paste its values into a chat or a screenshot.
- Changing `JWT_SECRET` signs everyone out, and admins must set up two-step sign-in again.
- Migrations in `backend/migrations/` are run by hand in the Supabase SQL Editor. 001 to 007 are applied
  (003 was optional).
- If you correct data by hand in Supabase, the rules from migration 006 may refuse it. The note at the
  top of `006_database_rules.sql` shows how to switch one off for a moment.
