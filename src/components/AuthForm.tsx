import { useState, type SubmitEvent } from "react";
import { createBrowserSupabase } from "../lib/browser-supabase";

type Mode = "signin" | "signup" | "reset" | "update";
const client = createBrowserSupabase();

export default function AuthForm({ initialMode = "signin" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!client) {
      setMessage("Account access is not configured yet. Please check back later.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const fullName = String(form.get("fullName") ?? "").trim();
    const phone = String(form.get("phone") ?? "").trim();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await client.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName, phone }, emailRedirectTo: `${window.location.origin}/account` },
        });
        if (error) throw error;
        setMessage("Check your email to verify your account before signing in.");
      } else if (mode === "reset") {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/account/reset-password`,
        });
        if (error) throw error;
        setMessage("If an account matches that address, a recovery email is on its way.");
      } else if (mode === "update") {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setMessage("Your password has been updated. You can now sign in.");
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const requestedReturn = new URLSearchParams(window.location.search).get("returnTo");
        const returnTo = requestedReturn?.startsWith("/") && !requestedReturn.startsWith("//") ? requestedReturn : "/account";
        window.location.assign(returnTo);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "We couldn’t complete that request. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "signup" ? "Create your account" : mode === "reset" ? "Send recovery link" : mode === "update" ? "Update password" : "Sign in";
  return (
    <div>
      <form className="simple-form" onSubmit={submit}>
        {mode === "signup" && <><label>Your name<input name="fullName" autoComplete="name" required /></label><label>Phone number<input name="phone" type="tel" autoComplete="tel" maxLength={30} required /></label></>}
        {mode !== "update" && <label>Email address<input name="email" type="email" autoComplete="email" required /></label>}
        {mode !== "reset" && <label>Password<input name="password" type="password" autoComplete={mode === "signup" || mode === "update" ? "new-password" : "current-password"} minLength={8} required /></label>}
        <button className="button" type="submit" disabled={busy}>{busy ? "Please wait…" : title} <span aria-hidden="true">↗</span></button>
      </form>
      <p className="auth-message" role="status" aria-live="polite">{message}</p>
      <div className="auth-links">
        {mode !== "signin" && mode !== "update" && <button type="button" onClick={() => { setMode("signin"); setMessage(""); }}>Sign in</button>}
        {mode !== "signup" && <button type="button" onClick={() => { setMode("signup"); setMessage(""); }}>Create an account</button>}
        {mode !== "reset" && mode === "signin" && <button type="button" onClick={() => { setMode("reset"); setMessage(""); }}>Forgot password?</button>}
      </div>
    </div>
  );
}
