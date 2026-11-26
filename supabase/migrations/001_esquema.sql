-- TRACKER XLIV · 001 esquema base · 26/11/2026
-- Aplicada en tracker-beta. Convenciones:
--   · perfil_id en todas las tablas aunque se deduzca del padre: deja cada
--     política RLS en una línea y los índices directos.
--   · perfil_id NULO = material común (plantillas, catálogo de alimentos).
--   · Lo que en la hoja admite texto (REPS, PESO) lo sigue admitiendo aquí.

create extension if not exists pgcrypto;

create type servicio      as enum ('entreno', 'dieta', 'completo');
create type estado_perfil as enum ('activo', 'pausa', 'baja');
create type tipo_dia      as enum ('entreno', 'descanso', 'ambos');

-- auth_id lo rellena el disparador de 002 al entrar con Google por primera
-- vez, casando por correo. Así se da de alta a alguien antes de que entre.
create table perfiles (
  id        uuid primary key default gen_random_uuid(),
  auth_id   uuid unique references auth.users (id) on delete set null,
  nombre    text not null,
  correo    text not null unique,
  sexo      text check (sexo in ('h', 'm')),
  servicio  servicio      not null default 'completo',
  estado    estado_perfil not null default 'activo',
  inicio    date not null default current_date,
  objetivo  text,
  gestor    boolean not null default false,
  creado_en timestamptz not null default now()
);

-- Aparte de perfiles porque su regla es distinta (solo gestor, ni siquiera
-- el interesado) y Postgres no tiene permisos por columna dentro de RLS.
create table notas_gestor (
  perfil_id   uuid primary key references perfiles (id) on delete cascade,
  notas       text,
  actualizado timestamptz not null default now()
);

create table gimnasios (
  id        uuid primary key default gen_random_uuid(),
  perfil_id uuid not null references perfiles (id) on delete cascade,
  nombre    text not null,
  habitual  boolean not null default false,
  orden     int  not null default 0,
  unique (perfil_id, nombre)
);
create unique index gimnasios_un_habitual on gimnasios (perfil_id) where habitual;

create table planes (
  id         uuid primary key default gen_random_uuid(),
  perfil_id  uuid not null references perfiles (id) on delete cascade,
  fecha      date not null default current_date,
  tipo       text not null,
  plan       text,
  comentario text
);
create index planes_perfil_fecha on planes (perfil_id, fecha desc);

-- Un mesociclo = una rutina. El siguiente es una fila nueva y el anterior
-- queda con su histórico intacto.
create table rutinas (
  id           uuid primary key default gen_random_uuid(),
  perfil_id    uuid references perfiles (id) on delete cascade,
  nombre       text not null,
  activa       boolean not null default false,
  es_plantilla boolean not null default false,
  desde        date,
  notas        text,
  creado_en    timestamptz not null default now(),
  check (es_plantilla = (perfil_id is null))
);
create unique index rutinas_una_activa on rutinas (perfil_id)
  where activa and perfil_id is not null;

create table dias (
  id          uuid primary key default gen_random_uuid(),
  rutina_id   uuid not null references rutinas (id) on delete cascade,
  perfil_id   uuid references perfiles (id) on delete cascade,
  nombre      text not null,
  orden       int  not null,
  es_descanso boolean not null default false,
  unique (rutina_id, orden)
);

create table ejercicios (
  id        uuid primary key default gen_random_uuid(),
  dia_id    uuid not null references dias (id) on delete cascade,
  perfil_id uuid references perfiles (id) on delete cascade,
  orden     int  not null,
  bloque    text,
  aviso     text,
  nombre    text not null,
  config    text,
  tecnica   text,
  notas     text,
  unique (dia_id, orden)
);

create table series_prescritas (
  id           uuid primary key default gen_random_uuid(),
  ejercicio_id uuid not null references ejercicios (id) on delete cascade,
  perfil_id    uuid references perfiles (id) on delete cascade,
  orden        int  not null,
  reps         text,
  rir          text,
  descanso     int,
  aproximacion boolean not null default false,
  unique (ejercicio_id, orden)
);

-- Lo que hoy es un ROLL: un paso por ese día, con fecha y gimnasio.
create table sesiones (
  id             uuid primary key default gen_random_uuid(),
  perfil_id      uuid not null references perfiles (id) on delete cascade,
  dia_id         uuid not null references dias (id) on delete cascade,
  ciclo          int  not null,
  fecha          date,
  gimnasio_id    uuid references gimnasios (id) on delete set null,
  gimnasio_libre text,
  creada_en      timestamptz not null default now(),
  unique (perfil_id, dia_id, ciclo)
);
create index sesiones_perfil_fecha on sesiones (perfil_id, fecha desc);

-- La unicidad (sesion_id, serie_prescrita_id) es lo que hace que reenviar la
-- cola local del móvil sobreescriba en vez de duplicar.
create table series (
  id                 uuid primary key default gen_random_uuid(),
  sesion_id          uuid not null references sesiones (id) on delete cascade,
  serie_prescrita_id uuid references series_prescritas (id) on delete set null,
  perfil_id          uuid not null references perfiles (id) on delete cascade,
  orden              int not null,
  peso               numeric(7,3),
  peso_texto         text,
  reps               text,
  rir                numeric(4,2),
  ajuste             text,
  auto               boolean not null default false,
  ejercicio_alt      text,
  registrada_en      timestamptz not null default now(),
  unique (sesion_id, serie_prescrita_id)
);
create index series_perfil on series (perfil_id);
create index series_sesion on series (sesion_id);

create table alimentos (
  id         uuid primary key default gen_random_uuid(),
  perfil_id  uuid references perfiles (id) on delete cascade,
  nombre     text not null,
  marca      text,
  por        text not null default '100g',
  kcal       numeric(7,2),
  hc         numeric(7,2),
  prot       numeric(7,2),
  grasa      numeric(7,2),
  fuente     text,
  confirmado boolean not null default false
);
create index alimentos_nombre on alimentos (lower(nombre));

create table dietas (
  id            uuid primary key default gen_random_uuid(),
  perfil_id     uuid not null references perfiles (id) on delete cascade,
  vigente_desde date not null,
  activa        boolean not null default false,
  notas         text
);
create unique index dietas_una_activa on dietas (perfil_id) where activa;

create table comidas (
  id        uuid primary key default gen_random_uuid(),
  dieta_id  uuid not null references dietas (id) on delete cascade,
  perfil_id uuid not null references perfiles (id) on delete cascade,
  orden     int  not null,
  nombre    text not null,
  hora      text,
  unique (dieta_id, orden)
);

-- grupo resuelve "125 g de pollo O 150 g de pescado": mismo grupo dentro de
-- la comida = opciones intercambiables, y solo se suma la elegida.
create table items (
  id          uuid primary key default gen_random_uuid(),
  comida_id   uuid not null references comidas (id) on delete cascade,
  perfil_id   uuid not null references perfiles (id) on delete cascade,
  alimento_id uuid references alimentos (id) on delete restrict,
  texto       text,
  cantidad    numeric(8,2),
  unidad      text default 'g',
  tipo_dia    tipo_dia not null default 'ambos',
  grupo       int not null default 0,
  orden       int not null default 0,
  nota        text
);
create index items_comida on items (comida_id);

create table preferencias (
  perfil_id   uuid not null references perfiles (id) on delete cascade,
  clave       text not null,
  valor       jsonb not null,
  actualizado timestamptz not null default now(),
  primary key (perfil_id, clave)
);
