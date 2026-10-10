# SecureTrade

**SIA101 – Systems Integration and Architecture · Deliverable 5**
UI prototype built with the Design Thinking Process · Team Alt-F4

SecureTrade is an escrow platform for gamers who buy and sell in-game items, accounts and currency. The buyer pays into escrow, the seller delivers, the buyer confirms, and only then is the payment released to the seller (minus a 3% service fee). If something goes wrong, either side can open a dispute and an administrator decides.

> This is a **non-functional UI prototype**. It uses sample data and has no backend or database. The backend will be integrated in a later phase.

**Live demo:** https://ikawbuang.github.io/SecureTrade/frontend/login.html

## Tech stack (frontend / UI)

| Technology | Used for |
|---|---|
| HTML5 | Page structure |
| CSS3 | Layout and styling (one shared `style.css`, responsive) |
| JavaScript | Interactions: tabs, accept/decline, search and filters, chat, dialogs, live fee preview |
| `data.js` | Single source of sample data and names, read by every page |
| Google Fonts | Chakra Petch (headings), Figtree (body) |
| Git and GitHub | Version control and hosting |
| Digital wireframes | Low-fidelity layouts of the seven screens (`docs/wireframes/`) |

## How to open it

1. Download or clone this repository.
2. Open `frontend/login.html` in a web browser.
3. Click **Sign in** (any input works) to enter the prototype.

Keep `data.js` and `style.css` in the same folder as the pages. An internet connection is only needed for the Google Fonts.

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

Features were prioritized into must have, should have and future work, using the survey results.

| Feature | Priority | Covered in the prototype |
|---|---|---|
| Register and sign in | Must | Yes |
| Trade request (send, accept, decline) | Must | Yes |
| Escrow payment hold | Must | Yes |
| Delivery and buyer confirmation | Must | Yes |
| Dispute with evidence upload | Must | Yes |
| Admin dispute review (refund or pay seller) | Must | Yes |
| Transaction history and receipts | Should | Yes |
| In-app chat | Should | Yes |
| Partner finder with online/offline status | Should | Yes |
| Auto-release after 2 hours | Should | Shown in the trade progress |
| Seller ratings and reviews | Future work | Partly: ratings are shown in the partner finder |
| Automatic refund when the seller does not deliver | Future work | Manual refund by the admin only |
| ID verification and repeat-scammer bans | Future work | No |

**Key decision: one dashboard for both buyers and sellers.** Whoever creates a trade sends a request that appears on the partner's dashboard, where it can be accepted or declined. A user's role (buyer or seller) is set per trade, not per account, and the Active trades table can be filtered by All, Buying or Selling.

### 4. Prototype

Low-fidelity wireframes were made first, then the high-fidelity pages were coded in HTML, CSS and JavaScript.

| Screen | File | Wireframe | Screenshot |
|---|---|---|---|
| Sign in / Create account | `login.html` | <img src="docs/wireframes/01-login.png" width="320"> | <img src="docs/screenshots/01-login.png" width="320"> |
| Dashboard | `dashboard.html` | <img src="docs/wireframes/02-dashboard.png" width="320"> | <img src="docs/screenshots/02-dashboard.png" width="320"> |
| New trade | `create-transaction.html` | <img src="docs/wireframes/03-new-trade.png" width="320"> | <img src="docs/screenshots/03-new-trade.png" width="320"> |
| Trade details | `transaction.html` | <img src="docs/wireframes/04-trade-details.png" width="320"> | <img src="docs/screenshots/04-trade-details.png" width="320"> |
| Report a problem | `dispute.html` | <img src="docs/wireframes/05-dispute.png" width="320"> | <img src="docs/screenshots/05-dispute.png" width="320"> |
| History and receipt | `history.html` | <img src="docs/wireframes/06-history.png" width="320"> | <img src="docs/screenshots/06-history.png" width="320"> |
| Admin | `admin-dashboard.html` | <img src="docs/wireframes/07-admin.png" width="320"> | <img src="docs/screenshots/07-admin.png" width="320"> |

**Design choices**

- A deep indigo and gold palette: indigo for a serious, trustworthy base, and gold for held funds and main actions.
- Status is always shown with a text label as well as a colour, for example Online or Offline and Payment held.
- The most important number on the dashboard is the amount currently held in escrow.
- The side menu stays visible while scrolling, and the layout adapts to small screens.

### 5. Test

Five people tried the prototype without help: Ruel, Jesso, Kristel, Tala and Jessel. They were left to explore it freely, with no set tasks. They liked it and said it was clear, easy to read, and less confusing than Binance. No one got stuck, so no changes were needed in this round.

**Next improvements from the survey:** make seller ratings and automatic refunds real features, and add ID verification.

## Changing names and sample data

All names and sample data live in **`data.js`**: brand, team, users, trades, requests, history and admin numbers. Edit it there and every page updates.

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
└── docs/
    ├── wireframes/
    └── screenshots/
```

## Team Alt-F4
Leader: Almario, Jessen
Member: 
    1. Anding, Jahn Patrick
    2. Angel, Waren
    3. Mantalaba, Erica
    4. Yusores, Rudolf