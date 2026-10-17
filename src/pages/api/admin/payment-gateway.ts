import type { APIRoute } from "astro";
import type { AstroCookies } from "astro";
import { z } from "zod";
import { createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

const gatewaySchema = z.object({
  enabled: z.boolean(),
  environment: z.enum(["test", "live"]),
  methods: z.array(z.enum(["card", "upi", "netbanking", "wallet"])).min(1).max(4),
}).strict().refine((value) => new Set(value.methods).size === value.methods.length, "Payment methods must be unique.");

async function adminSession(cookies: AstroCookies, request: Request) {
  const client = createRequestSupabase(cookies, request);
  if (!client) return { client: null, user: null };
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user || !isAdminRole(user.app_metadata)) return { client: null, user: null };
  return { client, user };
}

export const GET: APIRoute = async ({ cookies, request }) => {
  const { client, user } = await adminSession(cookies, request);
  if (!client || !user) return Response.json({ error: "Administrator access is required." }, { status: 403 });
  const { data, error } = await client.from("business_settings").select("value").eq("key", "payment_gateway").maybeSingle();
  if (error) return Response.json({ error: "Gateway settings could not be loaded. Apply the latest Supabase migration." }, { status: 503 });
  const value = data?.value as { enabled?: boolean; environment?: "test" | "live"; methods?: string[] } | null;
  const keyId = import.meta.env.RAZORPAY_KEY_ID ?? "";
  const credentialEnvironment = import.meta.env.RAZORPAY_ENVIRONMENT
    ?? (keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : "unknown");
  return Response.json({
    settings: {
      enabled: value?.enabled ?? false,
      environment: value?.environment ?? "test",
      methods: value?.methods ?? ["card", "upi", "netbanking"],
    },
    credentials: {
      ready: Boolean(keyId && import.meta.env.RAZORPAY_KEY_SECRET && import.meta.env.RAZORPAY_WEBHOOK_SECRET && import.meta.env.SUPABASE_SERVICE_ROLE_KEY),
      environment: credentialEnvironment,
    },
  }, { headers: { "Cache-Control": "no-store" } });
};

export const POST: APIRoute = async ({ cookies, request }) => {
  const { client, user } = await adminSession(cookies, request);
  if (!client || !user) return Response.json({ error: "Administrator access is required." }, { status: 403 });
  const parsed = gatewaySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose a valid Razorpay environment and at least one payment method." }, { status: 400 });
  const keyId = import.meta.env.RAZORPAY_KEY_ID ?? "";
  const secretEnvironment = import.meta.env.RAZORPAY_ENVIRONMENT
    ?? (keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : "unknown");
  if (parsed.data.enabled) {
    if (!keyId || !import.meta.env.RAZORPAY_KEY_SECRET || !import.meta.env.RAZORPAY_WEBHOOK_SECRET || !import.meta.env.SUPABASE_SERVICE_ROLE_KEY) {
      return Response.json({ error: "Add the Razorpay key ID, key secret, webhook secret and Supabase service-role key to the trusted server environment before enabling checkout." }, { status: 409 });
    }
    if (secretEnvironment !== parsed.data.environment) {
      return Response.json({ error: `The configured Razorpay credentials are for ${secretEnvironment} mode, not ${parsed.data.environment} mode.` }, { status: 409 });
    }
  }
  const { error } = await client.from("business_settings").upsert({
    key: "payment_gateway",
    value: { provider: "razorpay", ...parsed.data },
    is_public: true,
    updated_by: user.id,
  }, { onConflict: "key" });
  if (error) {
    console.error(`Payment gateway settings update failed: ${error.code ?? "database_error"}`);
    return Response.json({ error: "Gateway settings could not be saved. Apply the latest Supabase migration and try again." }, { status: 503 });
  }
  return Response.json({ saved: true });
};
