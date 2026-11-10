// Every site of the test site, by host name.
import type { Site } from './common.ts';
import margin from './margin.ts';
import dispatch from './dispatch.ts';
import shop from './shop.ts';
import reel from './reel.ts';
import docs from './docs.ts';
import murmur from './murmur.ts';
import metrics from './metrics.ts';
import post from './post.ts';
import noir from './noir.ts';
import accounts from './accounts.ts';
import embed, { maps } from './embed.ts';
import slow from './slow.ts';
import harbor from './harbor.ts';
import focus from './focus.ts';
import radio from './radio.ts';
import app from './app.ts';
import search from './search.ts';

export const SITES: Site[] = [margin, dispatch, shop, reel, docs, murmur, metrics, post, noir, accounts, embed, maps, slow, harbor, focus, radio, app, search];
