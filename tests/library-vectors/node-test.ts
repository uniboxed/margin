// node:test as the tests see it while the recorder runs them (hooks.ts): the same, each test's name kept while it
// runs, so its library calls are recorded under it (the tests of a file run one after another).
import * as real from 'node:test';
import { current } from './log.ts';

// (What tests/ imports of it: test, before, after, the TestContext type.)
export const { before, after } = real;
export type { TestContext } from 'node:test';

const named = (name: string, fn: (...a: any[]) => any) => async (...a: any[]) => {
  const outer = current.test;
  current.test = outer ? `${outer} › ${name}` : name;
  try { return await fn(...a); } finally { current.test = outer; }
};

export const test: typeof real.test = ((name: any, ...rest: any[]) => {
  const label = typeof name === 'string' ? name : '';
  return (real.test as any)(name, ...rest.map((x) => (typeof x === 'function' ? named(label, x) : x)));
}) as any;
export default test;
