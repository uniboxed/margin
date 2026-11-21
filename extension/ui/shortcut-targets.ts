// What Margin's numbered and pin keys act on, worked out from the view model as the sidebar draws it (the overlay's
// keys: app/shared/host/overlay.ts; the app's ShortcutSet: app/platforms/macos/shell/Shortcuts.swift).
// - ⌘D (toggle-pin): the pin bound to the row in front, anywhere in the space's pinned area (in a folder too, open
//   or closed) is unpinned; no pin bound to it: the row is pinned, unless its address is pinned already (a pin bound
//   to another tab), which would only be a second pin of the same page. The toast says what happened, once the
//   request has come back.
// - ⌘1–9 (item-index): the favorites, then the pins in the order the sidebar shows them (in open folders, and the
//   one shown in a closed folder), then today's rows.
import type { FavoriteRow, FolderRow, PinRow, TabRow, ViewModel } from './view-model.ts';

type Vm = Pick<ViewModel, 'tab' | 'space' | 'favorites'> | null | undefined;

/** Every pin of the space, in folders or not (a closed folder's too). */
export function allPins(vm: Vm): PinRow[] {
  if (!vm) return [];
  return vm.space.pinned.flatMap((g: FolderRow | PinRow) => (g.isFolder ? g.pins : [g]));
}

/** The row in front: the window's tab, else (Margin's own window: its items) today's row drawn in front. */
export function frontRowId(vm: Vm): number | string | null {
  if (!vm) return null;
  return vm.tab?.id ?? vm.space.today.find((t) => t.active)?.id ?? null;
}

export type PinToggle =
  | { kind: 'unpin', pinId: string }
  | { kind: 'pin', tabId: number | string }
  | { kind: 'pinned-already' }
  | { kind: 'none' };

/** What ⌘D does now. */
export function pinToggle(vm: Vm): PinToggle {
  const rowId = frontRowId(vm);
  const pins = allPins(vm);
  const bound = (rowId != null ? pins.find((p) => p.tabId != null && p.tabId === rowId) : null)
    ?? pins.find((p) => p.active && !p.away);
  if (bound) return { kind: 'unpin', pinId: bound.id };
  if (rowId == null) return { kind: 'none' };
  // (vm.tab.pinned: its address is a pin's, the pin bound to another tab.)
  if (vm?.tab && vm.tab.id === rowId && vm.tab.pinned) return { kind: 'pinned-already' };
  return { kind: 'pin', tabId: rowId };
}

type Runner = {
  dispatch(name: string, arg: unknown, origin: 'behavior'): unknown,
  showToast(text: string): void,
};

/**
 * ⌘D: the request made, then the toast for what came back (`failed`: the host's last request failed, host-app.ts
 * takeFailure). A refused action (false) shows nothing.
 */
export async function togglePin(vm: Vm, runner: Runner, failed: () => boolean = () => false): Promise<PinToggle['kind']> {
  const what = pinToggle(vm);
  if (what.kind === 'none') return what.kind;
  if (what.kind === 'pinned-already') { runner.showToast('Already Pinned'); return what.kind; }
  const res = what.kind === 'unpin' ? runner.dispatch('tab.unpin', what.pinId, 'behavior') : runner.dispatch('tab.pin', what.tabId, 'behavior');
  if (res === false) return 'none';
  const value = await res;
  if (failed()) return 'none';
  if (what.kind === 'unpin') runner.showToast('Unpinned Tab');
  else runner.showToast(typeof value === 'string' && value ? 'Pinned Tab' : 'Already Pinned');
  return what.kind;
}

export type NumberedRow = { kind: 'favorite', id: string } | { kind: 'pin', id: string } | { kind: 'tab', id: number | string };

/** ⌘1–9's rows, in the sidebar's order. */
export function numberedRows(vm: Vm): NumberedRow[] {
  if (!vm) return [];
  return [
    ...(vm.favorites?.items ?? []).map((f: FavoriteRow) => ({ kind: 'favorite' as const, id: f.id })),
    ...(vm.space.pinnedFlat ?? []).filter((g): g is PinRow => !g.isFolder).map((p) => ({ kind: 'pin' as const, id: p.id })),
    ...(vm.space.today ?? []).map((t: TabRow) => ({ kind: 'tab' as const, id: t.id })),
  ];
}

/** The action for ⌘`n` (1–9), or null: nothing there. */
export function numberedAction(vm: Vm, n: number): { name: 'favorite.open' | 'pin.open' | 'tab.activate', arg: string | number } | null {
  if (!Number.isInteger(n) || n < 1) return null;
  const row = numberedRows(vm)[n - 1];
  if (!row) return null;
  return { name: row.kind === 'favorite' ? 'favorite.open' : row.kind === 'pin' ? 'pin.open' : 'tab.activate', arg: row.id };
}
