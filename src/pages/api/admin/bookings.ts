import type { APIRoute } from "astro";
import { z } from "zod";
import { createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

const requestSchema = z.object({
  bookingId: z.string().uuid(),
  status: z.enum(["cancelled", "completed", "no_show"]),
  reason: z.string().trim().max(500).optional(),
}).strict();

export const POST: APIRoute = async ({ request, cookies }) => {
  const client = createRequestSupabase(cookies, request);
  if (!client) return Response.json({ error: "Booking management is not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user || !isAdminRole(user.app_metadata)) {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }
  const body = requestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "The booking update is invalid." }, { status: 400 });
  if (body.data.status === "cancelled" && !body.data.reason) {
    return Response.json({ error: "A reason is required to cancel an appointment." }, { status: 400 });
  }
  const { data, error } = await client.rpc("admin_update_booking_status", {
    p_booking_id: body.data.bookingId,
    p_status: body.data.status,
    p_reason: body.data.reason || null,
  });
  if (error || !data?.length) {
    console.error(`Admin booking update failed: ${error?.code ?? "not_updated"}`);
    return Response.json({ error: error?.message ?? "The booking could not be updated." }, { status: 409 });
  }
  return Response.json(data[0]);
};
