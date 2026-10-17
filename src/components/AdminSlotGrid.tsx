import { useEffect, useState } from "react";
import { createBrowserSupabase } from "../lib/browser-supabase";

interface Service { id: string; name: string; duration: number }
interface Chamber { id: string; name: string; type: string; capacity: number }
interface Slot { starts_at: string; available_spots: number }
interface Booking { id: string; reference: string; service_name_snapshot: string; starts_at: string; ends_at: string; status: string; hold_expires_at: string; chamber_id: string | null; booking_channel: string }
const client = createBrowserSupabase();
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export default function AdminSlotGrid({ services, chambers }: { services: Service[]; chambers: Chamber[] }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [message, setMessage] = useState("");
  const [busySlot, setBusySlot] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    if (!serviceId || !date || !client) return;
    setLoading(true);
    setMessage("");
    const selectedService = services.find((service) => service.id === serviceId);
    if (!selectedService) {
      setLoading(false);
      return;
    }
    try {
      const params = new URLSearchParams({ service: serviceId, date });
      const response = await fetch(`/api/availability?${params}`);
      const payload = await response.json() as { slots?: Slot[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Availability could not be loaded.");
      const dayStart = new Date(`${date}T00:00:00+05:30`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const { data, error } = await client.from("bookings")
        .select("id,reference,service_name_snapshot,starts_at,ends_at,status,hold_expires_at,chamber_id,booking_channel")
        .lt("starts_at", dayEnd.toISOString()).gt("ends_at", dayStart.toISOString())
        .in("status", ["confirmed", "pending_payment"]);
      if (error) throw new Error("Scheduled bookings could not be loaded.");
      setSlots(payload.slots ?? []);
      setBookings((data ?? []).filter((booking) => booking.status === "confirmed" || new Date(booking.hold_expires_at) > new Date()));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Slot data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [serviceId, date]);

  function conflicts(chamberId: string, slotStart: string, duration: number) {
    const start = new Date(slotStart).getTime();
    const end = start + duration * 60_000;
    return bookings.find((booking) => (booking.chamber_id === chamberId || booking.chamber_id === null)
      && new Date(booking.starts_at).getTime() < end
      && new Date(booking.ends_at).getTime() > start);
  }

  async function lockSlot(slot: Slot, duration: number) {
    setBusySlot(slot.starts_at);
    setMessage("");
    try {
      const response = await fetch("/api/admin/slot-locks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startsAt: slot.starts_at,
          endsAt: new Date(new Date(slot.starts_at).getTime() + duration * 60_000).toISOString(),
          reason: "Locked by reception from the chamber calendar",
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "This appointment time could not be locked.");
      await refresh();
      setMessage("The selected time is blocked online across treatment services.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "This appointment time could not be locked.");
    } finally {
      setBusySlot("");
    }
  }

  function openWalkIn(slot: Slot, chamber: Chamber) {
    window.dispatchEvent(new CustomEvent("ocean-valley:open-walkin", {
      detail: { serviceId, date, startsAt: slot.starts_at, chamberId: chamber.id },
    }));
  }

  const service = services.find((item) => item.id === serviceId);
  return <section className="admin-slot-grid-panel">
    <div className="admin-slot-grid-heading"><div><span className="eyebrow">LIVE CHAMBER SCHEDULE</span><h2>Interactive grid &amp; slot locking</h2><p>See room-level conflicts alongside public availability. Offline bookings and slot locks are validated in Supabase.</p></div><div className="admin-slot-filters"><label>Treatment<select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>{services.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Date · IST<input type="date" value={date} min={today} onChange={(event) => setDate(event.target.value)} /></label></div></div>
    {message && <p className="admin-inline-notice" role="status">{message}</p>}
    {loading ? <p className="setup-hint">Refreshing Supabase availability…</p> : !chambers.length ? <p className="setup-hint">Add treatment chambers under Settings → Treatment chambers to enable the room-by-room calendar.</p> : slots.length ? <div className="chamber-grid">{chambers.map((chamber) => <section className="chamber-column" key={chamber.id}><header><i></i><strong>{chamber.name}</strong><span>{chamber.type.toUpperCase()}</span><small>Capacity: {chamber.capacity}</small></header><div className="chamber-slot-list">{slots.map((slot) => {
      const conflict = conflicts(chamber.id, slot.starts_at, service?.duration ?? 0);
      return <article className={`chamber-slot-card ${conflict ? "is-booked" : "is-open"}`} key={`${chamber.id}-${slot.starts_at}`}><div className="chamber-slot-time"><strong>{new Date(slot.starts_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</strong><span>{conflict ? "Booked" : "Open online"}</span></div>{conflict ? <p>{conflict.service_name_snapshot}<small>{conflict.reference} · {conflict.booking_channel}</small></p> : <p>Ready for online or offline guest</p>}<div className="chamber-slot-actions">{!conflict && <button type="button" className="admin-primary-button" onClick={() => openWalkIn(slot, chamber)}>＋ Book offline</button>}<button type="button" className="admin-slot-lock" disabled={Boolean(conflict) || busySlot === slot.starts_at} onClick={() => void lockSlot(slot, service?.duration ?? 0)}>▣ {busySlot === slot.starts_at ? "Locking…" : "Lock slot"}</button></div></article>;
    })}</div></section>)}</div> : <p className="setup-hint">No available appointment slots for this treatment and date.</p>}
  </section>;
}
