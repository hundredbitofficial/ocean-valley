import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createBrowserSupabase } from "../lib/browser-supabase";
const client = createBrowserSupabase();
interface Booking {
  id: string;
  reference: string;
  service_name_snapshot: string;
  starts_at: string;
  status: string;
  total_paise: number;
  payment_status: string;
}
interface Profile {
  full_name: string;
  phone: string;
  whatsapp_opt_in: boolean;
}

function indiaLocalDateTime(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function indiaTimeToIso(value: string) {
  return new Date(`${value}:00+05:30`).toISOString();
}

export default function AccountDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [profile, setProfile] = useState<Profile>({ full_name: "", phone: "", whatsapp_opt_in: false });
  const [profileMessage, setProfileMessage] = useState("");
  const [appointmentMessage, setAppointmentMessage] = useState("");
  const [appointmentBusy, setAppointmentBusy] = useState("");
  const [message, setMessage] = useState("Checking your account…");

  useEffect(() => {
    if (!client) {
      setMessage("Account access is not configured. Please check back later.");
      return;
    }
    let alive = true;
    void client.auth.getUser().then(async ({ data, error }) => {
      if (!alive) return;
      if (error || !data.user) {
        setMessage("Sign in to view your appointments.");
        return;
      }
      setUser(data.user);
      const [{ data: rows, error: bookingError }, { data: savedProfile, error: profileError }] = await Promise.all([
        client.from("bookings")
          .select("id,reference,service_name_snapshot,starts_at,status,total_paise,payment_status")
          .order("starts_at", { ascending: false }),
        client.from("profiles").select("full_name,phone,whatsapp_opt_in").eq("id", data.user.id).maybeSingle(),
      ]);
      if (!alive) return;
      if (bookingError) setMessage("We couldn’t load your appointments. Please try again later.");
      else {
        setBookings(rows ?? []);
        setMessage(rows?.length ? "" : "You don’t have any appointments yet.");
      }
      if (profileError) setProfileMessage("Your contact preferences could not be loaded.");
      else if (savedProfile) setProfile({
        full_name: savedProfile.full_name ?? "",
        phone: savedProfile.phone ?? "",
        whatsapp_opt_in: savedProfile.whatsapp_opt_in,
      });
    });
    return () => { alive = false; };
  }, []);

  async function signOut() {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) setMessage("We couldn’t sign you out. Please try again.");
    else window.location.assign("/");
  }

  async function updateAppointment(bookingId: string, action: "cancel" | "reschedule", startsAt?: string) {
    if (!client) return;
    setAppointmentBusy(bookingId);
    setAppointmentMessage("");
    try {
      const { error } = action === "cancel"
        ? await client.rpc("customer_cancel_booking", { p_booking_id: bookingId, p_reason: "Cancelled by customer" })
        : await client.rpc("customer_reschedule_booking", {
          p_booking_id: bookingId,
          p_starts_at: startsAt ? indiaTimeToIso(startsAt) : "",
        });
      if (error) throw error;
      window.location.reload();
    } catch (error) {
      setAppointmentMessage(error instanceof Error ? error.message : "Appointment changes could not be saved.");
    } finally {
      setAppointmentBusy("");
    }
  }

  async function saveProfile() {
    if (!client || !user) return;
    if (profile.whatsapp_opt_in && !profile.phone.trim()) {
      setProfileMessage("Add a phone number before opting in to WhatsApp messages.");
      return;
    }

    setProfileMessage("Saving contact preferences…");
    const { error } = await client.from("profiles").update({
      full_name: profile.full_name.trim() || null,
      phone: profile.phone.trim() || null,
      whatsapp_opt_in: profile.whatsapp_opt_in,
    }).eq("id", user.id);
    setProfileMessage(error ? "Contact preferences could not be saved." : "Contact preferences saved.");
  }

  if (!user) {
    return <div className="empty-panel"><h2>Your visits, all in one place.</h2><p>{message}</p><a className="button" href="/account/login">Sign in <span aria-hidden="true">↗</span></a></div>;
  }

  return (
    <div className="account-dashboard">
      <div className="dashboard-welcome">
        <div><span className="eyebrow">YOUR OCEAN VALLEY</span><h2>Welcome{user.user_metadata.full_name ? `, ${user.user_metadata.full_name}` : ""}.</h2><p>{user.email}</p></div>
        <button className="text-button" type="button" onClick={signOut}>Sign out</button>
      </div>
      <h3>Your appointments</h3>
      {message && <p className="setup-hint" role="status">{message}</p>}
      {bookings.map((booking) => (
        <article className="booking-row" key={booking.id}>
          <div><strong>{booking.service_name_snapshot}</strong><span>{new Date(booking.starts_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}</span><a className="booking-view-link" href={`/account/bookings/${booking.id}`}>View appointment</a>
            {booking.status === "confirmed" && new Date(booking.starts_at) > new Date() && <div className="booking-customer-actions"><label>Choose a new time (IST)<input aria-label={`New appointment time for ${booking.reference}`} type="datetime-local" defaultValue={indiaLocalDateTime(booking.starts_at)} data-reschedule-input={booking.id} /></label><button type="button" className="text-button" disabled={appointmentBusy === booking.id} onClick={() => {
              const input = document.querySelector<HTMLInputElement>(`[data-reschedule-input="${booking.id}"]`);
              if (input?.value) void updateAppointment(booking.id, "reschedule", input.value);
              else setAppointmentMessage("Choose a new appointment time first.");
            }}>{appointmentBusy === booking.id ? "Saving…" : "Reschedule"}</button><button type="button" className="text-button" disabled={appointmentBusy === booking.id} onClick={() => {
              if (window.confirm("Cancel this appointment? Any refund is handled separately under the cancellation policy.")) void updateAppointment(booking.id, "cancel");
            }}>Cancel appointment</button></div>}
          </div>
          <div><span className="status-badge">{booking.status.replaceAll("_", " ")}</span><small>{booking.reference}</small></div>
        </article>
      ))}
      {appointmentMessage && <p className="setup-hint" role="status">{appointmentMessage}</p>}
      <section className="account-preferences">
        <h3>Contact preferences</h3>
        <label>Your name<input value={profile.full_name} maxLength={120} onChange={(event) => setProfile({ ...profile, full_name: event.target.value })} /></label>
        <label>Phone number<input type="tel" autoComplete="tel" value={profile.phone} maxLength={30} required onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></label>
        <label className="consent-option"><input type="checkbox" checked={profile.whatsapp_opt_in} onChange={(event) => setProfile({ ...profile, whatsapp_opt_in: event.target.checked })} /> I agree to receive WhatsApp booking confirmations and appointment updates. I can change this preference anytime.</label>
        <button type="button" className="button" onClick={saveProfile}>Save preferences</button>
        {profileMessage && <p className="setup-hint" role="status">{profileMessage}</p>}
      </section>
      <a className="text-link" href="/services">Explore treatments <span aria-hidden="true">↗</span></a>
    </div>
  );
}
