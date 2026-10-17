import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

export const GET: APIRoute = async ({ params }) => {
  const slug = z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).safeParse(params.slug);
  if (!slug.success) return Response.json({ error: "That treatment could not be found." }, { status: 404 });
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) return Response.json({ error: "The treatment menu is not configured." }, { status: 503 });
  const client = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { data, error } = await client.from("services")
    .select("id,name,slug,short_description,description,duration_minutes,buffer_minutes,price_paise,advance_type,advance_value,tax_rate_basis_points,is_featured,service_addons(id,name,description,price_paise,extra_duration_minutes)")
    .eq("slug", slug.data).eq("is_active", true).maybeSingle();
  if (error) return Response.json({ error: "The treatment could not be loaded." }, { status: 503 });
  if (!data) return Response.json({ error: "That treatment is not available." }, { status: 404 });
  return Response.json({ service: data }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
};
