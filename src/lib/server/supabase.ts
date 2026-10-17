import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";

export function createRequestSupabase(cookies: AstroCookies, request: Request) {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) return null;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const getAll = (): { name: string; value: string }[] => cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      const name = separator >= 0 ? part.slice(0, separator) : part;
      const value = separator >= 0 ? part.slice(separator + 1) : "";
      try { return { name, value: decodeURIComponent(value) }; }
      catch { return { name, value }; }
    });
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll,
      setAll: (values: { name: string; value: string; options: CookieOptions }[]) => {
        for (const { name, value, options } of values) {
          const astroOptions: Parameters<AstroCookies["set"]>[2] = {
            domain: options.domain,
            path: options.path,
            expires: options.expires,
            maxAge: options.maxAge,
            httpOnly: options.httpOnly,
            sameSite: options.sameSite,
            secure: options.secure,
            encode: options.encode,
            partitioned: options.partitioned,
          };
          cookies.set(name, value, astroOptions);
        }
      },
    },
  });
}

export function createPrivilegedSupabase(): SupabaseClient | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function isAdminRole(appMetadata: Record<string, unknown>): boolean {
  return appMetadata.role === "admin";
}
