// File-type + folder icons from the Iconify "vscode-icons" set (the same family
// StackBlitz uses), compiled to inline SVGs at build time via unplugin-icons.
//
// unplugin-icons needs *static* imports, so we enumerate the file types we care
// about and pick one by filename/extension at render time, falling back to a
// generic document icon.
//
// The extension is the source of truth: a file type gets ONE icon everywhere, so
// `.d.ts` reads as TypeScript and `package.json`/`tsconfig.json` read as JSON
// instead of each growing its own badge.

import type { SVGProps, ComponentType } from "react";

import DefaultFile from "~icons/vscode-icons/default-file";
import DefaultFolder from "~icons/vscode-icons/default-folder";
import DefaultFolderOpen from "~icons/vscode-icons/default-folder-opened";
import TypeScript from "~icons/vscode-icons/file-type-typescript";
import ReactTs from "~icons/vscode-icons/file-type-reactts";
import JavaScript from "~icons/vscode-icons/file-type-js";
import ReactJs from "~icons/vscode-icons/file-type-reactjs";
import Json from "~icons/vscode-icons/file-type-json";
import Yaml from "~icons/vscode-icons/file-type-yaml";
import Toml from "~icons/vscode-icons/file-type-toml";
import Ini from "~icons/vscode-icons/file-type-ini";
import Xml from "~icons/vscode-icons/file-type-xml";
import Sql from "~icons/vscode-icons/file-type-sql";
import Css from "~icons/vscode-icons/file-type-css";
import Scss from "~icons/vscode-icons/file-type-scss";
import Sass from "~icons/vscode-icons/file-type-sass";
import Less from "~icons/vscode-icons/file-type-less";
import Html from "~icons/vscode-icons/file-type-html";
import Markdown from "~icons/vscode-icons/file-type-markdown";
import Python from "~icons/vscode-icons/file-type-python";
import Java from "~icons/vscode-icons/file-type-java";
import Php from "~icons/vscode-icons/file-type-php";
import Go from "~icons/vscode-icons/file-type-go";
import Rust from "~icons/vscode-icons/file-type-rust";
import Wasm from "~icons/vscode-icons/file-type-wasm";
import Shell from "~icons/vscode-icons/file-type-shell";
import Text from "~icons/vscode-icons/file-type-text";
import License from "~icons/vscode-icons/file-type-license";
import Svg from "~icons/vscode-icons/file-type-svg";
import Image from "~icons/vscode-icons/file-type-image";
import Npm from "~icons/vscode-icons/file-type-npm";
import Vite from "~icons/vscode-icons/file-type-vite";
import Git from "~icons/vscode-icons/file-type-git";
import Eslint from "~icons/vscode-icons/file-type-eslint";

type IconCmp = ComponentType<SVGProps<SVGSVGElement>>;

// Whole-filename matches take priority over the extension, and are matched lowercased.
// Two kinds of name earn a place here. First, one whose extension carries no information:
// `bun.lock` is JSON content, and `LICENSE`/`.gitignore`/`.npmrc` are all name and no
// extension (`.npmrc` "ends in" a meaningless `npmrc`, `LICENSE` in nothing at all).
// Second, a TOOL-identity config we'd rather show as its tool than as its language — the
// eslint and vite entries ending in `.js`/`.mjs`/`.cjs` deliberately override `BY_EXT`,
// which does claim those extensions. Note the asymmetries that follow, and leave them be:
// `vite.config.js` is Vite while `vite.config.ts` is TypeScript, and `LICENSE.md` stays
// Markdown, because in each of those the extension DOES say something and this table only
// exists for the cases where it doesn't. Everything else belongs in `BY_EXT`.
const BY_NAME: Record<string, IconCmp> = {
  "bun.lock": Json,
  license: License,
  licence: License,
  ".gitignore": Git,
  ".gitattributes": Git,
  ".npmrc": Npm,
  ".npmignore": Npm,
  ".eslintrc": Eslint,
  ".eslintrc.js": Eslint,
  "eslint.config.js": Eslint,
  "eslint.config.mjs": Eslint,
  "vite.config.js": Vite,
  "vite.config.mjs": Vite,
  "vite.config.cjs": Vite,
};

const BY_EXT: Record<string, IconCmp> = {
  ts: TypeScript,
  mts: TypeScript,
  cts: TypeScript,
  tsx: ReactTs,
  js: JavaScript,
  mjs: JavaScript,
  cjs: JavaScript,
  jsx: ReactJs,
  json: Json,
  yml: Yaml,
  yaml: Yaml,
  toml: Toml,
  ini: Ini,
  xml: Xml,
  sql: Sql,
  css: Css,
  scss: Scss,
  sass: Sass,
  less: Less,
  html: Html,
  htm: Html,
  md: Markdown,
  mdx: Markdown,
  py: Python,
  pyi: Python,
  java: Java,
  php: Php,
  go: Go,
  rs: Rust,
  wasm: Wasm,
  sh: Shell,
  bash: Shell,
  zsh: Shell,
  txt: Text,
  svg: Svg,
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  webp: Image,
  avif: Image,
  bmp: Image,
  ico: Image,
};

function pickFileIcon(name: string): IconCmp {
  const lower = name.toLowerCase();
  if (lower in BY_NAME) return BY_NAME[lower];
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return BY_EXT[ext] ?? DefaultFile;
}

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const Cmp = pickFileIcon(name);
  return <Cmp className={className} />;
}

export function FolderIcon({ open, className }: { open?: boolean; className?: string }) {
  const Cmp = open ? DefaultFolderOpen : DefaultFolder;
  return <Cmp className={className} />;
}