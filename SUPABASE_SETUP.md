# Supabase Cloud Sync Setup (Uni Schedule)

Αυτό το repo υποστηρίζει Cloud Sync (πολλαπλές συσκευές) μέσω Supabase.

## 1) Δημιουργία Supabase Project
1. Φτιάξε ένα νέο project στο Supabase.
2. Πήγαινε **Project Settings → API** και κράτα:
   - **Project URL**
   - **anon public key**

## 2) Auth ρυθμίσεις (για username+PIN)
Πήγαινε **Authentication → Providers → Email** και:
- Κλείσε το **Email confirmations** (OFF)
  - Επειδή χρησιμοποιούμε ψεύτικα emails τύπου `username@uni-schedule.local`

## 3) Πίνακες + Policies (SQL)
Πήγαινε **SQL Editor** και τρέξε το παρακάτω:

```sql
-- 1) Profiles (username + master flag)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  is_master boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2) Schedules (ένα JSON ανά χρήστη)
create table if not exists public.schedules (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.schedules enable row level security;

-- Profiles: ο χρήστης βλέπει τη δική του εγγραφή.
-- MASTER: μπορεί να βλέπει όλες τις εγγραφές (για λίστα usernames).
create policy "profiles_read_self_or_master" on public.profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    OR exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid() and p.is_master = true
    )
  );

-- Profile insert/update: μόνο ο ίδιος ο χρήστης
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Schedules: μόνο ο ίδιος ο χρήστης
create policy "schedules_read_self" on public.schedules
  for select to authenticated
  using (user_id = auth.uid());

create policy "schedules_insert_self" on public.schedules
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "schedules_update_self" on public.schedules
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

## 4) Ορισμός Master χρήστη
1. Κάνε signup μέσα από την εφαρμογή με username π.χ. `master` και ένα PIN.
2. Πήγαινε **Table Editor → profiles** και στο row του `master` γύρνα το `is_master = true`.

> Σημείωση: Το app **δεν μπορεί** να “δείξει” υπάρχοντα PIN (είναι hashed). Ο master μπορεί να κάνει *reset* σε νέο προσωρινό PIN.

## 5) Edge Function για Reset PIN (MASTER)
Το reset PIN απαιτεί service role (δεν μπαίνει ποτέ στο frontend). Υπάρχει έτοιμος κώδικας στο `supabase/functions/reset-pin/index.ts`.

### Deploy (2 τρόποι)
- **Με Supabase CLI** (προτείνεται):
  1. `supabase login`
  2. `supabase link --project-ref <YOUR_REF>`
  3. `supabase functions deploy reset-pin`

- **Ή** από το Supabase Dashboard (Edge Functions), αν έχεις έτοιμο environment.

### Secrets (υποχρεωτικά)
Στο Supabase project βάλε secrets:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

(τα βρίσκεις στο Settings → API)

## 6) Ρύθμιση Vite env vars
Δημιούργησε `.env` (ή βάλε GitHub Secrets) με:

```bash
VITE_SUPABASE_URL="..."
VITE_SUPABASE_ANON_KEY="..."
```

## 7) GitHub Pages (Actions) env vars
Για να χτίζει σωστά στο GitHub Pages, βάλε τα παραπάνω ως **Repository Secrets** και στο workflow πρόσθεσε env:

```yml
- name: Build
  run: npm run build
  env:
    VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
    VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
```

