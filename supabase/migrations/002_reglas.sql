-- TRACKER XLIV · 002 reglas de seguridad (RLS) · 26/11/2026
-- Cada persona ve y escribe lo suyo; el gestor (Diego) ve y escribe todo.
-- Se cumple dentro de Postgres, no en el código de la app.
--
-- Las dos funciones de identidad son SECURITY DEFINER para que consultar
-- "perfiles" desde dentro de una política no vuelva a disparar la política
-- de "perfiles" (recursión infinita).

create or replace function mi_perfil()
returns uuid language sql stable security definer set search_path = public as $q$
  select id from perfiles where auth_id = auth.uid();
$q$;

create or replace function es_gestor()
returns boolean language sql stable security definer set search_path = public as $q$
  select coalesce((select gestor from perfiles
                    where auth_id = auth.uid() and estado = 'activo'), false);
$q$;

revoke execute on function mi_perfil() from public;
revoke execute on function es_gestor() from public;
grant execute on function mi_perfil() to authenticated;
grant execute on function es_gestor() to authenticated;

-- La persona existe en "perfiles" antes de entrar nunca (la da de alta el
-- gestor con su correo). Al entrar con Google se enlaza por correo. Si no hay
-- perfil con ese correo no se crea nada: entra autenticada pero no ve ni una
-- fila. El alta la decide Diego, no quien se presente con un Google.
create or replace function enlazar_perfil()
returns trigger language plpgsql security definer set search_path = public as $q$
begin
  update perfiles set auth_id = new.id
   where lower(correo) = lower(new.email) and auth_id is null;
  return new;
end;
$q$;

drop trigger if exists al_entrar_enlazar_perfil on auth.users;
create trigger al_entrar_enlazar_perfil
  after insert on auth.users for each row execute function enlazar_perfil();

-- Los proyectos se crearon con "Enable RLS on new tables automatically", así
-- que ya está activo. Se repite por si el esquema se aplica en otro sitio:
-- una tabla sin RLS devolvería todo a cualquiera.
alter table perfiles          enable row level security;
alter table notas_gestor      enable row level security;
alter table gimnasios         enable row level security;
alter table planes            enable row level security;
alter table rutinas           enable row level security;
alter table dias              enable row level security;
alter table ejercicios        enable row level security;
alter table series_prescritas enable row level security;
alter table sesiones          enable row level security;
alter table series            enable row level security;
alter table alimentos         enable row level security;
alter table dietas            enable row level security;
alter table comidas           enable row level security;
alter table items             enable row level security;
alter table preferencias      enable row level security;

create policy perfiles_ver on perfiles
  for select to authenticated
  using (auth_id = auth.uid() or es_gestor());

-- Nadie edita su propio perfil: servicio, estado y gestor los decide Diego.
-- Evita que alguien se ascienda a gestor.
create policy perfiles_gestor_escribe on perfiles
  for all to authenticated
  using (es_gestor()) with check (es_gestor());

create policy notas_solo_gestor on notas_gestor
  for all to authenticated
  using (es_gestor()) with check (es_gestor());

do $q$
declare t text;
begin
  foreach t in array array[
    'gimnasios','planes','dias','ejercicios','series_prescritas',
    'sesiones','series','dietas','comidas','items','preferencias'
  ] loop
    execute format(
      'create policy %1$s_mias on %1$I for all to authenticated '
      'using (perfil_id = mi_perfil() or es_gestor()) '
      'with check (perfil_id = mi_perfil() or es_gestor())', t);
  end loop;
end $q$;

-- rutinas y alimentos: además, lo común (perfil_id nulo) lo ve todo el mundo
create policy rutinas_mias on rutinas
  for all to authenticated
  using (perfil_id = mi_perfil() or es_gestor())
  with check (perfil_id = mi_perfil() or es_gestor());

create policy rutinas_plantillas_ver on rutinas
  for select to authenticated using (perfil_id is null);

create policy alimentos_mios on alimentos
  for all to authenticated
  using (perfil_id = mi_perfil() or es_gestor())
  with check (perfil_id = mi_perfil() or es_gestor());

create policy alimentos_catalogo_ver on alimentos
  for select to authenticated using (perfil_id is null);

-- Comprobación tras aplicar: toda tabla debe salir con rowsecurity = true y
-- al menos una política. En 0 políticas la tabla está muda (fallo seguro);
-- con RLS desactivada sería el fallo peligroso.
--   select c.relname, c.relrowsecurity, count(p.polname)
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--     left join pg_policy p on p.polrelid = c.oid
--    where n.nspname='public' and c.relkind='r' group by 1,2 order by 1;
