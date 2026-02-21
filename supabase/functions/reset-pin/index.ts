// Supabase Edge Function: reset-pin
// MASTER-only password reset (username + newPin)
//
// Requires secrets:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
//
// Deploy: supabase functions deploy reset-pin

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Body = {
  username?: string;
  newPin?: string;
};

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, message: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ ok: false, message: "Missing secrets" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization") || "";

    // Client for checking caller identity (uses the caller JWT)
    const userClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ ok: false, message: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Confirm caller is master via profiles table
    const callerId = userData.user.id;
    const { data: callerProfile, error: profErr } = await userClient
      .from("profiles")
      .select("is_master")
      .eq("user_id", callerId)
      .maybeSingle();

    if (profErr || !callerProfile?.is_master) {
      return new Response(JSON.stringify({ ok: false, message: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as Body;
    const username = (body.username || "").trim();
    const newPin = (body.newPin || "").trim();

    if (!username) {
      return new Response(JSON.stringify({ ok: false, message: "Missing username" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!/^\d{4,12}$/.test(newPin)) {
      return new Response(JSON.stringify({ ok: false, message: "PIN must be 4–12 digits" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Service client for admin operations
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Find target user_id by username from profiles
    const { data: targetProfile, error: tErr } = await admin
      .from("profiles")
      .select("user_id")
      .eq("username", username)
      .maybeSingle();

    if (tErr || !targetProfile?.user_id) {
      return new Response(JSON.stringify({ ok: false, message: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(targetProfile.user_id, {
      password: newPin,
    });

    if (updErr) {
      return new Response(JSON.stringify({ ok: false, message: updErr.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, message: (e as any)?.message || "Unknown error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
