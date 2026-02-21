import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Vite env vars (set in .env / GitHub Pages secrets)
const RAW_URL = ((import.meta as any).env?.VITE_SUPABASE_URL ?? "") as string;
const RAW_KEY = ((import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? "") as string;

// Fix common "look-alike" characters that break domains (Greek/Cyrillic omicron → latin o)
function sanitizeUrl(u: string) {
  return u
    .trim()
    .replace(/\u03BF/g, "o") // Greek ο
    .replace(/\u043E/g, "o"); // Cyrillic о
}

const SUPABASE_URL = sanitizeUrl(RAW_URL);
const SUPABASE_ANON_KEY = RAW_KEY.trim();

let client: SupabaseClient | null = null;

try {
  // Validate URL early (prevents black screen)
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const parsed = new URL(SUPABASE_URL);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Supabase URL must start with http/https");
    }
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch (e) {
  // If something is wrong, keep app running in local-only mode instead of crashing
  client = null;
  console.error("Supabase init failed:", e, { SUPABASE_URL });
}

export const supabase = client;
export const hasSupabaseConfig = Boolean(supabase);
