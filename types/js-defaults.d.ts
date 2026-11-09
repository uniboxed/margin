// What the code was type-checked against while it was JavaScript, kept for TypeScript: in a JavaScript file a
// generic call with nothing to infer from gives `any`; in TypeScript it gives `unknown`. These are the calls that
// relied on it: `Object.values`, `Object.entries` and `Array.from` of an untyped (`any`) value, and a `Map` or
// `Set` made from one. Typed arguments keep their types (the lib's own overloads say the same; these only add the default).
// Remove once those values are typed.
interface ObjectConstructor {
  values<T = any>(o: { [s: string]: T } | ArrayLike<T>): T[];
  entries<T = any>(o: { [s: string]: T } | ArrayLike<T>): [string, T][];
}
interface ArrayConstructor {
  from<T = any>(iterable: Iterable<T> | ArrayLike<T>): T[];
}
interface MapConstructor {
  new <K = any, V = any>(entries?: Iterable<readonly [K, V]> | null): Map<K, V>;
}
interface SetConstructor {
  new <T = any>(values?: Iterable<T> | null): Set<T>;
}
