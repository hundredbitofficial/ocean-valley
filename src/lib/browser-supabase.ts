import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabase() {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  return url && publishableKey ? createBrowserClient(url, publishableKey) : null;
}
