// The differential corpus for HTMLRewriter: one set of inputs, run by two
// engines. Bun's answers are recorded in scripts/fixtures/html-rewriter-bun.json
// and the spike asserts ours match them exactly.
//
// This file is shared by the spike and by the fixture generator ON PURPOSE — if
// the cases could drift apart from the recorded answers, the fixture would be
// pinning something other than what runs.
//
// To re-record against a newer Bun (the fixture header says which produced it):
//
//   curl -fsSL https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip -o /tmp/bun.zip
//   cd /tmp && unzip -q bun.zip
//   /tmp/bun-linux-x64/bun run scripts/record-html-rewriter.mjs > scripts/fixtures/html-rewriter-bun.json
//
// A regenerated fixture that differs is not a test failure to paper over: it
// means Bun changed, and the shim has to decide whether to follow.

// Shared cases: run by real bun and by Vivari's shim, then diffed.
export const CASES = [
  ["passthrough", "<P CLASS='a'   data-x=1 >hi</P >", (r) => r.on("nope", {})],
  ["setAttribute", "<p>hi</p>", (r) => r.on("p", { element(e) { e.setAttribute("x", "1"); } })],
  ["setAttribute quoting", "<a href=/x>t</a>", (r) => r.on("a", { element(e) { e.setAttribute("title", 'a"b<c&d'); } })],
  ["preserve other attrs", "<b\n  x='1'\n>t</b>", (r) => r.on("b", { element(e) { e.setAttribute("y", "2"); } })],
  ["removeAttribute", "<a href='/x' rel=nofollow>t</a>", (r) => r.on("a", { element(e) { e.removeAttribute("rel"); } })],
  ["set tagName", "<div>x</div>", (r) => r.on("div", { element(e) { e.tagName = "section"; } })],
  ["before/after text", "<b>x</b>", (r) => r.on("b", { element(e) { e.before("A<i>&"); e.after("B"); } })],
  ["before/after html", "<b>x</b>", (r) => r.on("b", { element(e) { e.before("<i>A</i>", { html: true }); } })],
  ["prepend/append", "<b>x</b>", (r) => r.on("b", { element(e) { e.prepend("["); e.append("]"); } })],
  ["replace", "<b>x</b>", (r) => r.on("b", { element(e) { e.replace("<hr>", { html: true }); } })],
  ["remove", "a<b>x</b>c", (r) => r.on("b", { element(e) { e.remove(); } })],
  ["removeAndKeepContent", "a<b>x<i>y</i></b>c", (r) => r.on("b", { element(e) { e.removeAndKeepContent(); } })],
  ["setInnerContent", "<b>x<i>y</i></b>", (r) => r.on("b", { element(e) { e.setInnerContent("Z"); } })],
  ["setInnerContent html", "<b>x</b>", (r) => r.on("b", { element(e) { e.setInnerContent("<i>Z</i>", { html: true }); } })],
  ["remove then append", "<b>x</b>", (r) => r.on("b", { element(e) { e.remove(); e.append("Z"); } })],
  ["onEndTag before", "<b>x</b>", (r) => r.on("b", { element(e) { e.onEndTag((t) => t.before("!")); } })],
  ["onEndTag remove", "<b>x</b>", (r) => r.on("b", { element(e) { e.onEndTag((t) => t.remove()); } })],
  ["onEndTag rename", "<b>x</b>", (r) => r.on("b", { element(e) { e.onEndTag((t) => { t.name = "i"; }); } })],
  ["append to void", "<img src=x>", (r) => r.on("img", { element(e) { e.append("Z"); } })],
  ["unclosed append", "<div>x", (r) => r.on("div", { element(e) { e.append("Z"); } })],
  ["malformed", "<p><b>x</p>", (r) => r.on("b", { element(e) { e.setAttribute("z", "1"); } })],
  ["nested same", "<div><div>x</div></div>", (r) => r.on("div", { element(e) { e.setAttribute("n", "1"); } })],
  ["text replace", "<p>hi</p>", (r) => r.on("p", { text(t) { if (t.text) t.replace("YO"); } })],
  ["text before+remove", "<p>hi</p>", (r) => r.on("p", { text(t) { if (t.text) { t.before("["); t.remove(); } } })],
  ["comment set", "<p><!-- c --></p>", (r) => r.on("p", { comments(c) { c.text = "d"; } })],
  ["comment remove", "<p><!--c-->x</p>", (r) => r.on("p", { comments(c) { c.remove(); } })],
  ["doc end append", "<p>x</p>", (r) => r.onDocument({ end(e) { e.append("<!--end-->", { html: true }); } })],
  ["doctype remove", "<!DOCTYPE html><p>x</p>", (r) => r.onDocument({ doctype(d) { d.remove(); } })],
  ["script untouched", "<script>if (a<b) {}</script><p>x</p>", (r) => r.on("p", { element(e) { e.setAttribute("z", "1"); } })],
  ["style text", "<style>a{b:c}</style>", (r) => r.on("style", { text(t) { if (t.text) t.replace("/*gone*/"); } })],
  ["svg child", "<svg><rect/></svg>", (r) => r.on("rect", { element(e) { e.setAttribute("fill", "red"); } })],
  ["entities kept", "<p>a&amp;b&#65;</p>", (r) => r.on("p", { element(e) { e.setAttribute("z", "1"); } })],
  ["p self closing", "<p/>x", (r) => r.on("p", { element(e) { e.setAttribute("z", "1"); } })],
  ["utf8", "<p>caf\u00e9 \u4f60\u597d</p>", (r) => r.on("p", { element(e) { e.setAttribute("z", "\u00e9"); } })],
  ["multiple rules", "<p>x</p>", (r) => r.on("p", { element(e) { e.setAttribute("a", "1"); } }).on("p", { element(e) { e.setAttribute("b", "2"); } })],
  ["attr selector", "<p data-x='1'>a</p><p>b</p>", (r) => r.on("[data-x='1']", { element(e) { e.setAttribute("hit", "1"); } })],
  ["class selector", "<p class='a b'>x</p><p class='c'>y</p>", (r) => r.on(".b", { element(e) { e.setAttribute("hit", "1"); } })],
  ["id selector", "<p id=i>x</p><p>y</p>", (r) => r.on("#i", { element(e) { e.setAttribute("hit", "1"); } })],
  ["descendant", "<div><span><i>x</i></span></div><i>y</i>", (r) => r.on("div i", { element(e) { e.setAttribute("hit", "1"); } })],
  ["child combinator", "<div><p>a</p><span><p>b</p></span></div>", (r) => r.on("div > p", { element(e) { e.setAttribute("hit", "1"); } })],
  ["not", "<div><p>a</p><span>b</span></div>", (r) => r.on("div :not(p)", { element(e) { e.setAttribute("hit", "1"); } })],
  ["nth-child", "<ul><li>1</li><li>2</li><li>3</li></ul>", (r) => r.on("li:nth-child(2)", { element(e) { e.setAttribute("hit", "1"); } })],
  ["first-child", "<ul><li>1</li><li>2</li></ul>", (r) => r.on("li:first-child", { element(e) { e.setAttribute("hit", "1"); } })],
  ["comma list", "<p>a</p><span>b</span><i>c</i>", (r) => r.on("p, span", { element(e) { e.setAttribute("hit", "1"); } })],
  ["star", "<div><p>x</p></div>", (r) => r.on("*", { element(e) { e.setAttribute("hit", "1"); } })],
  ["attr prefix op", "<p data-x='foobar'>a</p><p data-x='barfoo'>b</p>", (r) => r.on("[data-x^='foo']", { element(e) { e.setAttribute("hit", "1"); } })],
  ["attr contains op", "<p class='xy'>a</p><p class='zz'>b</p>", (r) => r.on("[class*='x']", { element(e) { e.setAttribute("hit", "1"); } })],
  ["tilde op", "<p class='a b'>x</p>", (r) => r.on("[class~='b']", { element(e) { e.setAttribute("hit", "1"); } })],
];

// Observations that are not the output string: what handlers SAW.
export const OBSERVE = [
  ["text chunks", "<p>hello <b>x</b> world</p>", (r, log) => r.on("p", { text(t) { log.push([t.text, t.lastInTextNode]); } })],
  ["doc text", "a<p>b</p>c", (r, log) => r.onDocument({ text(t) { log.push(t.text); } })],
  ["tagName seen", "<DIV>x</DIV>", (r, log) => r.on("div", { element(e) { log.push(e.tagName); } })],
  ["attributes list", "<a HREF='/x' Data-Y=2>t</a>", (r, log) => r.on("a", { element(e) { log.push([...e.attributes]); } })],
  ["attributes after set", "<b x=1>t</b>", (r, log) => r.on("b", { element(e) { e.setAttribute("y", "2"); log.push([...e.attributes]); } })],
  ["flags", "<img src=x><br/><p/><div>y</div>", (r, log) => r.on("*", { element(e) { log.push([e.tagName, e.selfClosing, e.canHaveContent, e.namespaceURI]); } })],
  ["svg ns", "<svg><rect/></svg>", (r, log) => r.on("*", { element(e) { log.push([e.tagName, e.namespaceURI, e.canHaveContent]); } })],
  ["removed flag", "<b>x</b>", (r, log) => r.on("b", { element(e) { e.remove(); log.push(e.removed); } })],
  ["comment text", "<p><!-- c --></p>", (r, log) => r.on("p", { comments(c) { log.push(c.text); } })],
  ["doctype fields", "<!DOCTYPE html><p>x</p>", (r, log) => r.onDocument({ doctype(d) { log.push([d.name, d.publicId, d.systemId]); } })],
  ["doctype public", '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">', (r, log) => r.onDocument({ doctype(d) { log.push([d.name, d.publicId, d.systemId]); } })],
  ["handler in removed", "<div><span>x</span></div>", (r, log) => r.on("div", { element(e) { e.remove(); } }).on("span", { element() { log.push("span ran"); } })],
  ["order doc vs el", "<p>x</p>", (r, log) => r.onDocument({ text() { log.push("doc"); } }).on("p", { text() { log.push("el"); } })],
  ["getAttribute case", "<a HREF='/x'>t</a>", (r, log) => r.on("a", { element(e) { log.push([e.getAttribute("href"), e.hasAttribute("HREF"), e.getAttribute("nope")]); } })],
  ["nested hits", "<div><div>x</div></div>", (r, log) => r.on("div", { element() { log.push("hit"); } })],
  ["duplicate attrs", "<b x=1 x=2>t</b>", (r, log) => r.on("b", { element(e) { log.push([...e.attributes]); } })],
];

// Selectors that must be REJECTED, and with which message.
export const BAD_SELECTORS = ["", "   ", "p, ", "p::before", "a:hover", "[data-x=1]", ":nth-child(", "p:unknown-thing"];

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset=utf-8><title>T &amp; T</title>
<link rel=stylesheet href='/a.css'>
<style>body { color: #333 }</style>
</head>
<body class="home  dark" data-env='prod'>
  <!-- nav -->
  <nav id="top"><ul><li class="item on"><a href="/a">A</a></li><li class=item><a href='/b'>B</a></li></ul></nav>
  <main>
    <h1>Hello <em>world</em>!</h1>
    <p>Text with <b>bold</b> and <i>italic</i> &amp; an entity.</p>
    <img src="/x.png" alt="an image">
    <br/>
    <script>var a = "<p>not a tag</p>"; if (1 < 2) {}</script>
    <svg viewBox="0 0 1 1"><rect width='1' height='1'/><circle r=".5"/></svg>
    <table><tr><td>1</td><td>2</td></tr></table>
  </main>
  <footer><!--f--><p>&copy; 2026</p></footer>
</body>
</html>`;

export const PAGE_CASES = [
  ["page passthrough", PAGE, (r) => r.on("nothing-here", {})],
  ["page rewrite links", PAGE, (r) => r.on("a[href]", { element(e) { e.setAttribute("href", "https://cdn/" + e.getAttribute("href")); } })],
  ["page inject head", PAGE, (r) => r.on("head", { element(e) { e.append("<meta name=x>", { html: true }); } })],
  ["page strip scripts", PAGE, (r) => r.on("script", { element(e) { e.remove(); } })],
  ["page rewrite text", PAGE, (r) => r.on("p", { text(t) { if (t.text.includes("entity")) t.replace(t.text.toUpperCase()); } })],
  ["page comments out", PAGE, (r) => r.onDocument({ comments(c) { c.remove(); } })],
  ["page class add", PAGE, (r) => r.on("body", { element(e) { e.setAttribute("class", e.getAttribute("class") + " js"); } })],
  ["page nested removeAndKeep", PAGE, (r) => r.on("em, b, i", { element(e) { e.removeAndKeepContent(); } })],
  ["page nth li", PAGE, (r) => r.on("li:nth-child(2)", { element(e) { e.setAttribute("second", ""); } })],
  ["page not-class", PAGE, (r) => r.on("li:not(.on)", { element(e) { e.setAttribute("off", "1"); } })],
  ["page svg only", PAGE, (r) => r.on("svg *", { element(e) { e.setAttribute("ns", e.namespaceURI); } })],
  ["page end tag hook", PAGE, (r) => r.on("main", { element(e) { e.onEndTag((t) => t.before("<!--/main-->")); } })],
  ["page doc end", PAGE, (r) => r.onDocument({ end(e) { e.append("\n<!-- built -->", { html: true }); } })],

  ["uppercase tags", "<DIV CLASS=A><SPAN>x</SPAN></DIV>", (r) => r.on("div span", { element(e) { e.setAttribute("hit", "1"); } })],
  ["valueless attrs", "<input disabled required name=q>", (r) => r.on("[disabled]", { element(e) { e.setAttribute("hit", "1"); } })],
  ["slash in unquoted", "<a href=/a/b>x</a>", (r) => r.on("a", { element(e) { e.setAttribute("hit", "1"); } })],
  ["equals in value", "<a href='?a=1&b=2'>x</a>", (r) => r.on("a", { element(e) { e.setAttribute("hit", "1"); } })],
  ["quote in value", '<a title="it\'s">x</a>', (r) => r.on("a", { element(e) { e.setAttribute("hit", "1"); } })],
  ["end tag with space", "<p>x</p >", (r) => r.on("p", { element(e) { e.setAttribute("hit", "1"); } })],
  ["bogus comment", "<!bogus><p>x</p>", (r) => r.on("p", { element(e) { e.setAttribute("hit", "1"); } })],
  ["unclosed comment", "<p>x</p><!-- never", (r) => r.on("p", { element(e) { e.setAttribute("hit", "1"); } })],
  ["processing instr", "<?xml version='1'?><p>x</p>", (r) => r.on("p", { element(e) { e.setAttribute("hit", "1"); } })],
  ["stray end tag", "</p><p>x</p></div>", (r) => r.on("p", { element(e) { e.setAttribute("hit", "1"); } })],
  ["deep nesting", "<a><b><c><d><e>x</e></d></c></b></a>", (r) => r.on("a e", { element(el) { el.setAttribute("deep", "1"); } })],
  ["textarea raw", "<textarea><p>x</p></textarea>", (r) => r.on("p", { element(e) { e.setAttribute("hit", "1"); } })],
  ["nth 2n+1", "<ul><li>1<li>2<li>3<li>4</ul>", (r) => r.on("li:nth-child(2n+1)", { element(e) { e.setAttribute("odd", ""); } })],
  ["multiple mutations", "<p class=a>x</p>", (r) => r.on("p", { element(e) { e.setAttribute("id", "i"); e.removeAttribute("class"); e.prepend("["); e.append("]"); e.before("B"); e.after("A"); } })],
  ["replace nested", "<div><p>x</p></div>", (r) => r.on("p", { element(e) { e.replace("<h1>y</h1>", { html: true }); } })],
  ["remove outer keep inner handler", "<div><p>x</p></div>", (r) => r.on("div", { element(e) { e.remove(); } }).on("p", { element(e) { e.setAttribute("z", "1"); } })],
  ["setInnerContent nested", "<div>a<p>b</p>c</div>", (r) => r.on("div", { element(e) { e.setInnerContent("Z"); } })],
  ["comment inside removed", "<div><!--c--></div>", (r) => r.on("div", { element(e) { e.remove(); } }).onDocument({ comments(c) { c.text = "seen"; } })],
  ["two elements one rule", "<p>a</p><p>b</p>", (r) => r.on("p", { element(e) { e.append("!"); } })],
  ["attr case in selector", "<p DATA-X='1'>a</p>", (r) => r.on("[data-x='1']", { element(e) { e.setAttribute("hit", "1"); } })],
  ["empty element", "<p></p>", (r) => r.on("p", { element(e) { e.setInnerContent("in"); } })],
  ["text at root", "hello <b>x</b> bye", (r) => r.onDocument({ text(t) { if (t.text.trim()) t.replace(t.text.toUpperCase()); } })],
];

export const PAGE_OBSERVE = [
  ["page all tags", PAGE, (r, log) => r.on("*", { element(e) { log.push(e.tagName); } })],
  ["page text runs", PAGE, (r, log) => r.onDocument({ text(t) { if (t.text.trim()) log.push(t.text.trim()); } })],
  ["page comments", PAGE, (r, log) => r.onDocument({ comments(c) { log.push(c.text); } })],
  ["page attrs of body", PAGE, (r, log) => r.on("body", { element(e) { log.push([...e.attributes]); } })],
  ["nested text ownership", "<p>a<b>c</b>d</p>", (r, log) => r.on("p", { text(t) { log.push(t.text); } })],
  ["b-only text", "<p>a<b>c</b>d</p>", (r, log) => r.on("b", { text(t) { log.push(t.text); } })],
  ["comment subtree", "<div><p><!--x--></p></div>", (r, log) => r.on("div", { comments(c) { log.push(c.text); } })],
  ["li indexes", "<ul><li>1<li>2<li>3</ul>", (r, log) => r.on("li", { element(e) { log.push(e.tagName); } })],
  ["svg flags", "<svg><rect/><g><circle/></g></svg>", (r, log) => r.on("*", { element(e) { log.push([e.tagName, e.namespaceURI, e.canHaveContent, e.selfClosing]); } })],
  ["table flags", "<table><tr><td>1</td></tr></table>", (r, log) => r.on("*", { element(e) { log.push([e.tagName, e.canHaveContent]); } })],
  ["input flags", "<input name=q><hr><wbr>", (r, log) => r.on("*", { element(e) { log.push([e.tagName, e.canHaveContent, e.selfClosing]); } })],
];

export const MORE_BAD_SELECTORS = ["p >", "> p", "..", "#", "[", "[]", "p[", ":not()", ":not(p", "p ~ span", "p + span", "::first-line", "p:nth-of-type(1)"];

// The fuzz half: deterministic pseudo-random documents crossed with rewrite recipes.
const TAGS = ["div", "p", "span", "b", "i", "ul", "li", "a", "em", "section", "h1", "table", "td"];
const VOID = ["br", "img", "hr", "input", "meta"];
const ATTRS = ["id", "class", "data-x", "href", "title", "name", "rel"];
const VALUES = ["a", "b", "a b", "1", "x-y", "foo bar", "", "a&b", "it's"];

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function makeDoc(rand, depth = 0) {
  const parts = [];
  const n = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const roll = rand();
    if (roll < 0.22) {
      parts.push(["plain text", "a & b", "tail", "  spaced  ", "caf\u00e9"][Math.floor(rand() * 5)]);
    } else if (roll < 0.3) {
      parts.push("<!--" + ["c", " spaced ", "x-y"][Math.floor(rand() * 3)] + "-->");
    } else if (roll < 0.38) {
      const v = VOID[Math.floor(rand() * VOID.length)];
      parts.push("<" + v + (rand() < 0.5 ? " " + ATTRS[Math.floor(rand() * ATTRS.length)] + "=x" : "") + (rand() < 0.3 ? "/>" : ">"));
    } else {
      const tag = TAGS[Math.floor(rand() * TAGS.length)];
      let attrs = "";
      const an = Math.floor(rand() * 3);
      for (let k = 0; k < an; k++) {
        const name = ATTRS[Math.floor(rand() * ATTRS.length)];
        const value = VALUES[Math.floor(rand() * VALUES.length)];
        const style = rand();
        attrs += style < 0.4 ? ` ${name}="${value}"` : style < 0.7 ? ` ${name}='${value}'` : value.includes(" ") || value === "" ? ` ${name}="${value}"` : ` ${name}=${value}`;
      }
      const inner = depth < 3 && rand() < 0.7 ? makeDoc(rand, depth + 1) : "text";
      parts.push(`<${tag}${attrs}>${inner}</${tag}>`);
    }
  }
  return parts.join("");
}

export const RECIPES = [
  ["attr", (r) => r.on("p, div, li, a", { element(e) { e.setAttribute("data-seen", "1"); } })],
  ["remove attr", (r) => r.on("*", { element(e) { e.removeAttribute("class"); } })],
  ["rename", (r) => r.on("b, em", { element(e) { e.tagName = "strong"; } })],
  ["wrap", (r) => r.on("span", { element(e) { e.before("<mark>", { html: true }); e.after("</mark>", { html: true }); } })],
  ["prepend/append", (r) => r.on("li, p", { element(e) { e.prepend("["); e.append("]"); } })],
  ["remove", (r) => r.on("i, td", { element(e) { e.remove(); } })],
  ["keep content", (r) => r.on("b, span", { element(e) { e.removeAndKeepContent(); } })],
  ["inner", (r) => r.on("h1, section", { element(e) { e.setInnerContent("Z<x>", { html: false }); } })],
  ["text upper", (r) => r.on("p, div", { text(t) { if (t.text.trim()) t.replace(t.text.toUpperCase()); } })],
  ["comments", (r) => r.onDocument({ comments(c) { c.text = "[" + c.text + "]"; } })],
  ["end tag", (r) => r.on("ul, table", { element(e) { e.onEndTag((t) => t.before("<!--/-->")); } })],
  ["nth", (r) => r.on("li:nth-child(2), td:first-of-type", { element(e) { e.setAttribute("n", "1"); } })],
  ["not", (r) => r.on("div :not(span)", { element(e) { e.setAttribute("q", "1"); } })],
  ["descendant", (r) => r.on("div p b", { element(e) { e.setAttribute("d", "1"); } })],
  ["child", (r) => r.on("ul > li", { element(e) { e.setAttribute("c", "1"); } })],
  ["doc end", (r) => r.onDocument({ end(e) { e.append("<!--E-->", { html: true }); } })],
  ["everything", (r) => r.on("*", { element(e) { e.setAttribute("k", e.tagName); }, text(t) { if (t.text === "tail") t.remove(); } })],
];


export const FUZZ_SEEDS = 12;
