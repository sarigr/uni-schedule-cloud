import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Vite env vars (set in .env / GitHub Pages secrets)
const supabaseUrl = "https://xskljsaknryzrspoayxs.supabase.co";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const hasSupabaseConfig = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Export a client (nullable) so the app can still run in local-only mode.
export const supabase: SupabaseClient | null = hasSupabaseConfig
  ? createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string)
  : null;
