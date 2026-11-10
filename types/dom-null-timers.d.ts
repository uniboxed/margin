// A timer's handle, as `setTimeout` and `setInterval` give it: a number in a browser, and Node's `Timeout` where the
// same code runs in the unit tests (tests/ are checked with Node's types too: tsconfig.tests.json).
type Timer = ReturnType<typeof setTimeout>;

// Clearing a timer that may not be set (`null`), as the code does throughout: in browsers `clearTimeout(null)` and
// `clearInterval(null)` do nothing (HTML: an id with no timer is ignored), but the DOM lib's types take only a
// number or undefined.
declare function clearTimeout(id: Timer | null | undefined): void;
declare function clearInterval(id: Timer | null | undefined): void;
