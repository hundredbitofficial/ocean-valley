import { useEffect, useRef, useState } from "react";
import { formatRupees } from "../lib/site";
import { createBrowserSupabase } from "../lib/browser-supabase";
import { calculateQuote } from "../lib/booking";
const client = createBrowserSupabase();
const indiaToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const [todayYear, todayMonth, todayDay] = indiaToday.split("-").map(Number);
interface Service {
  id: string; name: string; slug: string; duration_minutes: number; price_paise: number;
  tax_rate_basis_points: number; advance_type: "fixed" | "percentage"; advance_value: number;
}
interface AddOn { id: string; name: string; description: string | null; price_paise: number; extra_duration_minutes: number }
interface Slot { starts_at: string; available_spots: number }
interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  order_id: string;
  description: string;
  handler: (response: RazorpaySuccess) => void;
  modal: { ondismiss: () => void };
  notes: { booking_reference: string };
  theme: { color: string };
}
declare global {
  interface Window { Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void } }
}

export default function BookingStart({ selectedService = "" }: { selectedService?: string }) {
  const [services, setServices] = useState<Service[]>([]);
  const [addons, setAddons] = useState<AddOn[]>([]);
  const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
  const [couponCode, setCouponCode] = useState("");
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [serviceId, setServiceId] = useState(selectedService);
  const [date, setDate] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(todayYear, todayMonth - 1, 1));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const availabilityRequest = useRef(0);
  const [booking, setBooking] = useState<{ id: string; reference: string; holdExpiresAt: string; subtotalPaise: number; discountPaise: number; taxPaise: number; totalPaise: number; advanceDuePaise: number; balanceDuePaise: number } | null>(null);

  useEffect(() => {
    if (!client) return;
    void client.from("services").select("id,name,slug,duration_minutes,price_paise,tax_rate_basis_points,advance_type,advance_value").eq("is_active", true).order("sort_order")
      .then(({ data, error }) => {
        if (error) setMessage("We couldn’t load the treatment menu. Please try again later.");
        else {
          const availableServices = data ?? [];
          setServices(availableServices);
          if (selectedService) {
            const match = availableServices.find((item) => item.slug === selectedService || item.id === selectedService);
            if (match) setServiceId(match.id);
          }
        }
      });
  }, []);

  useEffect(() => {
    availabilityRequest.current += 1;
    setLoading(false);
    setSelectedAddons([]);
    setAddons([]);
    setSlots([]);
    if (!client || !serviceId) return;
    void client.from("service_addons")
      .select("id,name,description,price_paise,extra_duration_minutes")
      .eq("service_id", serviceId).eq("is_active", true).order("sort_order")
      .then(({ data, error }) => {
        if (error) setMessage("Optional extras could not be loaded.");
        else setAddons(data ?? []);
      });
  }, [serviceId]);

  async function findSlots(selectedDate = date) {
    if (!client || !serviceId || !selectedDate) return;
    const requestId = ++availabilityRequest.current;
    setLoading(true);
    setMessage("");
    setSlot("");
    try {
      const params = new URLSearchParams({ service: serviceId, date: selectedDate });
      if (selectedAddons.length) params.set("addons", selectedAddons.join(","));
      const response = await fetch(`/api/availability?${params.toString()}`);
      const payload = await response.json() as { slots?: Slot[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Availability could not be loaded.");
      if (requestId !== availabilityRequest.current) return;
      setSlots(payload.slots ?? []);
      if (!payload.slots?.length) setMessage("No appointments are available on that date.");
    } catch (error) {
      if (requestId !== availabilityRequest.current) return;
      setMessage(error instanceof Error ? error.message : "Availability could not be loaded.");
    } finally {
      if (requestId === availabilityRequest.current) setLoading(false);
    }
  }

  async function reserve() {
    if (!client || !serviceId || !slot) return;
    setLoading(true);
    setMessage("");
    try {
      const { data: auth, error: authError } = await client.auth.getUser();
      if (authError || !auth.user) {
        const returnTo = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
        window.location.assign(`/account/login?returnTo=${returnTo}`);
        return;
      }
      const { data: profile, error: profileError } = await client.from("profiles")
        .select("phone").eq("id", auth.user.id).maybeSingle();
      if (profileError) throw new Error("Your booking profile could not be checked. Please try again.");
      if (!profile?.phone?.trim()) {
        setMessage("Add a phone number to your profile before booking. Update it in your account, then return to booking.");
        return;
      }
      const paymentConfig = await fetch("/api/payments/config").then((response) => response.json()) as { configured?: boolean };
      if (!paymentConfig.configured) {
        setMessage("Online payment setup is not complete. No booking or payment was created.");
        return;
      }
      const { data, error } = await client.rpc("reserve_booking", {
        p_service_id: serviceId,
        p_starts_at: slot,
        p_addon_ids: selectedAddons,
        p_coupon_code: couponCode.trim() || null,
        p_customer_notes: null,
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.booking_id || !result?.booking_reference) throw new Error("We couldn’t verify the reservation. Please try again.");
      setBooking({
        id: result.booking_id,
        reference: result.booking_reference,
        holdExpiresAt: result.hold_expires_at,
        subtotalPaise: result.subtotal_paise,
        discountPaise: result.discount_paise,
        taxPaise: result.tax_paise,
        totalPaise: result.total_paise,
        advanceDuePaise: result.advance_due_paise,
        balanceDuePaise: result.balance_due_paise,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The appointment could not be reserved.");
    } finally {
      setLoading(false);
    }
  }

  async function startPayment() {
    if (!booking) return;
    setLoading(true);
    setMessage("");
    try {
      const paymentConfig = await fetch("/api/payments/config").then((response) => response.json()) as { configured?: boolean };
      if (!paymentConfig.configured) throw new Error("Online payment setup is not complete. No payment was created.");
      const orderResponse = await fetch("/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: booking.id }),
      });
      const order = await orderResponse.json() as { orderId?: string; keyId?: string; amount?: number; currency?: string; reference?: string; error?: string };
      if (!orderResponse.ok || !order.orderId || !order.keyId || !order.amount || !order.currency) {
        throw new Error(order.error ?? "Payment order could not be created. Your appointment hold will expire automatically.");
      }
      if (!window.Razorpay) {
        const script = document.createElement("script");
        script.src = "https://checkout.razorpay.com/v1/checkout.js";
        script.async = true;
        document.body.append(script);
        await new Promise<void>((resolve, reject) => {
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Secure checkout could not be loaded. Your appointment hold will expire automatically."));
        });
      }
      if (!window.Razorpay) throw new Error("Secure checkout is unavailable. Your appointment hold will expire automatically.");
      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: "Ocean Valley",
        order_id: order.orderId,
        description: service?.name ?? "Wellness appointment advance",
        notes: { booking_reference: order.reference ?? booking.reference },
        theme: { color: "#254d45" },
        modal: { ondismiss: () => setMessage("Checkout was closed. Your appointment is not confirmed; the temporary hold will expire automatically.") },
        handler: async (payment) => {
          setLoading(true);
          try {
            const verification = await fetch("/api/payments/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bookingId: booking.id, ...payment }),
            });
            const verified = await verification.json() as { reference?: string; confirmed?: boolean; error?: string };
            if (!verification.ok || !verified.confirmed || !verified.reference) throw new Error(verified.error ?? "Payment needs reconciliation; the visit is not yet confirmed.");
            window.location.assign(`/booking/confirmation/${encodeURIComponent(verified.reference)}`);
          } catch (error) {
            setMessage(error instanceof Error ? error.message : "Payment needs reconciliation. Please contact the studio.");
          } finally {
            setLoading(false);
          }
        },
      });
      checkout.open();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Secure payment could not be started.");
    } finally {
      setLoading(false);
    }
  }

  if (!client) return <div className="empty-panel"><span className="eyebrow">BOOKING STATUS</span><h2>We’re getting the booking space ready.</h2><p>No appointments can be reserved until Ocean Valley configures its booking database and verified payment setup.</p><a className="text-link" href="/contact">Contact the studio <span aria-hidden="true">↗</span></a></div>;
  if (booking) return <div className="booking-confirm-review"><span className="eyebrow">APPOINTMENT HOLD / {booking.reference}</span><h2>Review your appointment</h2><p>Your selected time is held until {new Date(booking.holdExpiresAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST. It is not confirmed until Razorpay reports a captured payment.</p><div className="booking-summary"><span>Service and selected extras</span><strong>{formatRupees(booking.subtotalPaise)}</strong>{booking.discountPaise > 0 && <><span>Eligible offer</span><strong>−{formatRupees(booking.discountPaise)}</strong></>}<span>Configured taxes</span><strong>{formatRupees(booking.taxPaise)}</strong><span>Total</span><strong>{formatRupees(booking.totalPaise)}</strong><span>Due now</span><strong>{formatRupees(booking.advanceDuePaise)}</strong><span>Remaining balance</span><strong>{formatRupees(booking.balanceDuePaise)}</strong></div><p className="setup-hint">The server has validated the appointment and applied any eligible offer. Review the final amount before continuing to secure checkout.</p><button type="button" className="button booking-submit" disabled={loading} onClick={startPayment}>{loading ? "Preparing secure checkout…" : "Continue to secure payment"} <span aria-hidden="true">↗</span></button>{message && <p className="booking-message" role="status">{message}</p>}<a className="text-link" href="/account">View your account <span aria-hidden="true">↗</span></a></div>;

  const service = services.find((item) => item.id === serviceId);
  const selectedAddonRows = addons.filter((addon) => selectedAddons.includes(addon.id));
  const quote = service ? calculateQuote({
    servicePricePaise: service.price_paise,
    addonPricesPaise: selectedAddonRows.map((addon) => addon.price_paise),
    taxRateBasisPoints: service.tax_rate_basis_points,
    advanceType: service.advance_type,
    advanceValue: service.advance_value,
  }) : null;
  const monthStart = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const firstWeekday = (monthStart.getDay() + 6) % 7;
  const maxCalendarDate = new Date(todayYear, todayMonth - 1, todayDay + 365);
  const maxCalendarDateString = `${maxCalendarDate.getFullYear()}-${String(maxCalendarDate.getMonth() + 1).padStart(2, "0")}-${String(maxCalendarDate.getDate()).padStart(2, "0")}`;
  const isBeyondHorizon = calendarMonth.getFullYear() > maxCalendarDate.getFullYear()
    || (calendarMonth.getFullYear() === maxCalendarDate.getFullYear() && calendarMonth.getMonth() > maxCalendarDate.getMonth());
  return (
    <div className="booking-form">
      {!services.length ? <div className="empty-panel"><h2>{message || "No treatments are available to book right now."}</h2><p>Ocean Valley must publish an active treatment and appointment hours before a booking can be placed.</p></div> : <>
        <div className="booking-step"><span>01</span><div><label htmlFor="service">Choose a treatment</label><select id="service" value={serviceId} onChange={(event) => { setServiceId(event.target.value); setSlots([]); setSlot(""); }}><option value="">Select a treatment</option>{services.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.duration_minutes} min · {formatRupees(item.price_paise)}</option>)}</select></div></div>
        {addons.length > 0 && <div className="booking-step"><span>+</span><div><span className="field-label">Optional extras</span>{addons.map((addon) => <label className="addon-option" key={addon.id}><input type="checkbox" checked={selectedAddons.includes(addon.id)} onChange={(event) => setSelectedAddons((current) => event.target.checked ? [...current, addon.id] : current.filter((id) => id !== addon.id))} /><span><strong>{addon.name}</strong><small>{addon.description} · +{addon.extra_duration_minutes} min · {formatRupees(addon.price_paise)}</small></span></label>)}</div></div>}
        <div className="booking-step"><span>02</span><div><span className="field-label">Choose a date · India Standard Time</span><div className="appointment-calendar">
          <div className="calendar-heading"><button type="button" className="text-button" aria-label="Previous month" disabled={calendarMonth.getFullYear() === todayYear && calendarMonth.getMonth() === todayMonth - 1} onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>←</button><strong>{calendarMonth.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</strong><button type="button" className="text-button" aria-label="Next month" disabled={isBeyondHorizon} onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>→</button></div>
          <div className="calendar-grid" role="group" aria-label="Appointment dates"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span>
            {Array.from({ length: firstWeekday }, (_, index) => <span className="calendar-empty" aria-hidden="true" key={`blank-${index}`} />)}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = index + 1;
              const dateValue = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const beforeToday = calendarMonth.getFullYear() === todayYear
                ? (calendarMonth.getMonth() < todayMonth - 1 || (calendarMonth.getMonth() === todayMonth - 1 && day < todayDay))
                : calendarMonth.getFullYear() < todayYear;
              return <button type="button" key={dateValue} className={`calendar-day ${date === dateValue ? "is-selected" : ""}`} aria-label={new Date(`${dateValue}T12:00:00`).toLocaleDateString("en-IN", { dateStyle: "full", timeZone: "Asia/Kolkata" })} aria-pressed={date === dateValue} disabled={beforeToday || dateValue > maxCalendarDateString || !serviceId} onClick={() => { setDate(dateValue); setSlot(""); void findSlots(dateValue); }}>{day}</button>;
            })}
          </div>
        </div></div></div>
        {loading && date && <p className="setup-hint" role="status">Checking available times…</p>}
        {slots.length > 0 && <div className="booking-step"><span>03</span><div><span className="field-label">Available times · India Standard Time</span><div className="slot-list">{slots.map((item) => <button type="button" className={`slot-option ${slot === item.starts_at ? "is-selected" : ""}`} key={item.starts_at} onClick={() => setSlot(item.starts_at)}>{new Date(item.starts_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}</button>)}</div></div></div>}
        {date && !loading && slots.length === 0 && message === "" && <p className="setup-hint">No appointments are available on {new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { dateStyle: "full", timeZone: "Asia/Kolkata" })}. Try another date.</p>}
        {service && quote && <div className="booking-summary"><span>{service.name} estimate before offer validation</span><strong>{formatRupees(quote.totalPaise)}</strong><span>Estimated advance</span><strong>{formatRupees(quote.advanceDuePaise)}</strong><small>Server validates any offer and displays the final amount for your review before checkout.</small></div>}
        {slot && <div className="booking-review"><label><input type="checkbox" checked={policyAccepted} onChange={(event) => setPolicyAccepted(event.target.checked)} /> I have reviewed the <a href="/cancellation-refund-policy">cancellation and refund information</a>.</label><label htmlFor="coupon">Offer code (optional)</label><input id="coupon" value={couponCode} onChange={(event) => setCouponCode(event.target.value.toUpperCase())} autoComplete="off" /></div>}
        {slot && <button type="button" className="button booking-submit" disabled={loading || !policyAccepted} onClick={reserve}>{loading ? "Preparing secure checkout…" : "Continue to secure payment"} <span aria-hidden="true">↗</span></button>}
      </>}
      {message && !booking && <p className="setup-hint booking-message" role="status">{message}</p>}
      {message.includes("Add a phone number") && <a className="text-link" href="/account">Update your account phone number <span aria-hidden="true">↗</span></a>}
      <p className="setup-hint">A selected time is not confirmed until the server validates the booking and the required payment is verified.</p>
    </div>
  );
}
