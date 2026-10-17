import type { APIRoute } from "astro";
import { createRequestSupabase } from "@/lib/server/supabase";

export const GET: APIRoute = async ({ cookies, redirect, request }) => {
  const client = createRequestSupabase(cookies, request);
  if (client) {
    const { error } = await client.auth.signOut();
    if (error) return new Response("Unable to sign out. Please try again.", { status: 503 });
  }
  return redirect("/");
};
