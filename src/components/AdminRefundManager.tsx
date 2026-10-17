import { useEffect, useState, type SyntheticEvent } from "react";
import { formatRupees } from "../lib/site";
import { createBrowserSupabase } from "../lib/browser-supabase";

interface Payment {
  id: string;
  provider_payment_id: string | null;
  amount_paise: number;
  status: string;
}
interface Refund {
  id: string;
  payment_id: string;
  provider_refund_id: string | null;
  amount_paise: number;
  reason: string | null;
  status: string;
  created_at: string;
}

const client = createBrowserSupabase();

export default function AdminRefundManager() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [paymentId, setPaymentId] = useState("");
  const [amountRupees, setAmountRupees] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!client) return;
    const [paymentResult, refundResult] = await Promise.all([
      client.from("payments").select("id,provider_payment_id,amount_paise,status").in("status", ["captured", "partially_refunded"]).order("created_at", { ascending: false }).limit(100),
      client.from("refunds").select("id,payment_id,provider_refund_id,amount_paise,reason,status,created_at").order("created_at", { ascending: false }).limit(100),
    ]);
    if (paymentResult.error || refundResult.error) {
      setMessage("Refund records could not be loaded. Check administrator access.");
      return;
    }
    setPayments((paymentResult.data ?? []).filter((payment) => payment.provider_payment_id));
    setRefunds(refundResult.data ?? []);
  }

  useEffect(() => { void load(); }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paymentId || !client) return;
    setBusy(true);
    setMessage("Submitting a refund request…");
    try {
      const response = await fetch("/api/admin/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId, amountPaise: Math.round(Number(amountRupees) * 100), requestId, reason: reason.trim() }),
      });
      const result = await response.json() as { refundId?: string; status?: string; error?: string; duplicate?: boolean };
      if (!response.ok) throw new Error(result.error ?? "The refund could not be requested.");
      if (result.error) {
        setMessage(result.error);
      } else {
        setMessage(result.duplicate
          ? `This request was already recorded as ${result.status ?? "pending"}; no second refund was submitted.`
          : `Refund request recorded as ${result.status ?? "pending"}. Provider confirmation may arrive by webhook.`);
        setPaymentId("");
        setAmountRupees("");
        setReason("");
        setRequestId(crypto.randomUUID());
      }
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The refund could not be requested.");
    } finally {
      setBusy(false);
    }
  }

  if (!client) return <div className="empty-panel"><h2>Refund management is not configured.</h2><p>Connect the approved Supabase project before handling refunds.</p></div>;

  return <div>
    <form className="admin-editor" onSubmit={submit}>
      <h2>Request a provider refund</h2>
      <div className="admin-editor-grid">
        <label>Captured payment<select required value={paymentId} onChange={(event) => setPaymentId(event.target.value)}><option value="">Choose a payment</option>{payments.map((payment) => <option value={payment.id} key={payment.id}>{payment.provider_payment_id} · {formatRupees(payment.amount_paise)}</option>)}</select></label>
        <label>Refund amount (₹)<input type="number" min="0.01" step=".01" required value={amountRupees} onChange={(event) => setAmountRupees(event.target.value)} /></label>
        <label>Reason (optional)<input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      </div>
      <p className="setup-hint">The server checks captured amount and existing refunds, creates a pending record, then requests Razorpay. An uncertain result remains pending; reuse this form only after reviewing the record.</p>
      <button className="button" type="submit" disabled={busy || !paymentId || !amountRupees}>{busy ? "Contacting provider…" : "Request refund"}</button>
      <p className="admin-form-message" role="status">{message}</p>
    </form>
    {refunds.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Provider refund</th><th>Amount (₹)</th><th>Status</th><th>Reason</th><th>Created</th></tr></thead><tbody>{refunds.map((refund) => <tr key={refund.id}><td>{refund.provider_refund_id ?? "Awaiting provider reference"}</td><td>{formatRupees(refund.amount_paise)}</td><td>{refund.status}</td><td>{refund.reason || "—"}</td><td>{new Date(refund.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td></tr>)}</tbody></table></div> : <div className="empty-panel"><h2>No refunds recorded.</h2><p>Provider-confirmed refunds will appear here.</p></div>}
  </div>;
}
