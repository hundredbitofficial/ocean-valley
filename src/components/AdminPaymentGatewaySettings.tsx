import { useEffect, useState } from "react";
import { createBrowserSupabase } from "../lib/browser-supabase";

interface GatewaySettings {
  enabled: boolean;
  environment: "test" | "live";
  methods: string[];
}
interface GatewayResponse {
  settings: GatewaySettings;
  credentials: { ready: boolean; environment: string };
}
const client = createBrowserSupabase();

export default function AdminPaymentGatewaySettings() {
  const [settings, setSettings] = useState<GatewaySettings>({ enabled: false, environment: "test", methods: ["card", "upi", "netbanking"] });
  const [credentials, setCredentials] = useState<GatewayResponse["credentials"] | null>(null);
  const [message, setMessage] = useState("Loading gateway status…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!client) {
      setMessage("Admin session is not available.");
      return;
    }
    let alive = true;
    void fetch("/api/admin/payment-gateway").then(async (response) => {
      const result = await response.json() as GatewayResponse & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Gateway settings could not be loaded.");
      if (alive) {
        setSettings(result.settings);
        setCredentials(result.credentials);
        setMessage("");
      }
    }).catch((error: unknown) => {
      if (alive) setMessage(error instanceof Error ? error.message : "Gateway settings could not be loaded.");
    });
    return () => { alive = false; };
  }, []);

  async function save() {
    setBusy(true);
    setMessage("Saving securely to Supabase…");
    try {
      const response = await fetch("/api/admin/payment-gateway", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          environment: settings.environment,
          methods: settings.methods,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Gateway settings could not be saved.");
      setMessage("Gateway settings saved to Supabase.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gateway settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-editor gateway-settings">
    <div className="gateway-heading"><div><span className="eyebrow">ONLINE CHECKOUT</span><h2>Razorpay payment gateway</h2><p>Enable secure online advances for customer bookings. Gateway settings are saved in Supabase; secret credentials stay in the trusted server environment.</p></div><span className={`gateway-health ${credentials?.ready ? "is-ready" : "is-missing"}`}>{credentials?.ready ? "Server credentials ready" : "Setup required"}</span></div>
    <div className="gateway-controls">
      <label className="gateway-enable"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /><span><strong>Enable online checkout</strong><small>Customers can pay their booking advance through Razorpay.</small></span></label>
      <label className="gateway-environment">Credential mode<select value={settings.environment} onChange={(event) => setSettings({ ...settings, environment: event.target.value as "test" | "live" })}><option value="test">Test mode</option><option value="live">Live mode</option></select></label>
    </div>
    <div className="gateway-methods"><span>Payment methods managed in Razorpay</span><div><b>Cards</b><b>UPI</b><b>Netbanking</b><b>Wallets</b></div></div>
    {credentials && <p className="setup-hint">{credentials.ready
      ? `Server-side Razorpay and Supabase credentials are present. Detected credential mode: ${credentials.environment}.`
      : "To activate, configure RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET and SUPABASE_SERVICE_ROLE_KEY as server-only environment variables. Never paste secret keys into this form."}</p>}
    {credentials && settings.enabled && credentials.environment !== settings.environment && <p className="gateway-warning" role="alert">The selected mode does not match the server credential mode ({credentials.environment}). Checkout remains unavailable until they match.</p>}
    <button className="button" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save gateway settings"}</button>
    <p className="admin-form-message" role="status">{message}</p>
  </section>;
}
