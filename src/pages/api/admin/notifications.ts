import type { APIRoute } from "astro";
import { z } from "zod";
import { createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

export const POST: APIRoute = async ({ request, cookies }) => {
  const client = createRequestSupabase(cookies, request);
  if (!client) return Response.json({ error: "Notification management is not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user || !isAdminRole(user.app_metadata)) {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }
  const body = z.object({ notificationId: z.string().uuid() }).strict()
    .safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "The notification request is invalid." }, { status: 400 });
  const { data, error } = await client.rpc("admin_requeue_notification", {
    p_notification_id: body.data.notificationId,
  });
  if (error || !data) {
    console.error(`Admin notification retry failed: ${error?.code ?? "not_requeued"}`);
    return Response.json({ error: error?.message ?? "The notification could not be retried." }, { status: 409 });
  }
  return Response.json({ notificationId: data, queued: true });
};
