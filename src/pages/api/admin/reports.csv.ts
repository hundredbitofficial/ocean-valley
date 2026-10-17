import type { APIRoute } from "astro";
import { z } from "zod";
import { createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

const querySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  status: z.enum(["pending_payment", "confirmed", "cancelled", "completed", "no_show", "payment_failed", "expired"]).optional(),
});

function csvCell(value: string | number): string {
  const text = String(value);
  const safeText = typeof value === "string" && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

export const GET: APIRoute = async ({ url, cookies, request }) => {
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return Response.json({ error: "The report filters are invalid." }, { status: 400 });
  if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
    return Response.json({ error: "The start date must be before the end date." }, { status: 400 });
  }
  if (parsed.data.from && parsed.data.to) {
    const rangeDays = (Date.parse(`${parsed.data.to}T00:00:00Z`) - Date.parse(`${parsed.data.from}T00:00:00Z`)) / 86_400_000;
    if (rangeDays > 366) return Response.json({ error: "Choose a date range of one year or less." }, { status: 400 });
  }

  const client = createRequestSupabase(cookies, request);
  if (!client) return Response.json({ error: "Reports are not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user || !isAdminRole(user.app_metadata)) {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }
  let reportQuery = client.from("bookings")
    .select("reference,customer_name_snapshot,customer_phone_snapshot,customer_email_snapshot,service_name_snapshot,booking_channel,starts_at,timezone,status,payment_status,subtotal_paise,discount_paise,tax_paise,total_paise,advance_due_paise,balance_due_paise")
    .order("starts_at", { ascending: true })
    .limit(10001);
  if (parsed.data.status) reportQuery = reportQuery.eq("status", parsed.data.status);
  if (parsed.data.from) reportQuery = reportQuery.gte("starts_at", `${parsed.data.from}T00:00:00+05:30`);
  if (parsed.data.to) {
    const dayAfter = new Date(Date.parse(`${parsed.data.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    reportQuery = reportQuery.lt("starts_at", `${dayAfter}T00:00:00+05:30`);
  }
  const { data, error } = await reportQuery;
  if (error) return Response.json({ error: "The report could not be generated." }, { status: 503 });
  if ((data?.length ?? 0) > 10000) return Response.json({ error: "Narrow the report filters to export fewer than 10,000 rows." }, { status: 413 });

  const header = ["reference", "guest_name", "guest_phone", "guest_email", "service", "booking_channel", "starts_at_utc", "timezone", "status", "payment_status", "subtotal_paise", "discount_paise", "tax_paise", "total_paise", "advance_due_paise", "balance_due_paise"];
  const rows = (data ?? []).map((booking) => [
    booking.reference,
    booking.customer_name_snapshot ?? "",
    booking.customer_phone_snapshot ?? "",
    booking.customer_email_snapshot ?? "",
    booking.service_name_snapshot,
    booking.booking_channel,
    new Date(booking.starts_at).toISOString(),
    booking.timezone,
    booking.status,
    booking.payment_status,
    booking.subtotal_paise,
    booking.discount_paise,
    booking.tax_paise,
    booking.total_paise,
    booking.advance_due_paise,
    booking.balance_due_paise,
  ].map(csvCell).join(","));
  const csv = [header.map(csvCell).join(","), ...rows].join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ocean-valley-bookings.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
