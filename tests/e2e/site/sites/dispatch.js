// dispatch.test: The Dispatch, a magazine. A front page and long articles
// with a hero picture, byline, drop cap, pull quotes, figures, a sticky
// section bar with a reading-progress line, a sticky share rail and related
// stories. SVG icon, theme-color.
import { art, avatar, doc, esc, icon } from './common.js';

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#b3261e"/><text x="32" y="34" text-anchor="middle" dominant-baseline="central" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="44" fill="#fff8ef">D</text></svg>`;

const LONG_TITLE =
  'What the river remembers: a year on foot along the Severn, from a bog high on a Welsh mountain to the wide brown mouth of the sea, and the towns and floods it has so quietly shaped';

const STORIES = [
  {
    path: '/2026/11/the-quiet-city',
    section: 'Cities',
    title: 'The Quiet City',
    dek: 'Between four and six in the morning, a capital belongs to the people who wake it up. We spent a month with them.',
    author: 'Mara Ellison',
    photos: 'Tomás Reyes',
    date: '6 November 2026',
    read: 12,
    hero: art('city', { seed: 3, p: 'dawn', w: 1600, h: 900 }),
    caption: 'The river at 5:40 a.m., before the first tram crosses the Kettle Bridge.',
    body: 'city',
  },
  {
    path: '/longread',
    section: 'Long read',
    title: LONG_TITLE,
    dek: 'Two hundred and twenty miles, four seasons, one river. A walk through the places the water has made and unmade.',
    author: 'Owen Hartley',
    photos: 'Isla Brennan',
    date: '1 November 2026',
    read: 38,
    hero: art('landscape', { seed: 11, p: 'forest', w: 1600, h: 900 }),
    caption: 'Plynlimon in April: the source is a wet patch among the grass, marked by a wooden post.',
    body: 'river',
  },
  {
    path: '/2026/11/salt-and-light',
    section: 'Food',
    title: 'Salt and Light',
    dek: 'On the last hand-raked salt pans of the coast, a harvest that depends on the wind, the sun and a great deal of patience.',
    author: 'Priya Natarajan',
    photos: 'Leo Marchetti',
    date: '4 November 2026',
    read: 9,
    hero: art('landscape', { seed: 4, p: 'desert', w: 1600, h: 900 }),
    caption: 'The pans at Alvor, an hour after sunrise.',
    body: 'short',
  },
  {
    path: '/2026/10/the-last-keepers',
    section: 'Places',
    title: 'The Last Keepers',
    dek: 'The lights are automatic now. The people who tended them still gather every autumn on the headland.',
    author: 'Ruth Calloway',
    photos: 'Ana Duarte',
    date: '29 October 2026',
    read: 14,
    hero: art('coast', { seed: 8, p: 'evening', w: 1600, h: 900 }),
    caption: 'Sennen Point at dusk. The light was automated in 1998.',
    body: 'short',
  },
  {
    path: '/2026/10/night-trains',
    section: 'Travel',
    title: 'The Night Trains Are Back',
    dek: 'Sleeper services are returning across the continent. We booked a berth from the Baltic to the Adriatic.',
    author: 'Jonas Vik',
    photos: 'Mei Tanaka',
    date: '24 October 2026',
    read: 11,
    hero: art('landscape', { seed: 7, p: 'night', w: 1600, h: 900 }),
    caption: 'Somewhere south of Linz, 2:10 a.m.',
    body: 'short',
  },
];

const P = {
  city: [
    'At four in the morning the city sounds like a held breath. The buses have stopped and the bars have emptied, and in the long gap before the first trams there is only the hum of the refrigerated trucks outside the market halls and, somewhere on the other side of the river, a dog that will not stop barking.',
    'This is the hour that belongs to the people who start the city up again. Bakers and sweepers, tram drivers and nurses on the turn of a shift, the man who unlocks the flower market and the woman who washes the steps of the central library with a hose. For a month we followed them, from the first light in a bakery window on Weaver Street to the moment, around a quarter past six, when the rest of us begin to arrive and the city stops being theirs.',
    '“People think nothing happens at night,” said Hanna Ruus, who has driven the first number 4 tram out of the Northgate depot for eleven years. “But everything happens at night. You just don’t see it, because by the time you wake up we have already put it back.”',
    'quote:By the time you wake up, we have already put it back.',
    'The depot opens at 3:50. Drivers check the brakes and the pantographs by torchlight, and a supervisor walks the length of each car looking for anything left behind the night before: umbrellas, mostly, and once, a violin. The first tram leaves at 4:42, empty except for Ruus and whoever she is training, and crosses the Kettle Bridge as the river begins to show grey under the lamps.',
    'figure:' + art('landscape', { seed: 2, p: 'dawn', w: 1400, h: 800 }) + '|The hills to the east catch the light first, twenty minutes before the streets do.',
    'On Weaver Street, the ovens at Brot & Salz have been on since two. Teodor Lind, who bought the bakery from its founder in 2019, works with three others in a room that is always too hot. They make four hundred loaves before six, and most of them are gone by nine. He keeps the front window lit from three o’clock, though the shop does not open until seven. “It is for the people walking home,” he said. “If they see a light, they know the day is coming.”',
    'The sweepers start in the centre and work outwards, in a pattern laid down in the 1970s and barely changed since. Their machines are quieter now, electric and slow, but the routine is the same: the squares first, then the shopping streets, then the long avenues that lead to the stations. By half past five, the square in front of the cathedral is wet and clean and entirely empty, and for a few minutes it looks like a drawing of itself.',
    'quote:For a few minutes, the square looks like a drawing of itself.',
    'Not everyone who is awake is working. In the all-night café by the bus station, a handful of regulars sit at the same tables every morning: a retired postman who no longer knows how to sleep past four, two students revising for exams, a taxi driver eating breakfast at the end of his shift rather than the start of it. The owner, Dalia, knows what each of them will order and has it ready before they sit down.',
    'figure-wide:' + art('city', { seed: 9, p: 'night', w: 1800, h: 800 }) + '|The office towers along the eastern bank keep a few lights burning all night. Cleaners finish there around five.',
    'At the hospital on the hill, the night shift hands over at seven, but the hour before is the busiest of the night. Bloods are taken, drugs are given, notes are written up for the day team. Sister Abena Owusu, who has worked nights on the same ward for nine years, says the early morning is when patients are most frightened. “They wake and they don’t know where they are,” she said. “So you sit with them for a minute. That is the job, really. The rest is paperwork.”',
    'At 6:12 on the last morning we spent with them, the first commuter train from the suburbs pulled into the central station, and several hundred people stepped out onto the platforms at once. Within ten minutes the quiet had gone. The café filled up, the trams ran full, the bakery window was just a shop window again. Hanna Ruus had finished her first loop of the city and was starting her second. “Now it is yours,” she said, nodding at the crowd. “Look after it.”',
  ],
  river: [
    'The Severn begins as almost nothing: a wet patch of ground on the flank of Plynlimon, marked by a wooden post that someone has carved with the river’s name in case you doubt it. You can stand with one foot either side of it. Two hundred and twenty miles later it is three miles wide and the second-highest tidal range in the world pours in and out of it twice a day.',
    'I walked it over the course of a year, a few days at a time, in all weathers and at every season. I wanted to know what it was like to follow a river all the way, and what a river does to the places it passes through. I found that the answer to the second question was: almost everything.',
    'quote:A river is a long argument between the land and the water, and the towns are where they have agreed to differ.',
    'In the uplands the river is fast and clear and loud. It runs over slate and through birch woods, under stone bridges built for packhorses, past farms where the same families have kept sheep for three hundred years. At Llanidloes, the first town, it is already big enough to flood, and the high-water marks on the wall of the old market hall go back to 1795.',
    'figure:' + art('landscape', { seed: 21, p: 'alpine', w: 1400, h: 800 }) + '|Above Llanidloes the valley narrows and the water quickens.',
    'By Shrewsbury the river has slowed and widened and begun to loop back on itself, wrapping almost all the way around the old town in a horseshoe that made it easy to defend and, later, hard to keep dry. The town has learned to live with the water: the car parks by the river are designed to flood, and the cafés along the bank keep their chairs light enough to carry upstairs.',
    'Further south, the river passes through the Ironbridge Gorge, where the industrial age more or less began. The bridge itself, cast in 1779, still stands, though the gorge it crosses is slowly sliding into the river and engineers spend a good part of every year holding it back. It is strange to stand there and think that the modern world was smelted on these banks.',
    'figure-wide:' + art('landscape', { seed: 12, p: 'dusk', w: 1800, h: 800 }) + '|The Severn Vale at dusk, from the hills above Tewkesbury.',
    'At Gloucester the river becomes tidal, and the character of it changes completely. Twice a day the sea pushes back up the estuary, and on the biggest tides of spring and autumn it arrives as a single wave, the Severn Bore, which surfers ride for miles inland. I watched it from the bank at Minsterworth on a cold March morning, with two hundred other people and their dogs. It came round the bend with a sound like a train.',
    'The last stretch is all mud and sky. The estuary widens until the far bank is a grey line, then nothing. Two great bridges cross it, and beyond them the river simply stops being a river and becomes the sea. There is no post to mark the end. I stood on the shingle at Sudbrook and watched the tide go out, and it seemed to take the whole year with it.',
  ],
  short: [
    'It starts before dawn, with the wind. If it blows from the north, dry and steady, the day will be good; if it comes off the sea, heavy and wet, there will be nothing to rake by evening. Everyone on the coast can read it, and most of them talk about it the way other people talk about money.',
    'The work itself has hardly changed in two hundred years. Sea water is let into a chain of shallow pans, moved from one to the next as it thickens, and left to the sun. When the crust forms, it is lifted by hand with long wooden rakes, piled in white cones along the banks and left to drain.',
    'quote:You don’t make salt. You wait for it, and you try not to get in the way.',
    'There were once dozens of families doing this along the shore. Now there are six, and the youngest of the people who rake is forty-eight. But orders have never been higher: restaurants in the cities want the flakes, and tourists come in coaches to watch the raking and buy a jar on the way out.',
    'figure:' + art('landscape', { seed: 31, p: 'mint', w: 1400, h: 800 }) + '|The last light on the drying banks.',
    'Whether that is enough to keep the pans going is a question nobody here likes to answer. For now, they rake, and wait for the wind.',
  ],
};

function paragraphs(kind) {
  let first = true;
  return P[kind]
    .map((p) => {
      if (p.startsWith('quote:')) return `<blockquote class="pull"><p>${esc(p.slice(6))}</p></blockquote>`;
      if (p.startsWith('figure:') || p.startsWith('figure-wide:')) {
        const wide = p.startsWith('figure-wide:');
        const [src, cap] = p.slice(p.indexOf(':') + 1).split('|');
        return `<figure class="${wide ? 'wide' : ''}"><img src="${src}" alt="" loading="lazy" width="1400" height="800"><figcaption>${esc(cap)} <span class="credit">Illustration: The Dispatch</span></figcaption></figure>`;
      }
      const out = `<p${first ? ' class="lede"' : ''}>${esc(p)}</p>`;
      first = false;
      return out;
    })
    .join('\n');
}

const SECTIONS = ['World', 'Cities', 'Culture', 'Science', 'Food', 'Travel', 'Long read', 'Opinion'];

function chrome(body, { active } = {}) {
  return `
<div class="topbar"><div class="wrap"><span>Friday, 6 November 2026</span><span class="tb-right"><a href="/">Today’s paper</a><a href="/subscribe" class="sub">Subscribe</a><a href="/signin">Sign in</a></span></div></div>
<header class="masthead"><a href="/" class="brand">The Dispatch</a><p class="motto">Independent journalism since 1897</p></header>
<nav class="sections" id="sections"><div class="wrap">${SECTIONS.map((s) => `<a href="/" class="${s === active ? 'on' : ''}">${s}</a>`).join('')}<button class="nav-search" aria-label="Search">${icon('search', { size: 18 })}</button></div><div class="progress"><i id="progress"></i></div></nav>
${body}
<footer class="foot"><div class="wrap"><div class="foot-brand">The Dispatch</div><div class="cols"><div><h4>Sections</h4>${SECTIONS.slice(0, 5).map((s) => `<a href="/">${s}</a>`).join('')}</div><div><h4>About</h4><a href="/">Our journalists</a><a href="/">Corrections</a><a href="/">Careers</a><a href="/">Contact us</a></div><div><h4>Subscribe</h4><a href="/subscribe">Digital</a><a href="/subscribe">Print + digital</a><a href="/subscribe">Gift a subscription</a></div><div><h4>Follow</h4><a href="/">Newsletters</a><a href="/">Podcasts</a><a href="/">Events</a></div></div><p class="legal">© 2026 The Dispatch Media Ltd. A test site: every story and name here is made up.</p></div></footer>
<script src="/assets/site.js" defer></script>`;
}

function article(story) {
  const related = STORIES.filter((s) => s !== story).slice(0, 3);
  const comments = 140 + story.title.length;
  const body = `
<main class="article">
  <header class="art-head">
    <a class="kicker" href="/">${esc(story.section)}</a>
    <h1${story.title.length > 80 ? ' class="long"' : ''}>${esc(story.title)}</h1>
    <p class="dek">${esc(story.dek)}</p>
    <div class="byline"><img src="${avatar(story.author)}" alt="" width="44" height="44"><div><div class="by">By <a href="/">${esc(story.author)}</a> · Photographs by ${esc(story.photos)}</div><div class="meta">${esc(story.date)} · ${story.read} min read</div></div></div>
  </header>
  <figure class="hero"><img src="${story.hero}" alt="" width="1600" height="900"><figcaption>${esc(story.caption)} <span class="credit">Illustration: The Dispatch</span></figcaption></figure>
  <div class="art-body">
    <aside class="share" aria-label="Share">
      <button title="Share">${icon('share')}</button><button title="Copy link">${icon('link')}</button><button title="Save" class="save">${icon('bookmark')}</button><button title="Comments" class="comments">${icon('chat')}<span>${comments}</span></button>
    </aside>
    <div class="text">
      ${paragraphs(story.body)}
      <section class="newsletter"><div><h3>The Morning Dispatch</h3><p>The day’s best stories, read by an editor, in your inbox at 6 a.m.</p></div><form onsubmit="event.preventDefault(); this.classList.add('done')"><input type="email" placeholder="you@example.test" aria-label="Email"><button>Sign up</button><span class="thanks">${icon('check', { size: 16 })} You’re on the list</span></form></section>
      <p class="end">◆</p>
      <div class="tags">${[story.section, 'Photography', 'Long reads', 'Europe'].map((t) => `<a href="/">${esc(t)}</a>`).join('')}</div>
      <div class="author"><img src="${avatar(story.author)}" alt="" width="64" height="64"><div><b>${esc(story.author)}</b> is a staff writer at The Dispatch, covering cities and the people who keep them running. Her last story was about the city’s lost rivers.</div></div>
    </div>
  </div>
</main>
<section class="related"><div class="wrap"><h2>More from The Dispatch</h2><div class="cards">${related.map(card).join('')}</div></div></section>`;
  return doc({ title: `${story.title} | The Dispatch`, icon: ICON, themeColor: '#faf6ef', description: story.dek, body: chrome(body, { active: story.section }) });
}

const card = (s) => `<a class="card" href="${s.path}"><img src="${s.hero}" alt="" loading="lazy"><span class="kicker">${esc(s.section)}</span><h3>${esc(s.title)}</h3><p>${esc(s.dek)}</p><span class="meta">${esc(s.author)} · ${s.read} min read</span></a>`;

function front() {
  const [lead, ...rest] = STORIES;
  const most = ['The bakers of Weaver Street', 'Why the trams still stop at 1:10', 'A new map of the city’s lost rivers', 'The library that never closes', 'Night trains, ranked', 'The hidden cost of free parking'];
  const body = `
<main class="front wrap">
  <section class="lead"><a href="${lead.path}" class="lead-img"><img src="${lead.hero}" alt=""></a><div class="lead-text"><span class="kicker">${esc(lead.section)}</span><h1><a href="${lead.path}">${esc(lead.title)}</a></h1><p class="dek">${esc(lead.dek)}</p><span class="meta">By ${esc(lead.author)} · ${lead.read} min read</span>
  <ol class="most"><li class="most-h">Most read</li>${most.map((m, i) => `<li><span>${i + 1}</span><a href="/">${esc(m)}</a></li>`).join('')}</ol></div></section>
  <section class="grid">${rest.map(card).join('')}</section>
</main>`;
  return doc({ title: 'The Dispatch — Independent journalism since 1897', icon: ICON, themeColor: '#faf6ef', body: chrome(body) });
}

const CSS = `
:root { --paper: #faf6ef; --ink: #1c1a17; --muted: #6d665c; --rule: #e3dbcd; --red: #b3261e; --serif: "Iowan Old Style", "Palatino Linotype", Palatino, ui-serif, Georgia, serif; --sans: -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif; }
* { box-sizing: border-box; }
html { scroll-padding-top: 64px; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 19px/1.65 var(--serif); -webkit-font-smoothing: antialiased; }
a { color: inherit; }
img { display: block; max-width: 100%; height: auto; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 28px; }
.topbar { font: 13px var(--sans); color: var(--muted); border-bottom: 1px solid var(--rule); }
.topbar .wrap { display: flex; justify-content: space-between; height: 38px; align-items: center; }
.tb-right { display: flex; gap: 20px; align-items: center; }
.tb-right a { text-decoration: none; }
.tb-right .sub { background: var(--red); color: #fff; padding: 5px 12px; border-radius: 4px; font-weight: 600; }
.masthead { text-align: center; padding: 26px 0 14px; }
.brand { font: 700 clamp(44px, 6vw, 76px)/1 "Old English Text MT", var(--serif); letter-spacing: -.01em; text-decoration: none; }
.motto { font: italic 14px var(--serif); color: var(--muted); margin: 8px 0 0; }
.sections { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--paper) 94%, transparent); backdrop-filter: blur(10px); border-top: 3px double var(--ink); border-bottom: 1px solid var(--rule); }
.sections .wrap { display: flex; gap: 26px; justify-content: center; align-items: center; height: 46px; font: 600 14px var(--sans); letter-spacing: .02em; }
.sections a { text-decoration: none; color: #3b3630; }
.sections a.on { color: var(--red); box-shadow: inset 0 -2px var(--red); padding: 12px 0; }
.nav-search { position: absolute; right: 28px; background: none; border: 0; color: var(--muted); cursor: pointer; }
.progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 3px; }
.progress i { display: block; height: 100%; width: 0; background: var(--red); transition: width .1s linear; }
.kicker { font: 700 13px var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--red); text-decoration: none; }
.meta { font: 13px var(--sans); color: var(--muted); }
.art-head { max-width: 860px; margin: 56px auto 32px; padding: 0 28px; text-align: center; }
.art-head h1 { font: 700 clamp(40px, 5.4vw, 68px)/1.04 var(--serif); letter-spacing: -.02em; margin: 14px 0 18px; text-wrap: balance; }
@supports (text-wrap: pretty) { .art-head h1.long { text-wrap: pretty; } }
.art-head h1.long { font-size: clamp(30px, 3.4vw, 44px); line-height: 1.12; max-width: 900px; margin-left: auto; margin-right: auto; }
.dek { font: italic 23px/1.45 var(--serif); color: #4a443c; margin: 0 auto 26px; max-width: 700px; }
.byline { display: inline-flex; gap: 12px; align-items: center; text-align: left; font: 15px var(--sans); }
.byline img { border-radius: 50%; }
.by a { font-weight: 600; }
.hero { margin: 0 auto 44px; max-width: 1280px; padding: 0 28px; }
.hero img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 2px; }
figcaption { font: 14px/1.45 var(--sans); color: var(--muted); margin-top: 10px; }
.credit { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; margin-left: 4px; }
.art-body { display: grid; grid-template-columns: 1fr minmax(0, 680px) 1fr; gap: 0 40px; padding: 0 28px; }
.share { grid-column: 1; justify-self: end; position: sticky; top: 90px; align-self: start; display: flex; flex-direction: column; gap: 10px; }
.share button { width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--rule); background: #fff; color: var(--ink); display: grid; place-items: center; cursor: pointer; transition: .15s; }
.share button:hover { border-color: var(--ink); }
.share .save.on { background: var(--ink); color: #fff; }
.share .comments { height: auto; padding: 10px 0 8px; border-radius: 22px; gap: 2px; font: 600 12px var(--sans); }
.text { grid-column: 2; }
.text p { margin: 0 0 1.25em; }
.lede::first-letter { float: left; font: 700 92px/0.8 var(--serif); margin: 8px 12px 0 0; color: var(--red); }
.pull { margin: 46px -40px; padding: 26px 0 22px; border-top: 2px solid var(--ink); border-bottom: 1px solid var(--rule); text-align: center; }
.pull p { margin: 0; font: italic 600 32px/1.3 var(--serif); letter-spacing: -.01em; text-wrap: balance; }
.pull p::before { content: "“"; color: var(--red); }
.pull p::after { content: "”"; color: var(--red); }
.text figure { margin: 40px 0; }
.text figure img { width: 100%; aspect-ratio: 7 / 4; object-fit: cover; }
.text figure.wide { margin: 52px calc(-1 * min(260px, (100vw - 740px) / 2)); }
.newsletter { display: flex; gap: 24px; align-items: center; justify-content: space-between; background: #f1e9db; border-left: 4px solid var(--red); padding: 22px 26px; margin: 44px 0; font-family: var(--sans); }
.newsletter h3 { margin: 0 0 4px; font: 700 20px var(--serif); }
.newsletter p { margin: 0; font-size: 15px; color: var(--muted); line-height: 1.4; }
.newsletter form { display: flex; gap: 8px; flex-shrink: 0; align-items: center; }
.newsletter input { font: 15px var(--sans); padding: 10px 12px; border: 1px solid #d3c8b5; border-radius: 4px; width: 210px; background: #fff; }
.newsletter button { font: 600 15px var(--sans); padding: 10px 16px; border: 0; border-radius: 4px; background: var(--ink); color: #fff; cursor: pointer; }
.newsletter .thanks { display: none; color: #2f6b3f; font-size: 14px; font-weight: 600; align-items: center; gap: 4px; }
.newsletter form.done input, .newsletter form.done button { display: none; }
.newsletter form.done .thanks { display: inline-flex; }
.end { text-align: center; color: var(--red); }
.tags { display: flex; gap: 8px; flex-wrap: wrap; margin: 28px 0; }
.tags a { font: 600 13px var(--sans); text-decoration: none; padding: 6px 12px; border: 1px solid var(--rule); border-radius: 99px; background: #fff; }
.author { display: flex; gap: 18px; align-items: center; padding: 22px 0; border-top: 1px solid var(--rule); font: 15px/1.5 var(--sans); color: #4a443c; margin-bottom: 40px; }
.author img { border-radius: 50%; }
.related { background: #f1e9db; padding: 48px 0 60px; border-top: 1px solid var(--rule); }
.related h2 { font: 700 15px var(--sans); letter-spacing: .14em; text-transform: uppercase; margin: 0 0 24px; }
.cards, .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
.grid { grid-template-columns: repeat(4, 1fr); padding: 40px 0 64px; border-top: 1px solid var(--rule); }
.card { text-decoration: none; display: flex; flex-direction: column; gap: 8px; }
.card img { aspect-ratio: 3 / 2; object-fit: cover; width: 100%; margin-bottom: 6px; }
.card h3 { font: 700 23px/1.2 var(--serif); margin: 0; text-wrap: balance; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.card p { margin: 0; font-size: 16px; line-height: 1.45; color: #4a443c; }
.card:hover h3 { text-decoration: underline; text-decoration-thickness: 1px; }
.front .lead { display: grid; grid-template-columns: 1.6fr 1fr; gap: 36px; padding: 36px 0 40px; }
.lead-img img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; }
.lead h1 { font: 700 54px/1.02 var(--serif); margin: 10px 0 14px; letter-spacing: -.02em; }
.lead h1 a { text-decoration: none; }
.lead .dek { text-align: left; font-size: 20px; margin-bottom: 12px; }
.most { list-style: none; padding: 18px 0 0; margin: 22px 0 0; border-top: 2px solid var(--ink); }
.most li { display: flex; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--rule); font: 600 16px/1.3 var(--sans); }
.most li span { font: 700 26px/1 var(--serif); color: var(--red); width: 22px; }
.most a { text-decoration: none; }
.most-h { font: 700 13px var(--sans) !important; letter-spacing: .14em; text-transform: uppercase; }
.foot { background: #1c1a17; color: #d6cfc3; padding: 44px 0 30px; font: 14px var(--sans); }
.foot-brand { font: 700 34px var(--serif); color: #fff; margin-bottom: 26px; }
.foot .cols { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; }
.foot h4 { color: #fff; margin: 0 0 10px; font-size: 13px; letter-spacing: .1em; text-transform: uppercase; }
.foot a { display: block; text-decoration: none; padding: 3px 0; color: #b9b0a2; }
.legal { margin: 36px 0 0; padding-top: 18px; border-top: 1px solid #3a3630; color: #8c8476; font-size: 13px; }
@media (max-width: 1000px) { .share { display: none; } .art-body { grid-template-columns: 0 minmax(0, 1fr) 0; } .grid { grid-template-columns: repeat(2, 1fr); } .front .lead { grid-template-columns: 1fr; } .pull { margin: 40px 0; } .text figure.wide { margin: 40px 0; } }
@media (max-width: 700px) { .cards { grid-template-columns: 1fr; } .sections .wrap { justify-content: flex-start; overflow-x: auto; } .newsletter { flex-direction: column; align-items: stretch; } }
`;

const JS = `
const bar = document.getElementById('progress');
const article = document.querySelector('.article');
if (bar && article) {
  const update = () => {
    const r = article.getBoundingClientRect();
    const total = r.height - innerHeight;
    bar.style.width = Math.max(0, Math.min(1, -r.top / (total || 1))) * 100 + '%';
  };
  addEventListener('scroll', update, { passive: true });
  update();
}
document.querySelector('.share .save')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
`;

export default {
  host: 'dispatch.test',
  name: 'The Dispatch',
  look: { bg: '#faf6ef', ink: '#1c1a17', accent: '#b3261e', font: '"Iowan Old Style", Palatino, ui-serif, Georgia, serif' },
  iconLink: ICON,
  pages: [
    { path: '/2026/11/the-quiet-city', title: 'The Quiet City | The Dispatch', what: 'A magazine article: hero, byline, drop cap, pull quotes, sticky bar', art: STORIES[0].hero },
    { path: '/longread', title: `${LONG_TITLE} | The Dispatch`, what: 'The same layout with a 180-character title', art: STORIES[1].hero },
    { path: '/', title: 'The Dispatch — Independent journalism since 1897', what: 'The magazine’s front page', art: STORIES[3].hero },
  ],
  longTitle: LONG_TITLE,
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/site.js': { type: 'text/javascript; charset=utf-8', body: JS },
    '/favicon.svg': { type: 'image/svg+xml', body: FAVICON },
  },
  routes: [
    ['GET', '/', () => front()],
    ['GET', /^\/(2026\/\d\d\/[\w-]+|longread)$/, ({ path }) => {
      const story = STORIES.find((s) => s.path === path);
      return story ? article(story) : null;
    }],
  ],
};
