// MAIN-world helper (Chromium only): performs the document.write for the
// isolated-world shell, so the written page is not bound by the isolated world's CSP.
document.addEventListener('margin-transplant', (e) => {
  const f = e.target; // the shell iframe (event dispatched on it)
  const markup = f.getAttribute('data-margin-markup');
  f.removeAttribute('data-margin-markup');
  const d = f.contentDocument;
  d.open(); d.write(markup); d.close();
}, true);
