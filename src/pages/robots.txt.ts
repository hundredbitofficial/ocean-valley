import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? "https://oceanvalley.example";
  return new Response(`User-agent: *\nAllow: /\nDisallow: /account/\nDisallow: /admin/\nDisallow: /booking/confirmation/\nSitemap: ${origin}/sitemap.xml\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
