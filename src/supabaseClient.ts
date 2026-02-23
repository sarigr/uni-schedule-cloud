import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Vite env vars (set in .env / GitHub Pages secrets)
const RAW_URL = ((import.meta as any).env?.VITE_SUPABASE_URL ?? "") as string;
const RAW_KEY = ((import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? "") as string;

// Guard against "look-alike" characters (Greek/Cyrillic omicron) that can break domains.
function sanitizeUrl(u: string) {
  return u
    .trim()
    .replace(/\u03BF/g, "o") // Greek ο
    .replace(/\u043E/g, "o"); // Cyrillic о
}

const SUPABASE_URL = sanitizeUrl(RAW_URL);
const SUPABASE_ANON_KEY = RAW_KEY.trim();

function isValidHttpUrl(u: string) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export const hasSupabaseConfig = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && isValidHttpUrl(SUPABASE_URL));

// Export a client (nullable) so the app can still run in local-only mode.
export const supabase: SupabaseClient | null = hasSupabaseConfig
  ? createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string)
  : null;
