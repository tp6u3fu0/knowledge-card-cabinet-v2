import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The public front page, built on its own.
 *
 * It is a plain static bundle — no RSC, no server, no local API — because that
 * is all a front page needs, and because it must be publishable somewhere that
 * has nothing to do with the desktop app. The desktop build (`vite.config.ts`,
 * vinext) has no front page in it at all: `/` there redirects to the cabinet.
 *
 * The card components and the stylesheet come from `app/`, so the cards on the
 * page stay the same cards the product draws.
 */
export default defineConfig({
  root: "site",
  // Relative, so the built page works from a subdirectory as well as a domain
  // root — GitHub Pages serves projects from /<repo>/.
  base: "./",
  publicDir: "../public",
  plugins: [react()],
  build: {
    outDir: "../dist-site",
    emptyOutDir: true,
  },
});
