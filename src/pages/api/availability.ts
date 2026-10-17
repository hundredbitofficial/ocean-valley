import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

export const GET: APIRoute = async ({ url }) => {
  const query = z.object({
    service: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    addons: z.string().optional(),
  }).safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return Response.json({ error: "A valid service and date are required." }, { status: 400 });
  const addonIds = query.data.addons ? query.data.addons.split(",") : [];
  if (addonIds.length > 20 || addonIds.some((id) => !z.string().uuid().safeParse(id).success)) {
    return Response.json({ error: "The selected add-ons are invalid." }, { status: 400 });
  }
  const parsedDate = new Date(`${query.data.date}T00:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== query.data.date) {
    return Response.json({ error: "Choose a valid appointment date." }, { status: 400 });
  }
  const projectUrl = import.meta.env.PUBLIC_SUPABASE_URL;
  const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!projectUrl || !publishableKey) return Response.json({ error: "Online booking is not configured yet." }, { status: 503 });
  const client = createClient(projectUrl, publishableKey, { auth: { persistSession: false } });
  const { data, error } = await client.rpc("get_available_slots", {
    p_service_id: query.data.service,
    p_date: query.data.date,
    p_addon_ids: addonIds,
  });
  if (error) return Response.json({ error: "Availability could not be loaded. Please try again later." }, { status: 503 });
  return Response.json({ slots: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
};
