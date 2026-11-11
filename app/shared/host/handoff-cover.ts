import { pickBridge } from '../../../extension/ui/overlay-bridge.ts';
import { mountHandoffCover } from './handoff-cover-view.ts';

const bridge = pickBridge(globalThis);
const post = (op: string) => bridge ? bridge({ op }) : Promise.reject(new Error('no app'));
async function start() {
  const message = await post('hello');
  const cover = await mountHandoffCover(typeof message === 'string' ? JSON.parse(message) : message);
  (globalThis as any).marginCover = {
    recovering: () => cover.recovering(),
    shown: () => {
      requestAnimationFrame(() => requestAnimationFrame(() => { void post('cover.visible').catch(() => {}); }));
    },
  };
  await post('cover.prepared'); // DOM/theme ready off screen; not a claim of compositor visibility
}
start().catch(() => { void post('cover.failed').catch(() => {}); });
