import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const b = await chromium.launch(); const p = await b.newPage();
p.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 200)));
p.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 300)));
await p.goto(process.argv[2]); await new Promise((r) => setTimeout(r, 2500)); await b.close();
