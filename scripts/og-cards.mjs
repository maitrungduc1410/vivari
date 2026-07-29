// Renders the 1200x630 PNG social cards for both Docusaurus sites:
//
//   sites/blog/static/img/og/<slug>.png   one per blog post
//   sites/blog/static/img/social-card.png blog default
//   sites/docs/static/img/social-card.png docs default
//
//   npm run og            regenerate every card
//   npm run og -- --check verify each post has one (no rendering)
//
// Why PNG and not SVG: X, Slack, LinkedIn and Discord all refuse to render an
// SVG `og:image`, so an SVG card is the same as no card.
//
// Why this runs at authoring time and NOT in scripts/cloudflare-build.sh: resvg
// rasterises text with whatever fonts the host happens to have installed. On a
// build machine without them the text silently renders blank — a broken card
// that still deploys. Generating here and committing the PNG keeps the output
// reviewable, and `--check` (wired into sites/blog's `prebuild`) fails the build
// if a post ever ships without one.
//
// `--check` deliberately imports nothing: it runs on every deploy, and resvg is
// a devDependency that a production install is free to prune.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const POSTS_DIR = path.join(root, "sites/blog/posts");
const OG_DIR = path.join(root, "sites/blog/static/img/og");
const BLOG_CARD = path.join(root, "sites/blog/static/img/social-card.png");
const DOCS_CARD = path.join(root, "sites/docs/static/img/social-card.png");

const WIDTH = 1200;
const HEIGHT = 630;
const TITLE_SIZE = 62;
const TITLE_LINE_HEIGHT = 76;
const MAX_TITLE_LINES = 4;
// resvg does no line breaking, so titles are wrapped by hand. Average glyph
// advance for this face is ~0.52em; the margin keeps long words inside the card.
const TITLE_CHARS_PER_LINE = Math.floor((WIDTH - 200) / (TITLE_SIZE * 0.52));

// Fonts are referenced by family name and resolved from the host. Liberation
// Sans is metric-compatible with the Inter used on the site; the rest are
// fallbacks that ship with most Linux images.
const SANS = "Liberation Sans, DejaVu Sans, FreeSans, sans-serif";
const MONO = "DejaVu Sans Mono, Liberation Mono, monospace";

const escapeXml = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
  );

// Minimal front-matter reader for the three flat scalar keys the cards need.
// Not a YAML parser: anything it cannot read unambiguously (a block scalar, a
// missing title) throws rather than rendering a card with the wrong text on it.
// Docusaurus does the real front-matter validation at build time.
function frontMatter(file, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) throw new Error(`${file}: no front matter block.`);
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === "|" || raw === ">" || raw === "") continue;
    out[key] = raw.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  }
  return out;
}

function wrap(text, maxChars) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length > MAX_TITLE_LINES) {
    const kept = lines.slice(0, MAX_TITLE_LINES);
    kept[MAX_TITLE_LINES - 1] = `${kept[MAX_TITLE_LINES - 1].slice(0, maxChars - 1)}…`;
    return kept;
  }
  return lines;
}

function cardSvg({ title, eyebrow }) {
  const lines = wrap(title, TITLE_CHARS_PER_LINE);
  // Bottom-anchor the title block so one-line and four-line titles both sit
  // above the footer rather than drifting down the card.
  const firstBaseline = 470 - (lines.length - 1) * TITLE_LINE_HEIGHT;
  const tspans = lines
    .map(
      (l, i) =>
        `<tspan x="96" y="${firstBaseline + i * TITLE_LINE_HEIGHT}">${escapeXml(l)}</tspan>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#05060a"/>
      <stop offset="1" stop-color="#0e1119"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset=".55" stop-color="#7c5cff"/>
      <stop offset="1" stop-color="#f472b6"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <circle cx="1010" cy="90" r="260" fill="#7c5cff" opacity="0.16"/>
  <circle cx="150" cy="600" r="230" fill="#22d3ee" opacity="0.12"/>
  <g transform="translate(96,86)">
    <rect x="0" y="0" width="64" height="64" rx="19" fill="url(#mark)"/>
    <path d="M18 23.5 L32 42 L46 23.5" fill="none" stroke="#fff" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="178" y="129" font-family="${SANS}" font-size="34" font-weight="bold" fill="#eef1f8">Vivari</text>
  <text x="96" y="212" font-family="${MONO}" font-size="24" fill="#22d3ee">${escapeXml(eyebrow)}</text>
  <text font-family="${SANS}" font-size="${TITLE_SIZE}" font-weight="bold" fill="#eef1f8">${tspans}</text>
  <rect x="96" y="530" width="60" height="4" rx="2" fill="url(#mark)"/>
  <text x="96" y="580" font-family="${SANS}" font-size="26" fill="#9aa3b8">An open-source WebContainer · vivari.run</text>
</svg>`;
}

function posts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .sort()
    .map((file) => {
      const data = frontMatter(file, fs.readFileSync(path.join(POSTS_DIR, file), "utf8"));
      if (!data.title) {
        throw new Error(`${file}: front matter is missing a \`title\`.`);
      }
      return {
        file,
        slug: data.slug ?? file.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.mdx?$/, ""),
        title: data.title,
        eyebrow: data.og_eyebrow ?? "TEARDOWN",
      };
    });
}

// Site-wide default cards, used by pages that declare no `image` of their own.
// Same layout, but a tagline takes the place of a post title.
const DEFAULTS = [
  {
    out: DOCS_CARD,
    title: "Run Node.js projects fully client-side in the browser",
    eyebrow: "npm i @vivari/core",
  },
  {
    out: BLOG_CARD,
    title: "Teardowns of the browser-side Node runtime behind Vivari",
    eyebrow: "VIVARI ENGINEERING",
  },
];

const all = posts();

if (process.argv.includes("--check")) {
  const missing = [
    ...DEFAULTS.filter((d) => !fs.existsSync(d.out)).map((d) =>
      path.relative(root, d.out),
    ),
    ...all
      .filter((p) => !fs.existsSync(path.join(OG_DIR, `${p.slug}.png`)))
      .map((p) => `${path.relative(root, OG_DIR)}/${p.slug}.png (for ${p.file})`),
  ];
  if (missing.length > 0) {
    console.error("\u2717 missing social cards:");
    for (const m of missing) console.error(`  ${m}`);
    console.error("\n  Run `npm run og` at the repo root and commit the PNGs.");
    process.exit(1);
  }
  console.log(`\u2713 og-cards: all ${all.length + DEFAULTS.length} card(s) present.`);
  process.exit(0);
}

const { Resvg } = await import("@resvg/resvg-js");

function render(svg, outPath) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: { loadSystemFonts: true, defaultFontFamily: "Liberation Sans" },
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, resvg.render().asPng());
  console.log(`\u2192 ${path.relative(root, outPath)}`);
}

for (const d of DEFAULTS) render(cardSvg(d), d.out);
for (const post of all) render(cardSvg(post), path.join(OG_DIR, `${post.slug}.png`));
console.log(`\u2713 og-cards: rendered ${all.length + DEFAULTS.length} card(s).`);