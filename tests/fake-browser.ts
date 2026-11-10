// A test's own fake of the browser API (MarginBrowserApi, types/browser.d.ts), typed: the parts the test provides,
// each typed as the real one, the rest left out (the code under test never reaches them). A test sets it as
// `globalThis.chrome = fakeBrowser({ … })`: checked part by part against the real API, then handed to the code as the
// whole. Nothing else runs here: fakeBrowser gives back the same object.

// Every part optional, down to an event's addListener; a function takes the real one's parameters, and answers as the
// real one does, only with what the code reads of it: any of an answer's fields (a tab's id and address, a window's
// id), or nothing where the code doesn't read it (a window update's). What it does give is typed as the real one's.
type Part<R> = R extends (infer E)[] ? Part<E>[] : R extends object ? { [K in keyof R]?: R[K] } : R;
type Answer<R> = R extends Promise<infer X> ? Promise<Part<X> | void> : Part<R> | void;
// (A method, as types/browser.d.ts declares them: its parameters compared both ways, as for the real API's.)
type Method<A extends any[], R> = { method(...args: A): R }['method'];
type Fake<T> = T extends (...args: infer A) => infer R ? Method<A, Answer<R>> : T extends object ? { [K in keyof T]?: Fake<T[K]> } : T;

// A storage area as Margin asks it: by a key or keys, or everything (null). Margin never passes defaults (an object),
// so the fakes take only those.
export interface FakeStorageArea {
  get?(keys?: string | string[] | null): Promise<Record<string, any>>;
  set?(items: Record<string, any>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
  clear?(): Promise<void>;
}

// scripting.executeScript as one call (the real one is two overloads, a function's or files, which a fake's single
// function can't be typed against): `args` are the page function's own, whatever it takes; the rows' results are the
// page's answers.
export interface FakeInjection {
  target: BrowserInjectionTarget;
  func?: (...args: any[]) => unknown;
  files?: string[];
  args?: any[];
  world?: 'ISOLATED' | 'MAIN';
  injectImmediately?: boolean;
}
export type FakeInjectionResult = { frameId?: number, result?: unknown, documentId?: string };

type Api = MarginBrowserApi;
export type FakeBrowserApi = Fake<Omit<Api, 'storage' | 'scripting'>> & {
  storage?: { local?: FakeStorageArea, session?: FakeStorageArea, onChanged?: Fake<Api['storage']['onChanged']> },
  scripting?: Fake<Omit<Api['scripting'], 'executeScript'>> & {
    executeScript?(injection: FakeInjection): Promise<FakeInjectionResult[]>,
  },
};

// The fake as the code under test takes it: the whole API. The same object, unchanged.
export function fakeBrowser(parts: FakeBrowserApi): MarginBrowserApi {
  return parts as MarginBrowserApi;
}
