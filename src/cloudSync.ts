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
  username: string;
  is_master: boolean;
  created_at?: string;
};

function normalizeUsername(input: string) {
  const u = input.trim();
  // Allow greek/latin/numbers/._- and spaces (spaces will become '.')
  const safe = u
    .replace(/\s+/g, ".")
    .replace(/[^\p{L}\p{N}._-]/gu, "");
  return safe.toLowerCase();
}

export function usernameToEmail(username: string) {
  const u = normalizeUsername(username);
  if (!u) return "";
  // Pseudo-email for Supabase auth (no real email required)
  return `${u}@example.com`;
}

export async function cloudSignUp(username: string, pin: string) {
  if (!supabase) throw new Error("Cloud not configured");

  const email = usernameToEmail(username);
  if (!email) throw new Error("Invalid username");

  const { data, error } = await supabase.auth.signUp({
    email,
    password: pin,
    options: {
      // store the original (display) username
      data: { username: username.trim() },
    },
  });
  if (error) throw error;

  // If the project has email confirmation OFF, user should be available immediately.
  // Create profile row (best effort).
  const user = data.user;
  if (user) {
    await ensureProfile(user, username.trim());
  }

  return data;
}

export async function cloudSignIn(username: string, pin: string) {
  if (!supabase) throw new Error("Cloud not configured");
  const email = usernameToEmail(username);
  if (!email) throw new Error("Invalid username");

  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pin });
  if (error) throw error;

  // Ensure profile exists
  if (data.user) {
    await ensureProfile(data.user, username.trim());
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

async function ensureProfile(user: User, displayUsername: string) {
  if (!supabase) return;

  // upsert profile row (RLS allows each user to upsert their own row)
  await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      username: displayUsername,
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
 */
export async function masterResetPin(username: string, newPin: string) {
  if (!supabase) throw new Error("Cloud not configured");

  const { data, error } = await supabase.functions.invoke("reset-pin", {
    body: { username, newPin },
  });

  if (error) throw error;
  return data as { ok: boolean; message?: string };
}
