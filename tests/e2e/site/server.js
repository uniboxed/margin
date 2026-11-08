// The e2e suite's test site: about twenty pages that look and behave like
// real sites, each site on its own `.test` host name, all from one local
// port. Nothing here reaches the network: the pictures are drawn (art.js),
// the raster files are made in memory (make-media.mjs), the video is a
// committed file made by make-video.mjs (files/<site>/), and fonts are the
// system's or the neo-brutalism theme's bundled ones. README.md lists the
// sites and what each one is for.
//
//   const site = await startSite();          // { port, url(host, path), sites, close }
//   site.url('shop.test', '/p/canvas-tote')  // 'http://shop.test:<port>/p/canvas-tote'
//
// Chromium reaches the hosts with HOST_RULES (every other host fails to
// resolve). A search engine's address is answered with searchResults(q)
// (the tests route it): a plain results page of this site's own pages.
//
// Every HTML page takes `?fp`: a recorder at the top of <head> notes where
// <html> sits in each of its first 40 frames (window.__fp), holding Margin's
// word to the page's box back until `&late=N` ms, as the WebKit host's /fp/
// pages do.
//
// `box.test` isn't a site: it serves the page patterns the box handles
// (tests/box/serve.js), so the suites that go through every site don't go through them.
//
// Nothing is logged unless MARGIN_E2E_VERBOSE is set.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { artFor } from './art.js';
import { media } from './make-media.mjs';
import { FIRST_FRAMES, notFound } from './sites/common.js';
import { SITES } from './sites/index.js';
import { searchResults as resultsPage } from './sites/search.js';
import { boxPage } from '../../box/serve.js';

export const HOST_RULES = 'MAP *.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
export { SITES };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FILES = join(HERE, 'files');
const FONTS = fileURLToPath(new URL('../../../extension/themes/neo-brutalism/fonts/', import.meta.url));
const TYPES = { '.webm': 'video/webm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

let made; // the raster files, made once a process
const art = new Map(); // drawn pictures, by address

export async function startSite({ port = 0, verbose = !!process.env.MARGIN_E2E_VERBOSE } = {}) {
  made ??= media();
  const byHost = new Map(SITES.map((s) => [s.host, s]));
  let actualPort = port;
  const url = (host, path = '/') => `http://${host}:${actualPort}${path}`;

  const server = createServer(async (req, res) => {
    const hostname = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const u = new URL(req.url, `http://${hostname || 'margin.test'}`);
    const site = byHost.get(hostname) ?? (hostname === '127.0.0.1' || hostname === 'localhost' ? byHost.get('margin.test') : null);
    if (verbose) console.log(`site ${req.method} ${hostname}${u.pathname}`);
    try {
      if (hostname === 'box.test') {
        const out = boxPage(u.pathname, u.searchParams);
        return send(res, out ? { ...out, cache: false } : { status: 404, type: 'text/plain; charset=utf-8', body: 'No such pattern.' }, u);
      }
      if (!site) return send(res, { status: 404, type: 'text/plain; charset=utf-8', body: 'No such site on the test server.' });
      // On every page: `?wait=<ms>` answers that late (a slow server), `?nocontent` with 204 (the page stays).
      const wait = Number(u.searchParams.get('wait'));
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      if (u.searchParams.has('nocontent')) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
      const out = await route(site, req, res, u, url);
      if (out === undefined) return; // the handler wrote it
      send(res, out, u);
    } catch (err) {
      if (verbose) console.log(err);
      if (!res.headersSent) send(res, { status: 500, type: 'text/plain; charset=utf-8', body: 'Server error' });
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  actualPort = server.address().port;
  server.keepAliveTimeout = 1000;
  return {
    port: actualPort,
    url,
    sites: SITES,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// The local results page for a search (no engine's name or look).
export function searchResults(query, port) {
  return resultsPage(query, (host, path = '/') => `http://${host}:${port}${path}`);
}

async function route(site, req, res, u, url) {
  const path = u.pathname;
  // Shared on every site: drawn pictures, made files, the committed files.
  const drawn = /^\/media\/art\/(\w+)\.svg$/.exec(path);
  if (drawn) {
    const key = `${drawn[1]}?${u.searchParams}`;
    if (!art.has(key)) art.set(key, artFor(drawn[1], u.searchParams));
    const body = art.get(key);
    return body ? { type: 'image/svg+xml', body, cache: true } : notFoundOut(site, path);
  }
  const key = `${site.dir ?? site.host.replace('.test', '')}${path}`;
  if (made.has(key)) return ranged(req, made.get(key).type, made.get(key).body);
  if (path.startsWith('/fonts/') && site.fonts) return file(join(FONTS, path.slice('/fonts/'.length)), site, path);
  if (path.startsWith('/files/')) return file(join(FILES, site.dir ?? site.host.replace('.test', ''), path.slice('/files/'.length)), site, path, req);
  if (site.assets?.[path]) return { ...site.assets[path], cache: false };

  const body = req.method === 'POST' ? await readBody(req) : '';
  for (const [method, pattern, handler] of site.routes) {
    if (method !== req.method && !(method === 'GET' && req.method === 'HEAD')) continue;
    const match = typeof pattern === 'string' ? (pattern === path ? [path] : null) : pattern.exec(path);
    if (!match) continue;
    const out = await handler({ req, res, url: u, path, query: u.searchParams, params: match, body, form: new URLSearchParams(body), link: url, site, sites: SITES });
    if (out === null) break; // the handler says: not here
    return out;
  }
  return notFoundOut(site, path);
}

const notFoundOut = (site, path) => ({ status: 404, body: notFound(site, path) });

function file(full, site, path, req) {
  const clean = normalize(full);
  if (!clean.startsWith(FILES) && !clean.startsWith(normalize(FONTS))) return notFoundOut(site, path);
  if (!existsSync(clean)) return notFoundOut(site, path);
  return ranged(req, TYPES[extname(clean)] ?? 'application/octet-stream', readFileSync(clean));
}

// Audio and video are asked for in ranges.
function ranged(req, type, bytes) {
  const range = req?.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return { status: 206, type, body: bytes.subarray(start, end + 1), cache: true, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'accept-ranges': 'bytes' } };
  }
  return { type, body: bytes, cache: true, headers: { 'accept-ranges': 'bytes' } };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

async function send(res, out, u) {
  if (typeof out === 'string') out = { body: out };
  if (out.delay) await new Promise((r) => setTimeout(r, out.delay));
  const type = out.type ?? 'text/html; charset=utf-8';
  let body = out.body ?? '';
  if (typeof body === 'string' && type.startsWith('text/html') && u?.searchParams.has('fp')) body = body.replace('<head>', `<head>\n${FIRST_FRAMES}`);
  res.statusCode = out.status ?? (out.location ? 302 : 200);
  res.setHeader('content-type', type);
  res.setHeader('cache-control', out.cache ? 'public, max-age=600' : 'no-store');
  if (out.location) res.setHeader('location', out.location);
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  res.end(body);
}
