import type { APIRoute } from "astro";
import { z } from "zod";
import { createPrivilegedSupabase, createRequestSupabase } from "@/lib/server/supabase";

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = z.object({ bookingId: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "A valid booking is required." }, { status: 400 });
  const session = createRequestSupabase(cookies, request);
  if (!session) return Response.json({ error: "Online payments are not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user) return Response.json({ error: "Sign in to continue with payment." }, { status: 401 });

  const keyId = import.meta.env.RAZORPAY_KEY_ID;
  const keySecret = import.meta.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = import.meta.env.RAZORPAY_WEBHOOK_SECRET;
  const admin = createPrivilegedSupabase();
  if (!keyId || !keySecret || !webhookSecret || !admin) {
    return Response.json({ error: "Online payments are not configured yet. Your appointment has not been charged." }, { status: 503 });
  }
  const adminClient = admin;
  const { data: gatewayRecord, error: gatewayError } = await adminClient.from("business_settings")
    .select("value").eq("key", "payment_gateway").maybeSingle();
  if (gatewayError) return Response.json({ error: "The payment gateway configuration could not be verified." }, { status: 503 });
  const gateway = gatewayRecord?.value as { enabled?: boolean; environment?: string; methods?: string[] } | null;
  if (gatewayRecord && gateway?.enabled !== true) {
    return Response.json({ error: "Online checkout is currently disabled by the studio." }, { status: 503 });
  }
  const credentialEnvironment = import.meta.env.RAZORPAY_ENVIRONMENT
    ?? (keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : "unknown");
  if (gateway?.environment && gateway.environment !== credentialEnvironment) {
    return Response.json({ error: "The selected gateway mode does not match the configured Razorpay credentials." }, { status: 503 });
  }

  const { data: paymentAttempt, error: attemptError } = await adminClient.rpc("prepare_booking_payment", {
    p_booking_id: body.data.bookingId,
    p_customer_id: user.id,
  });
  if (attemptError || !paymentAttempt) {
    return Response.json({ error: "That appointment could not be prepared for payment. The hold may have expired." }, { status: 409 });
  }
  const attempt = (Array.isArray(paymentAttempt) ? paymentAttempt[0] : paymentAttempt) as {
    payment_id: string;
    provider_order_id: string | null;
    amount_paise: number;
    booking_reference: string;
    order_in_progress: boolean;
  } | null;
  if (!attempt?.payment_id) return Response.json({ error: "The payment attempt could not be verified." }, { status: 503 });
  const paymentAttemptId = attempt.payment_id;
  if (attempt.provider_order_id) {
    return Response.json({
      orderId: attempt.provider_order_id, keyId, amount: attempt.amount_paise,
      currency: "INR", reference: attempt.booking_reference,
    });
  }
  if (attempt.order_in_progress) {
    return Response.json({ error: "A payment order is still being prepared. Wait a moment and retry this same appointment." }, { status: 409 });
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  async function failAttempt(message: string, status: number): Promise<Response> {
    const { error } = await adminClient.from("payments").update({ status: "failed", failure_code: "order_creation_failed" })
      .eq("id", paymentAttemptId).eq("status", "created").is("provider_order_id", null);
    if (error) return Response.json({ error: "Payment preparation needs reconciliation. Contact Ocean Valley before retrying." }, { status: 503 });
    return Response.json({ error: message }, { status });
  }
  let providerResponse: Response;
  try {
    providerResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: attempt.amount_paise,
        currency: "INR",
        receipt: attempt.booking_reference,
        notes: { booking_id: body.data.bookingId, payment_id: attempt.payment_id },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return failAttempt("The payment provider is unavailable. No payment was taken; you can retry.", 502);
  }
  if (!providerResponse.ok) {
    return failAttempt("A payment order could not be created. No payment has been taken.", 502);
  }
  const order = await providerResponse.json() as { id?: string; amount?: number; currency?: string };
  if (!order.id || order.amount !== attempt.amount_paise || order.currency !== "INR") {
    return failAttempt("The payment provider returned an invalid order. No payment has been taken.", 502);
  }
  const { data: stored, error: storeError } = await adminClient.from("payments")
    .update({ provider_order_id: order.id })
    .eq("id", paymentAttemptId).eq("status", "created").is("provider_order_id", null)
    .select("id").maybeSingle();
  if (storeError || !stored) {
    return Response.json({ error: "The provider order needs reconciliation. Do not retry payment until Ocean Valley reviews the appointment." }, { status: 503 });
  }
  return Response.json({ orderId: order.id, keyId, amount: order.amount, currency: "INR", reference: attempt.booking_reference });
};
