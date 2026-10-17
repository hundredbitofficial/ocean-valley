import { useEffect, useState, type SubmitEvent } from "react";
import { createBrowserSupabase } from "../lib/browser-supabase";
import { formatRupees } from "../lib/site";

interface CustomerOption { id: string; name: string; phone: string }
interface ServiceOption {
  id: string; name: string; duration: number; pricePaise: number;
  taxRateBasisPoints: number; advanceType: "fixed" | "percentage"; advanceValue: number;
}
interface ChamberOption { id: string; name: string; chamberType: string; capacity: number }
interface Slot { starts_at: string; available_spots: number }
const client = createBrowserSupabase();
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export default function AdminWalkInBooking({
  customers,
  services,
  chambers,
}: {
  customers: CustomerOption[];
  services: ServiceOption[];
  chambers: ChamberOption[];
}) {
  const [open, setOpen] = useState(false);
  const [customerMode, setCustomerMode] = useState<"guest" | "account">("guest");
  const [customerId, setCustomerId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [date, setDate] = useState(today);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [selectedChamber, setSelectedChamber] = useState("");
  const [collectionType, setCollectionType] = useState<"none" | "advance" | "full">("full");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card" | "upi">("cash");
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const service = services.find((item) => item.id === serviceId);
  const totalPaise = service
    ? service.pricePaise + Math.floor(service.pricePaise * service.taxRateBasisPoints / 10000)
    : 0;
  const advancePaise = service
    ? service.advanceType === "percentage"
      ? Math.floor(totalPaise * service.advanceValue / 10000)
      : Math.min(totalPaise, service.advanceValue)
    : 0;
  const collectedPaise = collectionType === "full" ? totalPaise : collectionType === "advance" ? advancePaise : 0;
  const chamberRequired = chambers.length > 0;
  const currentChamber = chambers.find((chamber) => chamber.id === selectedChamber);

  useEffect(() => {
    function handleGridBook(event: Event) {
      const detail = (event as CustomEvent<{ serviceId: string; date: string; startsAt: string; chamberId: string }>).detail;
      setServiceId(detail.serviceId);
      setDate(detail.date);
      setSelectedSlot(detail.startsAt);
      setSelectedChamber(detail.chamberId);
      setOpen(true);
      setMessage("");
    }
    window.addEventListener("ocean-valley:open-walkin", handleGridBook);
    return () => window.removeEventListener("ocean-valley:open-walkin", handleGridBook);
  }, []);

  useEffect(() => {
    setSlots([]);
    if (!serviceId || !date) return;
    if (chambers.length && !selectedChamber) return;
    let alive = true;
    setSlotsLoading(true);
    const params = new URLSearchParams({ service: serviceId, date });
    void Promise.all([
      fetch(`/api/availability?${params.toString()}`).then(async (response) => {
        const payload = await response.json() as { slots?: Slot[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Availability could not be loaded.");
        return payload.slots ?? [];
      }),
      chambers.length && client ? (async () => {
        const dayStart = new Date(`${date}T00:00:00+05:30`);
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const { data, error } = await client.from("bookings")
          .select("starts_at,ends_at,status,hold_expires_at,chamber_id")
          .lt("starts_at", dayEnd.toISOString()).gt("ends_at", dayStart.toISOString())
          .in("status", ["confirmed", "pending_payment"]);
        if (error) throw new Error("Existing chamber bookings could not be loaded.");
        return data ?? [];
      })() : Promise.resolve([]),
    ]).then(([available, existing]) => {
      if (!alive) return;
      const selectedRoom = chambers.find((chamber) => chamber.id === selectedChamber);
      const roomSlots = selectedRoom
        ? available.filter((slot) => {
          const slotEnd = new Date(new Date(slot.starts_at).getTime() + (service?.duration ?? 0) * 60_000);
          const occupied = existing.filter((booking) => (booking.chamber_id === selectedRoom.id || booking.chamber_id === null)
            && (booking.status === "confirmed" || new Date(booking.hold_expires_at) > new Date())
            && new Date(booking.starts_at) < slotEnd
            && new Date(booking.ends_at) > new Date(slot.starts_at)).length;
          return occupied < selectedRoom.capacity;
        })
        : available;
      setSlots(roomSlots);
    })
      .catch((error: unknown) => {
        if (alive) setMessage(error instanceof Error ? error.message : "Availability could not be loaded.");
      })
      .finally(() => { if (alive) setSlotsLoading(false); });
    return () => { alive = false; };
  }, [serviceId, date, selectedChamber, chambers, service?.duration]);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) {
      setMessage("Booking management is not configured.");
      return;
    }
    if (!serviceId || !selectedSlot || (chamberRequired && !selectedChamber)) {
      setMessage("Choose a treatment, available time and treatment chamber.");
      return;
    }
    if (collectionType !== "none" && !paymentMethod) {
      setMessage("Choose how the counter payment was collected.");
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("Saving appointment and locking the selected slot…");
    try {
      const response = await fetch("/api/admin/offline-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: customerMode === "account" ? customerId || null : null,
          guestName: customerMode === "guest" ? String(form.get("guestName") ?? "").trim() : null,
          guestPhone: customerMode === "guest" ? String(form.get("guestPhone") ?? "").trim() : null,
          guestEmail: customerMode === "guest" ? String(form.get("guestEmail") ?? "").trim() || null : null,
          guestWhatsappOptIn: customerMode === "guest" && whatsappOptIn,
          serviceId,
          chamberId: selectedChamber || null,
          startsAt: selectedSlot,
          notes: String(form.get("notes") ?? "").trim() || null,
          collectionType,
          paymentMethod: collectionType === "none" ? null : paymentMethod,
        }),
      });
      const result = await response.json() as {
        reference?: string; error?: string; notificationQueued?: boolean;
        notificationWarning?: string; amountCollectedPaise?: number;
      };
      if (!response.ok || !result.reference) throw new Error(result.error ?? "The appointment could not be verified.");
      const paymentSummary = result.amountCollectedPaise
        ? ` ${formatRupees(result.amountCollectedPaise)} recorded as ${paymentMethod.toUpperCase()}.`
        : " No counter payment was recorded.";
      const notificationSummary = result.notificationWarning
        ? ` ${result.notificationWarning}`
        : result.notificationQueued
          ? " An opted-in guest notification was queued."
          : "";
      setMessage(`Offline booking ${result.reference} saved; the selected chamber and slot are now locked.${paymentSummary}${notificationSummary}`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The offline appointment could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button className="admin-primary-button walkin-open-button" type="button" onClick={() => { setOpen(true); setMessage(""); }}>
      <span aria-hidden="true">＋</span> New offline walk-in
    </button>
    {open && <div className="walkin-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="walkin-dialog" role="dialog" aria-modal="true" aria-labelledby="walkin-title">
        <header className="walkin-dialog-heading"><div><span className="eyebrow">RECEPTION COUNTER DESK</span><h2 id="walkin-title">New Offline Walk-in Booking</h2></div><button type="button" className="walkin-close" aria-label="Close booking dialog" onClick={() => setOpen(false)}>×</button></header>
        <form className="walkin-form" onSubmit={submit}>
          <div className="walkin-lock-notice"><span aria-hidden="true">▣</span><p><strong>Instant Online Lock:</strong> Saving this booking reserves its treatment chamber and capacity immediately. Public visitors will see the slot as unavailable.</p></div>
          <div className="walkin-customer-tabs" role="group" aria-label="Guest type"><button type="button" className={customerMode === "guest" ? "is-selected" : ""} onClick={() => setCustomerMode("guest")}>New walk-in guest</button><button type="button" className={customerMode === "account" ? "is-selected" : ""} onClick={() => setCustomerMode("account")}>Existing account</button></div>
          {customerMode === "guest" ? <div className="walkin-fields">
            <label>Customer full name <span>*</span><input name="guestName" autoComplete="name" placeholder="e.g. Ramesh Patel" maxLength={120} required /></label>
            <label>Mobile phone <span>*</span><input name="guestPhone" type="tel" autoComplete="tel" placeholder="+91 98450 12345" maxLength={30} required /></label>
            <label className="walkin-wide">Email address <small>Optional</small><input name="guestEmail" type="email" autoComplete="email" placeholder="guest@example.com" maxLength={254} /></label>
            <label className="walkin-consent walkin-wide"><input type="checkbox" checked={whatsappOptIn} onChange={(event) => setWhatsappOptIn(event.target.checked)} /> Guest explicitly agrees to booking updates by WhatsApp.</label>
          </div> : <div className="walkin-fields"><label className="walkin-wide">Customer account <span>*</span><select value={customerId} onChange={(event) => setCustomerId(event.target.value)} required><option value="">Choose an account</option>{customers.map((customer) => <option value={customer.id} key={customer.id}>{customer.name} · {customer.phone}</option>)}</select></label></div>}
          <div className="walkin-fields">
            <label>Treatment ritual <span>*</span><select value={serviceId} onChange={(event) => { setServiceId(event.target.value); setSelectedChamber(""); setMessage(""); }} required><option value="">Choose a treatment</option>{services.map((item) => <option value={item.id} key={item.id}>{item.name} ({item.duration}m) · {formatRupees(item.pricePaise)}</option>)}</select></label>
            {chamberRequired &&             <label>Treatment chamber <span>*</span><select value={selectedChamber} onChange={(event) => { setSelectedChamber(event.target.value); setMessage(""); }} required><option value="">Choose a chamber</option>{chambers.map((chamber) => <option key={chamber.id} value={chamber.id}>{chamber.name} ({chamber.chamberType}) · {chamber.capacity} capacity</option>)}</select></label>}
            <label>Appointment date <span>*</span><input type="date" value={date} min={today} onChange={(event) => { setDate(event.target.value); setSelectedSlot(""); }} required /></label>
            <label>Time slot · IST <span>*</span><select value={selectedSlot} onChange={(event) => setSelectedSlot(event.target.value)} disabled={!serviceId || slotsLoading || (chamberRequired && !selectedChamber)} required><option value="">{slotsLoading ? "Loading available slots…" : chamberRequired && !selectedChamber ? "Choose a chamber first" : "Choose an available time"}</option>{slots.map((slot) => <option value={slot.starts_at} key={slot.starts_at}>{new Date(slot.starts_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} · {slot.available_spots} open</option>)}</select></label>
          </div>
          {service && <section className="walkin-payment-panel" aria-label="Counter payment">
            <div className="walkin-total"><span>Treatment fee total</span><strong>{formatRupees(totalPaise)}</strong></div>
            <div className="walkin-payment-grid">
              <fieldset><legend>Counter collection</legend><div className="walkin-choice-group">
                <button type="button" className={collectionType === "full" ? "is-selected" : ""} onClick={() => setCollectionType("full")}>100% Full <small>({formatRupees(totalPaise)})</small></button>
                <button type="button" className={collectionType === "advance" ? "is-selected" : ""} onClick={() => setCollectionType("advance")}>Advance <small>({formatRupees(advancePaise)})</small></button>
                <button type="button" className={collectionType === "none" ? "is-selected" : ""} onClick={() => setCollectionType("none")}>Not collected</button>
              </div></fieldset>
              <fieldset disabled={collectionType === "none"}><legend>Payment method</legend><div className="walkin-choice-group walkin-method-group">
                {(["cash", "card", "upi"] as const).map((method) => <button type="button" className={paymentMethod === method && collectionType !== "none" ? "is-selected" : ""} onClick={() => setPaymentMethod(method)} key={method}>{method.toUpperCase()}</button>)}
              </div></fieldset>
            </div>
            <p>{collectedPaise > 0 ? `${formatRupees(collectedPaise)} will be recorded in the payments ledger; the balance remains due as shown on the booking.` : "The appointment will be confirmed with its payment status still pending."}</p>
            {currentChamber && <small className="walkin-chamber-note">Selected chamber: {currentChamber.name}</small>}
          </section>}
          <label className="walkin-wide walkin-notes">Intake / reception notes <input name="notes" maxLength={1000} placeholder="Accessibility request, preferred pressure, etc." /></label>
          <p className="admin-form-message" role="status">{message}</p>
          <footer className="walkin-dialog-actions"><button type="button" className="admin-secondary-button" onClick={() => setOpen(false)}>Cancel</button><button className="admin-primary-button" type="submit" disabled={busy || slotsLoading}>{busy ? "Saving booking…" : "▣  Confirm offline booking & lock slot"}</button></footer>
        </form>
      </section>
    </div>}
  </>;
}
