'use strict';
/* InkForge tour: a guided look around with live examples.
   The tour runs in the practice workspace: choosing it makes a fresh one (replacing any old one, as only one is
   kept), switches to it and starts there (Tour.begin, then Tour.resume once it has opened). At the end the
   artist keeps playing there, or goes back to their own workspace and the practice one is deleted.
   An older tour run inside a real workspace kept a safety copy (tour-<workspace>.sqlite); Tour.recover still
   puts such a copy back if one is found. The practice workspace never syncs with Google.

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
    text: 'A quick look at how InkForge runs your studio, in a practice workspace full of made-up clients, bookings and work.',
    more: 'Your own workspace is untouched. Tap Next to move on; the tour does the tapping for you. At the end, keep playing here or go back to your workspace, and the practice one is deleted. Anything you make here is only for trying things out, but what you save to your device or share (a PNG, a PDF, a reel) is yours to keep.' },
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
    more: 'Calibrate holds your rates, speeds and pain areas, a tab for each, and Save and share exports it to load into another workspace. Quotes handle cover-ups and fix-ups with a difficulty slider, several tattoos at once with a combined price, discounts and VAT.' },
  { id: 'qsend', route: 'quote', sel: '.qz-out', title: 'Send it your way',
    text: 'Print, picture, text, or a link the client books from.',
    more: 'The quote link opens on the client\'s phone: they see the price and your open days, pick a time and reply on WhatsApp. Paste their reply into Saved quotes and it becomes a booking. Book with this quote does it directly.' },
  { id: 'saved', route: 'quotes', sel: '#ql', title: 'Saved quotes',
    pre: async () => { if (!QZ.place) Object.assign(QZ, { place: 'Forearm', side: 'L', w: 12, h: 18, colour: 'black', sized: true, detailSet: true, styleSet: true, lettering: false });
      QZ.client = 'Sam Example'; await qzSaveQuote(true); },
    text: 'Keep quotes to finish or book later.',
    more: 'Mark them done when the tattoo is finished, and see how the real time compared with the quote, so you can fine-tune your rates. Search them, star favourites and sort them into folders.' },
  { id: 'studio', basic: 1, route: 'studio', sel: '#view', title: 'Studio tools',
    text: 'Stencils, reels, designs, bends and big prints.',
    more: 'Everything for making the work: the stencil maker, the reel maker (saved reels you can edit again), the design studio for vouchers, cards and posts, the bend tool for bands, and split printing for large stencils. Your portfolio and consent forms live here too.' },
  { id: 'stencil', route: 'stencil', sel: '#view .card', title: 'Stencil maker',
    text: 'Photo to a clean stencil, printed at real size.',
    more: 'Choose lines, lines with shading or solid, tune the detail (undo and redo step back through every change), crop it (or Auto crop trims to where the stencil starts), then print at the width you need. Too big for one sheet? Split spreads it over several pages to tape together. Save to device or Share it, Keep it in Portfolio › Stencils, or send it to the tattoo simulator as a new piece with the stencil ready to trace, in normal or cheat mode. In the design studio, Make a stencil sends whatever you select here.' },
  { id: 'reels', route: 'reels', sel: '#reel-list', title: 'Reel maker',
    text: 'Vertical reels from your photos and videos, in your own style.',
    more: 'Each reel is saved as you go, with undo, so you can come back and change it. Intro and outro cards, captions, stickers, looks, transitions and music; your style and watermark make every reel match. Export it, then save it to your device or share it.' },
  { id: 'tattoo', route: 'tattoo', sel: '#tt', title: 'Tattoo simulator',
    text: 'Experimental: tattoo in ink on skin with needle groupings, with step-by-step lessons, challenges, medals and trophies.',
    more: 'Pick a page and skin tone, load a stencil to trace, hold the pen in an ink cap to load the needle (hold longer for more of that colour, dip into another to mix it like real pigment). Ink behaves like it does in skin: a light colour won’t take over a saturated dark one, but fills a feathered edge for a gradient, and colours meeting in the skin mix (blue into yellow makes green). Work in layers: linework, shadow, mid tone, light tone and highlights. The strip across the top holds quick shortcuts (pen lean, magnum angle, favourite needles, references); its + chooses what shows, favourite needles with their size (up to 5) and ink palettes (up to 3) included. Cheat mode keeps a strip of its own that can hold any cheat tool. Inks opens the palettes: the standard caps, Old school, Skin tones, Pastel greys, Pastel colours, grey wash and your own. The pencil edits a palette of up to 10 caps with a colour wheel, mixing and pre-diluted caps, and Share file sends it to Drive or a friend. Focus (top bar) hides every panel for a clean view, and Panels brings any of them back on its own. In the meter, hold the eye for a quick healed look and tap the grid for a skin damage map. Pressure sets depth, hand speed spaces the punctures, tilt spreads the needles; start with Tune in under the sliders icon: short steps (follow a stencil line, line with a round shader, match a shaded or packed block, set skin and needle look) fit every needle to your pen and hand, and Copy settings lets you send the result on. Each grouping can still be fine tuned there (needle hang too), and skin stretch is set there. Overworking the skin turns it red, swollen and then raw, and pressing too hard while pulling slowly blows the ink out under the skin (both can be adjusted under All needles). The references button floats pictures over the skin to follow (move, resize, turn, flip, lock to tattoo through them). The Apprentice exam runs eleven challenges, from straight lines to a finished heart, and ends with a report card. Challenges has over thirty single challenges (lining, shading, packing, colour and flash pieces), one to three stars each, with medals, personal bests, a trophy cabinet and a results sheet to print or save. Every piece keeps stats (strokes, distance, time). The full screen button at the top gives the skin the whole screen. Two fingers move, zoom and turn the skin to a comfortable angle (it snaps at every 90 degrees; Fit straightens it). The clock button previews the piece fresh, healed or after 10 years. Magnums keep their angle like a calligraphy nib (set it under the needle button, or with [ and ]), so you can line with one by pulling it along its row; the cursor shows which way it faces.' },
  { id: 'designs', route: 'designs', sel: '#dz-list', title: 'Design studio',
    text: 'Vouchers, business cards, flyers, folded pamphlets (trifold, bifold and more), blank pages (A6 to A2, Letter, custom) and tattoo posts.',
    more: 'Sticky notes are made here too: pin them on Home, Studio and More with quick links, or use the Notes button on those screens. Start from a template and theme; your studio name, logo and contact fill in. A quick strip across the top of the page holds your favourite tools, actions, colours and fonts (its + chooses them), and, as in the simulator, Focus hides every panel while Panels shows or hides each one. Tools sit down the left (hold an icon on a touchscreen to see its name); the panel on the right appears for whatever is selected and folds away with its arrow, and the page icon holds the theme, background and sides. Add text (normal, or frame text for paragraphs that wrap inside a box), pictures and shapes (Shift-drag, or hold an empty spot, to box-select several), set exact sizes in mm, bend text into an arc or run it along any shape or pen curve, crop and arrange layers, draw your own shapes with the Pen (P) or Pencil (N; hold still to snap to a shape), reshape any shape point by point with the Nodes tool (A), or double-tap it, combine shapes with the shape builder (add, subtract, intersect, exclude, divide, separate) or grow an outline with Contour (items snap to the page and to each other; hold Alt to move freely). The grid button adds a square, isometric, perspective (one, two or three point, with vanishing points you drag) or radial grid to snap to, and pen lines follow its directions; it is never printed. Fill shapes and text with a colour, a gradient of up to 5 colours or a repeating texture; trace a picture (like a silhouette PNG) into a shape, or flatten any item into a picture. Select area picks part of an item (box, ellipse, lasso or colour, with feathering) to delete, split off, move or copy. Print designs can be one-sided or front and back, with a master page for shared backgrounds. Clip a texture into a shape, hold a layer (or Ctrl-click) to select several, then merge them or save them to References; shapes can also be saved as SVG or to Assets. Print a sheet or share a post, and save your own templates. The full screen button gives the design the whole screen.' },
  { id: 'organise', route: 'designs', sel: '.lib-bar', title: 'Keep it tidy',
    text: 'Search, sort, favourites and folders on every library.',
    more: 'Designs, simulator pieces, reels, portfolio, stencils, forms, saved quotes, the rule book and stock all have them, so a year of work stays easy to find. Tap the folder button on anything to file it. When you import a photo, reference or stencil, the picker opens on those folders too, with a search over everything.' },
  { id: 'bend', route: 'studio', sel: '[data-go="bend"]', title: 'Bend and split',
    text: 'Arc a band to sit flush, or split a back piece over pages.',
    more: 'The bend tool curves a design so a band meets neatly around an arm or leg, and can send it straight to the stencil maker. Split for printing cuts a large stencil into labelled pages with an overlap for taping.' },
  { id: 'portfolio', route: 'portfolio', sel: '#view', title: 'Portfolio',
    text: 'Your tattoos, art and flash, with fresh and healed photos.',
    more: 'Print a portfolio book, set a white or black background for flash, zoom into photos, and turn any piece into a social post with one tap. The References tab keeps pictures you\'ve collected for ideas, sorted by category and ready to use in the design studio. The Assets tab keeps vector stickers and shapes as SVG: save shapes there from the design studio, or add .svg files, and find them under Shape › Assets. The Stencils tab keeps stencils you made, each with the picture it came from, ready to print again or reopen in the stencil maker.' },
  { id: 'forms', route: 'forms', sel: '#view', title: 'Consent and aftercare',
    text: 'Clients read, tick and sign on your phone or tablet.',
    more: 'Forms are designed in the Design studio with text boxes, check boxes, radio and combo boxes and signatures. Fill them in here, print them, or save an interactive PDF. Completed copies are kept here and on the client\'s card; aftercare can go with the receipt.' },
  { id: 'more', basic: 1, route: 'more', sel: '#view', title: 'Running the studio',
    text: 'Quotes, stats, stock, your rule book and settings.',
    more: 'Stats shows tattoos, hours and earnings over time. Inventory tracks stock with low-stock alerts and stock takes. The rule book keeps your studio rules for clients and staff, with search, favourites and folders.' },
  { id: 'stock', route: 'inventory', sel: '#view', title: 'Stock',
    text: 'Items running low are flagged and go on a shopping list.',
    more: 'Do a stock take on your phone, print a blank count sheet, or the current stock with values. Folders work as stock sections: one item can sit in several (a needles sheet and an ordering list), and printing a folder gives just that sheet.' },
  { id: 'stats', route: 'stats', sel: '#st-body, #view', title: 'Stats',
    text: 'Tattoos, hours and earnings by month or year.',
    more: 'Pick a period, see averages per tattoo and per hour, and export to a spreadsheet for your books.' },
  { id: 'backup', basic: 1, route: 'settings', sel: '[data-sec="backup"]', title: 'Keep it safe',
    pre: () => SET_OPEN.add('backup'),
    text: 'Everything stays on this device. Save a backup file now and then.',
    more: 'A backup holds all your data, photos and reel videos: Save workspace file puts it in your Downloads, Share sends it to Drive or email. You can merge another backup in, keep a workspace in your own Google Drive to use on several devices, and run first-time setup or this tour again from Settings.' },
  { id: 'workspace', route: 'settings', sel: '#db-badge', title: 'Workspaces',
    text: 'Tap here to switch between studios or artists.',
    more: 'Each workspace has its own clients, bookings and settings. Keep one per artist, and give any of them a password in Settings so others can\'t open it.' },
  { id: 'end', basic: 1, title: 'That\'s the tour',
    text: 'Keep playing in this practice workspace, or go back to yours and this one is deleted.',
    more: 'The practice workspace is full of made-up clients, bookings, quotes, portfolio pieces and stock, so you can try printing, quoting, receipts and everything else without touching your real data. It shows in orange and never syncs with Google. Only one is kept: delete it or start it fresh from Settings, and taking the tour again makes a new one.' }
];

/* ---------- Running the tour ---------- */
// Choose Basics or In depth.
function tourOffer(after) {
  const o = document.createElement('div'); o.id = 'merge-dlg';
  o.innerHTML = `<div class="card tour-offer"><h2>Take a tour?</h2>
    <p class="muted" style="margin-top:0">It runs in a fresh practice workspace full of made-up data, so your own work is never touched.${Practice.get() && !WS.cur?.test ? ' Your current practice workspace is replaced by the new one.' : ''}</p>
    <button class="tour-pick" data-t="basic"><b>The basics</b><span>About a minute: home, clients, calendar, quotes and the main tools.</span></button>
    <button class="tour-pick" data-t="full"><b>In depth</b><span>About three minutes: everything InkForge can do, screen by screen.</span></button>
    <button class="btn" data-t="" style="width:100%;margin-top:10px">${after ? 'Not now' : 'Cancel'}</button></div>`;
  o.onclick = (e) => { const b = e.target.closest('[data-t]'); if (!b) return; o.remove(); if (b.dataset.t) Tour.begin(b.dataset.t); };
  document.body.appendChild(o);
}

// Make a fresh practice workspace and open it; the tour starts there (Tour.resume).
Tour.begin = async (kind) => {
  if (Tour.on) return;
  try { sessionStorage.setItem('tour-go', kind); } catch {}
  Dirty.set(false); await Snapshot.save().catch(() => {});
  await Practice.fresh();
};
// Called once a workspace has opened: starts a tour that was asked for, in the practice workspace.
Tour.resume = async () => {
  let kind = ''; try { kind = sessionStorage.getItem('tour-go') || ''; sessionStorage.removeItem('tour-go'); } catch {}
  if (kind && WS.cur?.test) Tour.start(kind);
};

Tour.start = async (kind) => {
  if (Tour.on) return;
  if (!WS.cur?.test) return Tour.begin(kind);
  Tour.on = true; Tour.back = '#home';
  Tour.steps = TOUR_STEPS.filter(s => kind === 'full' || s.basic);
  Tour.i = 0;
  // The practice workspace's own made-up client and booking.
  try { const sam = (await DB.one(`SELECT id FROM clients WHERE first_name = 'Sam' ORDER BY id LIMIT 1`))?.id;
    Tour.ids = { sam, bk: (await DB.one(`SELECT id FROM bookings WHERE description = 'Fine-line rose with stem' ORDER BY id LIMIT 1`))?.id }; } catch (e) { console.warn('Tour examples:', e); }
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
      <span style="flex:1"></span>
      ${Tour.i ? '<button class="btn small" data-a="back">Back</button>' : ''}
      ${Tour.i === n - 1 ? `<button class="btn small" data-a="stay" disabled>Keep playing here</button><button class="btn small primary" data-a="home" disabled>Back to my workspace</button>`
        : '<button class="btn small primary" data-a="next" disabled>Next</button>'}</div>
    <div class="tour-dots">${Tour.steps.map((_, j) => `<i class="${j === Tour.i ? 'on' : j < Tour.i ? 'done' : ''}"></i>`).join('')}</div>`;
  card.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'more') { card.classList.toggle('more'); e.target.textContent = card.classList.contains('more') ? 'Less' : 'See more'; tourPlace(); }
    if (a === 'next') { Tour.i++; Tour.show(); }
    if (a === 'back') { Tour.i--; Tour.show(); }
    if (a === 'skip' || a === 'stay') Tour.end();
    if (a === 'home') Tour.end(true);
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
  card.querySelectorAll('[data-a="next"], [data-a="stay"], [data-a="home"]').forEach(b => { b.disabled = false; });
};

// The spotlight around the highlighted part, and the card beside it (a bottom sheet on phones).
function tourPlace() {
  if (!Tour.el) return;
  const hole = Tour.el.querySelector('.tour-hole'), card = Tour.el.querySelector('.tour-card'), t = Tour.target;
  card.style.left = card.style.top = '';   // a centred card or a bottom sheet must not keep the last floating position
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

// Ends the tour: stay and keep playing in the practice workspace, or (home) go back and delete it.
Tour.end = async (home) => {
  if (!Tour.on) return;
  await tourCleanUp();
  if (home) return Practice.leave();
  toast('Keep playing: nothing here is real. Settings › Practice workspace deletes it, or Back to my workspace there.', 6000);
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


/* ---------- Practice workspace ----------
   A separate workspace full of made-up data to try everything on: clients (fake numbers, so nothing can
   be sent), bookings that always sit around today, finished tattoos for Stats, quotes, portfolio pieces
   drawn from the quote's detail roses, stock, rules, a voucher and a post. It's marked `test` in the
   workspace list: orange accent, a PRACTICE badge, and no Google Calendar or Drive. Each time it opens,
   bookings move along so the upcoming ones stay upcoming. Delete it from the start screen like any other. */
const Practice = {
  get: () => WS.list.find(w => w.test && !w.dropping),
  // Make (or open) the practice workspace; the data goes in the first time it opens.
  async open() {
    let w = Practice.get();
    if (!w) { w = await WS.create('Practice studio'); w.test = true; w.back = WS.cur && !WS.cur.test ? WS.cur.id : null; await WS.save(); }
    Dirty.set(false); Snapshot.save().finally(() => WS.switchTo(w.id));
  },
  /* Only one practice workspace is kept. fresh(): a new one in place of any old one; leave(): back to the
     artist's own workspace, deleting the practice one; drop(): delete it. A workspace that is open can't be
     deleted, so that waits for the next start (Practice.tidy, via sessionStorage 'practice-drop'). */
  back() { const b = Practice.get()?.back; return WS.get(b) && !WS.get(b).test ? b : WS.list.find(w => !w.test)?.id || null; },
  async fresh() {
    const old = Practice.get(), back = WS.cur && !WS.cur.test ? WS.cur.id : Practice.back();
    if (old && old !== WS.cur) await WS.remove(old); else if (old) { old.dropping = true; try { sessionStorage.setItem('practice-drop', old.id); } catch {} }
    const w = await WS.create('Practice studio'); w.test = true; w.back = back; await WS.save();
    WS.switchTo(w.id);
  },
  async leave() { const w = Practice.get(); if (w) { try { sessionStorage.setItem('practice-drop', w.id); } catch {} }
    Dirty.set(false); await Snapshot.save().catch(() => {}); WS.switchTo(Practice.back()); },
  async drop() { const w = Practice.get(); if (!w) return;
    if (!await ask('Delete the practice workspace?\n\nEverything made in it goes. Anything you saved to your device or shared from it is kept.')) return;
    if (w === WS.cur) return Practice.leave();
    await WS.remove(w); toast('Practice workspace deleted.'); render(); },
  // At start-up: delete a practice workspace that was left behind.
  async tidy() { let id = ''; try { id = sessionStorage.getItem('practice-drop') || ''; } catch {} if (!id || WS.cur?.id === id) return;
    try { sessionStorage.removeItem('practice-drop'); } catch {} const w = WS.get(id); if (w) await WS.remove(w); },
  // A portfolio picture: one of the quote's detail roses on paper, at 1080 x 1350.
  async picture(level, colour, healed) {
    const svg = new Blob([detailSvg(level, colour).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" ')], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svg), img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = url; });
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const x = c.getContext('2d');
    x.fillStyle = healed ? '#eadfcf' : '#f6efe3'; x.fillRect(0, 0, 1080, 1350);
    if (healed) x.filter = 'saturate(.75) contrast(.92) blur(.6px)';
    if (img) x.drawImage(img, 40, 120, 1000, 1000);
    URL.revokeObjectURL(url);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86)), small = document.createElement('canvas'); small.width = 384; small.height = 480;
    small.getContext('2d').drawImage(c, 0, 0, 384, 480);
    return { photo: await Media.save(blob, 'jpg'), thumb: await Media.save(await new Promise(r => small.toBlob(r, 'image/jpeg', 0.8)), 'jpg') };
  },
  async seed() {
    const t = new Date(), day = (n) => ymd(addDays(t, n)), at = (n, hm) => day(n) + 'T' + hm;
    const S = { studio_name: 'Practice Studio', artist_name: 'Alex Demo', currency: Settings.get('currency') || 'R', country_code: '27',
      artist_phone: '+27 00 000 0000', artist_instagram: '@practice.studio', day_start: '10:00', day_end: '17:00', max_per_day: '2', booking_gap: '60',
      setup_done: '1', days_off: JSON.stringify({ weekly: [0], until: '', dates: [] }), test_anchor: ymd(t) };
    for (const [k, v] of Object.entries(S)) await Settings.set(k, v);
    // Clients: made-up names, fake numbers (+27 00 ...), two birthdays this week.
    const bday = (n) => { const d = addDays(t, n); return `1992-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const people = [['Sam', 'Rivera', 'regular, fine line', bday(2), 'Latex allergy'], ['Jordan', 'Lee', 'first tattoo', null, null], ['Taylor', 'Nkosi', 'blackwork, sleeve', bday(5), null],
      ['Morgan', 'Botha', 'regular', null, 'On blood thinners: check before booking'], ['Casey', 'van Wyk', 'colour', null, null], ['Riley', 'Moyo', 'script', null, null],
      ['Jamie', 'Pillay', 'cover-up', null, null], ['Alex', 'Smith', 'flash', null, null], ['Quinn', 'Dlamini', 'regular, geometric', null, null],
      ['Avery', 'Jacobs', 'walk-in', null, null], ['Drew', 'Fourie', 'touch-up due', null, null]];
    for (const [i, [f, l, tags, dob, med]] of people.entries())
      await DB.run(`INSERT INTO clients (first_name, last_name, phone, email, instagram, category, tags, dob, medical) VALUES (?, ?, ?, ?, ?, 'Client', ?, ?, ?)`,
        [f, l, `+27 00 000 ${String(1000 + i * 37).slice(-4)}`, `${f.toLowerCase()}@example.com`, `${f.toLowerCase()}.${l.toLowerCase().replace(/\s/g, '')}`, tags, dob, med]);
    await DB.run(`INSERT INTO clients (first_name, last_name, phone, category, notes) VALUES ('Ink Supplies', 'Co', '+27 00 000 9999', 'Supplier', 'Needles, ink and aftercare')`);
    const id = async (f) => (await DB.one('SELECT id FROM clients WHERE first_name = ?', [f])).id;
    // Bookings: a few in the past (finished, for Stats) and the coming weeks.
    const B = [[-80, '11:00', 180, 'tattoo', 'Taylor', 'Blackwork panther', 'Left forearm', 2600, 1, 2700, 175, 'Card'],
      [-62, '13:00', 120, 'tattoo', 'Sam', 'Fine-line peony', 'Ribs', 1600, 1, 1600, 115, 'EFT'], [-45, '10:00', 240, 'tattoo', 'Quinn', 'Geometric half sleeve, session 1', 'Right upper arm', 3400, 1, 3400, 230, 'Card'],
      [-30, '14:00', 60, 'tattoo', 'Riley', 'Script: "breathe"', 'Inner wrist', 750, 1, 800, 50, 'Cash'], [-21, '11:00', 180, 'tattoo', 'Casey', 'Colour koi', 'Calf', 2400, 1, 2500, 190, 'Card'],
      [-12, '13:00', 120, 'tattoo', 'Jamie', 'Cover-up: rose over old script', 'Shoulder', 2200, 1, 2200, 140, 'EFT'], [-5, '10:00', 30, 'followup', 'Riley', 'Check healing', 'Inner wrist', null, 0, null, null, null],
      [0, '13:00', 180, 'tattoo', 'Sam', 'Fine-line rose with stem', 'Left forearm', 1800, 0], [1, '10:00', 60, 'consult', 'Jordan', 'Small script, first tattoo', null, null, 0],
      [2, '11:00', 240, 'tattoo', 'Quinn', 'Geometric half sleeve, session 2', 'Right upper arm', 3400, 0], [4, '14:00', 120, 'tattoo', 'Alex', 'Flash: dagger and roses', 'Thigh', 1400, 0],
      [6, '10:00', 300, 'tattoo', 'Taylor', 'Blackwork sleeve, session 2', 'Left upper arm', 3800, 0], [8, '15:00', 60, 'touchup', 'Drew', 'Touch-up on lettering', 'Forearm', 250, 0],
      [9, '10:00', 420, 'hold', null, 'Held for a back piece', null, null, 0], [12, '11:00', 180, 'tattoo', 'Casey', 'Colour koi, finishing session', 'Calf', 2000, 0],
      [15, '13:00', 120, 'tattoo', 'Avery', 'Small moth', 'Sternum', 1300, 0], [19, '10:00', 60, 'consult', 'Morgan', 'Back piece ideas', null, null, 0]];
    for (const [n, hm, dur, kind, who, desc, place, quote, done, paid, mins, pay] of B) {
      const c = who ? await id(who) : null;
      await DB.run(`INSERT INTO bookings (client_id, start_at, duration_min, kind, description, placement, size, quote, deposit, deposit_paid, completed, completed_at, paid, time_min, pay_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [c, at(n, hm), dur, kind, desc, place, place ? '12 x 9 cm' : null, quote, quote ? Math.round(quote * 0.25 / 50) * 50 : null,
        quote && (done || n < 3) ? 1 : 0, done ? 1 : 0, done ? addDays(t, n).toISOString() : null, done ? paid : null, done ? mins : null, done ? pay : null]);
    }
    // Portfolio: pieces drawn from the quote's detail roses, fresh and healed.
    const P = [['Fine-line peony', 'tattoo', 'Ribs', 'fine line, floral', 1, 'black', -62, 'Sam'], ['Blackwork panther', 'tattoo', 'Left forearm', 'blackwork, animal', 3, 'black', -80, 'Taylor'],
      ['Black and grey rose', 'tattoo', 'Shoulder', 'black and grey, rose, cover-up', 4, 'bg', -12, 'Jamie'], ['Colour koi', 'tattoo', 'Calf', 'colour, japanese', 5, 'colour', -21, 'Casey'],
      ['Rose flash', 'flash', null, 'flash, rose', 2, 'colour', -3, null], ['Linework study', 'art', null, 'sketch, linework', 1, 'black', -8, null]];
    for (const [title, kind, place, tags, lv, col, n, who] of P) {
      await DB.run(`INSERT INTO portfolio_items (kind, title, placement, tags, client_id, made_on, price, favourite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [kind, title, place, tags, who ? await id(who) : null, day(n), kind === 'flash' ? 900 : null, lv === 5 ? 1 : 0]);
      const pid = (await DB.one('SELECT last_insert_rowid() AS id')).id, fresh = await Practice.picture(lv, col, false);
      await DB.run('INSERT INTO portfolio_photos (item_id, photo_ref, thumb_ref, label, sort) VALUES (?, ?, ?, ?, 0)', [pid, fresh.photo, fresh.thumb, kind === 'tattoo' ? 'Fresh' : null]);
      if (kind === 'tattoo') { const h = await Practice.picture(lv, col, true); await DB.run('INSERT INTO portfolio_photos (item_id, photo_ref, thumb_ref, label, sort) VALUES (?, ?, ?, ?, 1)', [pid, h.photo, h.thumb, 'Healed']); }
    }
    // Stock, rules, saved quotes.
    await DB.run(`INSERT INTO inventory_items (name, category, unit, qty, min_qty, supplier, cost) VALUES
      ('Black ink 4oz', 'Ink', 'bottle', 1, 2, 'Ink Supplies Co', 320), ('Grey wash set', 'Ink', 'set', 2, 1, 'Ink Supplies Co', 650), ('Needles 3RL', 'Needles', 'box', 6, 2, 'Ink Supplies Co', 180),
      ('Needles 9RM', 'Needles', 'box', 1, 2, 'Ink Supplies Co', 190), ('Nitrile gloves (M)', 'Hygiene', 'box', 4, 3, NULL, 120), ('Cling wrap', 'Hygiene', 'roll', 2, 2, NULL, 60),
      ('Stencil paper', 'Stencil', 'pack', 1, 1, NULL, 450), ('Aftercare balm', 'Aftercare', 'tub', 14, 6, NULL, 45)`);
    await DB.run(`INSERT INTO rules (title, body, category) VALUES ('Deposits are non-refundable', 'They secure your date and go towards the final price.', 'Client rules'),
      ('48 hours to reschedule', 'Move your booking with at least 48 hours notice to keep your deposit.', 'Client rules'),
      ('Arrive fed and hydrated', 'Eat a proper meal before your session.', 'Client rules'), ('Clean down after every client', 'Surfaces, machine and chair before the next setup.', 'Staff rules')`);
    const cfg = qCfg();
    for (const [client, q] of [['Morgan Botha', { job: 'new', jobLvl: 3, place: 'Upper back', side: 'C', w: 30, h: 35, colour: 'black', detail: 4, style: 'Blackwork', text: '', font: '', fontName: '', letter: 2, hours: null }],
      ['Jordan Lee', { job: 'new', jobLvl: 3, place: 'Inner bicep', side: 'L', w: 8, h: 3, colour: 'black', detail: 1, style: 'Script / Text', text: 'still here', font: 'Handwritten', fontName: '', letter: 2, hours: null }]]) {
      const data = { ...q, discType: 'pct', discVal: 0, client, designNote: '', withDesign: false, items: [], pos: 0, sized: true, detailSet: true, styleSet: true, lettering: !!q.text };
      const r = qCalc({ ...data, cfg: null });
      await DB.run('INSERT INTO quotes (client_name, summary, data, cfg, total, hours) VALUES (?, ?, ?, ?, ?, ?)',
        [client, `${q.place} · ${q.w} x ${q.h} cm · ${q.style}`, JSON.stringify(data), JSON.stringify(cfg), r.total, r.hours]);
    }
    // Design studio: a voucher and a post from the first portfolio piece.
    const mk = async (name, kind, doc) => { await DB.run('INSERT INTO designs (name, kind, doc) VALUES (?, ?, ?)', [name, kind, JSON.stringify(doc)]);
      const did = (await DB.one('SELECT last_insert_rowid() AS id')).id;
      for (const r of [...new Set(doc.layers.filter(l => l.ref).map(l => l.ref))]) await DB.run('INSERT INTO design_assets (design_id, ref) VALUES (?, ?)', [did, r]);
      await dzThumb(did, doc); };
    const v = dzNew('voucher', dzLayouts('voucher')[0], 'gold'); Object.assign(v.vals, { amount: '1000', to: 'Sam', from: 'Jordan' });
    await mk('Gift voucher', 'voucher', v);
    const piece = await dzPiece((await DB.one(`SELECT id FROM portfolio_items WHERE title = 'Black and grey rose'`)).id);
    await mk('Black and grey rose (portrait post)', 'portrait', dzNew('portrait', dzLayouts('portrait')[3], 'ink', piece));
  },
  // Keeps the practice bookings around today: everything moves on by the days since it was last opened.
  async refresh() {
    const a = Settings.get('test_anchor'); if (!a) return;
    const n = Math.round((new Date(ymd(new Date()) + 'T00:00') - new Date(a + 'T00:00')) / 864e5); if (n <= 0) return;
    await DB.run(`UPDATE bookings SET start_at = strftime('%Y-%m-%dT%H:%M', start_at, '+${n} days')`);
    await DB.run(`UPDATE portfolio_items SET made_on = date(made_on, '+${n} days') WHERE made_on IS NOT NULL`);
    for (const [f, k] of [['Sam', 2], ['Taylor', 5]]) { const d = addDays(new Date(), k); await DB.run('UPDATE clients SET dob = ? WHERE first_name = ? AND dob IS NOT NULL', [`1992-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, f]); }
    await Settings.set('test_anchor', ymd(new Date()));
  }
};
