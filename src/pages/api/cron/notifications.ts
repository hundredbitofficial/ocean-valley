import type { APIRoute } from "astro";
import { timingSafeEqual } from "node:crypto";
import { dispatchNotifications } from "@/lib/server/notifications";
import { createPrivilegedSupabase } from "@/lib/server/supabase";

export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.NOTIFICATION_CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? Buffer.from(authorization.slice(7)) : Buffer.alloc(0);
  const expected = Buffer.from(secret ?? "");
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(
    supplied.length === expected.length ? supplied : Buffer.alloc(expected.length),
    expected,
  )) {
    return new Response("Unauthorized", { status: secret ? 401 : 503, headers: { "Cache-Control": "no-store" } });
  }
  const admin = createPrivilegedSupabase();
  if (!admin) return new Response("Notification dispatch is not configured", { status: 503 });
  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? "20");
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 100
    ? requestedLimit
    : 20;
  try {
    const result = await dispatchNotifications(admin, limit);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Scheduled notification dispatch failed.");
    return Response.json({ error: "Notification dispatch failed." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
