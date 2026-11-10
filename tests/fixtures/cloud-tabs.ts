// iCloud Tabs as Margin.app sends them to an overlay (app/engines/webkit/safari/CloudTabs.swift
// json): made-up devices and tabs, never anyone's own. An iPhone used a few
// minutes ago (a pinned tab, a site Margin has an icon for and one it hasn't),
// a MacBook Air used yesterday (its record's time only, rounded to the day as
// Safari keeps it), and an iPad not used for ten days (dimmed). Times are
// relative to `now` (milliseconds).
const MIN = 60_000;
const DAY = 86_400_000;
const midnight = (ms: number) => { const t = new Date(ms); t.setHours(0, 0, 0, 0); return t.getTime(); };

export const PHONE = 'A1B2C3D4-0000-4000-8000-000000000001';
export const AIR = 'A1B2C3D4-0000-4000-8000-000000000002';
export const PAD = 'A1B2C3D4-0000-4000-8000-000000000003';

export function cloudFixture(now: number = Date.now()) {
  return {
    status: 'ready',
    devices: [
      {
        id: PHONE, name: 'Nora’s iPhone', kind: 'phone', model: 'com.apple.iphone-13-pro-9', modifiedAt: midnight(now), ephemeral: false, duplicateName: false,
        tabs: [
          { id: 'T-PHONE-1', title: 'Ferry timetable – Tagus Lines', url: 'https://tagus.example/ferries', pinned: true, viewedAt: now - 5 * MIN },
          { id: 'T-PHONE-2', title: 'Slow software — Margins', url: 'https://margins.example/essays/slow-software', pinned: false, viewedAt: now - 30 * MIN },
          { id: 'T-PHONE-3', title: 'Liquid surfaces – Pinwall', url: 'https://pinwall.example/board/liquid-surfaces', pinned: false, viewedAt: now - 60 * MIN },
        ],
      },
      {
        id: AIR, name: 'Studio MacBook Air', kind: 'mac', model: 'com.apple.macbookair-15-2025-silver', modifiedAt: midnight(now) - DAY, ephemeral: false, duplicateName: false,
        tabs: [
          { id: 'T-AIR-1', title: 'Render queue · Cloudrender', url: 'https://cloudrender.example/queue', pinned: false, viewedAt: 0 },
          { id: 'T-AIR-2', title: 'Ferry fares – Tagus Lines', url: 'https://tagus.example/fares', pinned: false, viewedAt: 0 },
        ],
      },
      {
        id: PAD, name: 'Kitchen iPad', kind: 'pad', model: 'com.apple.ipad-air-11-m2', modifiedAt: midnight(now) - 10 * DAY, ephemeral: false, duplicateName: false,
        tabs: [
          { id: 'T-PAD-1', title: 'Sourdough Hydration Chart: Stiff to Open Crumb – Bread Notes', url: 'https://breadnotes.example/hydration-chart', pinned: false, viewedAt: now - 10 * DAY - 3 * 3600_000 },
        ],
      },
    ],
  };
}
