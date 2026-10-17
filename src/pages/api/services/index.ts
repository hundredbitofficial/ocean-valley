import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";

export const GET: APIRoute = async () => {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) return Response.json({ error: "The treatment menu is not configured." }, { status: 503 });
  const client = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { data, error } = await client.from("services")
    .select("id,name,slug,short_description,description,duration_minutes,buffer_minutes,price_paise,advance_type,advance_value,tax_rate_basis_points,is_featured,sort_order,service_addons(id,name,description,price_paise,extra_duration_minutes)")
    .eq("is_active", true)
    .order("sort_order");
  if (error) return Response.json({ error: "The treatment menu could not be loaded." }, { status: 503 });
  return Response.json({ services: data ?? [] }, {
    headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
  });
};
