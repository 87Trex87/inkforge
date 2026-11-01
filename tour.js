'use strict';
/* InkForge tour: a guided look around with live examples.
   Before anything is added, a copy of the whole workspace database is kept (in memory and in OPFS as
   tour-<workspace>.sqlite). Finishing or skipping puts that copy back, so every example and change is
   gone. If the app closes mid-tour, the next start finds the copy and restores it (Tour.recover).
   While the tour runs, Google Calendar and Google Drive don't sync. The tour never creates media files.

   Keep TOUR_STEPS up to date: when a screen, control or feature moves or is added, change its stop here
   (route, the element it highlights, the short text and the "See more" text). */
const TOUR_VERSION = 1;
const Tour = { on: false, steps: [], i: 0, ids: {}, snap: null, el: null };

const tourFile = async (create) => (await navigator.storage.getDirectory()).getFileHandle(`tour-${WS.cur?.id || 'main'}.sqlite`, { create });
const tourWait = (sel, ms = 3000) => new Promise((res) => {
  const t0 = Date.now(), look = () => { const e = sel && document.querySelector(sel); if (e || !sel || Date.now() - t0 > ms) return res(e || null); setTimeout(look, 80); };
  look();
});
const tourSleep = (ms) => new Promise(r => setTimeout(r, ms));
const tourGo = async (route, sel) => { Dirty.set(false); if (location.hash !== '#' + route) { location.hash = route; await tourSleep(250); } else render(); return tourWait(sel); };

// Example records, added once at the start (all removed again at the end).
async function tourSeed() {
  const t = new Date(), d = (n) => ymd(addDays(t, n)), bd = addDays(t, 3);
  await DB.run(`INSERT INTO clients (first_name, last_name, phone, email, instagram, category, tags, dob, medical, notes) VALUES
    ('Sam', 'Example', '+27 82 000 0000', 'sam@example.com', 'sam.example', 'Client', 'regular, fine line', ?, 'Allergic to latex', 'Example client from the tour'),
    ('Jordan', 'Sample', '+27 83 000 0000', NULL, NULL, 'Client', 'first tattoo', NULL, NULL, NULL)`, [`1994-${pad(bd.getMonth() + 1)}-${pad(bd.getDate())}`]);
  const sam = (await DB.one(`SELECT id FROM clients WHERE last_name = 'Example'`)).id, jo = (await DB.one(`SELECT id FROM clients WHERE last_name = 'Sample'`)).id;
  const b = (c, at, dur, kind, desc, place, q, dep, paid) => DB.run(`INSERT INTO bookings (client_id, start_at, duration_min, kind, description, placement, size, quote, deposit, deposit_paid) VALUES (?, ?, ?, ?, ?, ?, '12 x 8 cm', ?, ?, ?)`,
    [c, at, dur, kind, desc, place, q, dep, paid]);
  await b(sam, d(0) + 'T13:00', 180, 'tattoo', 'Fine-line rose with stem', 'Left forearm', 1800, 450, 1);
  await b(jo, d(1) + 'T10:00', 60, 'consult', 'Small script, first tattoo', null, null, null, 0);
  await b(sam, d(9) + 'T11:00', 240, 'tattoo', 'Peony half sleeve, session 1', 'Right upper arm', 3200, 800, 0);
  await DB.run(`INSERT INTO bookings (client_id, start_at, duration_min, kind, description, placement, quote, deposit, deposit_paid, completed, completed_at, paid, time_min, pay_method)
    VALUES (?, ?, 120, 'tattoo', 'Minimal moon', 'Wrist', 900, 250, 1, 1, ?, 950, 110, 'Card')`, [jo, d(-12) + 'T14:00', addDays(t, -12).toISOString()]);
  const bk = (await DB.one(`SELECT id FROM bookings WHERE description = 'Fine-line rose with stem'`)).id;
  await DB.run(`INSERT INTO inventory_items (name, category, unit, qty, min_qty, supplier, cost) VALUES ('Black ink 4oz', 'Ink', 'bottle', 1, 2, 'Supplier', 320),
    ('Needles 3RL', 'Needles', 'box', 6, 2, 'Supplier', 180), ('Aftercare balm', 'Aftercare', 'tub', 12, 4, NULL, 45)`);
  await DB.run(`INSERT INTO rules (title, body, category) VALUES ('Deposits are non-refundable', 'They secure your date and go towards the final price.', 'Client rules'),
    ('Arrive fed and hydrated', 'Eat a proper meal before your session.', 'Client rules')`);
  Tour.ids = { sam, jo, bk };
}

/* The stops. route: screen to open; sel: what to highlight; run: the demo for this stop.
   text: one or two short lines; more: the longer "See more" description. */
const TOUR_STEPS = [
  { id: 'welcome', basic: 1, title: 'Welcome to InkForge',
    text: 'A quick look at how InkForge runs your studio. We\'ll add a few examples as we go.',
    more: 'Everything the tour adds or changes is removed when it ends or when you skip it, so your own data is untouched. Tap Next to move on; the tour does the tapping for you.' },
  { id: 'home', basic: 1, route: 'home', sel: '#home-today', title: 'Your day at a glance',
    text: 'Today\'s sessions, and birthdays coming up this week.',
    more: 'Tap a session to open it. Birthdays show a Send wishes button that opens WhatsApp with a short message from your studio. Quick links for the stencil maker and quotes sit below.' },
  { id: 'clients', basic: 1, route: 'clients', sel: '#c-list', title: 'Clients',
    text: 'Everyone in one place, searchable by name, phone or tag.',
    more: 'Group contacts into categories (clients, suppliers and your own), print a phonebook or export it to a spreadsheet. Phone numbers are kept with the country code so WhatsApp works from every card.' },
  { id: 'client', route: () => 'client/' + Tour.ids.sam, sel: '#view .card', title: 'A client\'s card',
    text: 'Contact, health notes in red, bookings, forms and portfolio.',
    more: 'Call, text or WhatsApp in one tap. Medical notes and allergies are highlighted so they\'re never missed. Their bookings, signed consent forms and tattoos in your portfolio are all listed here.' },
  { id: 'book', basic: 1, route: 'book', sel: '.mwrap, #cal', title: 'Your calendar',
    pre: () => { Cal.mode = 'month'; Cal.date = new Date(); },
    text: 'Names on every day, coloured by booking type.',
    more: 'Switch between day, week and month. Tap a day to see its bookings; + Book adds one. Days off are greyed out, and bookings can sync both ways with Google Calendar.' },
  { id: 'booking', route: () => 'booking-edit/' + Tour.ids.bk, sel: '#b-form', title: 'A booking',
    text: 'Who, when, the tattoo, price and deposit on one screen.',
    more: 'Mark the deposit as paid, add reference photos and notes. After the session, tick Tattoo completed to record what was paid and how long it took; then send a thank-you receipt or book a healing check.' },
  { id: 'quote', basic: 1, route: 'quote', sel: '.qz-card-main', title: 'Quote in seconds',
    run: async () => {
      Object.assign(QZ, QZ_RESET); qzDraw(); await tourSleep(500);
      Object.assign(QZ, { place: 'Forearm', side: 'L' }); qzDraw(); await tourSleep(700);
      Object.assign(QZ, { sized: true, w: 12, h: 18, colour: 'black', detail: 3, detailSet: true, styleSet: true, style: 'Fine Line', lettering: false, seen: 6 });
      qzGo(2); await tourSleep(500); qzGo(3); await tourSleep(500); qzGo(6); await tourSleep(300);
    },
    text: 'Placement, size, colour, detail and style: the price comes from your own rates.',
    more: 'Calibrate holds your rates, speeds and pain areas. Quotes handle cover-ups and fix-ups with a difficulty slider, several tattoos at once with a combined price, discounts and VAT.' },
  { id: 'qsend', route: 'quote', sel: '.qz-out', title: 'Send it your way',
    text: 'Print, picture, text, or a link the client books from.',
    more: 'The quote link opens on the client\'s phone: they see the price and your open days, pick a time and reply on WhatsApp. Paste their reply into Saved quotes and it becomes a booking. Book with this quote does it directly.' },
  { id: 'saved', route: 'quotes', sel: '#ql', title: 'Saved quotes',
    pre: async () => { if (!QZ.place) Object.assign(QZ, { place: 'Forearm', side: 'L', w: 12, h: 18, colour: 'black', sized: true, detailSet: true, styleSet: true, lettering: false });
      QZ.client = 'Sam Example'; await qzSaveQuote(true); },
    text: 'Keep quotes to finish or book later.',
    more: 'Mark them done when the tattoo is finished, and see how the real time compared with the quote, so you can fine-tune your rates.' },
  { id: 'studio', basic: 1, route: 'studio', sel: '#view', title: 'Studio tools',
    text: 'Stencils, reels, designs, bends and big prints.',
    more: 'Everything for making the work: the stencil maker, the reel maker, the design studio for vouchers, cards and posts, the bend tool for bands, and split printing for large stencils. Your portfolio and consent forms live here too.' },
  { id: 'stencil', route: 'stencil', sel: '#view .card', title: 'Stencil maker',
    text: 'Photo to a clean stencil, printed at real size.',
    more: 'Choose lines, lines with shading or solid, tune the detail, then print at the width you need. Too big for one sheet? Split spreads it over several pages to tape together.' },
  { id: 'designs', route: 'designs', sel: '#dz-list', title: 'Design studio',
    text: 'Vouchers, business cards, flyers and tattoo posts.',
    more: 'Start from a template and theme; your studio name, logo and contact fill in. Add text, pictures and shapes, bend text into an arc, crop and arrange layers, then print a sheet or share a post. Save your own templates.' },
  { id: 'bend', route: 'studio', sel: '[data-go="bend"]', title: 'Bend and split',
    text: 'Arc a band to sit flush, or split a back piece over pages.',
    more: 'The bend tool curves a design so a band meets neatly around an arm or leg, and can send it straight to the stencil maker. Split for printing cuts a large stencil into labelled pages with an overlap for taping.' },
  { id: 'portfolio', route: 'portfolio', sel: '#view', title: 'Portfolio',
    text: 'Your tattoos, art and flash, with fresh and healed photos.',
    more: 'Print a portfolio book, set a white or black background for flash, zoom into photos, and turn any piece into a social post with one tap.' },
  { id: 'forms', route: 'forms', sel: '#view', title: 'Consent and aftercare',
    text: 'Clients read, tick and sign on your phone or tablet.',
    more: 'Edit the forms to suit your studio. Signed copies are kept on the client\'s card; aftercare can be printed or sent with the receipt.' },
  { id: 'more', basic: 1, route: 'more', sel: '#view', title: 'Running the studio',
    text: 'Quotes, stats, stock, your rule book and settings.',
    more: 'Stats shows tattoos, hours and earnings over time. Inventory tracks stock with low-stock alerts and stock takes. The rule book keeps your studio rules for clients and staff.' },
  { id: 'stock', route: 'inventory', sel: '#view', title: 'Stock',
    text: 'Items running low are flagged and go on a shopping list.',
    more: 'Do a stock take on your phone, print a blank count sheet, or the current stock with values.' },
  { id: 'stats', route: 'stats', sel: '#st-body, #view', title: 'Stats',
    text: 'Tattoos, hours and earnings by month or year.',
    more: 'Pick a period, see averages per tattoo and per hour, and export to a spreadsheet for your books.' },
  { id: 'backup', basic: 1, route: 'settings', sel: '[data-sec="backup"]', title: 'Keep it safe',
    pre: () => SET_OPEN.add('backup'),
    text: 'Everything stays on this device. Save a backup file now and then.',
    more: 'A backup holds all your data and photos. You can merge another backup in, keep a workspace in your own Google Drive to use on several devices, and run first-time setup or this tour again from Settings.' },
  { id: 'workspace', route: 'settings', sel: '#db-badge', title: 'Workspaces',
    text: 'Tap here to switch between studios or artists.',
    more: 'Each workspace has its own clients, bookings and settings. Keep one per artist, or a test workspace to try things out.' },
  { id: 'end', basic: 1, title: 'That\'s the tour',
    text: 'Finish removes all the examples. Run it again any time from Settings.',
    more: 'Tip: start with first-time setup (your hours, days off and prices), add your logo, then try a quote. Everything can be changed later.' }
];

/* ---------- Running the tour ---------- */
// Choose Basics or In depth.
function tourOffer(after) {
  const o = document.createElement('div'); o.id = 'merge-dlg';
  o.innerHTML = `<div class="card tour-offer"><h2>Take a tour?</h2>
    <p class="muted" style="margin-top:0">A guided look around with examples. Everything it adds is removed when it ends.</p>
    <button class="tour-pick" data-t="basic"><b>The basics</b><span>About a minute: home, clients, calendar, quotes and the main tools.</span></button>
    <button class="tour-pick" data-t="full"><b>In depth</b><span>About three minutes: everything InkForge can do, screen by screen.</span></button>
    <button class="btn" data-t="" style="width:100%;margin-top:10px">${after ? 'Not now' : 'Cancel'}</button></div>`;
  o.onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b) return; o.remove(); if (b.dataset.t) Tour.start(b.dataset.t); };
  document.body.appendChild(o);
}

Tour.start = async (kind) => {
  if (Tour.on) return;
  // The safety copy first: if this fails, no examples are added.
  try {
    await Snapshot.save();
    const bytes = await DB.exportBytes();
    Tour.snap = bytes.slice();
    const w = await (await tourFile(true)).createWritable(); await w.write(bytes); await w.close();
  } catch (e) { return toast('Could not start the tour: ' + e.message, 5000); }
  Tour.on = true; Tour.back = location.hash || '#home';
  Tour.steps = TOUR_STEPS.filter(s => kind === 'full' || s.basic);
  Tour.i = 0;
  try { await tourSeed(); } catch (e) { console.warn('Tour examples:', e); }
  Tour.el = document.createElement('div'); Tour.el.id = 'tour';
  Tour.el.innerHTML = `<div class="tour-hole" hidden></div><div class="tour-card"></div>`;
  document.body.appendChild(Tour.el);
  addEventListener('resize', tourPlace); document.addEventListener('scroll', tourPlace, true);
  Tour.show();
};

Tour.show = async () => {
  const s = Tour.steps[Tour.i], card = Tour.el.querySelector('.tour-card'), n = Tour.steps.length;
  card.classList.remove('more');
  card.innerHTML = `<div class="tour-top"><span class="tour-n">${Tour.i + 1} / ${n}</span><button class="link" data-a="skip">${Tour.i === n - 1 ? '' : 'Skip tour'}</button></div>
    <h3>${s.title}</h3><p class="tour-t">${s.text}</p><p class="tour-m">${s.more || ''}</p>
    <div class="tour-acts">${s.more ? '<button class="btn small" data-a="more">See more</button>' : '<span></span>'}
      <span style="flex:1"></span>${Tour.i ? '<button class="btn small" data-a="back">Back</button>' : ''}
      <button class="btn small primary" data-a="next" disabled>${Tour.i === n - 1 ? 'Finish' : 'Next'}</button></div>
    <div class="tour-dots">${Tour.steps.map((_, j) => `<i class="${j === Tour.i ? 'on' : j < Tour.i ? 'done' : ''}"></i>`).join('')}</div>`;
  card.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'more') { card.classList.toggle('more'); e.target.textContent = card.classList.contains('more') ? 'Less' : 'See more'; tourPlace(); }
    if (a === 'next') { if (Tour.i === n - 1) return Tour.end(); Tour.i++; Tour.show(); }
    if (a === 'back') { Tour.i--; Tour.show(); }
    if (a === 'skip') Tour.end();
  };
  Tour.target = null; tourPlace();
  // Open the screen, run the demo, then highlight.
  try {
    if (s.pre) await s.pre();
    if (s.route) Tour.target = await tourGo(typeof s.route === 'function' ? s.route() : s.route, s.sel);
    if (s.run) await s.run();
    if (s.sel) Tour.target = await tourWait(s.sel, 1500);
    Tour.target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await tourSleep(350);
  } catch (e) { console.warn('Tour step', s.id, e); }
  if (Tour.steps[Tour.i] !== s) return;   // moved on meanwhile
  tourPlace();
  const nx = card.querySelector('[data-a="next"]'); if (nx) nx.disabled = false;
};

// The spotlight around the highlighted part, and the card beside it (a bottom sheet on phones).
function tourPlace() {
  if (!Tour.el) return;
  const hole = Tour.el.querySelector('.tour-hole'), card = Tour.el.querySelector('.tour-card'), t = Tour.target;
  if (!t || !document.body.contains(t)) { hole.hidden = true; card.className = card.className.replace(/ ?at-\w+/g, '') + ' at-mid'; return; }
  const r = t.getBoundingClientRect(), pad = 6, top = Math.max(4, r.top - pad), h = Math.min(innerHeight - top - 4, r.height + pad * 2);
  Object.assign(hole.style, { left: Math.max(4, r.left - pad) + 'px', top: top + 'px', width: Math.min(innerWidth - 8, r.width + pad * 2) + 'px', height: Math.max(20, h) + 'px' });
  hole.hidden = false;
  card.className = card.className.replace(/ ?at-\w+/g, '');
  if (innerWidth < 700) return card.classList.add('at-sheet');
  // Beside the highlight where there's room, otherwise below or above it.
  const cw = card.offsetWidth || 340, ch = card.offsetHeight || 200;
  let x, y;
  // A highlight that fills most of the screen: the card sits in the bottom-right corner over it.
  if (r.width * r.height > innerWidth * innerHeight * 0.35) { x = innerWidth - cw - 20; y = innerHeight - ch - 20; }
  else if (r.right + cw + 24 < innerWidth) { x = r.right + 16; y = r.top; }
  else if (r.left - cw - 24 > 0) { x = r.left - cw - 16; y = r.top; }
  else if (r.bottom + ch + 16 < innerHeight) { x = r.left; y = r.bottom + 12; }
  else { x = r.left; y = Math.max(12, r.top - ch - 12); }
  card.style.left = Math.max(12, Math.min(innerWidth - cw - 12, x)) + 'px'; card.style.top = Math.max(12, Math.min(innerHeight - ch - 12, y)) + 'px';
  card.classList.add('at-float');
}

// Put the workspace back exactly as it was before the tour.
Tour.end = async () => {
  if (!Tour.on) return;
  const card = Tour.el?.querySelector('.tour-card'); if (card) card.innerHTML = '<p class="tour-t" style="margin:0">Removing the examples…</p>';
  try { if (Tour.snap) await DB.importBytes(Tour.snap); } catch (e) { toast('Could not remove the tour examples: ' + e.message, 8000); return; }
  await tourCleanUp();
  toast('Tour finished. Your data is just as it was.');
};
async function tourCleanUp() {
  Tour.on = false; Tour.snap = null; Tour.target = null;
  removeEventListener('resize', tourPlace); document.removeEventListener('scroll', tourPlace, true);
  Tour.el?.remove(); Tour.el = null;
  try { await (await navigator.storage.getDirectory()).removeEntry(`tour-${WS.cur?.id || 'main'}.sqlite`); } catch {}
  Settings.cache = {}; await Settings.load();
  Object.assign(QZ, QZ_RESET); Cal.date = new Date(); Dirty.set(false);
  location.hash = Tour.back && !/booking-edit|client\/|#tour/.test(Tour.back) ? Tour.back : '#home'; render();
}
// Start-up: a tour that didn't finish (app closed) left its safety copy behind; put it back.
Tour.recover = async () => {
  let f; try { f = await (await tourFile(false)).getFile(); } catch { return false; }
  if (!f.size) return false;
  await DB.importBytes(new Uint8Array(await f.arrayBuffer()));
  try { await (await navigator.storage.getDirectory()).removeEntry(`tour-${WS.cur?.id || 'main'}.sqlite`); } catch {}
  return true;
};
