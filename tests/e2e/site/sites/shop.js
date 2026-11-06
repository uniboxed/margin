// shop.test: Common Goods, a shop. The grid (filters, 24 drawn products, a
// sideways carousel of collections) and a product page per product
// (gallery, colour swatches, sizes, Add to bag: the title becomes
// "(1) Bag · …"). PNG icon.
import { art, doc, esc, icon } from './common.js';
import { rng } from '../art.js';

const ICON = '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">';

const LINES = [
  ['tote', 'Canvas Tote', '#d9c6a5', 'Carry', 'Market Tote', '#7d8f5a'],
  ['mug', 'Stoneware Mug', '#e7dccb', 'Kitchen', 'Speckle Mug', '#3f5a7a'],
  ['lamp', 'Dome Lamp', '#e0a458', 'Home', 'Pebble Lamp', '#9fb8ad'],
  ['sneaker', 'Court Sneaker', '#c8553d', 'Wear', 'Runner', '#3d5a80'],
  ['backpack', 'Daypack', '#2f4858', 'Carry', 'Roll-top Pack', '#c97b4a'],
  ['plant', 'Terracotta Pot', '#c66b3d', 'Home', 'Glazed Planter', '#5a7d9a'],
  ['chair', 'Lounge Chair', '#b5835a', 'Home', 'Studio Chair', '#4e6e58'],
  ['bottle', 'Field Bottle', '#6c8ead', 'Carry', 'Trail Bottle', '#e07a5f'],
  ['cap', 'Six-panel Cap', '#22333b', 'Wear', 'Wool Cap', '#a3b18a'],
  ['notebook', 'Dot Notebook', '#bc4749', 'Desk', 'Linen Notebook', '#6a994e'],
  ['candle', 'Cedar Candle', '#e9c46a', 'Home', 'Fig Candle', '#9d6381'],
  ['headphones', 'Studio Headphones', '#2b2d42', 'Desk', 'Wireless Cans', '#e5989b'],
];
const GROUNDS = ['#efe9df', '#e4ece4', '#f3e6dc', '#e5e9f0', '#f1ede4', '#ebe4ee'];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');

export const PRODUCTS = LINES.flatMap(([kind, a, ca, cat, b, cb], i) =>
  [[a, ca], [b, cb]].map(([name, color], k) => {
    const r = rng(`p${name}`);
    return {
      kind,
      name,
      slug: slug(name),
      color,
      cat,
      bg: GROUNDS[(i * 2 + k) % GROUNDS.length],
      price: Math.round(18 + r() * 160) + (r() < 0.5 ? 0 : 0.5),
      rating: Math.round((3.8 + r() * 1.2) * 10) / 10,
      reviews: Math.round(12 + r() * 600),
      badge: k === 0 && i % 4 === 0 ? 'New' : k === 1 && i % 5 === 1 ? 'Sale' : '',
    };
  }),
);
// Canvas Tote first: the page the tests open.
const pic = (p, extra = {}) => art('product', { kind: p.kind, c: p.color, bg: p.bg, ...extra });
const money = (n) => `$${n.toFixed(2).replace(/\.00$/, '')}`;
const stars = (r) => `<span class="stars" style="--r:${(r / 5) * 100}%" aria-label="${r} out of 5">★★★★★</span>`;

function chrome(body, { bag = 0 } = {}) {
  return `
<div class="promo">Free shipping on orders over $75 · Returns within 60 days · <a href="/">Gift cards</a></div>
<header class="top"><div class="wrap">
  <a class="logo" href="/"><svg width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="#2f5a3e"/><path d="M8 11h12l-1 10H9z" fill="#f6efe1"/><path d="M11 11V9.5a3 3 0 0 1 6 0V11" stroke="#f6efe1" stroke-width="1.8" fill="none"/></svg>Common Goods</a>
  <nav>${['New in', 'Home', 'Carry', 'Kitchen', 'Wear', 'Desk', 'Journal'].map((n) => `<a href="/">${n}</a>`).join('')}</nav>
  <label class="search">${icon('search', { size: 18 })}<input placeholder="Search goods" aria-label="Search"></label>
  <div class="tools"><a href="/" aria-label="Account">${icon('user')}</a><a href="/" aria-label="Saved">${icon('heart')}</a><a href="/" class="bag" aria-label="Bag">${icon('bag')}<b id="bag-count" ${bag ? '' : 'hidden'}>${bag}</b></a></div>
</div></header>
${body}
<footer class="foot"><div class="wrap">
  <div class="foot-news"><h3>Letters from the workshop</h3><p>New goods, restocks and the stories of the people who make them. Once a month.</p><form onsubmit="event.preventDefault()"><input placeholder="Email address" aria-label="Email"><button>Subscribe</button></form></div>
  <div class="foot-cols"><div><h4>Shop</h4><a href="/">New in</a><a href="/">Best sellers</a><a href="/">Gift cards</a></div><div><h4>Help</h4><a href="/">Shipping</a><a href="/">Returns</a><a href="/">Contact</a></div><div><h4>About</h4><a href="/">Our makers</a><a href="/">Materials</a><a href="/">Journal</a></div></div>
</div><p class="legal wrap">© 2026 Common Goods. A made-up shop on a test site.</p></footer>
<div class="toast" id="toast">${icon('check', { size: 18 })}<span></span></div>
<script src="/assets/shop.js" defer></script>`;
}

const productCard = (p) => `<a class="product" href="/p/${p.slug}">
  <div class="ph"><img src="${pic(p)}" alt="${esc(p.name)}" loading="lazy" width="400" height="400">${p.badge ? `<span class="badge ${p.badge === 'Sale' ? 'sale' : ''}">${p.badge}</span>` : ''}<button class="fav" aria-label="Save" onclick="event.preventDefault(); this.classList.toggle('on')">${icon('heart', { size: 18 })}</button></div>
  <div class="pi"><h3>${esc(p.name)}</h3><span class="price">${p.badge === 'Sale' ? `<s>${money(p.price * 1.25)}</s> ` : ''}${money(p.price)}</span></div>
  <div class="meta">${stars(p.rating)}<span>${p.rating} (${p.reviews})</span></div>
</a>`;

const COLLECTIONS = [
  ['The kitchen shelf', 'landscape', { seed: 31, p: 'mint' }],
  ['Everyday carry', 'landscape', { seed: 4, p: 'desert' }],
  ['Slow mornings', 'landscape', { seed: 2, p: 'dawn' }],
  ['The reading corner', 'landscape', { seed: 11, p: 'forest' }],
  ['Out of office', 'coast', { seed: 5 }],
  ['Light for winter', 'landscape', { seed: 7, p: 'night' }],
  ['Desk, sorted', 'landscape', { seed: 21, p: 'alpine' }],
  ['Gifts under $50', 'landscape', { seed: 12, p: 'dusk' }],
];

function grid() {
  const cats = ['Home', 'Carry', 'Kitchen', 'Wear', 'Desk'];
  const swatches = ['#d9c6a5', '#7d8f5a', '#2f4858', '#c8553d', '#e9c46a', '#9d6381', '#22333b', '#e5989b'];
  const body = `
<main class="wrap shop">
  <div class="crumbs"><a href="/">Home</a> / <span>All goods</span></div>
  <div class="head"><div><h1>All goods</h1><p>Useful things, made well, by people we know.</p></div></div>
  <section class="carousel-wrap" aria-label="Collections"><div class="row-h"><h2>Shop by collection</h2><div class="arrows"><button data-dir="-1" aria-label="Previous">${icon('chevron', { size: 18 })}</button><button data-dir="1" aria-label="Next">${icon('chevron', { size: 18 })}</button></div></div>
    <div class="carousel" id="carousel">${COLLECTIONS.map(([t, k, q]) => `<a class="coll" href="/"><img src="${art(k, { ...q, w: 800, h: 600 })}" alt=""><span>${esc(t)}<small>Shop now ${icon('chevron', { size: 14 })}</small></span></a>`).join('')}</div>
  </section>
  <div class="layout">
    <aside class="filters">
      <div class="f-head"><b>${icon('filter', { size: 16 })} Filters</b><a href="/">Clear all</a></div>
      <details open><summary>Category</summary>${cats.map((c, i) => `<label><input type="checkbox" ${i === 1 ? 'checked' : ''}> ${c}<span>${PRODUCTS.filter((p) => p.cat === c).length}</span></label>`).join('')}</details>
      <details open><summary>Price</summary><div class="range"><input type="range" min="0" max="200" value="140" aria-label="Most"><div class="range-l"><span>$0</span><span>$140</span></div></div></details>
      <details open><summary>Colour</summary><div class="sw">${swatches.map((c, i) => `<button style="--c:${c}" class="${i === 0 ? 'on' : ''}" aria-label="Colour ${i + 1}"></button>`).join('')}</div></details>
      <details open><summary>Size</summary><div class="sizes">${['XS', 'S', 'M', 'L', 'XL', 'One size'].map((s, i) => `<button class="${i === 2 ? 'on' : ''}">${s}</button>`).join('')}</div></details>
      <details><summary>Material</summary>${['Cotton canvas', 'Stoneware', 'Recycled', 'Wool'].map((m) => `<label><input type="checkbox"> ${m}</label>`).join('')}</details>
      <label class="toggle"><input type="checkbox" checked><i></i> In stock only</label>
    </aside>
    <section>
      <div class="bar"><span>${PRODUCTS.length} goods</span><label>Sort by <select><option>Featured</option><option>Newest</option><option>Price, low to high</option><option>Price, high to low</option></select></label></div>
      <div class="products">${PRODUCTS.map(productCard).join('')}</div>
      <div class="more"><span>Showing ${PRODUCTS.length} of ${PRODUCTS.length}</span><div class="pbar"><i></i></div></div>
    </section>
  </div>
</main>`;
  return doc({ title: 'All goods — Common Goods', icon: ICON, themeColor: '#2f5a3e', body: chrome(body) });
}

function productPage(p) {
  const others = PRODUCTS.filter((o) => o.kind === p.kind && o !== p);
  const colors = [p.color, ...others.map((o) => o.color), '#3b3b3b', '#efe7da'].slice(0, 4);
  const shots = [pic(p), pic(p, { a: -8 }), pic(p, { a: 8, bg: '#f4f1ea' }), pic(p, { bg: '#e2e7ea' })];
  const also = PRODUCTS.filter((o) => o.cat === p.cat && o !== p).slice(0, 4);
  const bars = [72, 18, 6, 3, 1];
  const body = `
<main class="wrap pdp">
  <div class="crumbs"><a href="/">Home</a> / <a href="/">${esc(p.cat)}</a> / <span>${esc(p.name)}</span></div>
  <div class="pdp-grid">
    <section class="gallery"><div class="thumbs">${shots.map((s, i) => `<button class="${i ? '' : 'on'}" data-src="${s}"><img src="${s}" alt=""></button>`).join('')}</div><div class="main-img"><img id="main-img" src="${shots[0]}" alt="${esc(p.name)}" width="400" height="400">${p.badge ? `<span class="badge">${p.badge}</span>` : ''}</div></section>
    <section class="buy">
      <span class="eyebrow">${esc(p.cat)} · Made in Portugal</span>
      <h1>${esc(p.name)}</h1>
      <div class="meta">${stars(p.rating)}<a href="#reviews">${p.rating} · ${p.reviews} reviews</a></div>
      <div class="price-l">${money(p.price)} <small>or 4 payments of ${money(p.price / 4)}</small></div>
      <p class="desc">A sturdy, everyday ${esc(p.kind === 'tote' ? 'bag in heavy cotton canvas, with long handles that sit comfortably on the shoulder and an inside pocket for keys' : 'piece, made in small batches and finished by hand, built to be used every day for years')}.</p>
      <div class="opt"><div class="opt-h">Colour <b id="colour-name">Natural</b></div><div class="swatches">${colors.map((c, i) => `<button style="--c:${c}" data-c="${c}" data-name="${['Natural', 'Olive', 'Charcoal', 'Oat'][i]}" class="${i ? '' : 'on'}" aria-label="${['Natural', 'Olive', 'Charcoal', 'Oat'][i]}"></button>`).join('')}</div></div>
      <div class="opt"><div class="opt-h">Size <a href="/">Size guide</a></div><div class="sizes">${['Small', 'Medium', 'Large'].map((s, i) => `<button class="${i === 1 ? 'on' : ''}">${s}</button>`).join('')}</div></div>
      <div class="actions"><div class="qty"><button data-q="-1" aria-label="Fewer">−</button><span id="qty">1</span><button data-q="1" aria-label="More">+</button></div><button class="add" id="add">${icon('bag', { size: 18 })} Add to bag · ${money(p.price)}</button><button class="save" aria-label="Save">${icon('heart')}</button></div>
      <ul class="perks"><li>${icon('check', { size: 16 })} Free shipping over $75</li><li>${icon('check', { size: 16 })} Free returns within 60 days</li><li>${icon('check', { size: 16 })} Ships in 1–2 working days</li></ul>
      <details open><summary>Details</summary><p>18 oz cotton canvas, waxed base, riveted handles. 40 × 38 × 14 cm. Holds a laptop up to 15 inches.</p></details>
      <details><summary>Materials and care</summary><p>Spot clean with a damp cloth. The canvas softens and darkens a little with use.</p></details>
      <details><summary>Shipping and returns</summary><p>Orders ship from our workshop in Porto. Returns are free within 60 days.</p></details>
    </section>
  </div>
  <section class="reviews" id="reviews"><h2>Reviews</h2><div class="rv-grid"><div class="rv-sum"><div class="big">${p.rating}</div>${stars(p.rating)}<p>${p.reviews} reviews</p>${bars.map((b, i) => `<div class="rbar"><span>${5 - i}★</span><i><b style="width:${b}%"></b></i><span>${b}%</span></div>`).join('')}</div>
  <div class="rv-list">${[['Hannah K.', 'My everyday bag now', 'Took it to work every day for three months. The canvas has softened up beautifully and it still looks new.'], ['Sam O.', 'Bigger than it looks', 'Fits my laptop, lunch and a jumper with room to spare. The inside pocket is a nice touch.'], ['Ines R.', 'Lovely colour', 'The colour is exactly as pictured. Handles could be a little longer for winter coats.']].map(([n, t, x], i) => `<article><div class="rv-h">${stars(5 - (i === 2 ? 1 : 0))}<b>${t}</b></div><p>${x}</p><span>${n} · Verified buyer</span></article>`).join('')}</div></div></section>
  <section class="also"><h2>You may also like</h2><div class="products four">${also.map(productCard).join('')}</div></section>
</main>`;
  return doc({ title: `${p.name} — Common Goods`, icon: ICON, themeColor: '#2f5a3e', body: chrome(body).replace('<script src="/assets/shop.js" defer></script>', `<script>window.PRODUCT = ${JSON.stringify({ name: p.name, price: p.price })};</script><script src="/assets/shop.js" defer></script>`) });
}

const CSS = `
:root { --ink: #1f2420; --muted: #6b716b; --line: #e6e2d9; --bg: #fbfaf7; --green: #2f5a3e; --clay: #c8673e; --sans: -apple-system, system-ui, "Helvetica Neue", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
img { display: block; max-width: 100%; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 0 32px; }
.promo { background: var(--green); color: #eef3ea; text-align: center; font-size: 13px; padding: 8px; letter-spacing: .01em; }
.promo a { text-decoration: underline; }
.top { background: #fff; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 20; }
.top .wrap { display: flex; align-items: center; gap: 28px; height: 68px; }
.logo { display: flex; align-items: center; gap: 10px; font: 700 20px/1 var(--sans); letter-spacing: -.02em; }
.top nav { display: flex; gap: 22px; font-weight: 500; font-size: 14px; }
.top nav a:hover { color: var(--green); }
.search { margin-left: auto; display: flex; align-items: center; gap: 8px; background: #f3f1ec; border-radius: 999px; padding: 0 14px; height: 40px; width: 260px; color: var(--muted); }
.search input { border: 0; background: none; outline: none; font: inherit; width: 100%; }
.tools { display: flex; gap: 16px; }
.bag { position: relative; }
.bag b[hidden] { display: none; }
.bag b { position: absolute; top: -6px; right: -9px; background: var(--clay); color: #fff; font-size: 11px; min-width: 18px; height: 18px; border-radius: 9px; display: grid; place-items: center; padding: 0 4px; }
.crumbs { font-size: 13px; color: var(--muted); padding: 22px 0 6px; }
.crumbs a:hover { color: var(--ink); }
.head h1 { font: 700 40px/1.1 var(--sans); letter-spacing: -.03em; margin: 6px 0 4px; }
.head p { color: var(--muted); margin: 0 0 22px; font-size: 16px; }
.row-h { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.row-h h2 { font-size: 18px; margin: 0; letter-spacing: -.01em; }
.arrows { display: flex; gap: 8px; }
.arrows button { width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--line); background: #fff; display: grid; place-items: center; }
.arrows button[data-dir="-1"] svg { transform: scaleX(-1); }
.carousel { display: flex; gap: 16px; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; padding-bottom: 4px; overscroll-behavior-x: contain; }
.carousel::-webkit-scrollbar { display: none; }
.coll { flex: 0 0 280px; height: 180px; border-radius: 16px; overflow: hidden; position: relative; scroll-snap-align: start; }
.coll img { width: 100%; height: 100%; object-fit: cover; transition: transform .4s; }
.coll:hover img { transform: scale(1.04); }
.coll span { position: absolute; inset: auto 0 0 0; padding: 40px 16px 14px; background: linear-gradient(transparent, rgba(0, 0, 0, .55)); color: #fff; font-weight: 600; font-size: 17px; }
.coll small { display: flex; align-items: center; gap: 2px; font-weight: 500; font-size: 13px; opacity: .85; }
.layout { display: grid; grid-template-columns: 240px 1fr; gap: 36px; margin: 36px 0 60px; }
.filters { position: sticky; top: 88px; align-self: start; font-size: 14px; }
.f-head { display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.f-head b { display: flex; gap: 6px; align-items: center; }
.f-head a { color: var(--muted); text-decoration: underline; font-size: 13px; }
details { border-bottom: 1px solid var(--line); padding: 12px 0; }
summary { font-weight: 600; cursor: pointer; list-style: none; display: flex; justify-content: space-between; }
summary::after { content: "+"; color: var(--muted); font-weight: 400; }
details[open] summary::after { content: "−"; }
details label { display: flex; gap: 8px; align-items: center; padding: 5px 0; }
details label span { margin-left: auto; color: var(--muted); font-size: 12px; }
input[type=checkbox] { accent-color: var(--green); width: 16px; height: 16px; }
.range { padding: 10px 0 0; }
.range input { width: 100%; accent-color: var(--green); }
.range-l { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
.sw { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; }
.sw button, .swatches button { width: 26px; height: 26px; border-radius: 50%; border: 0; background: var(--c); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .12); }
.sw button.on, .swatches button.on { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--ink); }
.sizes { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 10px; }
.sizes button { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 12px; font-size: 13px; }
.sizes button.on { border-color: var(--ink); background: var(--ink); color: #fff; }
.toggle { display: flex; align-items: center; gap: 10px; padding: 14px 0; font-weight: 500; }
.toggle input { display: none; }
.toggle i { width: 36px; height: 20px; border-radius: 10px; background: #cfcabd; position: relative; transition: .2s; }
.toggle i::after { content: ""; position: absolute; width: 16px; height: 16px; top: 2px; left: 2px; background: #fff; border-radius: 50%; transition: .2s; }
.toggle input:checked + i { background: var(--green); }
.toggle input:checked + i::after { left: 18px; }
.bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; color: var(--muted); font-size: 14px; }
.bar select { font: inherit; border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 10px; margin-left: 6px; color: var(--ink); }
.products { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 28px 20px; }
.products.four { grid-template-columns: repeat(4, 1fr); }
.product .ph { position: relative; border-radius: 14px; overflow: hidden; aspect-ratio: 1; }
.product .ph img { width: 100%; height: 100%; object-fit: cover; transition: transform .35s; }
.product:hover .ph img { transform: scale(1.05); }
.badge { position: absolute; top: 12px; left: 12px; background: #fff; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
.badge.sale { background: var(--clay); color: #fff; }
.fav { position: absolute; top: 10px; right: 10px; width: 34px; height: 34px; border-radius: 50%; border: 0; background: rgba(255, 255, 255, .85); display: grid; place-items: center; opacity: 0; transition: .2s; }
.product:hover .fav, .fav.on { opacity: 1; }
.fav.on { color: var(--clay); }
.fav.on svg { fill: currentColor; }
.pi { display: flex; justify-content: space-between; gap: 10px; margin-top: 12px; }
.pi h3 { margin: 0; font-size: 15px; font-weight: 600; }
.price { font-weight: 600; white-space: nowrap; }
.price s { color: var(--muted); font-weight: 400; }
.meta { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 13px; margin-top: 2px; }
.stars { position: relative; display: inline-block; color: #d8d3c6; font-size: 13px; letter-spacing: 1px; line-height: 1; }
.stars::before { content: "★★★★★"; position: absolute; inset: 0; width: var(--r); overflow: hidden; color: #e0a234; }
.more { text-align: center; color: var(--muted); font-size: 13px; margin-top: 40px; }
.pbar { width: 200px; height: 3px; background: var(--line); margin: 8px auto 0; border-radius: 2px; }
.pbar i { display: block; height: 100%; width: 100%; background: var(--ink); border-radius: 2px; }
.pdp-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 56px; margin: 12px 0 64px; }
.gallery { display: grid; grid-template-columns: 76px 1fr; gap: 14px; align-self: start; position: sticky; top: 90px; }
.thumbs { display: flex; flex-direction: column; gap: 10px; }
.thumbs button { padding: 0; border: 0; border-radius: 10px; overflow: hidden; opacity: .6; outline: 2px solid transparent; outline-offset: 2px; background: none; }
.thumbs button.on { opacity: 1; outline-color: var(--ink); }
.main-img { position: relative; border-radius: 20px; overflow: hidden; }
.main-img img { width: 100%; aspect-ratio: 1; object-fit: cover; }
.eyebrow { font-size: 13px; color: var(--muted); letter-spacing: .02em; }
.buy h1 { font: 700 40px/1.1 var(--sans); letter-spacing: -.03em; margin: 6px 0 8px; }
.buy .meta a { text-decoration: underline; }
.price-l { font: 600 26px var(--sans); margin: 18px 0 8px; }
.price-l small { font-size: 14px; color: var(--muted); font-weight: 400; margin-left: 8px; }
.desc { color: #474d47; font-size: 16px; max-width: 520px; }
.opt { margin: 22px 0; }
.opt-h { display: flex; gap: 8px; font-weight: 600; margin-bottom: 8px; }
.opt-h b { font-weight: 400; color: var(--muted); }
.opt-h a { margin-left: auto; font-weight: 400; text-decoration: underline; font-size: 13px; color: var(--muted); }
.swatches { display: flex; gap: 12px; }
.swatches button { width: 32px; height: 32px; }
.opt .sizes button { padding: 10px 22px; font-size: 14px; border-radius: 10px; }
.actions { display: flex; gap: 10px; margin: 28px 0 18px; }
.qty { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
.qty button { width: 40px; height: 52px; border: 0; background: none; font-size: 18px; }
.qty span { width: 24px; text-align: center; font-weight: 600; }
.add { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; height: 54px; border: 0; border-radius: 12px; background: var(--ink); color: #fff; font-weight: 600; font-size: 16px; transition: background .2s; }
.add:hover { background: var(--green); }
.add.done { background: var(--green); }
.save { width: 54px; border-radius: 12px; border: 1px solid var(--line); background: #fff; display: grid; place-items: center; }
.perks { list-style: none; padding: 0; margin: 0 0 18px; color: #474d47; font-size: 14px; }
.perks li { display: flex; gap: 8px; align-items: center; padding: 3px 0; color: var(--green); }
.buy details p { color: #474d47; margin: 8px 0 0; }
.reviews { border-top: 1px solid var(--line); padding: 44px 0; }
.reviews h2, .also h2 { font-size: 24px; letter-spacing: -.02em; margin: 0 0 22px; }
.rv-grid { display: grid; grid-template-columns: 280px 1fr; gap: 48px; }
.big { font: 700 56px/1 var(--sans); letter-spacing: -.03em; }
.rv-sum .stars { font-size: 18px; }
.rv-sum p { color: var(--muted); margin: 6px 0 16px; }
.rbar { display: grid; grid-template-columns: 26px 1fr 34px; gap: 8px; align-items: center; font-size: 12px; color: var(--muted); margin: 6px 0; }
.rbar i { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
.rbar b { display: block; height: 100%; background: #e0a234; }
.rv-list { display: grid; gap: 16px; }
.rv-list article { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; }
.rv-h { display: flex; gap: 12px; align-items: center; }
.rv-list p { margin: 8px 0; color: #474d47; }
.rv-list span { color: var(--muted); font-size: 13px; }
.also { padding-bottom: 60px; }
.foot { background: #1f2420; color: #c9cec6; padding: 52px 0 0; margin-top: 20px; }
.foot .wrap { display: grid; grid-template-columns: 1.3fr 1fr; gap: 48px; }
.foot h3 { color: #fff; font-size: 22px; margin: 0 0 6px; letter-spacing: -.02em; }
.foot-news p { margin: 0 0 16px; }
.foot-news form { display: flex; gap: 8px; }
.foot-news input { flex: 1; max-width: 300px; background: #2c332d; border: 1px solid #3d453e; border-radius: 10px; padding: 12px 14px; color: #fff; font: inherit; }
.foot-news button { background: #f6efe1; color: #1f2420; border: 0; border-radius: 10px; padding: 0 18px; font-weight: 600; }
.foot-cols { display: grid; grid-template-columns: repeat(3, 1fr); }
.foot h4 { color: #fff; margin: 0 0 10px; font-size: 14px; }
.foot-cols a { display: block; padding: 3px 0; color: #a7ada5; }
.legal { color: #7d847c; font-size: 13px; padding: 36px 32px 28px !important; display: block !important; }
.toast { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 120px); background: var(--ink); color: #fff; padding: 14px 20px; border-radius: 14px; display: flex; gap: 10px; align-items: center; box-shadow: 0 12px 30px rgba(0, 0, 0, .25); transition: transform .35s cubic-bezier(.2, .9, .3, 1.2); z-index: 50; font-weight: 500; }
.toast.on { transform: translate(-50%, 0); }
.toast svg { color: #9be2ae; }
@media (max-width: 1100px) { .top nav { display: none; } .pdp-grid { grid-template-columns: 1fr; } .gallery { position: static; } .products.four { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .filters { position: static; } .search { display: none; } .rv-grid { grid-template-columns: 1fr; } .foot .wrap { grid-template-columns: 1fr; } }
`;

const JS = `
const toast = document.getElementById('toast');
const say = (text) => { toast.querySelector('span').textContent = text; toast.classList.add('on'); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('on'), 2600); };
const carousel = document.getElementById('carousel');
document.querySelectorAll('.arrows button').forEach((b) => b.addEventListener('click', () => carousel.scrollBy({ left: Number(b.dataset.dir) * 296, behavior: 'smooth' })));
document.querySelectorAll('.sizes, .sw').forEach((g) => g.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); }));
const main = document.getElementById('main-img');
document.querySelectorAll('.thumbs button').forEach((b) => b.addEventListener('click', () => { main.src = b.dataset.src; document.querySelectorAll('.thumbs button').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelectorAll('.swatches button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.swatches button').forEach((x) => x.classList.toggle('on', x === b));
  document.getElementById('colour-name').textContent = b.dataset.name;
  const swap = (img) => { const u = new URL(img.getAttribute('src'), location.href); u.searchParams.set('c', b.dataset.c); img.src = u.pathname + u.search; };
  swap(main);
  document.querySelectorAll('.thumbs button').forEach((t) => { const img = t.querySelector('img'); swap(img); t.dataset.src = img.getAttribute('src'); });
}));
let qty = 1;
document.querySelectorAll('.qty button').forEach((b) => b.addEventListener('click', () => { qty = Math.max(1, Math.min(9, qty + Number(b.dataset.q))); document.getElementById('qty').textContent = qty; }));
let bag = 0;
const base = document.title;
document.getElementById('add')?.addEventListener('click', (e) => {
  bag += qty;
  const count = document.getElementById('bag-count');
  count.hidden = false;
  count.textContent = bag;
  document.title = '(' + bag + ') Bag · ' + base;
  e.currentTarget.classList.add('done');
  say((qty > 1 ? qty + ' × ' : '') + window.PRODUCT.name + ' added to your bag');
});
`;

export default {
  host: 'shop.test',
  name: 'Common Goods',
  blurb: 'Useful things, made well.',
  look: { bg: '#fbfaf7', ink: '#1f2420', accent: '#2f5a3e' },
  iconLink: ICON,
  pages: [
    { path: '/', title: 'All goods — Common Goods', what: 'A shop grid: filters, 24 drawn products, a sideways carousel', art: pic(PRODUCTS[0]) },
    { path: '/p/canvas-tote', title: 'Canvas Tote — Common Goods', what: 'A product page: gallery, swatches, sizes, Add to bag changes the title', art: pic(PRODUCTS[0], { a: -8 }) },
  ],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/shop.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [
    ['GET', '/', () => grid()],
    ['GET', /^\/p\/([\w-]+)$/, ({ params }) => {
      const p = PRODUCTS.find((x) => x.slug === params[1]);
      return p ? productPage(p) : null;
    }],
  ],
};
