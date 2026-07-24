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

// Official VitePress logo (docs/public/vitepress-logo-mini.svg) — a Vite-style
// lightning bolt on a white card with the brand blue→purple gradient. Gradient
// ids are namespaced (vpMini*) so they don't collide with other inline SVGs.
function VitePressIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <path
        d="M5.03628 7.87818C4.75336 5.83955 6.15592 3.95466 8.16899 3.66815L33.6838 0.0367403C35.6969 -0.24977 37.5581 1.1706 37.841 3.20923L42.9637 40.1218C43.2466 42.1604 41.8441 44.0453 39.831 44.3319L14.3162 47.9633C12.3031 48.2498 10.4419 46.8294 10.159 44.7908L5.03628 7.87818Z"
        fill="url(#vpMini0)"
      />
      <path
        d="M6.85877 7.6188C6.71731 6.59948 7.41859 5.65703 8.42512 5.51378L33.9399 1.88237C34.9465 1.73911 35.8771 2.4493 36.0186 3.46861L41.1412 40.3812C41.2827 41.4005 40.5814 42.343 39.5749 42.4862L14.0601 46.1176C13.0535 46.2609 12.1229 45.5507 11.9814 44.5314L6.85877 7.6188Z"
        fill="white"
      />
      <path
        d="M33.1857 14.9195L25.8505 34.1576C25.6991 34.5547 25.1763 34.63 24.9177 34.2919L12.3343 17.8339C12.0526 17.4655 12.3217 16.9339 12.7806 16.9524L22.9053 17.3607C22.9698 17.3633 23.0344 17.3541 23.0956 17.3337L32.5088 14.1992C32.9431 14.0546 33.3503 14.4878 33.1857 14.9195Z"
        fill="url(#vpMini1)"
      />
      <path
        d="M27.0251 12.5756L19.9352 15.0427C19.8187 15.0832 19.7444 15.1986 19.7546 15.3231L20.3916 23.063C20.4066 23.2453 20.5904 23.3628 20.7588 23.2977L22.7226 22.5392C22.9064 22.4682 23.1021 22.6138 23.0905 22.8128L22.9102 25.8903C22.8982 26.0974 23.1093 26.2436 23.295 26.1567L24.4948 25.5953C24.6808 25.5084 24.892 25.6549 24.8795 25.8624L24.5855 30.6979C24.5671 31.0004 24.9759 31.1067 25.1013 30.8321L25.185 30.6487L29.4298 17.8014C29.5008 17.5863 29.2968 17.3809 29.0847 17.454L27.0519 18.1547C26.8609 18.2205 26.6675 18.0586 26.6954 17.8561L27.3823 12.8739C27.4103 12.6712 27.2163 12.5091 27.0251 12.5756Z"
        fill="url(#vpMini2)"
      />
      <defs>
        <linearGradient id="vpMini0" x1="6.48163" y1="1.9759" x2="39.05" y2="48.2064" gradientUnits="userSpaceOnUse">
          <stop stopColor="#49C7FF" />
          <stop offset="1" stopColor="#BD36FF" />
        </linearGradient>
        <linearGradient id="vpMini1" x1="11.8848" y1="16.4266" x2="26.7246" y2="31.4177" gradientUnits="userSpaceOnUse">
          <stop stopColor="#41D1FF" />
          <stop offset="1" stopColor="#BD34FE" />
        </linearGradient>
        <linearGradient id="vpMini2" x1="21.8138" y1="13.7046" x2="26.2464" y2="28.8069" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFEA83" />
          <stop offset="0.0833333" stopColor="#FFDD35" />
          <stop offset="1" stopColor="#FFA800" />
        </linearGradient>
      </defs>
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
  slidev: Badge({ text: "Sl", bg: "#0e9aa5" }),
  docusaurus: (p) => <DocusaurusIcon className={p.className} />,
  vitepress: VitePressIcon,
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