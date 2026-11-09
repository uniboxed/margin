// The browser's own accessor for a property the page box takes over or reads around a page (Element's scrollTop,
// CSSStyleRule's style, window's innerWidth…), as `Object.getOwnPropertyDescriptor` gives it: with a getter, and a
// setter for those that can be set. Only for properties every browser Margin runs in has as accessors. A type only:
// nothing at run time.
export type Accessor = PropertyDescriptor & { get: (this: any) => any, set: (this: any, value: any) => void };
