import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docsSidebar: [
    "intro",
    "getting-started",
    {
      type: "category",
      label: "SDK",
      collapsed: false,
      items: ["core-api", "react", "embedding"],
    },
    {
      type: "category",
      label: "Concepts",
      collapsed: false,
      items: ["how-it-works", "python", "cross-origin-isolation"],
    },
    "deployment",
  ],
};

export default sidebars;