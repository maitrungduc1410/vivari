// Brand-approximate framework icons for the "Start from template" picker.
//
// Hand-rolled inline SVGs (no icon-set dependency) so the picker renders the same
// react/vue/svelte/express/nest marks the reference create-vite grid shows,
// without pulling brand names that may or may not exist in an installed icon set.

import SvelteIcon from "~icons/vscode-icons/file-type-svelte";
import NestIcon from "~icons/vscode-icons/file-type-nestjs";
import type { Framework } from "@/oc/templates";

type IconProps = { className?: string };

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

const ICONS: Record<Framework, (p: IconProps) => React.ReactElement> = {
  react: ReactIcon,
  vue: VueIcon,
  svelte: (p) => <SvelteIcon className={p.className} />,
  express: ExpressIcon,
  nest: (p) => <NestIcon className={p.className} />,
};

export function TemplateIcon({ framework, className }: { framework: Framework; className?: string }) {
  const Icon = ICONS[framework] ?? ReactIcon;
  return <Icon className={className} />;
}
