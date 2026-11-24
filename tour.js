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
    text: 'Today\'s sessions, rewards to send, and birthdays this week.',
    more: 'Tap a session to open it; once it\'s done, Done \u2713 takes it off the list. Rewards to send lists loyalty rewards clients have earned: Send opens their card, Sent \u2713 takes it off. Birthdays show Send wishes (WhatsApp) and Done \u2713. The Draw group opens the design studio, simulator and sketchpad, which also sit beside full screen at the top of every page.' },
  { id: 'clients', basic: 1, route: 'clients', sel: '#c-list', title: 'Clients',
    text: 'Everyone in one place, searchable by name, phone or tag.',
    more: 'Group contacts into categories (clients, suppliers and your own), print a phonebook or export it to a spreadsheet. The table icon shows every contact as a table to search, filter, edit, export or print. Its Export and Import move clients between workspaces (the export arrow on a row sends just that one, as it does on every card and row in the app): a preview shows what is new, changed or deleted, a client already here (same phone or email) is not added twice, and imported clients get a coloured artist tag. Phone numbers are kept with the country code so WhatsApp works from every card.' },
  { id: 'client', route: () => 'client/' + Tour.ids.sam, sel: '#view .card', title: 'A client\'s card',
    text: 'Contact, health notes in red, bookings, forms and portfolio.',
    more: 'Call, text or WhatsApp in one tap. Medical notes and allergies are highlighted so they\'re never missed. Their bookings, signed consent forms and tattoos in your portfolio are all listed here.' },
  { id: 'book', basic: 1, route: 'book', sel: '.mwrap, #cal', title: 'Your calendar',
    pre: () => { Cal.mode = 'month'; Cal.date = new Date(); },
    text: 'Names on every day, coloured by booking type.',
    more: 'Switch between day, week and month. Tap a day to see its bookings; + Book adds one. Days off are greyed out. Completed ones get a green tick; cancelled ones are faded and struck through, and their time is free again. The table icon opens all your bookings as a table to search, filter, edit, export, print or share. Export and Import move bookings between workspaces (e.g. staff into the owner’s): a preview shows what is new, changed or deleted, and imports can be tagged with a colour, counted for real or added as read-only ghosts.' },
  { id: 'booking', route: () => 'booking-edit/' + Tour.ids.bk, sel: '#b-form', title: 'A booking',
    text: 'Who, when, the tattoo, price and deposit on one screen.',
    more: 'Mark the deposit as paid, add reference photos and notes. Reminder: Notify me before it starts, and Add to phone calendar puts it in your phone\'s calendar with the alarm (InkForge\'s own notifications only come while it\'s open). After the session, tick Tattoo completed to record what was paid and how long it took, tick any loyalty rewards the client uses (the price drops), then send a thank-you receipt or book a healing check. Or tick Cancelled (client cancelled, no-show or you) with a reason: the booking is kept, but out of stats and free time.' },
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
    more: 'Mark them done when the tattoo is finished, and see how the real time compared with the quote, so you can fine-tune your rates. Search them, star favourites and sort them into folders. The table icon shows them all as a table with totals, to export or print, or to move them to another workspace with Export and Import.' },
  { id: 'studio', basic: 1, route: 'studio', sel: '#view', title: 'Studio tools',
    text: 'Draw (design studio, simulator, sketchpad), then stencils, reels, bends, size sheets and big prints.',
    more: 'Everything for making the work: the stencil maker, the reel maker (saved reels you can edit again), the design studio for vouchers, cards and posts, the bend tool for bands, and split printing for large stencils. Your portfolio and consent forms live here too.' },
  { id: 'stencil', route: 'stencil', sel: '#view .card', title: 'Stencil maker',
    text: 'Photo to a clean stencil, printed at real size.',
    more: 'Choose lines, lines with shading or solid, tune the detail (undo and redo step back through every change), crop it (or Auto crop trims to where the stencil starts), then print at the width you need. Every button is in the strip along the top. Too big for one sheet? Split spreads it over several pages to tape together. Save or Share it, Keep it in Portfolio › Stencils, or send it to the tattoo simulator as a new piece with the stencil ready to trace, in normal or cheat mode. In the design studio, Make a stencil sends whatever you select here.' },
  { id: 'reels', route: 'reels', sel: '#reel-list', title: 'Reel maker',
    text: 'Vertical reels from your photos and videos, in your own style.',
    more: 'Each reel is saved as you go, with undo, so you can come back and change it. Export and Import on the list move reels, with their photos, videos, music and fonts, to another workspace. Effects on a clip (glitch, heartbeat, blur, zoom punch, hearts, film burn and 30 more) sit as bars under it on the timeline: drag them to move or lengthen, tap to set their start, length, speed and strength. Intro and outro cards, captions in 18 fonts with looks and animations, emoji, text and picture stickers (from your device or portfolio) that pop, slide, spin or float, blank pages to fill, your own imported fonts, 24 filters with adjustments, effects like grain, glitch and light leaks, 14 transitions, crop and music. Text, stickers and sound sit on their own timeline rows: drag them to move, drag their ends to set when they start and stop, and use two sound rows to cross-fade songs or add a voiceover; your style and watermark make every reel match. A strip along the top adds media, text and pages, duplicates, splits and deletes, with Shift, Ctrl and Alt buttons for tablets and a shortcut list (?). Drag handles to size, stretch and turn anything, like the design studio. ▶ Watch plays it full screen with pause, restart and a scrub bar. Freeze frame and Save frame sit by each clip’s name. Export it, then save it to your device or share it.' },
  { id: 'tattoo', route: 'tattoo', sel: '#tt', title: 'Tattoo simulator',
    text: 'Experimental: tattoo in ink on skin with needle groupings, with step-by-step lessons, challenges, medals and trophies. Lessons and challenges have a body area and a pain meter: work too hard, too deep or back over raw skin and the client needs breaks, or taps out.',
    more: 'Press ? in a piece for every shortcut. Export and Import on the list move pieces, stencil, ink and skin included, to another workspace. Pick a page and skin tone, load a stencil to trace, hold the pen in an ink cap to load the needle (hold longer for more of that colour, dip into another to mix it like real pigment). Ink behaves like it does in skin: a light colour won’t take over a saturated dark one, but fills a feathered edge for a gradient, and colours meeting in the skin mix (blue into yellow makes green). Work in layers: linework, shadow, mid tone, light tone and highlights; each can be hidden, faded or locked so nothing lands on it. Cheat mode can also start a Pattern tile, tattooed the same way and saved to References for the design studio to fill with. In cheat mode, holding the pen still snaps a stroke to a line or circle, and dragging before you let go resizes it, as in the design studio; the shapes, lettering, lasso (freehand, box or ellipse) and grid work like their design studio twins. The strip across the top holds quick shortcuts (pen lean, magnum angle, favourite needles, references); its + chooses what shows, favourite needles with their size (up to 5) and ink palettes (up to 3) included. Cheat mode keeps a strip of its own that can hold any cheat tool, and your favourite lettering fonts behind one Aa button. Inks opens the palettes: the standard caps, Old school, Skin tones, Pastel greys, Pastel colours, grey wash and your own. The pencil edits a palette of up to 10 caps with a colour wheel, mixing and pre-diluted caps, and Share file sends it to Drive or a friend. Focus (top bar) hides every panel for a clean view, and Panels brings any of them back on its own. In the meter, hold the eye for a quick healed look and tap the grid for a skin damage map. Pressure sets depth, hand speed spaces the punctures, tilt spreads the needles, and leaning a magnum along its row tilts it in steps (all its needles, then fewer, down to 3) that hold steady; start with Tune in under the sliders icon: short steps (follow a stencil line, line with a round shader, match a shaded or packed block, set skin and needle look) fit every needle to your pen and hand, and Copy settings lets you send the result on. Each grouping can still be fine tuned there (needle hang too), and skin stretch is set there. Overworking the skin turns it red, swollen and then raw, and pressing too hard while pulling slowly blows the ink out under the skin (both can be adjusted under All needles). The references button floats pictures over the skin to follow (move, resize, turn, flip, lock to tattoo through them). The Apprentice exam runs eleven challenges, from straight lines to a finished heart, and ends with a report card. Challenges has over thirty single challenges (lining, shading, packing, colour and flash pieces), one to three stars each, with medals, personal bests, a trophy cabinet and a results sheet to print or save. Every piece keeps stats (strokes, distance, time). The full screen button at the top gives the skin the whole screen. Two fingers move, zoom and turn the skin to a comfortable angle (it snaps at every 90 degrees; Fit straightens it). The clock button previews the piece fresh, healed or after 10 years. Magnums keep their angle like a calligraphy nib (set it under the needle button, or with [ and ]), so you can line with one by pulling it along its row; the cursor shows which way it faces.' },
  { id: 'designs', route: 'designs', sel: '#dz-list', title: 'Design studio',
    text: 'Vouchers, business cards, flyers, folded pamphlets (trifold, bifold and more), blank pages (A6 to A2, Letter, custom) and tattoo posts.',
    more: 'Every colour has an eyedropper, your recent colours and your palettes (Palettes… makes, exports and imports them). Animate (top bar) turns a post into a reel with each piece moving in, ready for music and effects. Tables live under Shape: add rows and columns, colour and style cells, put icons in them, or fill one from a CSV. Sticky notes are made here too: pin them on Home, Studio and More with quick links, or use the Notes button on those screens. Start from a template and theme; your studio name, logo and contact fill in. A quick strip across the top of the page holds your favourite tools, actions, colours and fonts (its + chooses them), and, as in the simulator, Focus hides every panel while Panels shows or hides each one. Tools sit down the left (hold an icon on a touchscreen to see its name); the panel on the right appears for whatever is selected and folds away with its arrow, and the page icon holds the theme, background and sides. Add text (normal, or frame text for paragraphs that wrap inside a box), pictures and shapes (Shift-drag, or hold an empty spot, to box-select several), set exact sizes in mm, bend text into an arc or run it along any shape or pen curve, crop and arrange layers, draw your own shapes with the Pen (P) or Pencil (N; hold still to snap to a shape, then keep holding and drag to resize it), reshape any shape point by point with the Nodes tool (A), or double-tap it, combine shapes with the shape builder (add, subtract, intersect, exclude, divide, separate) or grow an outline with Contour (items snap to the page and to each other; hold Alt to move freely). The grid button adds a square, isometric, perspective (one, two or three point, with vanishing points you drag) or radial grid to snap to, and pen lines follow its directions; it is never printed. Its opacity slider makes it fainter, and Lock keeps it in place. On the isometric grid, a selected shape fits onto the top, front or side plane, turns and flips within it, and new shapes can start on a plane. Fill shapes and text with a colour, a gradient of up to 5 colours or a repeating texture; trace a picture (like a silhouette PNG) into a shape, or flatten any item into a picture. Bend, in the strip under the top bar, arcs a shape or picture like the bend tool: shapes stay editable. A picture added from the device or portfolio can go into the design or float over it as a reference, as in the simulator: move, size, turn, flip, fade, hide or lock it; references are never printed. A Pattern tile (New design) is one seamless cell: what crosses an edge comes back on the other side, its neighbours show faintly round it, and the tile saves to References in Patterns, ready for any texture fill. Ctrl+C, Ctrl+X and Ctrl+V copy, cut and paste (Ctrl+Shift+V pastes in the same spot, Ctrl+D duplicates in place); a deleted design can be put back with Undo for a few seconds. Challenge (New design) makes a challenge for the simulator on 18 × 13 cm of skin. A new one starts from a picture or blank. From a picture, any drawing, photo or simulator piece is traced into shapes to tattoo: pick the style (colour line work, blackwork, fine line, black and grey or colour realism) and tune colours or zones, detail, smoothness and line weight; it comes in as an Outline, Detail lines, Packing per colour or Shading zones with their gradients, all editable with nodes. Then a short setup (skin and body area, size, needles, judging and pictures; Setup in the Challenge menu brings it back, and Trace a picture adds another). Then select a shape and use Grade as to make it the outline, a detail line, packing or a shading zone (stipple, whip, grey wash, or a colour blend of up to 10 colours, with an even, straight, radial or painted gradient: drag the dots on the shape, use Auto shading (pillow, edge fade, 3D, cast shadow), or paint it with the airbrush), each with the needle allowed (packing and shading can allow several to mix and match), pick the palette in the Challenge menu, then press Play in the simulator. Every lesson is there as a template and keeps its calibrated judging until you change its shapes; anything else is judged by the focus sliders in the Challenge menu. The Stencil tab of a shading zone has a skin marker and spirit wipe to draw the stencil for its shading by hand. Adjust colour, beside it for pictures, has the same exposure, contrast, saturation, hue and more as the simulator, previewed on the design. Select area picks part of an item (box, ellipse, lasso or colour, with feathering) to delete, split off, move or copy. Print designs can be one-sided or front and back, with a master page for shared backgrounds. Clip a texture into a shape, hold a layer (or Ctrl-click) to select several, then merge them or save them to References; shapes can also be saved as SVG or to Assets. Export and Import on the designs list move many designs at once to another workspace, pictures, references and fonts included. Every design has Print and Save as at the top (a picture, a PDF, or a copy under a new name, background and all), and Share beside them; save your own templates too. The full screen button gives the design the whole screen.' },
  { id: 'sketch', route: 'sketches', sel: '#skp-list', title: 'Sketchpad',
    text: 'An open page that grows as you go: notes, plans, sketches and mind maps.',
    more: 'Its tools sit in the strip on the left: select and lasso, seven brushes behind one button (pencil, pen, marker, highlighter, calligraphy, manga pen and airbrush), the eraser (below 100% it fades), shapes, text, and mind-map ideas with an If for yes or no branches. Steady lines (lazy and smoothness), size and opacity, and colours with your own swatch panels sit underneath. Hold still at the end of a stroke to snap it to a line, arc, ellipse or box. On a tablet, two fingers move, zoom and turn the page, three fingers up or down change the size and left or right the opacity, a two-finger tap undoes and three redoes. Draw on one layer keeps every stroke in one Drawing layer. The grid stays put as the page grows, and Snap to the grid works with brushes and shapes. Open the example to see a mind map.' },
  { id: 'sizes', route: 'sizes', sel: '#sz', title: 'Size sheet',
    text: 'One design in a range of sizes on a page, to try on the client.',
    more: 'Pick a design or photo, the sizes you want, then print the sheet: the client holds them up to choose. The panel scrolls on its own, fits the screen, and has spacing and a margin from the page edge.' },
  { id: 'organise', route: 'designs', sel: '.lib-bar', title: 'Keep it tidy',
    text: 'Search, sort, favourites and folders on every library.',
    more: 'Designs, simulator pieces, reels, portfolio, stencils, forms, saved quotes, the rule book and stock all have them, so a year of work stays easy to find. Tap the folder button on anything to file it. When you import a photo, reference or stencil, the picker opens on those folders too, with a search over everything.' },
  { id: 'bend', route: 'studio', sel: '[data-go="bend"]', title: 'Bend and split',
    text: 'Arc a band to sit flush, or split a back piece over pages.',
    more: 'The bend tool curves a design so a band meets neatly around an arm or leg, and can send it straight to the stencil maker. Split for printing cuts a large stencil into labelled pages with an overlap for taping.' },
  { id: 'portfolio', route: 'portfolio', sel: '#view', title: 'Portfolio',
    text: 'Your tattoos, art and flash, with fresh and healed photos.',
    more: 'Print a portfolio book, export pieces (photos and all) to another workspace or import them, set a white or black background for flash, zoom into photos, and turn any piece into a social post with one tap. The References tab keeps pictures you\'ve collected for ideas, sorted by category and ready to use in the design studio. The Assets tab keeps vector stickers and shapes as SVG: save shapes there from the design studio, or add .svg files, and find them under Shape › Assets. The Stencils tab keeps stencils you made, each with the picture it came from, ready to print again or reopen in the stencil maker.' },
  { id: 'forms', route: 'forms', sel: '#view', title: 'Consent and aftercare',
    text: 'Clients read, tick and sign on your phone or tablet.',
    more: 'Forms are designed in the Design studio with text boxes, check boxes, radio and combo boxes and signatures. Fill them in here, print them, or save an interactive PDF. Completed copies are kept here and on the client\'s card; aftercare can go with the receipt. Export and Import move forms, pictures and all, to another workspace.' },
  { id: 'more', basic: 1, route: 'more', sel: '#view', title: 'Running the studio',
    text: 'Quotes, stats, stock, your rule book and settings.',
    more: 'Stats shows tattoos, hours and earnings over time, and your pay. Inventory tracks stock with low-stock alerts and stock takes. The rule book keeps your studio rules for clients and staff, with search, favourites and folders, and a table view to export or print, or to move rules to another workspace with Export and Import. Loyalty runs your rewards program.' },
  { id: 'loyalty', route: 'loyalty', sel: '#loy-view', title: 'Loyalty rewards',
    pre: () => { LOYV.tab = 'rewards'; LOYV.f = 'all'; },
    text: 'Clients earn rewards for sending people your way, or for what they spend.',
    more: 'Rewards are earned when a tattoo is completed and listed here: who holds it, what earned it, when it was sent and when it runs out. The figures on top show how many get used. Send opens the reward card and message (WhatsApp, share, or a saved picture); tick Sent once it\'s gone. Pass on gives a reward to someone else, Hand over gives a product instead, and a deleted reward is kept under Deleted with the reason, to restore if it hasn\'t run out. Ran out shows the ones never claimed. On a client\'s page you can switch rewards off for them: they stay in the referral tree, but earn nothing.' },
  { id: 'loyprog', route: 'loyalty', sel: '#loy-view', title: 'Set up the program',
    pre: () => { LOYV.tab = 'program'; LOYV.ptab = 'terms'; },
    text: 'Earning, Reward, Terms and Message: one program for every client.',
    more: 'Earning: per referral (first tattoo only, or every tattoo they get) or by spend. Reward: a percentage, an amount or a product, how long it lasts, passing on, stacking several on one tattoo (the full amount, then half, then a quarter), and a product they can choose instead. Terms are written from your choices, with the usual ones to untick and your own to add; each reward keeps the terms and rules it was earned under, even if you change the program later. Message: the card is a simple one or your own design in the design studio, from the Classic or Light template, with fields like {reward}, {code} and {terms} filled in for each client. Rewards are the artist\'s own, so cards say who to redeem with.' },
  { id: 'stock', route: 'inventory', sel: '#view', title: 'Stock',
    text: 'Items running low are flagged and go on a shopping list.',
    more: 'Do a stock take on your phone, or Count one at a time: each item fills the screen with its own number pad, pack buttons, As expected and None, Next and Back. Arrange sets the order you walk the shop (drag \u283f, or send to the top, bottom or a place); the stock take, the count sheet and the table can all follow it. Tapping any count box selects its number, ready to type over. Print a blank count sheet, or the current stock with values. Folders work as stock sections: one item can sit in several (a needles sheet and an ordering list), and printing a folder gives just that sheet. The table icon shows all your stock as a table to filter, adjust, export or print. Its Export and Import move stock lists between workspaces (with or without counts and costs): an item with the same name is not added twice, and imported items get a coloured artist tag.' },
  { id: 'stats', route: 'stats', sel: '#st-body, #view', title: 'Stats',
    text: 'Tattoos, hours and earnings, and your own take-home.',
    more: 'Pick a period, see averages per tattoo and per hour, how clients found you and your top referrers. With Your pay on (commission or chair rent, in Settings), it shows your take-home, the studio\'s share or rent, supplies, pay days and the next pay day; loyalty discounts come off your share or are shared. The table icon lists every tattoo with the columns and filters you choose, totals, CSV and print.' },
  { id: 'cancelled', route: 'bookings', sel: '#bkt', title: 'Cancellations',
    pre: () => { BK.status = 'cancelled'; BK.range = 'all'; },
    text: 'Cancelled bookings, kept on record, and your unreliable clients.',
    more: 'The bookings table\'s Cancelled filter lists every cancellation with its reason. Below, Unreliable clients ranks who cancels or doesn\'t turn up (no-shows count double, your own cancellations don\'t), with WhatsApp to rebook. To put one back on, untick Cancelled on the booking and pick a new date.' },
  { id: 'backup', basic: 1, route: 'settings', sel: '[data-sec="backup"]', title: 'Keep it safe',
    pre: () => SET_OPEN.add('backup'),
    text: 'Everything stays on this device. Save a backup file now and then.',
    more: 'A backup holds all your data, photos and reel videos: Save workspace file puts it in your Downloads, Share sends it on. You can merge another backup in (a section at a time, with the same previews as each Import button: what is new or changed, tick what comes in, tag clients, bookings and stock), and run first-time setup or this tour again from Settings. InkForge works best installed from Chrome or Edge: they give it the most room and let it protect your data. The space depends on the device\'s free space and is shared by every workspace on it.' },
  { id: 'workspace', route: 'settings', sel: '#db-badge', title: 'Workspaces',
    text: 'Tap here to switch between studios or artists.',
    more: 'Each workspace has its own clients, bookings and settings. Keep one per artist, and give any of them a password in Settings so others can\'t open it. A new workspace can be a full studio or design only (just the design tools, forms, notes and portfolio); switch it any time under Settings, Workspace type.' },
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
    await Practice.seedMore(id, at, day).catch(e => console.warn('Practice extras:', e));
  },
  /* The newer features, filled so each one shows itself off: referrals and a supporter, the loyalty program
     (rewards to send, used, run out, deleted, a client with rewards off), your pay, cancelled bookings and an
     unreliable client, a reminder, stock packs and a count order, and a sketch with a mind map. */
  async seedMore(id, at, day) {
    const mk2 = async (name, kind, doc) => { await DB.run('INSERT INTO designs (name, kind, doc) VALUES (?, ?, ?)', [name, kind, JSON.stringify(doc)]); await dzThumb((await DB.one('SELECT last_insert_rowid() AS id')).id, doc); };
    const q = (sql, p = []) => DB.run(sql, p), last = async () => (await DB.one('SELECT last_insert_rowid() AS id')).id;
    // Referrals: who sent who (a supporter too), and how others found the studio
    await q(`INSERT INTO clients (first_name, last_name, phone, category, notes) VALUES ('Kim', 'Naidoo', '+27 00 000 7777', 'Supporter', 'Never tattooed, sends friends our way')`);
    const ref = async (who, by) => q('UPDATE clients SET referred_by = ?, ref_src = ? WHERE first_name = ?', [await id(by), 'person', who]);
    await ref('Jordan', 'Sam'); await ref('Riley', 'Sam'); await ref('Casey', 'Taylor'); await ref('Avery', 'Taylor'); await ref('Jamie', 'Quinn'); await ref('Morgan', 'Kim'); await ref('Drew', 'Riley');
    await q(`UPDATE clients SET ref_src = 'online', ref_note = 'Instagram' WHERE first_name IN ('Alex', 'Quinn')`);
    await q(`UPDATE clients SET ref_src = 'advert', ref_note = 'Flyer at the coffee shop' WHERE first_name = 'Taylor'`);
    await q(`UPDATE clients SET loy_off = 1, loy_off_note = 'Moved overseas' WHERE first_name = 'Avery'`);
    // Stock: a studio cap to give away, pack sizes, and a count order (the way round the shop)
    await q(`INSERT INTO inventory_items (name, category, unit, qty, min_qty, cost) VALUES ('Studio cap', 'Merch', 'cap', 18, 5, 95)`); const cap = await last();
    await q(`UPDATE inventory_items SET pack = 20 WHERE name LIKE 'Needles%'`); await q(`UPDATE inventory_items SET pack = 100, qty = 340, unit = 'glove' WHERE name LIKE 'Nitrile%'`);
    const order = ['Black ink 4oz', 'Grey wash set', 'Needles 3RL', 'Needles 9RM', 'Stencil paper', 'Nitrile gloves (M)', 'Cling wrap', 'Aftercare balm', 'Studio cap'];
    for (const [i, n] of order.entries()) await q('UPDATE inventory_items SET sort = ? WHERE name = ?', [i, n]);
    await Settings.set('inv_order', 'custom');
    // Loyalty: 10% off for every tattoo a referred client gets, up to 3 stacked, passable, a cap instead, 3 months
    await Settings.set('loy_cfg', JSON.stringify({ type: 'ref', scope: 'every', kind: 'pct', value: 10, months: 3, stack: true, maxStack: 3, pass: true,
      alt: true, altItem: cap, altName: 'Studio cap', terms: { own: ['Not valid with other offers.'] } }));
    await Settings.set('loy_on', '1');
    const tat = async (who, desc) => (await DB.one(`SELECT b.id FROM bookings b JOIN clients c ON c.id = b.client_id WHERE c.first_name = ? AND b.description = ?`, [who, desc]))?.id;
    for (const [who, desc] of [['Riley', 'Script: "breathe"'], ['Casey', 'Colour koi'], ['Jamie', 'Cover-up: rose over old script']]) { const b = await tat(who, desc); if (b) await Loy.done(b, true); }
    await q(`UPDATE loyalty_rewards SET issued_at = ? WHERE from_client = ?`, [day(-30), await id('Riley')]);
    await q(`UPDATE loyalty_rewards SET issued_at = ?, sent_at = ? WHERE from_client = ?`, [day(-12), day(-11), await id('Jamie')]);
    const snap = JSON.stringify(Loy.snapOf(Loy.cfg()));
    // one already used (on Taylor's earlier session), one that ran out unclaimed, one deleted with a reason
    const used = await tat('Taylor', 'Blackwork panther');
    await q(`INSERT INTO loyalty_rewards (client_id, kind, value, code, src, from_client, issued_at, expires_at, status, used_booking, used_at, sent_at, prog) VALUES (?, 'pct', 10, 'PANTH3', 'ref', ?, ?, ?, 'used', ?, ?, ?, ?)`,
      [await id('Taylor'), await id('Avery'), day(-110), day(-20), used, day(-80), day(-108), snap]);
    if (used) await q('UPDATE bookings SET loy_off = 270 WHERE id = ?', [used]);
    await q(`INSERT INTO loyalty_rewards (client_id, kind, value, code, src, from_client, issued_at, expires_at, status, sent_at, prog) VALUES (?, 'pct', 10, 'OLDRWD', 'ref', ?, ?, ?, 'open', ?, ?)`,
      [await id('Kim'), await id('Morgan'), day(-130), day(-40), day(-128), snap]);
    await q(`INSERT INTO loyalty_rewards (client_id, kind, value, code, src, from_client, issued_at, expires_at, status, deleted_at, del_reason, del_prev, prog) VALUES (?, 'pct', 10, 'DUPL1C', 'ref', ?, ?, ?, 'deleted', ?, 'Earned twice by mistake', 'open', ?)`,
      [await id('Sam'), await id('Jordan'), day(-15), day(75), day(-14), snap]);
    await Loy.left();
    try { await loyDesignMake('classic'); await Settings.set('loy_msg', JSON.stringify({ ...loyMsgCfg(), card: 'design' })); } catch (e) { console.warn('Practice reward card:', e); }
    // Your pay: half each, the studio supplies, paid weekly on Fridays
    await Settings.set('pay_cfg', JSON.stringify({ on: true, mode: 'comm', pct: 50, sup: 'studio', every: 'week', wd: 5, loy: 'artist' }));
    // Cancelled bookings, and so an unreliable client
    for (const [n, hm, who, desc, by, why] of [[-9, '11:00', 'Morgan', 'Back piece, session 1', 'noshow', 'No reply on the day'], [-25, '14:00', 'Morgan', 'Back piece consult', 'client', 'Sick'],
      [-3, '10:00', 'Drew', 'Small anchor', 'client', 'Work came up'], [3, '15:00', 'Jordan', 'Script, first tattoo', 'me', 'Artist unwell: rebook']])
      await q(`INSERT INTO bookings (client_id, start_at, duration_min, kind, description, quote, cancelled, cancel_by, cancel_reason, cancelled_at) VALUES (?, ?, 180, 'tattoo', ?, 2000, 1, ?, ?, ?)`,
        [await id(who), at(n, hm), desc, by, why, addDays(new Date(), Math.min(0, n)).toISOString()]);
    // A reminder on today's session
    await q(`UPDATE bookings SET notify_min = 60 WHERE description = 'Fine-line rose with stem'`);
    // Sketchpad: a back piece plan as a mind map, with a few pen strokes
    try { const sk = dzNew('sketch', null, 'ink'); sk.bg = { c: '#f7f4ee' }; sk.skOne = true; const cx = sk.w / 2, cy = sk.h / 2;
      const node = (txt, x, y, k = 'node', p, br) => { const l = { id: dzId(), t: 'text', text: txt, size: p ? 44 : 56, font: '@2', c: '#1d2326', al: 'center', lh: 1.2, tbg: k === 'if' ? '#fff6dc' : p ? '#ffffff' : '#e6f6f4', tbr: 22, tbp: 24,
          mm: { k, mw: 560, bc: '#1fb5a8', ...(p ? { p } : {}), ...(br ? { br } : {}) }, x: x - 200, y: y - 34, w: 400, h: 67, rot: 0, op: 1 }; sk.layers.push(l); return l.id; };
      const root = node('Morgan\u2019s back piece', cx, cy), a = node('Peonies and koi', cx + 620, cy - 260, 'node', root), b = node('Black and grey?', cx + 620, cy + 240, 'if', root);
      node('Wash with red accents', cx + 1260, cy + 120, 'node', b, 'yes'); node('Full colour', cx + 1260, cy + 420, 'node', b, 'no'); node('3 sessions', cx - 640, cy - 200, 'node', root); node('Deposit taken', cx - 640, cy + 200, 'node', root); void a;
      const G = dzId(); sk.groups = { [G]: { name: 'Drawing', shut: true } }; sk.skG = G;
      for (const [b0, c0, P] of [['pen', '#1d2326', Array.from({ length: 24 }, (_, i) => [cx - 300 + i * 25, cy + 620 + Math.sin(i / 3) * 60, 0.6])],
        ['marker', '#f28c28', Array.from({ length: 18 }, (_, i) => [cx - 260 + i * 30, cy + 760 + Math.cos(i / 2) * 30, 0.7])]])
        sk.layers.push({ ...dzInkMake({ b: b0, c: c0, s: b0 === 'pen' ? 8 : 28 }, P), g: G });
      await mk2('Back piece plan', 'sketch', sk); } catch (e) { console.warn('Practice sketch:', e); }
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
