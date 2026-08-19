import { redirect } from "next/navigation";

/**
 * There is no front page in the product.
 *
 * The marketing page lives in `site/` and is published on its own (see
 * `vite.config.site.ts`); what ships to someone who downloaded the app is the
 * cabinet. Anyone who lands on the root — a headless host typed into a browser,
 * an old bookmark — goes straight to their cards.
 */
export default function Root() {
  redirect("/collection");
}
