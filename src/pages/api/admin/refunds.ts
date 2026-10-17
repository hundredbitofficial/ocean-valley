import type { APIRoute } from "astro";
import { z } from "zod";
import { createPrivilegedSupabase, createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

const refundRequest = z.object({
  paymentId: z.string().uuid(),
  amountPaise: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
}).strict();

export const POST: APIRoute = async ({ request, cookies }) => {
  const parsed = refundRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Provide a payment, refund amount and request id." }, { status: 400 });
  const session = createRequestSupabase(cookies, request);
  const admin = createPrivilegedSupabase();
  const keyId = import.meta.env.RAZORPAY_KEY_ID;
  const secret = import.meta.env.RAZORPAY_KEY_SECRET;
  if (!session || !admin || !keyId || !secret) return Response.json({ error: "Refund processing is not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user || !isAdminRole(user.app_metadata)) return Response.json({ error: "Administrator access is required." }, { status: 403 });

  const { data: reservation, error: reservationError } = await admin.rpc("reserve_refund", {
    p_payment_id: parsed.data.paymentId,
    p_amount_paise: parsed.data.amountPaise,
    p_request_id: parsed.data.requestId,
    p_reason: parsed.data.reason ?? null,
    p_actor_id: user.id,
  });
  if (reservationError || !reservation) {
    console.error(`Admin refund reservation failed: ${reservationError?.code ?? "database_error"}`);
    return Response.json({ error: "The refund could not be reserved. Check the captured balance, existing refunds and administrator role." }, { status: 409 });
  }
  const reserved = (Array.isArray(reservation) ? reservation[0] : reservation) as { refund_id: string; already_exists: boolean } | null;
  if (!reserved?.refund_id) return Response.json({ error: "The refund reservation could not be verified." }, { status: 503 });
  const { data: refund, error: refundError } = await admin.from("refunds")
    .select("id,status,provider_refund_id,payment_id")
    .eq("id", reserved.refund_id)
    .maybeSingle();
  if (refundError || !refund) return Response.json({ error: "The reserved refund record needs reconciliation." }, { status: 503 });
  if (reserved.already_exists) return Response.json({
    refundId: refund.id,
    status: refund.status,
    providerRefundId: refund.provider_refund_id,
    duplicate: true,
  });
  const { data: payment, error: paymentError } = await admin.from("payments")
    .select("id,provider_payment_id")
    .eq("id", refund.payment_id)
    .maybeSingle();
  if (paymentError || !payment?.provider_payment_id) {
    return Response.json({ refundId: refund.id, status: "pending", error: "The refund is reserved but its provider payment could not be loaded. Reconcile before retrying." }, { status: 202 });
  }

  let providerResponse: Response;
  try {
    providerResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(payment.provider_payment_id)}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: parsed.data.amountPaise,
        notes: { ocean_valley_refund_id: refund.id, reason: parsed.data.reason ?? "" },
      }),
    });
  } catch {
    console.error("Razorpay refund request outcome is unknown; refund remains pending for reconciliation.");
    return Response.json({ refundId: refund.id, status: "pending", error: "The provider response was not received. Do not submit a second refund; reconcile this pending request." }, { status: 202 });
  }
  const providerRefund = await providerResponse.json().catch(() => null) as { id?: string; payment_id?: string; amount?: number; status?: string } | null;
  if (!providerResponse.ok) {
    if (providerResponse.status < 500) {
      const { error: rejectUpdateError } = await admin.from("refunds").update({ status: "failed" }).eq("id", refund.id);
      if (rejectUpdateError) {
        console.error(`Refund ${refund.id} was rejected by the provider but remains pending locally.`);
        return Response.json({ refundId: refund.id, status: "pending", error: "The provider rejected this refund, but the local status needs reconciliation." }, { status: 202 });
      }
      return Response.json({ error: "The payment provider rejected the refund request." }, { status: 502 });
    }
    console.error(`Razorpay refund request returned HTTP ${providerResponse.status}; refund remains pending for reconciliation.`);
    return Response.json({ refundId: refund.id, status: "pending", error: "The provider outcome is uncertain. Do not submit a second refund; reconcile this pending request." }, { status: 202 });
  }
  if (!providerRefund?.id || providerRefund.payment_id !== payment.provider_payment_id || providerRefund.amount !== parsed.data.amountPaise) {
    console.error("Razorpay refund response did not match the requested payment and amount.");
    return Response.json({ refundId: refund.id, status: "pending", error: "The provider response needs manual reconciliation. Do not submit a second refund." }, { status: 202 });
  }
  const refundStatus = providerRefund.status === "processed" ? "processed" : providerRefund.status === "failed" ? "failed" : "pending";
  const { error: updateError } = await admin.from("refunds").update({
    provider_refund_id: providerRefund.id,
    status: refundStatus,
    completed_at: refundStatus === "processed" ? new Date().toISOString() : null,
  }).eq("id", refund.id);
  if (updateError) {
    console.error(`Provider refund ${providerRefund.id} exists but its local record needs reconciliation.`);
    return Response.json({ refundId: refund.id, providerRefundId: providerRefund.id, status: "pending", error: "The provider created the refund, but local state needs reconciliation." }, { status: 202 });
  }
  return Response.json({ refundId: refund.id, providerRefundId: providerRefund.id, status: refundStatus });
};
