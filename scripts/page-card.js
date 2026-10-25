// Arc's page card: continuous ("squircle") corners and a soft shadow, drawn
// as one 9-slice SVG border image. CSS border-radius only makes circular
// corners, and `corner-shape` isn't available in Safari, so the corner is
// generated here. scripts/build-styles.js writes the result into the CSS
// that draws the card (between `/* page-card … */` markers); a unit test
// checks they're current.
//
// Measured from Tirth's Arc screenshots (2×, see DECISIONS.md): a plain
// circle fits Arc's corner 16× worse than a smoothed one; best fit radius
// 6.25px with 80% smoothing. Shadow: a key shadow 1px down (σ 2.5px, 24%
// black) plus an ambient one (σ 1.5px, 6%), so the bottom edge is darker.

export const CARD = {
  radius: 6.25,
  smoothing: 0.8, // Figma's "corner smoothing"; Apple's continuous corners are ≈0.6
  frame: '#9c9da1', // the sidebar/frame color (content/sidebar.css --frame)
  shadows: [
    { dy: 0, sigma: 1.5, alpha: 0.06 },
    { dy: 1, sigma: 2.5, alpha: 0.24 },
  ],
};

const round = (n) => Math.round(n * 1000) / 1000;

// Figma's smoothed-corner construction ("Desperately seeking squircles"):
// each corner is a Bézier lead-in, a circular arc and a Bézier lead-out,
// together using p = (1 + smoothing) × radius of each edge.
function cornerParams(radius, smoothing) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const p = (1 + smoothing) * radius;
  const arcMeasure = 90 * (1 - smoothing);
  const arcLen = Math.sin(rad(arcMeasure / 2)) * radius * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3ToP4 = radius * Math.tan(rad(alpha / 2));
  const beta = 45 * smoothing;
  const c = p3ToP4 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arcLen - c - d) / 3;
  const a = 2 * b;
  return { p, arcLen, a, b, c, d };
}

// Closed path of a smoothed rounded rectangle, clockwise from the top edge.
export function squirclePath(x, y, width, height, { radius, smoothing }) {
  const { p, arcLen, a, b, c, d } = cornerParams(radius, smoothing);
  if (2 * p > Math.min(width, height)) throw new Error('page-card: corner too large for the rectangle');
  // Per corner: u = direction of travel, v = the next edge's direction.
  const corners = [
    { u: [1, 0], v: [0, 1] },
    { u: [0, 1], v: [-1, 0] },
    { u: [-1, 0], v: [0, -1] },
    { u: [0, -1], v: [1, 0] },
  ];
  const pt = ({ u, v }, du, dv) => `${round(u[0] * du + v[0] * dv)} ${round(u[1] * du + v[1] * dv)}`;
  const edges = [width - 2 * p, height - 2 * p, width - 2 * p, height - 2 * p];
  let path = `M${round(x + p)} ${round(y)}`;
  corners.forEach((k, i) => {
    path += `l${pt(k, edges[i], 0)}`;
    path += `c${pt(k, a, 0)} ${pt(k, a + b, 0)} ${pt(k, a + b + c, d)}`;
    path += `a${round(radius)} ${round(radius)} 0 0 1 ${pt(k, arcLen, arcLen)}`;
    path += `c${pt(k, d, c)} ${pt(k, d, b + c)} ${pt(k, d, a + b + c)}`;
  });
  return `${path}z`;
}

// The 9-slice image: a small card with `outset` px of room around it for the
// shadow and `inset` px inside each edge for the corner. Outside the card it
// holds the shadow (translucent, so it also falls on the sidebar); inside the
// card's box, only the frame color in the corners. Elsewhere transparent.
export function pageCardImage(card = CARD) {
  const { p } = cornerParams(card.radius, card.smoothing);
  const reach = Math.max(...card.shadows.map((s) => s.dy + 3 * s.sigma));
  const outset = Math.ceil(reach);
  const inset = Math.ceil(p + reach); // the corner, plus where its shadow differs from the edge's
  const slice = outset + inset;
  const size = 2 * slice + 2; // 2px middle, stretched along each edge
  const cardPath = squirclePath(outset, outset, size - 2 * outset, size - 2 * outset, card);
  const box = `M${outset} ${outset}h${size - 2 * outset}v${size - 2 * outset}h${-(size - 2 * outset)}z`;
  const whole = `M0 0h${size}v${size}h${-size}z`;
  const shadowFilter = card.shadows.map((s, i) =>
    `<feOffset in="SourceAlpha" dy="${s.dy}" result="o${i}"/>` +
    `<feGaussianBlur in="o${i}" stdDeviation="${s.sigma}" result="b${i}"/>` +
    `<feComponentTransfer in="b${i}" result="s${i}"><feFuncA type="linear" slope="${s.alpha}"/></feComponentTransfer>`).join('');
  const merge = card.shadows.map((_, i) => `<feMergeNode in="s${i}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    '<defs>' +
    `<clipPath id="out"><path clip-rule="evenodd" d="${whole}${cardPath}"/></clipPath>` +
    `<clipPath id="corners"><path clip-rule="evenodd" d="${box}${cardPath}"/></clipPath>` +
    `<filter id="shadow" filterUnits="userSpaceOnUse" x="0" y="0" width="${size}" height="${size}">${shadowFilter}<feMerge>${merge}</feMerge></filter>` +
    '</defs>' +
    `<path clip-path="url(#corners)" fill="${card.frame}" d="${box}"/>` +
    `<path clip-path="url(#out)" filter="url(#shadow)" d="${cardPath}"/>` +
    '</svg>';
  return { svg, size, slice, inset, outset };
}

const dataUrl = (svg) => `data:image/svg+xml,${svg.replace(/[#%<>"]/g, (ch) => encodeURIComponent(ch))}`;

// CSS declarations for an element whose border box is the page card. The
// card's corners and shadow are its border image; its border is transparent.
export function pageCardCss({ important = false, indent = '  ' } = {}) {
  const { svg, slice, inset, outset } = pageCardImage();
  const imp = important ? ' !important' : '';
  return [
    `border: ${inset}px solid transparent${imp};`,
    `border-image: url("${dataUrl(svg)}") ${slice} / ${slice}px / ${outset}px stretch${imp};`,
  ].map((line) => indent + line).join('\n');
}
