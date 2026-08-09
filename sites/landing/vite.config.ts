import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import { fileURLToPath, URL } from "node:url";
import { seo } from "./src/site";

// Substitute the `%VV_*%` placeholders in index.html from `seo` in src/site.ts,
// so the title, description and social cards have exactly one definition. A
// missing token throws rather than shipping a literal `%VV_TITLE%` into the
// document head, which is the one failure mode a templated head really has.
function seoHead() {
  const values: Record<string, string> = {
    VV_TITLE: seo.title,
    VV_DESCRIPTION: seo.description,
    VV_OG_DESCRIPTION: seo.ogDescription,
    VV_TWITTER_DESCRIPTION: seo.twitterDescription,
    VV_URL: seo.url,
    VV_IMAGE: seo.image,
    VV_IMAGE_WIDTH: seo.imageWidth,
    VV_IMAGE_HEIGHT: seo.imageHeight,
  };
  return {
    name: "vivari-seo-head",
    transformIndexHtml(html: string) {
      return html.replace(/%(VV_[A-Z_]+)%/g, (_match, key: string) => {
        const value = values[key];
        if (value === undefined) {
          throw new Error(`index.html references %${key}%, which is not defined in seo (src/site.ts)`);
        }
        return value;
      });
    },
  };
}

// The landing site is a plain static Vite + React app. It is intentionally NOT
// cross-origin isolated: it uses no SharedArrayBuffer and links out to /studio
// (which carries the COOP/COEP headers) and /docs. Keeping COEP off here means the
// marketing page is free to load whatever it likes without CORP constraints.
export default defineConfig({
  plugins: [
    react(),
    seoHead(),
    // The React Compiler runs as a Babel plugin, wired in via plugin-react's
    // exported preset (same pattern the studio app uses).
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // Third-party brand marks for the "what it runs" grid, same pattern the
    // studio uses. The `logos` set ships each project's official full-colour
    // mark, which is what lets us show them unaltered. Several of these
    // (Python's and Django's in particular) may not be recoloured.
    // `vv` is a filesystem collection for marks Iconify does not carry. See
    // src/assets/icons/SOURCES.md for each file's origin and licence.
    Icons({
      compiler: "jsx",
      jsx: "react",
      customCollections: {
        vv: FileSystemIconLoader("./src/assets/icons"),
      },
    }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
