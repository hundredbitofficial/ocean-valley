import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import vercel from "@astrojs/vercel";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: process.env.SITE_URL || "https://oceanvalley.example",
  output: "server",
  adapter: vercel(),
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
