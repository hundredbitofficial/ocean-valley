import type { APIRoute } from "astro";

const publicPaths = [
  "/", "/about", "/services", "/offers", "/contact", "/faq",
  "/privacy-policy", "/terms", "/cancellation-refund-policy",
];

export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? "https://oceanvalley.example";
  const urls = publicPaths.map((path) => `<url><loc>${new URL(path, origin).toString()}</loc></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
