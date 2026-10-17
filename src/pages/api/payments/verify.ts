import type { APIRoute } from "astro";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createPrivilegedSupabase, createRequestSupabase } from "@/lib/server/supabase";
import { enqueueBookingConfirmation } from "@/lib/server/notifications";

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = z.object({
    bookingId: z.string().uuid(),
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i),
  }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Payment verification details are invalid." }, { status: 400 });
  const session = createRequestSupabase(cookies, request);
  const admin = createPrivilegedSupabase();
  const secret = import.meta.env.RAZORPAY_KEY_SECRET;
  if (!session || !admin || !secret) return Response.json({ error: "Payment verification is not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user) return Response.json({ error: "Sign in to verify this payment." }, { status: 401 });

  const expected = createHmac("sha256", secret)
    .update(`${body.data.razorpay_order_id}|${body.data.razorpay_payment_id}`)
    .digest();
  const supplied = Buffer.from(body.data.razorpay_signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    return Response.json({ error: "The payment signature could not be verified." }, { status: 400 });
  }

  const { data: booking } = await session.from("bookings")
    .select("id,reference,customer_id,status,hold_expires_at,total_paise,advance_due_paise")
    .eq("id", body.data.bookingId).maybeSingle();
  if (!booking || booking.customer_id !== user.id) return Response.json({ error: "That appointment could not be found." }, { status: 404 });

  const { data: payment, error: paymentError } = await admin.from("payments")
    .select("id,booking_id,provider_order_id,amount_paise,status")
    .eq("booking_id", booking.id).eq("provider_order_id", body.data.razorpay_order_id).maybeSingle();
  if (paymentError || !payment || payment.amount_paise !== booking.advance_due_paise) {
    return Response.json({ error: "The payment does not match the appointment amount." }, { status: 409 });
  }
  if (payment.status === "captured" && booking.status === "confirmed") {
    try { await enqueueBookingConfirmation(admin, booking.id); }
    catch { console.error("Confirmed appointment notifications could not be queued."); }
    return Response.json({ reference: booking.reference, confirmed: true });
  }
  const keyId = import.meta.env.RAZORPAY_KEY_ID;
  if (!keyId || booking.status !== "pending_payment" || new Date(booking.hold_expires_at) <= new Date()) {
    return Response.json({ error: "The appointment hold has expired or payment reconciliation is unavailable. Contact Ocean Valley before paying again." }, { status: 409 });
  }
  const providerResponse = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(body.data.razorpay_payment_id)}`,
    { headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` } },
  );
  if (!providerResponse.ok) return Response.json({ error: "Payment status could not be reconciled. The webhook will update your account when confirmed." }, { status: 503 });
  const providerPayment = await providerResponse.json() as { order_id?: string; amount?: number; currency?: string; status?: string };
  if (
    providerPayment.order_id !== payment.provider_order_id ||
    providerPayment.amount !== payment.amount_paise ||
    providerPayment.currency !== "INR" ||
    providerPayment.status !== "captured"
  ) {
    return Response.json({ error: "The payment provider has not confirmed a captured payment." }, { status: 409 });
  }

  const { error: captureError } = await admin.rpc("process_razorpay_webhook", {
    p_event_id: `verify:${body.data.razorpay_payment_id}`,
    p_event_type: "payment.captured",
    p_order_id: payment.provider_order_id,
    p_payment_id: body.data.razorpay_payment_id,
    p_amount_paise: providerPayment.amount,
    p_currency: providerPayment.currency,
    p_refund_id: null,
    p_refund_amount_paise: null,
    p_refund_payment_id: null,
    p_refund_internal_id: null,
  });
  if (captureError) return Response.json({ error: "Payment was received but needs reconciliation. Contact Ocean Valley with your payment reference." }, { status: 503 });
  const { data: confirmedBooking, error: confirmationError } = await session.from("bookings")
    .select("reference,status")
    .eq("id", booking.id)
    .maybeSingle();
  if (confirmationError || confirmedBooking?.status !== "confirmed") {
    return Response.json({ error: "Payment was received, but the appointment could not be confirmed automatically. Contact Ocean Valley with your payment reference." }, { status: 409 });
  }
  try { await enqueueBookingConfirmation(admin, booking.id); }
  catch { console.error("Confirmed appointment notifications could not be queued."); }
  return Response.json({ reference: confirmedBooking.reference, confirmed: true });
};
