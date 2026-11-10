// What a crawl row comes to, shared by the crawl (as it writes a row) and the store (as it reads old ones).

// A row of results.jsonl (check.mts visit writes it; a skipped site or a crawler error has no loads). Rows are read
// back from older rounds too, so what came later is optional.
export type Cpu = { task: number, script?: number, style?: number, layout?: number };
export type LoadRow = {
  ok: boolean, status: number | null, ms: number, cpu?: Cpu | null, error: string | null, finalHost?: string | null,
  errors?: string[], m?: unknown, box?: unknown,
};
export type Row = {
  rank: number, domain: string, verdict: string, flags?: string[], at: string, commit?: string | null, error?: string,
  margin?: LoadRow, plain?: LoadRow, rules?: string[], samePage?: boolean, slot?: unknown, look?: unknown, shots?: boolean,
};
// A row whose site loaded both ways.
export type Loaded = Row & { margin: LoadRow, plain: LoadRow };

// The site turned an automated browser away (bot protection, a captcha, too many requests): the plain load
// was refused too, so it says nothing about Margin either way.
export const blockedStatus: ReadonlySet<number | null> = new Set([401, 403, 429]);
const challengeHost = /(^|\.)(captcha|challenge)[\w-]*\.|captcha/i;
export function isBlocked(plain: Pick<LoadRow, 'ok' | 'status' | 'finalHost'> | null | undefined) {
  if (!plain) return false;
  if (!plain.ok && blockedStatus.has(plain.status)) return true;
  return !!plain.finalHost && challengeHost.test(plain.finalHost);
}

// A row's verdict, with rows written before 'blocked' existed read as they'd be written now.
export function verdictOf(row: Row) {
  if ((row.verdict === 'plain-failed' || row.verdict === 'ok' || row.verdict === 'flagged') && isBlocked(row.plain)) return 'blocked';
  return row.verdict;
}

// What the box promises that a real site can be held to (tests/box/rules.ts): its place and size, what the page is
// told, the window still, <body> the scroller, nothing past the box sideways. Not `same-layout`, `same-scroll` or
// `same-answers`: a real site differs between two loads by itself (ads, a carousel, an A/B test).
export const HELD_RULES = ['box-at-slot', 'box-size', 'told-size', 'window-still', 'same-scroller', 'no-overflow'];
export const LOOSE_RULES = ['same-layout', 'same-scroll', 'same-answers'];
// What only suggests a look (a picture or a count off between two loads): never a finding by itself.
export const HINTS = ['content-cut-off', 'text-missing', 'elements-missing', 'blank', 'looks-different', 'more-errors'];

// The verdicts, best first, and progress.json's name for each.
//   flagged:  a rule the box promises is broken (HELD_RULES): a finding
//   hinted:   only hints, on the same page both ways: worth a look at its pictures, not a finding by itself
//   varied:   both loaded, but the site served each a different page (titles differ: a robot check, a login, a variant)
//             and only hints differ, so nothing says the box got it wrong
//   not-html: the address isn't a web page (plain text, JSON): the box leaves those alone, by design
export const VERDICTS = ['ok', 'flagged', 'margin-failed', 'hinted', 'varied', 'blocked', 'not-html', 'plain-failed', 'skipped', 'error'];
export const KEY: Record<string, string> = { ok: 'ok', flagged: 'flagged', 'margin-failed': 'marginFailed', hinted: 'hinted', varied: 'varied', blocked: 'blocked', 'not-html': 'notHtml', 'plain-failed': 'plainFailed', skipped: 'skipped', error: 'errors' };
// A site that ends in a crawler error this many times in a round is left at that for the round.
export const ERROR_TRIES = 3;
