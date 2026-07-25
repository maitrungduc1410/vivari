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

// Rsbuild/Rspack ship no icon in any Iconify set, so bundle their official brand
// SVGs (the mascot logos from assets.rspack.rs) as base-aware asset URLs and render
// them as <img>. Vite returns a resolved URL for .svg imports (no SVGR here).
import rsbuildLogo from "@/assets/rsbuild-logo.svg";
import rspackLogo from "@/assets/rspack-logo.svg";
// TanStack / Vitest ship official raster logos; bundle them as base-aware asset
// URLs and render via <img>, same as the Rsbuild/Rspack marks above.
import tanstackLogo from "@/assets/tanstack-logo.png";
import vitestLogo from "@/assets/vitest-logo.jpg";
// Bun ships an official brand SVG (bun.com/logo.svg); bundle it the same way.
import bunLogo from "@/assets/bun-logo.svg";

type IconProps = { className?: string };

// Renders a full-color brand SVG bundled as an asset URL. object-contain keeps the
// mascot undistorted inside the picker's square (size-7 / size-5) icon box.
function ImgIcon(src: string, alt: string) {
  return function BrandImgIcon({ className }: IconProps) {
    return <img src={src} alt={alt} aria-hidden className={className} style={{ objectFit: "contain" }} />;
  };
}

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

// SolidJS — official logo (logos:solidjs-icon). Non-square viewBox; preserved by
// the default preserveAspectRatio when the picker sizes it in a square box.
function SolidIcon({ className }: IconProps) {
  const d1 =
    "M512 289.472s-85.333-62.791-151.347-48.301l-4.829 1.61c-9.66 3.221-17.711 8.05-22.542 14.491l-3.219 4.829l-24.152 41.862l41.863 8.051c17.71 11.27 40.251 16.101 61.182 11.27l74.063 14.491z";
  const d2 =
    "m333.282 289.472l-6.439 1.611c-27.371 8.05-35.421 33.811-20.932 56.352c16.101 20.931 49.913 32.201 77.284 24.151l99.824-33.811s-85.334-62.792-149.737-48.303";
  return (
    <svg viewBox="256 239 256 239" className={className} aria-hidden>
      <defs>
        <linearGradient id="vpSolidA" x1="27.5" x2="152" y1="3" y2="63.5" gradientTransform="translate(249.56 233.12)scale(1.61006)" gradientUnits="userSpaceOnUse">
          <stop offset=".1" stopColor="#76b3e1" />
          <stop offset=".3" stopColor="#dcf2fd" />
          <stop offset="1" stopColor="#76b3e1" />
        </linearGradient>
        <linearGradient id="vpSolidB" x1="95.8" x2="74" y1="32.6" y2="105.2" gradientTransform="translate(249.56 233.12)scale(1.61006)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#76b3e1" />
          <stop offset=".5" stopColor="#4377bb" />
          <stop offset="1" stopColor="#1f3b77" />
        </linearGradient>
        <linearGradient id="vpSolidC" x1="18.4" x2="144.3" y1="64.2" y2="149.8" gradientTransform="translate(249.56 233.12)scale(1.61006)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#315aa9" />
          <stop offset=".5" stopColor="#518ac8" />
          <stop offset="1" stopColor="#315aa9" />
        </linearGradient>
        <linearGradient id="vpSolidD" x1="75.2" x2="24.4" y1="74.5" y2="260.8" gradientTransform="translate(249.56 233.12)scale(1.61006)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4377bb" />
          <stop offset=".5" stopColor="#1a336b" />
          <stop offset="1" stopColor="#1a336b" />
        </linearGradient>
      </defs>
      <path fill="#76b3e1" d={d1} />
      <path fill="url(#vpSolidA)" d={d1} opacity=".3" />
      <path fill="#518ac8" d={d2} />
      <path fill="url(#vpSolidB)" d={d2} opacity=".3" />
      <path fill="url(#vpSolidC)" d="M465.308 361.925c-18.439-23.036-49.008-32.588-77.283-24.15l-99.823 32.201L256 426.328l180.327 30.592l32.201-57.963c6.441-11.271 4.831-24.15-3.22-37.032" />
      <path fill="url(#vpSolidD)" d="M433.106 418.277c-18.439-23.036-49.006-32.588-77.282-24.15L256 426.328s85.333 64.402 151.346 48.303l4.83-1.612c27.371-8.049 37.031-33.81 20.93-54.742" />
    </svg>
  );
}

// Qwik — official logo (logos:qwik-icon).
function QwikIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 256 272" className={className} aria-hidden>
      <path fill="#18b6f6" d="m224.803 271.548l-48.76-48.483l-.744.107v-.532L71.606 120.252l25.55-24.667l-15.01-86.12l-71.222 88.247c-12.136 12.226-14.372 32.109-5.642 46.781l44.5 73.788c6.813 11.376 19.163 18.18 32.47 18.074l22.038-.213z" />
      <path fill="#ac7ef4" d="m251.414 96.01l-9.795-18.075l-5.11-9.25l-2.023-3.615l-.212.213l-26.829-46.463C200.738 7.125 188.176-.105 174.55 0l-23.527.639l-70.158.213c-13.307.106-25.444 7.123-32.151 18.5l-42.69 84.632L82.353 9.25l100.073 109.937l-17.779 17.968l10.646 86.015l.107-.213v.213h-.213l.213.212l8.304 8.081l40.348 39.445c1.704 1.595 4.472-.318 3.3-2.339l-24.911-49.014l43.436-80.273l1.383-1.595c.533-.638 1.065-1.276 1.491-1.914c8.517-11.589 9.688-27.112 2.662-39.764" />
      <path fill="#fff" d="M182.746 118.763L82.353 9.358l14.266 85.695l-25.55 24.773L175.08 223.065l-9.368-85.696z" />
    </svg>
  );
}

// Lit — official logo (logos:lit-icon).
function LitIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 256 320" className={className} aria-hidden>
      <path fill="#00e8ff" d="m64 192l25.926-44.727l38.233-19.114l63.974 63.974l10.833 61.754L192 320l-64-64l-38.074-25.615z" />
      <path fill="#283198" d="M128 256V128l64-64v128zM0 256l64 64l9.202-60.602L64 192l-37.542 23.71z" />
      <path fill="#324fff" d="M64 192V64l64-64v128zm128 128V192l64-64v128zM0 256V128l64 64z" />
      <path fill="#0ff" d="M64 320V192l64 64z" />
    </svg>
  );
}

// Bootstrap — official logo (logos:bootstrap).
function BootstrapIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 256 204" className={className} aria-hidden>
      <path fill="#7e13f8" d="M53.172 0C38.565 0 27.756 12.785 28.24 26.65c.465 13.32-.139 30.573-4.482 44.642C19.402 85.402 12.034 94.34 0 95.488v12.956c12.034 1.148 19.402 10.086 23.758 24.197c4.343 14.069 4.947 31.32 4.482 44.641c-.484 13.863 10.325 26.65 24.934 26.65h149.673c14.608 0 25.414-12.785 24.93-26.65c-.464-13.32.139-30.572 4.482-44.641c4.359-14.11 11.707-23.05 23.741-24.197V95.488c-12.034-1.148-19.382-10.086-23.74-24.196c-4.344-14.067-4.947-31.321-4.483-44.642C228.261 12.787 217.455 0 202.847 0H53.17zM173.56 125.533c0 19.092-14.24 30.67-37.872 30.67h-40.23a4.34 4.34 0 0 1-4.338-4.339V52.068a4.34 4.34 0 0 1 4.339-4.34h39.999c19.705 0 32.637 10.675 32.637 27.063c0 11.503-8.7 21.801-19.783 23.604v.601c15.089 1.655 25.248 12.104 25.248 26.537m-42.26-64.05h-22.937v32.4h19.32c14.934 0 23.17-6.014 23.17-16.764c0-10.073-7.082-15.636-19.552-15.636m-22.937 45.256v35.705h23.782c15.548 0 23.786-6.239 23.786-17.965c0-11.728-8.467-17.742-24.786-17.742h-22.782z" />
    </svg>
  );
}

// Slidev — official logo (logos:slidev).
function SlidevIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 256 256" className={className} aria-hidden>
      <defs>
        <linearGradient id="vpSlidevA" x1="0%" x2="100%" y1="-8.889%" y2="100%">
          <stop offset="0%" stopColor="#3acbd4" />
          <stop offset="100%" stopColor="#2988b1" />
        </linearGradient>
        <linearGradient id="vpSlidevB" x1="-10.556%" x2="84.536%" y1="-12.222%" y2="100%">
          <stop offset="0%" stopColor="#95f0cf" />
          <stop offset="100%" stopColor="#3ab9d5" />
        </linearGradient>
        <linearGradient id="vpSlidevC" x1="-.132%" x2="12.361%" y1="-8.073%" y2="104.495%">
          <stop offset="0%" stopColor="#ffeb83" />
          <stop offset=".01%" stopColor="#ffeb83" />
          <stop offset="8.333%" stopColor="#ffdd35" />
          <stop offset="60.177%" stopColor="#ffbb13" />
          <stop offset="100%" stopColor="#ffa800" />
        </linearGradient>
      </defs>
      <path fill="url(#vpSlidevA)" d="M71.385 34.462h147.692c20.392 0 36.923 16.53 36.923 36.923v147.692C256 239.469 239.469 256 219.077 256H71.385c-20.392 0-36.923-16.531-36.923-36.923V71.385c0-20.392 16.53-36.923 36.923-36.923" />
      <path fill="url(#vpSlidevB)" d="M110.77 0c61.175 0 110.768 49.593 110.768 110.77c0 61.175-49.593 110.768-110.769 110.768S0 171.945 0 110.77S49.593 0 110.77 0" />
      <path fill="url(#vpSlidevC)" d="M138.159 157.354c-2.897-10.812-4.346-16.218-2.912-19.951a12.3 12.3 0 0 1 7.079-7.08c3.733-1.433 9.14.016 19.95 2.913l53.74 14.399c10.811 2.897 16.217 4.345 18.734 7.453a12.3 12.3 0 0 1 2.59 9.671c-.625 3.95-4.582 7.907-12.497 15.822l-39.34 39.34c-7.914 7.914-11.871 11.871-15.821 12.497a12.3 12.3 0 0 1-9.67-2.592c-3.109-2.516-4.557-7.922-7.454-18.734z" />
    </svg>
  );
}

// three.js — official logo (logos:threejs). Monochrome mark: use currentColor so
// it stays visible in both light and dark UI.
function ThreeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 256 259" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M.087 3.585C-.446 1.427 1.555-.5 3.691.116l62.23 17.916a2.94 2.94 0 0 1 1.578.455l122.73 35.334c.508.01 1.01.155 1.446.416l62.234 17.918c2.138.616 2.807 3.316 1.203 4.858l-187.8 180.649c-1.603 1.542-4.274.77-4.807-1.39L31.353 130.16a3 3 0 0 1-.098-.396Zm53.306 191.71l13.52 54.733l40.714-39.165zm41.938-43.284l-39.419 37.995l52.512 15.076zm5.851-.406l13.052 52.903l39.311-37.814zm-63.07-18.174l13.109 53.073l39.372-37.95zm103.704-26.278l-40.051 38.606l53.373 15.38zm5.612-1.373l13.322 53.984l40.161-38.631zM79.847 89.239l-40.137 38.64l53.471 15.407zm5.59-1.457l13.094 53.07l39.419-37.996zM22.385 69.759L35.71 123.71l40.108-38.612zm166.192-7.49l-39.419 37.995l52.512 15.076zm5.633-1.29l13.28 53.826l40.008-38.484zm-67.86-16.506L87.109 82.25l52.265 15.003zm5.601-1.419l13.112 53.134l39.43-38.007zM64.338 26.48L24.919 64.476L77.431 79.55zm5.638-1.269l13.061 52.937l39.323-37.855zM6.894 7.05l13.323 53.935l40.022-38.577z"
      />
    </svg>
  );
}

// Tailwind CSS — official logo (logos:tailwindcss-icon), a single cyan wave mark.
function TailwindIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 256 154" className={className} aria-hidden>
      <path
        fill="#38bdf8"
        d="M128 0C93.867 0 72.533 17.067 64 51.2C76.8 34.133 91.733 27.733 108.8 32c9.737 2.434 16.697 9.499 24.401 17.318C145.751 62.057 160.275 76.8 192 76.8c34.133 0 55.467-17.067 64-51.2c-12.8 17.067-27.733 23.467-44.8 19.2c-9.737-2.434-16.697-9.499-24.401-17.318C173.999 14.743 159.475 0 128 0M64 76.8C29.867 76.8 8.533 93.867 0 128c12.8-17.067 27.733-23.467 44.8-19.2c9.737 2.434 16.697 9.499 24.401 17.318C81.751 138.857 96.275 153.6 128 153.6c34.133 0 55.467-17.067 64-51.2c-12.8 17.067-27.733 23.467-44.8 19.2c-9.737-2.434-16.697-9.499-24.401-17.318C109.999 91.543 95.475 76.8 64 76.8"
      />
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
  bootstrap: BootstrapIcon,
  koa: Badge({ text: "Koa", bg: "#33333a" }),
  hono: Badge({ text: "h", bg: "#ff5b11" }),
  h3: Badge({ text: "H3", bg: "#eab308", fg: "#000" }),
  bun: ImgIcon(bunLogo, "Bun"),
  three: ThreeIcon,
  gsap: Badge({ text: "GS", bg: "#0ae448", fg: "#0e100f" }),
  node: (p) => <NodeIcon className={p.className} />,
  webpack: (p) => <WebpackIcon className={p.className} />,
  rsbuild: ImgIcon(rsbuildLogo, "Rsbuild"),
  rspack: ImgIcon(rspackLogo, "Rspack"),
  sse: Badge({ text: "SSE", bg: "#16a34a" }),
  ws: Badge({ text: "WS", bg: "#646cff" }),
  fullstack: Badge({ text: "FS", bg: "#646cff" }),
  // Phase 2 — meta-frameworks
  nuxt: (p) => <NuxtIcon className={p.className} />,
  sveltekit: (p) => <SvelteIcon className={p.className} />,
  remix: (p) => <ReactRouterIcon className={p.className} />,
  astro: (p) => <AstroIcon className={p.className} />,
  slidev: SlidevIcon,
  docusaurus: (p) => <DocusaurusIcon className={p.className} />,
  vitepress: VitePressIcon,
  // Phase 3 — frontend variants
  preact: (p) => <PreactIcon className={p.className} />,
  lit: LitIcon,
  solid: SolidIcon,
  qwik: QwikIcon,
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
  // Top-3 additions
  tailwind: TailwindIcon,
  tanstack: ImgIcon(tanstackLogo, "TanStack"),
  vitest: ImgIcon(vitestLogo, "Vitest"),
};

export function TemplateIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? GenericIcon;
  return <Icon className={className} />;
}