import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin, Rule } from "postcss";
// The stylesheets are written in px. Here every size becomes rem (16px = 1rem),
// so the whole interface follows the root font size, which index.html raises on
// large screens. Hairlines (1px lines and offsets) stay as they are, and so do
// the conditions of @media rules, which this does not touch.
const pxToRem: Plugin = {
  postcssPlugin: "px-to-rem",
  Declaration(decl) {
    if (!decl.value.includes("px") || decl.value.includes("url(")) return;
    // The root font size itself is the one thing that must stay in px.
    if ((decl.parent as Rule | undefined)?.selector === "html") return;
    const hairlines = decl.prop !== "letter-spacing";
    decl.value = decl.value.replace(
      /(?<![\w#.])(-?\d*\.?\d+)px\b/g,
      (match, n) =>
        hairlines && Math.abs(Number(n)) <= 1
          ? match
          : `${+(Number(n) / 16).toFixed(6)}rem`,
    );
  },
};
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [pxToRem] } },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: { map: ["maplibre-gl"], react: ["react", "react-dom"] },
      },
    },
  },
});
