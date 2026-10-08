/* ==========================================================
   data.js – the ONE place for names and sample data.
   Edit a name here and every page updates.
   Load this file before each page's own script:
     <script src="data.js"></script>
   ========================================================== */

const ST = {

  /* ---------- Branding ---------- */
  brand: { first: 'Secure', second: 'Trade' },   // shown as SecureTrade (second part is gold)
  team: 'Alt-F4',
  course: 'SIA101',

  /* ---------- Rules ---------- */
  feeRate: 0.03,            // 3% service fee
  autoReleaseHours: 2,      // payment releases this many hours after delivery

  /* ---------- The person using the prototype ---------- */
  me: {
    name: 'Jahn Patrick Anding',
    first: 'Patrick',
    username: '@Anding_JP',
    completedTrades: 12
  },

  /* ---------- Status key -> [badge class, label] ---------- */
  status: {
    held:             ['badge-held',     'Payment held'],
    waiting_seller:   ['badge-pending',  'Waiting for seller'],
    confirm:          ['badge-released', 'Confirm receipt'],
    dispute:          ['badge-dispute',  'In dispute'],
    await_pay:        ['badge-pending',  'Waiting for your payment'],
    await_buyer_pay:  ['badge-pending',  "Waiting for buyer's payment"],
    completed:        ['badge-released', 'Completed'],
    refunded:         ['badge-dispute',  'Refunded'],
    cancelled:        ['badge-pending',  'Cancelled']
  },

  /* ---------- Everyone on the platform (anyone can buy or sell) ---------- */
  users: [
    { username: '@Angel_Waren',    status: 'online',  trades: 18, rating: 4.8, joined: '2026-08-12', account: 'Active' },
    { username: '@Yusores_Yudolf', status: 'online',  trades: 34, rating: 4.9, joined: '2026-08-30', account: 'Active' },
    { username: '@Almario_Jessen', status: 'online',  trades: 27, rating: 4.6, joined: '2026-08-21', account: 'Active' },
    { username: '@Mantalaba_Erica',status: 'online',  trades: 3,  rating: 4.8, joined: '2026-10-06', account: 'Active' },
    { username: '@Cortes_Mavs',    status: 'offline', lastSeen: '25 min ago',  trades: 15, rating: 4.7, joined: '2026-09-02', account: 'Active' },
    { username: '@Ikaw_Buang',     status: 'offline', lastSeen: '2 hours ago', trades: 7,  rating: 4.5, joined: '2026-10-03', account: 'Active' },
    { username: '@Anding_Aries',   status: 'offline', lastSeen: 'Yesterday',   trades: 11, rating: 4.4, joined: '2026-09-25', account: 'Active' },
    { username: '@Anding_Tala',    status: 'offline', lastSeen: '3 days ago',  trades: 21, rating: 3.9, joined: '2026-09-14', account: 'Under review' }
  ],

  /* ---------- My active trades (role = what I am in that trade) ---------- */
  trades: [
    { id: 'ST-1051', item: 'Mobile Legends', game: 'Mobile Legends', role: 'seller', partner: '@Yusores_Yudolf',
      amount: 3000, status: 'held', started: 'Oct 8, 2026',
      chat: [['them', '1:48 PM', 'I paid. Ready when you are.'], ['me', '1:51 PM', 'Sending the account details now.']] },

    { id: 'ST-1048', item: 'Crossfire', game: 'Valorant', role: 'buyer', partner: '@Angel_Waren',
      amount: 1200, status: 'waiting_seller', started: 'Oct 7, 2026',
      chat: [['me', '10:05 AM', 'Paid into escrow. Please send when you can.'], ['them', '10:12 AM', 'Got it, sending tonight.']] },

    { id: 'ST-1047', item: 'Roblox (Robux)', game: 'Roblox', role: 'seller', partner: '@Mantalaba_Erica',
      amount: 300, status: 'dispute', started: 'Oct 6, 2026', chat: [] },

    { id: 'ST-1042', item: 'Grow a Garden', game: 'Genshin Impact', role: 'buyer', partner: '@Almario_Jessen',
      amount: 1500, status: 'confirm', started: 'Oct 8, 2026',
      chat: [['them', '2:14 PM', 'Sent the primogems to your UID. Please check.'], ['me', '2:16 PM', 'Checking now, thanks.']] }
  ],

  /* ---------- Requests other users sent me (myRole = what I would be) ---------- */
  requests: [
    { id: 'RQ-1', from: '@Anding_Aries', myRole: 'seller', item: 'Roblox',       game: 'Roblox', amount: 2500 },
    { id: 'RQ-2', from: '@Anding_Tala',  myRole: 'buyer',  item: 'MLBB Account', game: 'MLBB',   amount: 900 }
  ],

  /* ---------- My finished trades (History page) ---------- */
  history: [
    { id: 'ST-1031', date: 'Oct 5, 2026',  item: 'Crossfire',            role: 'seller', partner: '@Angel_Waren',     amount: 3000, status: 'completed' },
    { id: 'ST-1024', date: 'Sep 29, 2026', item: 'Grow a Garden',        role: 'buyer',  partner: '@Mantalaba_Erica', amount: 1200, status: 'completed' },
    { id: 'ST-1018', date: 'Sep 21, 2026', item: 'Roblox Robux (1,000)', role: 'buyer',  partner: '@Mantalaba_Erica', amount: 500,  status: 'refunded' },
    { id: 'ST-1009', date: 'Sep 12, 2026', item: 'CS2',                  role: 'seller', partner: '@Anding_Aries',    amount: 1500, status: 'completed' },
    { id: 'ST-1002', date: 'Sep 3, 2026',  item: 'Valorant skin bundle', role: 'buyer',  partner: '@Almario_Jessen',  amount: 800,  status: 'cancelled' }
  ],

  /* ---------- Admin: platform-wide numbers ---------- */
  admin: {
    heldInEscrow: 48300,
    tradesThisMonth: 214,
    feesEarned: 9870,

    disputes: [
      { id: 'DP-214', tradeId: 'ST-1047', item: 'Roblox limited item', buyer: '@Mantalaba_Erica', seller: '@Anding_JP', amount: 300,
        reason: 'I did not receive the item',
        story: 'Seller said it was sent at 8 PM but my inventory is empty. I checked twice.',
        reply: 'Item was sent to the username given. Buyer may have given the wrong account.',
        proof: ['buyer-inventory.png', 'chat-8pm.png'] },
      { id: 'DP-216', tradeId: 'ST-1038', item: 'Mobile Legends account', buyer: '@Anding_Tala', seller: '@Almario_Jessen', amount: 3000,
        reason: 'Item is different from the description',
        story: 'Listing said Mythic rank. The account is Epic and skins are missing.',
        reply: 'Account was Mythic last season. Rank reset happened after the season ended.',
        proof: ['rank-screen.png', 'skins-list.png', 'listing-copy.png'] },
      { id: 'DP-218', tradeId: 'ST-1042', item: 'Grow a Garden', buyer: '@Ikaw_Buang', seller: '@Mantalaba_Erica', amount: 1500,
        reason: 'I did not receive the item',
        story: 'Marked as sent but only 1,640 primogems arrived, not 3,280.',
        reply: 'Sent the full amount in two top-ups. Second one may be delayed.',
        proof: ['primogem-balance.png'] }
    ],

    recentTransactions: [
      { id: 'ST-1046', item: 'Crossfire',            buyer: '@Angel_Waren',     seller: '@Anding_JP',       amount: 1200, status: 'waiting_seller' },
      { id: 'ST-1045', item: 'Mobile Legends skin',  buyer: '@Anding_Tala',     seller: '@Yusores_Yudolf',  amount: 600,  status: 'held' },
      { id: 'ST-1044', item: 'Roblox Robux (2,000)', buyer: '@Mantalaba_Erica', seller: '@Almario_Jessen',  amount: 1000, status: 'completed' },
      { id: 'ST-1043', item: 'Grow a Garden',        buyer: '@Ikaw_Buang',      seller: '@Mantalaba_Erica', amount: 4500, status: 'held' },
      { id: 'ST-1042', item: 'MLBB Acount',          buyer: '@Anding_Tala',     seller: '@Almario_Jessen',  amount: 1500, status: 'dispute' }
    ]
  }
};

/* ==========================================================
   Helpers shared by every page
   ========================================================== */

// ₱1,500.00
ST.peso = n => '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ₱1,500
ST.pesoShort = n => '₱' + n.toLocaleString('en-PH');

// '2026-10-06' -> 'Oct 6, 2026'
ST.fmtDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// A coloured status badge element
ST.badge = key => {
  const s = ST.status[key] || ['badge-pending', key];
  const el = document.createElement('span');
  el.className = 'badge ' + s[0];
  el.textContent = s[1];
  return el;
};

// Find one of my active trades by id
ST.findTrade = id => ST.trades.find(t => t.id === id);

// Fill every .brand element and the page title with the brand name
ST.applyBrand = () => {
  document.querySelectorAll('.brand').forEach(el => {
    const second = document.createElement('span');
    second.textContent = ST.brand.second;
    el.textContent = ST.brand.first;
    el.appendChild(second);
  });
  document.title = document.title.replace('SecureTrade', ST.brand.first + ST.brand.second);
};
