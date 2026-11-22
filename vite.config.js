import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import Database from "better-sqlite3";
import { resolve } from "path";
import { defineConfig } from "vite";

const RANKED_VOTE_DB = process.env.RANKED_VOTE_DB
  ? resolve(process.env.RANKED_VOTE_DB)
  : resolve("./report_pipeline/reports.sqlite3");

function getPrerenderEntries() {
  try {
    const db = new Database(RANKED_VOTE_DB, { readonly: true });
    const rows = db.prepare("SELECT path, office FROM reports").all();
    db.close();

    const entries = [];
    for (const row of rows) {
      const fullPath = `${row.path}/${row.office}`;
      entries.push(`/report/${fullPath}`);
      entries.push(`/card/${fullPath}`);
    }

    return entries;
  } catch (err) {
    console.warn(
      "Could not load reports from database for prerender entries:",
      err,
    );
    return [];
  }
}

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess({ script: true }),
      adapter: adapter({
        pages: "build",
        assets: "build",
        fallback: undefined,
        precompress: false,
        strict: true,
      }),
      prerender: {
        entries: ["*", ...getPrerenderEntries()],
        handleHttpError: ({ path, referrer, message }) => {
          // Ignore errors for card routes during prerender - they're generated dynamically
          if (path.startsWith("/card/")) {
            console.warn(`Skipping prerender for ${path}: ${message}`);
            return;
          }
          // For other routes, throw to fail the build
          throw new Error(`Prerender error for ${path}: ${message}`);
        },
      },
    }),
  ],
  server: {
    port: 3000,
  },
  ssr: {
    external: ["better-sqlite3", "bun:sqlite"],
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // Suppress the @__PURE__ annotation warning from Rollup
        if (warning.message.includes("@__PURE__")) {
          return;
        }
        warn(warning);
      },
    },
  },
});
