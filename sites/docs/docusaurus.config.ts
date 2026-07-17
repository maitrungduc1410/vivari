import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const GITHUB_URL = "https://github.com/maitrungduc1410/vivari";

const config: Config = {
  title: "Vivari",
  tagline: "Run Node.js projects fully client-side in the browser",
  favicon: "img/favicon.svg",

  // Deployed as part of a single Cloudflare Pages site: the landing lives at `/`,
  // the studio at `/studio/`, and these docs at `/docs/`.
  url: "https://vivari.pages.dev",
  baseUrl: "/docs/",

  organizationName: "maitrungduc1410",
  projectName: "vivari",

  onBrokenLinks: "throw",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  markdown: {
    mermaid: false,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  presets: [
    [
      "classic",
      {
        docs: {
          // Serve docs at the site root (i.e. `/docs/` once baseUrl is applied)
          // instead of `/docs/docs/`.
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: `${GITHUB_URL}/tree/master/sites/docs/`,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.svg",
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "Vivari",
      logo: {
        alt: "Vivari",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        // `pathname://` emits a real same-origin pathname (leaving the docs SPA for
        // the sibling apps) without Docusaurus prefixing baseUrl or route-checking it.
        { to: "pathname:///studio/", label: "Studio", position: "left" },
        { to: "pathname:///", label: "Home", position: "left" },
        {
          href: GITHUB_URL,
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Introduction", to: "/" },
            { label: "Getting started", to: "/getting-started" },
            { label: "Core API", to: "/core-api" },
            { label: "React", to: "/react" },
          ],
        },
        {
          title: "Product",
          items: [
            { label: "Home", to: "pathname:///" },
            { label: "Studio", to: "pathname:///studio/" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "GitHub", href: GITHUB_URL },
            { label: "@vivari/core on npm", href: "https://www.npmjs.com/package/@vivari/core" },
          ],
        },
      ],
      copyright: `MIT-licensed. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "jsx", "tsx"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
