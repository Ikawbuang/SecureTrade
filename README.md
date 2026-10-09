# SecureTrade

**SIA101 – Systems Integration and Architecture · Deliverable 5**
UI prototype built with the Design Thinking Process · Team Alt-F4

SecureTrade is an escrow platform for gamers who buy and sell in-game items, accounts and currency. The buyer pays into escrow, the seller delivers, the buyer confirms, and only then is the payment released to the seller (minus a 3% service fee). If something goes wrong, either side can open a dispute and an administrator decides.

> This is a **non-functional UI prototype**. It uses sample data and has no backend or database. The backend will be integrated in a later phase.

## Live demo

[Add the GitHub Pages link here, for example `https://ikawbuang.github.io/SecureTrade/frontend/login.html`]

## Tech stack (frontend / UI)

| Technology | Used for |
|---|---|
| HTML5 | Page structure |
| CSS3 | Layout and styling (one shared `style.css`, responsive) |
| JavaScript | Interactions: tabs, accept/decline, search and filters, chat, dialogs, live fee preview |
| `data.js` | Single source of sample data and names, read by every page |
| Google Fonts | Chakra Petch (headings), Figtree (body) |
| Git and GitHub | Version control and hosting |
| [Figma or paper] | Low-fidelity wireframes |

## How to open it

1. Download or clone this repository.
2. Open `frontend/login.html` in a web browser.
3. Click **Sign in** (any input works) to enter the prototype.

Keep `data.js` and `style.css` in the same folder as the pages. An internet connection is only needed for the Google Fonts.

## Pages

| Page | File | What it shows |
|---|---|---|
| Sign in / Create account | `login.html` | Switches between sign in and registration; explains how escrow works |
| Dashboard | `dashboard.html` | Trade requests (accept/decline), funds held, active trades with All / Buying / Selling tabs |
| New trade | `create-transaction.html` | Role choice, trade form, live cost breakdown, partner finder with online/offline status |
| Trade details | `transaction.html` | Progress tracker, chat, evidence upload; different view for buyer and seller |
| Report a problem | `dispute.html` | Dispute form with reason, description, evidence and desired outcome |
| History | `history.html` | Search and filter past trades; digital receipt with buyer and seller names |
| Admin | `admin-dashboard.html` | Platform numbers, dispute review (refund or pay seller), transactions, users |

## Changing names and sample data

All names and sample data live in **`data.js`**: brand, team, users, trades, requests, history and admin numbers. Edit it there and every page updates.

## Design Thinking summary

**1. Empathize.** A Google Forms survey for gamers about their trading experience, how they protect themselves, wanted features and the service fee.
Respondents: [number]. Key findings: [two or three findings with numbers].

**2. Define.** Problem statement: *Gamers who trade digital items with strangers need a trusted way to hold payment until delivery is confirmed, because they currently risk losing money or items to scams.* [Adjust using the survey results.]

**3. Ideate.** Features were prioritized (must have, should have, future work). Key decision: **one dashboard for both buyers and sellers**. Whoever creates a trade sends a request that appears on the partner's dashboard, where it can be accepted or declined. A user's role is set per trade, not per account.

**4. Prototype.** Hand-drawn wireframes (see `docs/`), then the coded high-fidelity pages above.

**5. Test.** [Number] people tried the main flow. [One or two changes made from their feedback.]

## Repository layout

```
SecureTrade/
├── README.md
├── frontend/
│   ├── login.html
│   ├── dashboard.html
│   ├── create-transaction.html
│   ├── transaction.html
│   ├── dispute.html
│   ├── history.html
│   ├── admin-dashboard.html
│   ├── style.css
│   └── data.js
└── docs/            (screenshots, survey summary, wireframes)
```

## Team Alt-F4

[Almario, Jessen], [Anding, Jahn Patrick], [Angel, Waren], [Yusores, Rudolf], [Mantalaba, Erica]
