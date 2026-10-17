import type { APIRoute } from "astro";
import { z } from "zod";
import { createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

const requestSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  guestName: z.string().trim().max(120).nullable().optional(),
  guestPhone: z.string().trim().max(30).nullable().optional(),
  guestEmail: z.string().trim().email().max(254).nullable().optional(),
  guestWhatsappOptIn: z.boolean().default(false),
  serviceId: z.string().uuid(),
  chamberId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime(),
  notes: z.string().trim().max(1000).nullable().optional(),
  collectionType: z.enum(["none", "advance", "full"]),
  paymentMethod: z.enum(["cash", "card", "upi"]).nullable().optional(),
}).strict();

export const POST: APIRoute = async ({ request, cookies }) => {
  const client = createRequestSupabase(cookies, request);
  if (!client) return Response.json({ error: "Booking management is not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user || !isAdminRole(user.app_metadata)) {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "The offline appointment details are invalid." }, { status: 400 });

  const { data, error } = await client.rpc("admin_create_offline_booking", {
    p_customer_id: parsed.data.customerId ?? null,
    p_guest_name: parsed.data.guestName ?? null,
    p_guest_phone: parsed.data.guestPhone ?? null,
    p_guest_email: parsed.data.guestEmail ?? null,
    p_guest_whatsapp_opt_in: parsed.data.guestWhatsappOptIn,
    p_service_id: parsed.data.serviceId,
    p_chamber_id: parsed.data.chamberId ?? null,
    p_starts_at: parsed.data.startsAt,
    p_customer_notes: parsed.data.notes ?? null,
    p_collection_type: parsed.data.collectionType,
    p_payment_method: parsed.data.paymentMethod ?? null,
  });
  if (error || !data?.length) {
    console.error(`Offline appointment creation failed: ${error?.code ?? "not_created"}`);
    return Response.json({ error: error?.message ?? "The offline appointment could not be saved." }, { status: 409 });
  }
  const booking = data[0];
  const profileResult = parsed.data.customerId
    ? await client.from("profiles").select("phone,whatsapp_opt_in").eq("id", parsed.data.customerId).maybeSingle()
    : { data: null, error: null };
  if (profileResult.error) {
    console.error("Offline appointment was saved but its notification recipient could not be verified.");
    return Response.json({ reference: booking.booking_reference, notificationWarning: "The appointment was saved, but the confirmation could not be queued." });
  }
  const phone = profileResult.data?.phone ?? parsed.data.guestPhone ?? "";
  const whatsappOptIn = profileResult.data?.whatsapp_opt_in ?? parsed.data.guestWhatsappOptIn;
  const recipientUserId = parsed.data.customerId ?? null;
  const notifications = [];
  if (parsed.data.guestEmail) {
    notifications.push({
      booking_id: booking.booking_id,
      recipient_user_id: recipientUserId,
      channel: "email",
      event_type: "booking_confirmation",
      recipient: parsed.data.guestEmail,
      status: "queued",
    });
  }
  if (whatsappOptIn && phone) {
    const recipient = phone.replace(/[^\d]/g, "");
    if (/^[1-9]\d{7,14}$/.test(recipient)) {
      notifications.push({
        booking_id: booking.booking_id,
        recipient_user_id: recipientUserId,
        channel: "whatsapp",
        event_type: "booking_confirmation",
        recipient,
        status: "queued",
      });
    }
  }
  if (!notifications.length) return Response.json({
    reference: booking.booking_reference,
    amountCollectedPaise: booking.amount_collected_paise,
    notificationQueued: false,
  });
  const { error: notificationError } = await client.from("notifications").upsert(notifications, {
    onConflict: "booking_id,channel,event_type",
    ignoreDuplicates: true,
  });
  if (notificationError) {
    console.error(`Offline appointment confirmation could not be queued: ${notificationError.code ?? "database_error"}`);
    return Response.json({ reference: booking.booking_reference, amountCollectedPaise: booking.amount_collected_paise, notificationWarning: "The appointment was saved, but its guest notification could not be queued." });
  }
  return Response.json({
    reference: booking.booking_reference,
    amountCollectedPaise: booking.amount_collected_paise,
    notificationQueued: true,
  });
};
