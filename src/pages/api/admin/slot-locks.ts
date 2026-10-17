import type { APIRoute } from "astro";
import { z } from "zod";
import { createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

const requestSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const POST: APIRoute = async ({ request, cookies }) => {
  const client = createRequestSupabase(cookies, request);
  if (!client) return Response.json({ error: "Appointment management is not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user || !isAdminRole(user.app_metadata)) {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  const startTime = parsed.success ? Date.parse(parsed.data.startsAt) : Number.NaN;
  const endTime = parsed.success ? Date.parse(parsed.data.endsAt) : Number.NaN;
  if (!parsed.success || startTime <= Date.now() || endTime <= startTime || endTime - startTime > 24 * 60 * 60 * 1000) {
    return Response.json({ error: "Choose a valid slot window to lock." }, { status: 400 });
  }
  const { data, error } = await client.rpc("admin_lock_appointment_slot", {
    p_starts_at: parsed.data.startsAt,
    p_ends_at: parsed.data.endsAt,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(`Appointment slot lock failed: ${error.code ?? "database_error"}`);
    return Response.json({
      error: error.message.includes("occupies this time")
        ? "An existing appointment occupies this time. Cancel or reschedule it before locking the slot."
        : "This appointment slot could not be locked.",
    }, { status: 409 });
  }
  return Response.json({ id: data, locked: true });
};
