import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export type CloudSchedulePayload = {
  slots: any[];
  courses: any[];
  entries: any[];
  theme: "dark" | "light";
  exportSkin: "default" | "lotr";
};

export type ProfileRow = {
  user_id: string;
  /**
   * We store the user's identifier here for the master panel.
   * In the "email login" flow this will be the email.
   */
  username: string;
  is_master: boolean;
  created_at?: string;
};

function normalizeEmail(input: string) {
  return input.trim().toLowerCase();
}

function isValidEmail(email: string) {
  // Simple, practical email check (good enough for UI validation)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Cloud sign-up with REAL email + PIN.
 * Note: Supabase may enforce rate limits; avoid repeated rapid signups.
 */
export async function cloudSignUp(emailInput: string, pin: string) {
  if (!supabase) throw new Error("Cloud not configured");

  const email = normalizeEmail(emailInput);
  if (!email || !isValidEmail(email)) throw new Error("Μη έγκυρο email.");

  const { data, error } = await supabase.auth.signUp({
    email,
    password: pin,
    options: {
      // store some metadata (optional)
      data: { email },
    },
  });
  if (error) throw error;

  // If email confirmation is OFF, user should be available immediately.
  // Create profile row (best effort).
  const user = data.user;
  if (user) {
    await ensureProfile(user, email);
  }

  return data;
}

export async function cloudSignIn(emailInput: string, pin: string) {
  if (!supabase) throw new Error("Cloud not configured");

  const email = normalizeEmail(emailInput);
  if (!email || !isValidEmail(email)) throw new Error("Μη έγκυρο email.");

  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pin });
  if (error) throw error;

  // Ensure profile exists
  if (data.user) {
    await ensureProfile(data.user, email);
  }

  return data;
}

export async function cloudSignOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function getMyProfile(userId: string) {
  if (!supabase) throw new Error("Cloud not configured");
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, username, is_master, created_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as ProfileRow | null;
}

export async function listProfilesAsMaster() {
  if (!supabase) throw new Error("Cloud not configured");
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, username, is_master, created_at")
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as ProfileRow[];
}

export async function loadScheduleFromCloud(userId: string) {
  if (!supabase) throw new Error("Cloud not configured");

  const { data, error } = await supabase
    .from("schedules")
    .select("data, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data as { data: CloudSchedulePayload; updated_at: string } | null;
}

export async function saveScheduleToCloud(userId: string, payload: CloudSchedulePayload) {
  if (!supabase) throw new Error("Cloud not configured");

  const { data, error } = await supabase
    .from("schedules")
    .upsert(
      {
        user_id: userId,
        data: payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select("updated_at")
    .single();

  if (error) throw error;
  return data as { updated_at: string };
}

async function ensureProfile(user: User, identifier: string) {
  if (!supabase) return;

  // upsert profile row (RLS allows each user to upsert their own row)
  await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      username: identifier,
      is_master: false,
      created_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
}

/**
 * Master-only PIN reset:
 * - Implemented via Supabase Edge Function (server-side) because it needs service role.
 * - This helper calls it.
 *
 * IMPORTANT: The Edge Function currently looks up a user by profiles.username.
 * In this "email login" version, profiles.username stores the email,
 * so you should pass the target email here.
 */
export async function masterResetPin(usernameOrEmail: string, newPin: string) {
  if (!supabase) throw new Error("Cloud not configured");

  const { data, error } = await supabase.functions.invoke("reset-pin", {
    body: { username: usernameOrEmail, newPin },
  });

  if (error) throw error;
  return data as { ok: boolean; message?: string };
}
