import type { SupabaseClient } from "@supabase/supabase-js";

export async function enqueueBookingConfirmation(admin: SupabaseClient, bookingId: string): Promise<void> {
  const { data: booking, error: bookingError } = await admin.from("bookings")
    .select("id,reference,customer_id,status")
    .eq("id", bookingId)
    .maybeSingle();
  if (bookingError) throw new Error("The appointment notification could not be prepared.");
  if (!booking || booking.status !== "confirmed") return;

  const [{ data: account, error: accountError }, { data: profile, error: profileError }] = await Promise.all([
    admin.auth.admin.getUserById(booking.customer_id),
    admin.from("profiles").select("phone,whatsapp_opt_in").eq("id", booking.customer_id).maybeSingle(),
  ]);
  if (accountError || profileError) throw new Error("The appointment notification recipient could not be loaded.");

  const notifications: {
    booking_id: string;
    recipient_user_id: string;
    channel: "email" | "whatsapp";
    event_type: string;
    recipient: string;
    status: "queued";
  }[] = [];
  if (account.user.email) {
    notifications.push({
      booking_id: booking.id,
      recipient_user_id: booking.customer_id,
      channel: "email",
      event_type: "booking_confirmation",
      recipient: account.user.email,
      status: "queued",
    });
  }
  if (profile?.whatsapp_opt_in && profile.phone) {
    const phone = profile.phone.replace(/[^\d]/g, "");
    if (/^[1-9]\d{7,14}$/.test(phone)) {
      notifications.push({
        booking_id: booking.id,
        recipient_user_id: booking.customer_id,
        channel: "whatsapp",
        event_type: "booking_confirmation",
        recipient: phone,
        status: "queued",
      });
    }
  }
  if (!notifications.length) return;
  const { error } = await admin.from("notifications").upsert(notifications, {
    onConflict: "booking_id,channel,event_type",
    ignoreDuplicates: true,
  });
  if (error) throw new Error("The appointment notification could not be queued.");
}

class ProviderHttpError extends Error {
  constructor(status: number) {
    super(`Notification provider returned HTTP ${status}.`);
    this.name = "ProviderHttpError";
  }
  get retryable(): boolean { return this.message.includes("429") || /HTTP 5\d\d/.test(this.message); }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

interface NotificationClaim {
  notification_id: string;
  booking_id: string;
  channel: "email" | "whatsapp" | "in_app";
  event_type: string;
  recipient: string;
  attempt_count: number;
}

async function sendEmail(to: string, booking: { reference: string; service_name_snapshot: string; starts_at: string }): Promise<string | null> {
  const apiKey = import.meta.env.EMAIL_PROVIDER_API_KEY;
  const from = import.meta.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("Email provider is not configured.");
  const time = new Date(booking.starts_at).toLocaleString("en-IN", {
    dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata",
  });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Appointment confirmed · ${booking.reference}`,
      text: `Your Ocean Valley appointment is confirmed.\n\n${booking.service_name_snapshot}\n${time} IST\nReference: ${booking.reference}\n\nPlease keep this reference for your visit.`,
      html: `<p>Your Ocean Valley appointment is confirmed.</p><p><strong>${escapeHtml(booking.service_name_snapshot)}</strong><br>${escapeHtml(time)} IST<br>Reference: ${escapeHtml(booking.reference)}</p><p>Please keep this reference for your visit.</p>`,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  const result = await response.json().catch(() => null) as { id?: string } | null;
  return result?.id ?? null;
}

async function sendWhatsApp(to: string, booking: { reference: string; service_name_snapshot: string; starts_at: string }): Promise<string | null> {
  const token = import.meta.env.WHATSAPP_PROVIDER_TOKEN;
  const phoneNumberId = import.meta.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = import.meta.env.WHATSAPP_CONFIRMATION_TEMPLATE;
  const language = import.meta.env.WHATSAPP_TEMPLATE_LANGUAGE;
  const version = import.meta.env.WHATSAPP_GRAPH_API_VERSION;
  if (!token || !phoneNumberId || !templateName || !language || !version) {
    throw new Error("Approved WhatsApp provider and confirmation template are not configured.");
  }
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("WhatsApp Graph API version is invalid.");
  const time = new Date(booking.starts_at).toLocaleString("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  });
  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        components: [{
          type: "body",
          parameters: [booking.reference, booking.service_name_snapshot, time].map((text) => ({ type: "text", text })),
        }],
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  const result = await response.json().catch(() => null) as { messages?: { id?: string }[] } | null;
  return result?.messages?.[0]?.id ?? null;
}

export async function dispatchNotifications(admin: SupabaseClient, batchSize = 20): Promise<{ claimed: number; sent: number; failed: number }> {
  const { data, error } = await admin.rpc("claim_notifications", { p_batch_size: batchSize });
  if (error) throw new Error("Queued notifications could not be claimed.");
  const claimed = (data ?? []) as NotificationClaim[];
  let sent = 0;
  let failed = 0;
  for (const notification of claimed) {
    try {
      if (notification.channel === "in_app") throw new Error("In-app notification delivery is not configured.");
      const { data: booking, error: bookingError } = await admin.from("bookings")
        .select("reference,service_name_snapshot,starts_at,status")
        .eq("id", notification.booking_id)
        .maybeSingle();
      if (bookingError || !booking || booking.status !== "confirmed") {
        throw new Error("The confirmed appointment could not be loaded.");
      }
      const providerId = notification.channel === "email"
        ? await sendEmail(notification.recipient, booking)
        : await sendWhatsApp(notification.recipient, booking);
      const { error: updateError } = await admin.from("notifications").update({
        status: "sent",
        provider_message_id: providerId,
        sent_at: new Date().toISOString(),
        last_error: null,
      }).eq("id", notification.notification_id);
      if (updateError) throw new Error("Provider accepted the message, but delivery state needs reconciliation.");
      sent += 1;
    } catch (error) {
      const permanentProviderError = error instanceof ProviderHttpError && !error.retryable;
      const finalAttempt = notification.attempt_count >= 5 || permanentProviderError;
      const delayMinutes = [1, 5, 30, 120, 1440][Math.min(notification.attempt_count - 1, 4)];
      const { error: updateError } = await admin.from("notifications").update({
        status: finalAttempt ? "failed" : "retrying",
        last_error: error instanceof Error ? error.message.slice(0, 300) : "Notification delivery failed.",
        next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      }).eq("id", notification.notification_id);
      if (updateError) {
        console.error(`Notification ${notification.notification_id} delivery state could not be updated.`);
      }
      failed += 1;
    }
  }
  return { claimed: claimed.length, sent, failed };
}
