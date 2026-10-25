// MAIN-world document_start probe (all frames): does it run in the transplanted frame, and before page scripts?
(() => { try { window.webkit.messageHandlers.m.postMessage(JSON.stringify({ ev: 'main-world', href: location.href, framed: window !== top, scripts: document.scripts.length, t: Math.round(performance.now()) })); } catch (e) {} })();
