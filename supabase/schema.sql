-- =============================================================================
-- Bitácora de Barra — esquema Supabase (PostgreSQL)
-- =============================================================================
-- Cómo usar este archivo: Supabase Dashboard → SQL Editor → pegar todo → Run.
-- Es seguro volver a ejecutarlo (usa IF NOT EXISTS / OR REPLACE donde aplica),
-- salvo las políticas RLS, que se borran y recrean para poder iterar.
--
-- DISEÑO (coherente con js/sync.js, ver también README.md "Estrategia de
-- sincronización"):
--   - Multi-negocio: TODAS las tablas de datos llevan business_id y están
--     protegidas con Row Level Security a nivel de PostgreSQL — un usuario
--     autenticado solo puede leer/escribir filas de su propio negocio. La
--     interfaz también puede ocultar botones, pero la seguridad real vive
--     aquí, no en el cliente.
--   - Esquema híbrido v1: cada tabla sincronizable tiene unas pocas columnas
--     relacionales (para RLS, FKs y los JOIN/índices que de verdad hacen
--     falta) + una columna `data jsonb` con el registro completo tal cual
--     vive en IndexedDB (mismos nombres de campo en español que usa
--     js/app.js). Normalizar columna a columna es un paso natural futuro,
--     no un requisito para que la sincronización funcione hoy.
--   - Borrado lógico: nunca se hace DELETE físico de datos operativos —se
--     marca deleted_at— para que el "tombstone" se pueda propagar a otros
--     dispositivos que estén offline en ese momento.
--   - updated_at + business_id son la base tanto de la sincronización
--     (cursor incremental) como de RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Extensiones
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- 1) Negocios (multi-establecimiento) y perfiles (vinculan auth.users → negocio)
-- -----------------------------------------------------------------------------
create table if not exists businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Roles válidos, coherentes con el sistema de roles ya existente en la app
-- (ADMINISTRADOR / ENCARGADO / EMPLEADO).
do $$ begin
  create type app_role as enum ('ADMINISTRADOR', 'ENCARGADO', 'EMPLEADO');
exception
  when duplicate_object then null;
end $$;

-- Un perfil por usuario de Supabase Auth. Es la tabla que resuelve
-- "¿a qué negocio pertenece este login, y con qué rol?" — sync.js la
-- consulta justo después de iniciar sesión (resolveBusinessId()).
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  business_id   uuid not null references businesses(id) on delete cascade,
  role          app_role not null default 'EMPLEADO',
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_profiles_business on profiles(business_id);

-- -----------------------------------------------------------------------------
-- 2) Función auxiliar: negocio del usuario autenticado actual
-- -----------------------------------------------------------------------------
-- security definer para poder leer `profiles` desde dentro de las políticas
-- de las demás tablas sin recursión de RLS.
create or replace function current_business_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select business_id from profiles where id = auth.uid()
$$;

create or replace function current_role_name()
returns app_role
language sql
security definer
stable
set search_path = public
as $$
  select role from profiles where id = auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- 3) Categorías (catálogo simple, opcional — hoy la app guarda la categoría
--    como texto libre dentro de `productos`; esta tabla queda preparada para
--    cuando se normalice, y de momento puede convivir vacía o usarse solo
--    para informes).
-- -----------------------------------------------------------------------------
create table if not exists categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_categories_business on categories(business_id);

-- -----------------------------------------------------------------------------
-- 4) Dispositivos (traza de qué tablet/móvil sincroniza qué y cuándo)
-- -----------------------------------------------------------------------------
create table if not exists devices (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  device_id     text not null,          -- identificador estable generado en el cliente (localStorage bb_device_id)
  user_id       uuid references auth.users(id) on delete set null,
  app_version   text,
  last_sync_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, device_id)
);
create index if not exists idx_devices_business on devices(business_id);

-- -----------------------------------------------------------------------------
-- 5) sync_metadata — un registro por (negocio, dispositivo, tabla) para
--    diagnóstico/auditoría de sincronización desde el propio Supabase
--    (además del cursor local que cada dispositivo guarda en su IndexedDB).
-- -----------------------------------------------------------------------------
create table if not exists sync_metadata (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  device_id       text not null,
  table_name      text not null,
  last_pushed_at  timestamptz,
  last_pulled_at  timestamptz,
  updated_at      timestamptz not null default now(),
  unique (business_id, device_id, table_name)
);
create index if not exists idx_sync_metadata_business on sync_metadata(business_id);

-- -----------------------------------------------------------------------------
-- 6) Tablas de datos operativos (esquema híbrido: columnas relacionales +
--    `data jsonb`). Todas siguen el mismo patrón:
--      id uuid, business_id uuid, updated_at, deleted_at, data jsonb
--    más las columnas "extra" que también manda js/sync.js (TABLE_MAP).
-- -----------------------------------------------------------------------------

create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  sku         text,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_products_business on products(business_id);
create index if not exists idx_products_updated on products(business_id, updated_at);

create table if not exists suppliers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_suppliers_business on suppliers(business_id);
create index if not exists idx_suppliers_updated on suppliers(business_id, updated_at);

create table if not exists equipment (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_equipment_business on equipment(business_id);
create index if not exists idx_equipment_updated on equipment(business_id, updated_at);

-- Movimientos de stock: la fuente de verdad del inventario. NUNCA se
-- sobrescriben ni se resuelven por "última escritura gana" — son eventos
-- inmutables que se acumulan (PURCHASE, CONSUMPTION, SALE, WASTE,
-- BREAKAGE, EXPIRATION, INTERNAL_USE, ADJUSTMENT, RETURN, OTHER...).
create table if not exists stock_movements (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  product_id  uuid references products(id) on delete set null,
  type        text,                     -- tipo de movimiento (ver js/app.js para el catálogo exacto usado hoy)
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_stock_movements_business on stock_movements(business_id);
create index if not exists idx_stock_movements_product on stock_movements(product_id);
create index if not exists idx_stock_movements_updated on stock_movements(business_id, updated_at);

create table if not exists temperature_records (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  equipment_id    uuid references equipment(id) on delete set null,
  out_of_range    boolean not null default false,
  data            jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists idx_temperature_records_business on temperature_records(business_id);
create index if not exists idx_temperature_records_updated on temperature_records(business_id, updated_at);

create table if not exists invoices (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  supplier_id   uuid references suppliers(id) on delete set null,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists idx_invoices_business on invoices(business_id);
create index if not exists idx_invoices_updated on invoices(business_id, updated_at);

-- Líneas de factura, normalizadas. Preparada de cara al futuro: la app hoy
-- (v1 de sync.js) guarda las líneas dentro de invoices.data como parte del
-- registro de factura (igual que en IndexedDB), y todavía no las vuelca fila
-- a fila aquí — ver README.md, sección "Alcance actual de la sincronización".
create table if not exists invoice_items (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  invoice_id    uuid references invoices(id) on delete cascade,
  product_id    uuid references products(id) on delete set null,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists idx_invoice_items_business on invoice_items(business_id);
create index if not exists idx_invoice_items_invoice on invoice_items(invoice_id);

-- Mermas/roturas como tabla dedicada, preparada de cara al futuro. Igual que
-- invoice_items: v1 de sync.js sigue representando una merma como un
-- stock_movement con type='merma' (mismo flujo que ya usa la app), y esta
-- tabla queda lista para cuando se quiera separar en un flujo propio con
-- foto/motivo relacional — ver README.md.
create table if not exists waste_records (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  product_id    uuid references products(id) on delete set null,
  reason        text,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists idx_waste_records_business on waste_records(business_id);

create table if not exists inventory_counts (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_inventory_counts_business on inventory_counts(business_id);
create index if not exists idx_inventory_counts_updated on inventory_counts(business_id, updated_at);

create table if not exists incidents (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  status      text,
  priority    text,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_incidents_business on incidents(business_id);
create index if not exists idx_incidents_updated on incidents(business_id, updated_at);

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_tasks_business on tasks(business_id);
create index if not exists idx_tasks_updated on tasks(business_id, updated_at);

create table if not exists checklists (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_checklists_business on checklists(business_id);
create index if not exists idx_checklists_updated on checklists(business_id, updated_at);

create table if not exists checklist_records (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  checklist_id  uuid references checklists(id) on delete set null,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists idx_checklist_records_business on checklist_records(business_id);
create index if not exists idx_checklist_records_checklist on checklist_records(checklist_id);

-- Adjuntos (fotos de facturas, incidencias, mermas...) subidos a Supabase
-- Storage. Esta tabla guarda solo los metadatos/ruta; el binario vive en el
-- bucket de Storage (ver README.md).
create table if not exists attachments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  entity_table  text not null,          -- p.ej. 'invoices', 'incidents', 'stock_movements'
  entity_id     uuid,
  storage_path  text not null,          -- ruta dentro del bucket 'attachments'
  content_type  text,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists idx_attachments_business on attachments(business_id);
create index if not exists idx_attachments_entity on attachments(entity_table, entity_id);

-- -----------------------------------------------------------------------------
-- 7) Row Level Security — activar en todas las tablas de negocio
-- -----------------------------------------------------------------------------
alter table businesses           enable row level security;
alter table profiles             enable row level security;
alter table categories           enable row level security;
alter table devices              enable row level security;
alter table sync_metadata        enable row level security;
alter table products             enable row level security;
alter table suppliers            enable row level security;
alter table equipment            enable row level security;
alter table stock_movements      enable row level security;
alter table temperature_records  enable row level security;
alter table invoices             enable row level security;
alter table invoice_items        enable row level security;
alter table waste_records        enable row level security;
alter table inventory_counts     enable row level security;
alter table incidents            enable row level security;
alter table tasks                enable row level security;
alter table checklists           enable row level security;
alter table checklist_records    enable row level security;
alter table attachments          enable row level security;

-- --- businesses: solo se puede leer el propio negocio (alta de negocios la
--     hace el administrador de Supabase o un flujo de "onboarding" aparte).
drop policy if exists business_select on businesses;
create policy business_select on businesses for select
  using (id = current_business_id());

-- --- profiles: cada usuario ve los perfiles de su propio negocio; solo
--     puede editar su propia fila.
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select
  using (business_id = current_business_id());
drop policy if exists profiles_update_self on profiles;
create policy profiles_update_self on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- --- Plantilla RLS para el resto de tablas: select/insert/update por
--     business_id = current_business_id(). Se genera una política por
--     tabla (Postgres no permite parametrizar el nombre de tabla en DDL
--     estático sin PL/pgSQL dinámico, así que se listan explícitas).
do $$
declare
  t text;
  tables text[] := array[
    'categories','devices','sync_metadata','products','suppliers','equipment',
    'stock_movements','temperature_records','invoices','invoice_items',
    'waste_records','inventory_counts','incidents','tasks','checklists',
    'checklist_records','attachments'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I_select on %I', t, t);
    execute format('create policy %I_select on %I for select using (business_id = current_business_id())', t, t);

    execute format('drop policy if exists %I_insert on %I', t, t);
    execute format('create policy %I_insert on %I for insert with check (business_id = current_business_id())', t, t);

    execute format('drop policy if exists %I_update on %I', t, t);
    execute format('create policy %I_update on %I for update using (business_id = current_business_id()) with check (business_id = current_business_id())', t, t);

    -- Sin política de DELETE a propósito: el borrado es siempre lógico
    -- (UPDATE ... SET deleted_at = ...), nunca un DELETE físico, así que
    -- no se concede permiso de DELETE por RLS.
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 8) Supabase Storage — bucket para adjuntos (fotos de facturas, incidencias,
--    mermas...). Privado: solo accesible con sesión y RLS por carpeta
--    "<business_id>/...". Ejecutar solo si el bucket no existe aún.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
select 'attachments', 'attachments', false
where not exists (select 1 from storage.buckets where id = 'attachments');

-- Supabase activa RLS en storage.objects por defecto en proyectos nuevos
-- (confirmado en Fase 8 contra un proyecto Supabase real). Se intenta
-- también aquí como defensa en profundidad para un PostgreSQL genérico que
-- no lo traiga activado por defecto (se comprobó exactamente ese caso
-- durante la auditoría de la Fase 7, contra un PostgreSQL local). En un
-- proyecto Supabase real, `storage.objects` pertenece al rol interno
-- `supabase_storage_admin`, no al usuario que ejecuta el SQL Editor — el
-- ALTER TABLE falla ahí con "must be owner of table objects" (42501), error
-- real encontrado en Fase 8. Se envuelve para que ese fallo, esperado y
-- ya cubierto por el propio Supabase, no interrumpa el resto del script.
do $$ begin
  alter table storage.objects enable row level security;
exception
  when insufficient_privilege then
    raise notice 'storage.objects ya gestionado por Supabase (RLS activado por defecto); se omite ALTER (sin permisos de owner, esperado en un proyecto real).';
end $$;

drop policy if exists attachments_storage_rw on storage.objects;
create policy attachments_storage_rw on storage.objects for all
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = current_business_id()::text
  )
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = current_business_id()::text
  );

-- -----------------------------------------------------------------------------
-- Fin del esquema. Siguiente paso: crear el primer negocio y el primer
-- perfil de administrador — ver SETUP.md, paso "Primer usuario y negocio".
-- -----------------------------------------------------------------------------
