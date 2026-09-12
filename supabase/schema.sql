-- Freehold mijlpalenbord, databaseschema voor Supabase (Postgres).
-- Eén keer uitvoeren in de SQL-editor van het project. Idempotent waar dat kan.
--
-- Toegangsmodel in één zin: wie inlogt, komt alleen binnen als zijn e-mailadres
-- op het blad Mensen staat en actief is; schrijven kan alleen wie daar
-- "mag bewerken" heeft; het register zelf beheert alleen een beheerder.
-- Elke wijziging en elke opmerking wordt aan de serverkant gestempeld met
-- het e-mailadres van de ingelogde gebruiker, nooit met wat de pagina opgeeft.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------

create table if not exists mensen (
  id             uuid primary key default gen_random_uuid(),
  email          text unique,                     -- inlogidentiteit, mag leeg zijn voor een externe zonder toegang
  naam           text not null,
  organisatie    text,
  soort          text not null default 'extern' check (soort in ('oprichter','intern','extern')),
  rol            text,
  notities       text,
  mag_bewerken   boolean not null default false,
  is_beheerder   boolean not null default false,
  actief         boolean not null default true,
  volgorde       integer not null default 100,
  aangemaakt_op  timestamptz not null default now()
);

create table if not exists instellingen (
  sleutel        text primary key,
  waarde         jsonb not null,
  bijgewerkt_op  timestamptz not null default now(),
  bijgewerkt_door text
);

create table if not exists kaarten (
  id               uuid primary key default gen_random_uuid(),
  nr               text unique,
  titel            text not null,
  toets            text,
  afhankelijkheid  text,
  grond            text,
  eigenaar_id      uuid references mensen(id) on delete set null,
  gedeeld_groep    boolean not null default false,       -- mijlpaal van de vennootschap met één verantwoordelijke
  gedeeld_met_id   uuid references mensen(id) on delete set null,  -- tweede oprichter die ze mee draagt
  periode          smallint check (periode between 1 and 4),
  maand            smallint,                             -- maanden na de aanvangsdatum
  streefdatum      date,
  kolom            text not null default 'open'
                   check (kolom in ('open','in_uitvoering','wacht_op','gehaald','vervallen')),
  positie          double precision not null default 0,
  betrokkenen      uuid[] not null default '{}',
  checklist        jsonb not null default '[]',          -- [{id, tekst, gedaan}]
  aangemaakt_op    timestamptz not null default now(),
  aangemaakt_door  text,
  bijgewerkt_op    timestamptz not null default now(),
  bijgewerkt_door  text
);

create index if not exists kaarten_kolom_positie on kaarten (kolom, positie);
create index if not exists kaarten_eigenaar on kaarten (eigenaar_id);

create table if not exists opmerkingen (
  id             uuid primary key default gen_random_uuid(),
  kaart_id       uuid not null references kaarten(id) on delete cascade,
  auteur_email   text not null,
  auteur_naam    text,
  tekst          text not null,
  aangemaakt_op  timestamptz not null default now()
);

create index if not exists opmerkingen_kaart on opmerkingen (kaart_id, aangemaakt_op);

create table if not exists activiteit (
  id           bigserial primary key,
  tijdstip     timestamptz not null default now(),
  actor_email  text,
  actor_naam   text,
  actie        text not null,
  kaart_id     uuid,
  kaart_nr     text,
  detail       jsonb
);

create index if not exists activiteit_tijd on activiteit (tijdstip desc);

-- ---------------------------------------------------------------------
-- Hulpfuncties voor de toegangsregels
-- ---------------------------------------------------------------------

create or replace function huidig_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function is_lid() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from mensen
    where actief and email is not null and lower(email) = huidig_email()
  )
$$;

create or replace function mag_bewerken() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from mensen
    where actief and mag_bewerken and email is not null and lower(email) = huidig_email()
  )
$$;

create or replace function is_beheerder() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from mensen
    where actief and is_beheerder and email is not null and lower(email) = huidig_email()
  )
$$;

create or replace function huidige_naam() returns text
language sql stable security definer set search_path = public as $$
  select naam from mensen where email is not null and lower(email) = huidig_email() limit 1
$$;

-- ---------------------------------------------------------------------
-- Stempels en activiteitenlog, aan de serverkant
-- ---------------------------------------------------------------------

create or replace function kaart_stempel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.aangemaakt_op := now();
    new.aangemaakt_door := huidig_email();
  end if;
  new.bijgewerkt_op := now();
  new.bijgewerkt_door := huidig_email();
  return new;
end $$;

drop trigger if exists kaart_stempel_trg on kaarten;
create trigger kaart_stempel_trg before insert or update on kaarten
  for each row execute function kaart_stempel();

create or replace function kaart_activiteit() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if tg_op = 'INSERT' then
    insert into activiteit (actor_email, actor_naam, actie, kaart_id, kaart_nr, detail)
    values (huidig_email(), huidige_naam(), 'aangemaakt', new.id, new.nr, jsonb_build_object('titel', new.titel));
    return new;
  elsif tg_op = 'DELETE' then
    insert into activiteit (actor_email, actor_naam, actie, kaart_id, kaart_nr, detail)
    values (huidig_email(), huidige_naam(), 'verwijderd', old.id, old.nr, jsonb_build_object('titel', old.titel));
    return old;
  end if;
  d := '{}'::jsonb;
  if new.kolom is distinct from old.kolom then
    d := d || jsonb_build_object('van', old.kolom, 'naar', new.kolom);
    insert into activiteit (actor_email, actor_naam, actie, kaart_id, kaart_nr, detail)
    values (huidig_email(), huidige_naam(), 'verplaatst', new.id, new.nr, d);
  end if;
  if new.titel is distinct from old.titel
     or new.toets is distinct from old.toets
     or new.afhankelijkheid is distinct from old.afhankelijkheid
     or new.grond is distinct from old.grond
     or new.streefdatum is distinct from old.streefdatum
     or new.eigenaar_id is distinct from old.eigenaar_id
     or new.gedeeld_met_id is distinct from old.gedeeld_met_id
     or new.gedeeld_groep is distinct from old.gedeeld_groep
     or new.betrokkenen is distinct from old.betrokkenen then
    insert into activiteit (actor_email, actor_naam, actie, kaart_id, kaart_nr, detail)
    values (huidig_email(), huidige_naam(), 'bewerkt', new.id, new.nr, jsonb_build_object('titel', new.titel));
  end if;
  if new.checklist is distinct from old.checklist then
    insert into activiteit (actor_email, actor_naam, actie, kaart_id, kaart_nr, detail)
    values (huidig_email(), huidige_naam(), 'checklist', new.id, new.nr, jsonb_build_object('titel', new.titel));
  end if;
  return new;
end $$;

drop trigger if exists kaart_activiteit_trg on kaarten;
create trigger kaart_activiteit_trg after insert or update or delete on kaarten
  for each row execute function kaart_activiteit();

create or replace function opmerking_stempel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.auteur_email := huidig_email();
  new.auteur_naam := huidige_naam();
  new.aangemaakt_op := now();
  insert into activiteit (actor_email, actor_naam, actie, kaart_id, kaart_nr, detail)
  select huidig_email(), huidige_naam(), 'opmerking', k.id, k.nr, jsonb_build_object('titel', k.titel)
  from kaarten k where k.id = new.kaart_id;
  return new;
end $$;

drop trigger if exists opmerking_stempel_trg on opmerkingen;
create trigger opmerking_stempel_trg before insert on opmerkingen
  for each row execute function opmerking_stempel();

create or replace function instelling_stempel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.bijgewerkt_op := now();
  new.bijgewerkt_door := huidig_email();
  return new;
end $$;

drop trigger if exists instelling_stempel_trg on instellingen;
create trigger instelling_stempel_trg before insert or update on instellingen
  for each row execute function instelling_stempel();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table mensen       enable row level security;
alter table instellingen enable row level security;
alter table kaarten      enable row level security;
alter table opmerkingen  enable row level security;
alter table activiteit   enable row level security;

drop policy if exists mensen_lezen on mensen;
create policy mensen_lezen on mensen for select to authenticated using (is_lid());
drop policy if exists mensen_beheren_insert on mensen;
create policy mensen_beheren_insert on mensen for insert to authenticated with check (is_beheerder());
drop policy if exists mensen_beheren_update on mensen;
create policy mensen_beheren_update on mensen for update to authenticated using (is_beheerder()) with check (is_beheerder());
drop policy if exists mensen_beheren_delete on mensen;
create policy mensen_beheren_delete on mensen for delete to authenticated using (is_beheerder());

drop policy if exists instellingen_lezen on instellingen;
create policy instellingen_lezen on instellingen for select to authenticated using (is_lid());
drop policy if exists instellingen_schrijven_insert on instellingen;
create policy instellingen_schrijven_insert on instellingen for insert to authenticated with check (is_beheerder());
drop policy if exists instellingen_schrijven_update on instellingen;
create policy instellingen_schrijven_update on instellingen for update to authenticated using (is_beheerder()) with check (is_beheerder());

drop policy if exists kaarten_lezen on kaarten;
create policy kaarten_lezen on kaarten for select to authenticated using (is_lid());
drop policy if exists kaarten_insert on kaarten;
create policy kaarten_insert on kaarten for insert to authenticated with check (mag_bewerken());
drop policy if exists kaarten_update on kaarten;
create policy kaarten_update on kaarten for update to authenticated using (mag_bewerken()) with check (mag_bewerken());
drop policy if exists kaarten_delete on kaarten;
create policy kaarten_delete on kaarten for delete to authenticated using (mag_bewerken());

drop policy if exists opmerkingen_lezen on opmerkingen;
create policy opmerkingen_lezen on opmerkingen for select to authenticated using (is_lid());
drop policy if exists opmerkingen_insert on opmerkingen;
create policy opmerkingen_insert on opmerkingen for insert to authenticated with check (mag_bewerken());
drop policy if exists opmerkingen_delete on opmerkingen;
create policy opmerkingen_delete on opmerkingen for delete to authenticated
  using (is_beheerder() or lower(auteur_email) = huidig_email());

drop policy if exists activiteit_lezen on activiteit;
create policy activiteit_lezen on activiteit for select to authenticated using (is_lid());
-- Schrijven in activiteit gebeurt uitsluitend via de triggers (security definer); geen insert-policy nodig.

-- ---------------------------------------------------------------------
-- Realtime: wijzigingen live naar elk open scherm
-- ---------------------------------------------------------------------

alter table kaarten     replica identity full;
alter table opmerkingen replica identity full;
alter table mensen      replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['kaarten','opmerkingen','mensen','activiteit','instellingen'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Eerste beheerder en aanvangsdatum
-- Vervang het e-mailadres vóór het uitvoeren. De overige oprichters komen
-- via het blad Mensen in de toepassing of via het seed-bestand.
-- ---------------------------------------------------------------------

insert into mensen (email, naam, organisatie, soort, rol, mag_bewerken, is_beheerder, volgorde)
values ('ben@respublicai.org', 'Ben Broeckx', 'Freehold Works', 'oprichter', 'Organisatie en administratie, ecosysteem', true, true, 1)
on conflict (email) do nothing;

insert into instellingen (sleutel, waarde)
values ('aanvangsdatum', '"2026-09-30"'::jsonb)
on conflict (sleutel) do nothing;
