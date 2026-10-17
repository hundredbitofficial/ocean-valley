import { useState, type SubmitEvent } from "react";
import { createBrowserSupabase } from "../lib/browser-supabase";

export default function AdminAuthForm() {
  const client = createBrowserSupabase();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!client) {
      setMessage("Admin sign-in is not configured.");
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: String(form.get("email") ?? "").trim(),
        password: String(form.get("password") ?? ""),
      });
      if (error) throw error;
      if (data.user.app_metadata.role !== "admin") {
        await client.auth.signOut();
        throw new Error("This account is not authorized for the admin portal.");
      }
      window.location.assign("/admin");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Admin sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="simple-form" onSubmit={submit}>
    <label>Email address<input type="email" name="email" autoComplete="username" required /></label>
    <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
    <button className="button" type="submit" disabled={busy}>{busy ? "Checking access…" : "Admin sign in"} <span aria-hidden="true">↗</span></button>
    <p className="auth-message" role="status" aria-live="polite">{message}</p>
  </form>;
}
