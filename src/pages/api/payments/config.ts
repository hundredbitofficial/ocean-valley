import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";

export const GET: APIRoute = async () => {
  const projectUrl = import.meta.env.PUBLIC_SUPABASE_URL;
  const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  let gatewayEnabled = true;
  let environment: "test" | "live" | "unknown" = "unknown";
  if (projectUrl && publishableKey) {
    const client = createClient(projectUrl, publishableKey, { auth: { persistSession: false } });
    const { data, error } = await client.from("business_settings").select("value").eq("key", "payment_gateway").maybeSingle();
    if (!error && data?.value) {
      const gateway = data.value as { enabled?: boolean; environment?: "test" | "live" };
      gatewayEnabled = gateway.enabled === true;
      environment = gateway.environment ?? "unknown";
    }
  }
  const keyId = import.meta.env.RAZORPAY_KEY_ID ?? "";
  const credentialEnvironment = import.meta.env.RAZORPAY_ENVIRONMENT
    ?? (keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : "unknown");
  const environmentMatches = environment === "unknown" || environment === credentialEnvironment;
  const configured = gatewayEnabled && environmentMatches && Boolean(
    projectUrl && publishableKey &&
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY &&
    keyId && import.meta.env.RAZORPAY_KEY_SECRET &&
    import.meta.env.RAZORPAY_WEBHOOK_SECRET,
  );
  return Response.json({ configured, gatewayEnabled, environmentMatches }, { headers: { "Cache-Control": "no-store" } });
};
