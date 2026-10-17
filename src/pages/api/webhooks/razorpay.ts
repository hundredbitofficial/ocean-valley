import type { APIRoute } from "astro";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createPrivilegedSupabase } from "@/lib/server/supabase";
import { enqueueBookingConfirmation } from "@/lib/server/notifications";

export const POST: APIRoute = async ({ request }) => {
  const secret = import.meta.env.RAZORPAY_WEBHOOK_SECRET;
  const admin = createPrivilegedSupabase();
  const signature = request.headers.get("x-razorpay-signature");
  const eventId = request.headers.get("x-razorpay-event-id");
  if (!secret || !admin) return new Response("Webhook is not configured", { status: 503 });
  if (!signature || !eventId) return new Response("Missing webhook signature or event id", { status: 400 });
  const rawBody = await request.text();
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "hex"); } catch { return new Response("Invalid signature", { status: 400 }); }
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    return new Response("Invalid signature", { status: 400 });
  }
  let payload: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string } };
      refund?: { entity?: { id?: string; payment_id?: string; amount?: number; notes?: { ocean_valley_refund_id?: string } } };
    };
  };
  try { payload = JSON.parse(rawBody) as typeof payload; } catch { return new Response("Invalid JSON body", { status: 400 }); }
  const event = payload.event;
  const payment = payload.payload?.payment?.entity;
  const refund = payload.payload?.refund?.entity;
  if (!event) return new Response("Missing event type", { status: 400 });
  if (!["payment.captured", "payment.failed", "refund.processed", "refund.failed"].includes(event)) {
    return new Response(null, { status: 200 });
  }
  const { error } = await admin.rpc("process_razorpay_webhook", {
    p_event_id: eventId,
    p_event_type: event,
    p_order_id: payment?.order_id ?? null,
    p_payment_id: payment?.id ?? null,
    p_amount_paise: payment?.amount ?? null,
    p_currency: payment?.currency ?? null,
    p_refund_id: refund?.id ?? null,
    p_refund_amount_paise: refund?.amount ?? null,
    p_refund_payment_id: refund?.payment_id ?? null,
    p_refund_internal_id: refund?.notes?.ocean_valley_refund_id ?? null,
  });
  if (error) return new Response("Webhook could not be processed", { status: 503 });
  if (event === "payment.captured" && payment?.order_id) {
    const { data: capturedPayment, error: lookupError } = await admin.from("payments")
      .select("booking_id,status")
      .eq("provider_order_id", payment.order_id)
      .maybeSingle();
    if (lookupError) return new Response("Payment confirmation could not be reconciled", { status: 503 });
    if (capturedPayment?.status === "captured") {
      try {
        await enqueueBookingConfirmation(admin, capturedPayment.booking_id);
      } catch {
        return new Response("Appointment notifications could not be queued", { status: 503 });
      }
    }
  }
  return new Response(null, { status: 200 });
};
