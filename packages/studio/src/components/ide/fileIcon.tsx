// File-type + folder icons from the Iconify "vscode-icons" set (the same family
// StackBlitz uses), compiled to inline SVGs at build time via unplugin-icons.
//
// unplugin-icons needs *static* imports, so we enumerate the file types we care
// about and pick one by filename/extension at render time, falling back to a
// generic document icon.

import type { SVGProps, ComponentType } from "react";

import DefaultFile from "~icons/vscode-icons/default-file";
import DefaultFolder from "~icons/vscode-icons/default-folder";
import DefaultFolderOpen from "~icons/vscode-icons/default-folder-opened";
import TypeScript from "~icons/vscode-icons/file-type-typescript";
import TypeScriptDef from "~icons/vscode-icons/file-type-typescriptdef";
import ReactTs from "~icons/vscode-icons/file-type-reactts";
import JavaScript from "~icons/vscode-icons/file-type-js";
import ReactJs from "~icons/vscode-icons/file-type-reactjs";
import Json from "~icons/vscode-icons/file-type-json";
import Css from "~icons/vscode-icons/file-type-css";
import Html from "~icons/vscode-icons/file-type-html";
import Markdown from "~icons/vscode-icons/file-type-markdown";
import Python from "~icons/vscode-icons/file-type-python";
import Text from "~icons/vscode-icons/file-type-text";
import Svg from "~icons/vscode-icons/file-type-svg";
import Image from "~icons/vscode-icons/file-type-image";
import Npm from "~icons/vscode-icons/file-type-npm";
import Vite from "~icons/vscode-icons/file-type-vite";
import Nest from "~icons/vscode-icons/file-type-nestjs";
import Git from "~icons/vscode-icons/file-type-git";
import TsConfig from "~icons/vscode-icons/file-type-tsconfig";
import Eslint from "~icons/vscode-icons/file-type-eslint";

type IconCmp = ComponentType<SVGProps<SVGSVGElement>>;

// Whole-filename matches take priority over the extension.
const BY_NAME: Record<string, IconCmp> = {
  "package.json": Npm,
  "package-lock.json": Npm,
  ".gitignore": Git,
  ".gitattributes": Git,
  ".eslintrc": Eslint,
  ".eslintrc.js": Eslint,
  ".eslintrc.json": Eslint,
  "eslint.config.js": Eslint,
  "eslint.config.mjs": Eslint,
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
  css: Css,
  scss: Css,
  less: Css,
  html: Html,
  htm: Html,
  md: Markdown,
  mdx: Markdown,
  py: Python,
  pyi: Python,
  txt: Text,
  svg: Svg,
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  webp: Image,
  ico: Image,
};

function pickFileIcon(name: string): IconCmp {
  const lower = name.toLowerCase();
  if (lower in BY_NAME) return BY_NAME[lower];
  if (lower.endsWith(".d.ts")) return TypeScriptDef;
  if (lower.startsWith("tsconfig") && lower.endsWith(".json")) return TsConfig;
  if (lower.startsWith("vite.config.")) return Vite;
  if (lower.startsWith("nest-cli.")) return Nest;
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