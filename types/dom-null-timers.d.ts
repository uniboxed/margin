// Clearing a timer that may not be set (`null`), as the code does throughout: in browsers `clearTimeout(null)` and
// `clearInterval(null)` do nothing (HTML: an id with no timer is ignored), but the DOM lib's types take only a
// number or undefined.
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;
