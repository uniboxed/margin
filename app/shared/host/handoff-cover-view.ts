// Read-only theme rendering for the temporary live handoff cover. No runtime
// behaviors, browser requests, layout reports, state subscription or JS animation loop.
import { createAppHost } from '../../../extension/ui/host-app.ts';
import { loadTheme, resolveSettings } from '../../../extension/ui/theme-loader.ts';
import { buildViewModel } from '../../../extension/ui/view-model.ts';
import { View } from '../../../extension/ui/render.ts';

export async function mountHandoffCover(hello: any, doc: Document = document) {
  if (!hello?.theme || !Number.isInteger(hello.windowId) || typeof hello.profile !== 'string') throw new Error('no cover context');
  const host = createAppHost({ hello, post: async () => { throw new Error('read-only cover'); }, warn: () => {} });
  const pkg = hello.theme;
  let theme: Awaited<ReturnType<typeof loadTheme>> | null = null;
  let view: View | null = null;
  try {
    const state = host.getState();
    const across = state?.across;
    const sw = across?.switching;
    // Use the cached source hello only for its exact outgoing switch. Without
    // matching target rows, refusing is safer than drawing the source sidebar.
    if (!state || across?.profile !== hello.profile || sw?.from?.profile !== hello.profile || sw?.from?.windowId !== hello.windowId
      || sw.profile === hello.profile || !across.profiles.some((p: any) => p.id === sw.profile)
      || !across.spaces.some((s: any) => s.profile === sw.profile && s.id === sw.space)
      || !sw.content || sw.content.space !== sw.space) throw new Error('cover context does not name this switch');
    // The native host may have selected its built-in fallback for an absent
    // configured theme. The delivered package must still name its own manifest.
    if (typeof pkg.id !== 'string') throw new Error('cover theme does not name its package');
    const own = state.settings?.themes?.[pkg.id] ?? null;
    const files = Object.fromEntries(Object.entries(pkg.files ?? {}).map(([path, data]) => [path, Uint8Array.from(atob(String(data)), (c) => c.charCodeAt(0))]));
    theme = await loadTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files }, { document: doc, settings: own });
    if (!theme.ok || theme.id !== pkg.id) throw new Error('cover theme refused');
    let vm = buildViewModel({ state, ui: { windowId: host.windowId, mode: 'fullscreen', sidebar: 'open', focused: true }, platform: host.platform, settings: resolveSettings(theme.manifest, own) });
    if (!vm.ready || !vm.switchCover) throw new Error('cover context does not name this switch');
    view = new View(doc, theme.template, { sheets: [theme.sheet, theme.settingsSheet], onAction: () => {}, onInput: () => {} });
    view.update(vm);
    const loaded = theme;
    const mounted = view;
    return {
      view: mounted, get vm() { return vm; },
      recovering() {
        vm = { ...vm, switchCover: { ...vm.switchCover!, text: 'Restoring your window…', label: 'Restoring your window…' } };
        mounted.update(vm);
      },
      destroy() { mounted.destroy(); loaded.unload(); host.destroy(); },
    };
  } catch (error) {
    view?.destroy();
    if (theme?.ok) theme.unload();
    host.destroy();
    throw error;
  }
}
