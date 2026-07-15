// Brand-approximate icons for the "Start from template" picker.
//
// Hand-rolled inline SVGs (no icon-set dependency) keyed by a string `icon` slug
// from each template's manifest, so adding a template never forces widening a
// TypeScript union. Unknown slugs fall back to a neutral mark.

import SvelteIcon from "~icons/vscode-icons/file-type-svelte";
import NestIcon from "~icons/vscode-icons/file-type-nestjs";
import NuxtIcon from "~icons/vscode-icons/file-type-nuxt";
import PreactIcon from "~icons/vscode-icons/file-type-preact";
import GraphqlIcon from "~icons/vscode-icons/file-type-graphql";
import AstroIcon from "~icons/vscode-icons/file-type-astro";
import ReactRouterIcon from "~icons/vscode-icons/file-type-reactrouter";
import NodeIcon from "~icons/vscode-icons/file-type-node";
import PnpmIcon from "~icons/vscode-icons/file-type-pnpm";
import SqliteIcon from "~icons/vscode-icons/file-type-sqlite";
import NextjsIcon from "~icons/vscode-icons/file-type-next";
import WebpackIcon from "~icons/vscode-icons/file-type-webpack";
import DocusaurusIcon from "~icons/vscode-icons/file-type-docusaurus";
import AngularIcon from "~icons/vscode-icons/file-type-angular";

type IconProps = { className?: string };

// Simple rounded-square badge with 1-3 chars — used for stacks without a bespoke
// mark. Keeps the picker visually consistent without pulling a brand icon set.
function Badge({ text, bg, fg = "#fff" }: { text: string; bg: string; fg?: string }) {
  return function BadgeIcon({ className }: IconProps) {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill={bg} />
        <text
          x="12"
          y="12.5"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={text.length >= 3 ? 6 : 9}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fontWeight="700"
          fill={fg}
        >
          {text}
        </text>
      </svg>
    );
  };
}

function ReactIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="2" fill="#61DAFB" />
      <g stroke="#61DAFB" strokeWidth="1" fill="none">
        <ellipse cx="12" cy="12" rx="10" ry="4" />
        <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

function VueIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M2 3h4l6 10 6-10h4L12 21z" fill="#41B883" />
      <path d="M6 3h3l3 5 3-5h3l-6 10z" fill="#35495E" />
    </svg>
  );
}

function ExpressIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#303030" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="10"
        fontFamily="ui-monospace, monospace"
        fontWeight="700"
        fill="#fff"
      >
        ex
      </text>
    </svg>
  );
}

function GenericIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <path d="M8 9h8M8 12h8M8 15h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

const ICONS: Record<string, (p: IconProps) => React.ReactElement> = {
  react: ReactIcon,
  angular: (p) => <AngularIcon className={p.className} />,
  vue: VueIcon,
  svelte: (p) => <SvelteIcon className={p.className} />,
  express: ExpressIcon,
  nest: (p) => <NestIcon className={p.className} />,
  next: (p) => <NextjsIcon className={p.className} />,
  vanilla: Badge({ text: "JS", bg: "#f7df1e", fg: "#000" }),
  ts: Badge({ text: "TS", bg: "#3178c6" }),
  html: Badge({ text: "</>", bg: "#e34f26" }),
  bootstrap: Badge({ text: "B", bg: "#7952b3" }),
  koa: Badge({ text: "Koa", bg: "#33333a" }),
  hono: Badge({ text: "h", bg: "#ff5b11" }),
  h3: Badge({ text: "H3", bg: "#eab308", fg: "#000" }),
  three: Badge({ text: "3", bg: "#000" }),
  gsap: Badge({ text: "GS", bg: "#0ae448", fg: "#0e100f" }),
  node: (p) => <NodeIcon className={p.className} />,
  webpack: (p) => <WebpackIcon className={p.className} />,
  sse: Badge({ text: "SSE", bg: "#16a34a" }),
  ws: Badge({ text: "WS", bg: "#646cff" }),
  fullstack: Badge({ text: "FS", bg: "#646cff" }),
  // Phase 2 — meta-frameworks
  nuxt: (p) => <NuxtIcon className={p.className} />,
  sveltekit: (p) => <SvelteIcon className={p.className} />,
  remix: (p) => <ReactRouterIcon className={p.className} />,
  astro: (p) => <AstroIcon className={p.className} />,
  vitepress: Badge({ text: "VP", bg: "#3451b2" }),
  slidev: Badge({ text: "Sl", bg: "#0e9aa5" }),
  docusaurus: (p) => <DocusaurusIcon className={p.className} />,
  // Phase 3 — frontend variants
  preact: (p) => <PreactIcon className={p.className} />,
  lit: Badge({ text: "Lit", bg: "#324fff" }),
  solid: Badge({ text: "So", bg: "#2c4f7c" }),
  qwik: Badge({ text: "Q", bg: "#18b6f6", fg: "#002b3f" }),
  // Phase 3 — backends
  fastify: Badge({ text: "F", bg: "#121212" }),
  nitro: Badge({ text: "Ni", bg: "#c8a415", fg: "#1a1500" }),
  graphql: (p) => <GraphqlIcon className={p.className} />,
  feathers: Badge({ text: "Fe", bg: "#333333" }),
  // Phase 3 — showcases
  socketio: Badge({ text: "IO", bg: "#010101" }),
  trpc: Badge({ text: "tR", bg: "#398ccb" }),
  monorepo: (p) => <PnpmIcon className={p.className} />,
  sqlite: (p) => <SqliteIcon className={p.className} />,
  postgres: Badge({ text: "Pg", bg: "#336791" }),
};

export function TemplateIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? GenericIcon;
  return <Icon className={className} />;
}
