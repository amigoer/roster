import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: { "/api": { target: process.env.ROSTER_CORE ?? "http://127.0.0.1:7788", ws: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
