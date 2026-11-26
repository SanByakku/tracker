-- TRACKER XLIV · 005 isométricos y vistas finales · 26/11/2026
--
-- En los isométricos (Wall sit de Amara) la columna REPS lleva tiempo:
-- "90s", "2 min". Es como debe apuntarse. Sin tratarlo, 40 kg x 90 s entraba
-- al tonelaje como si fueran 90 repeticiones.
-- dur_seg() lo reconoce como duración y reps_num() devuelve nulo: no suma
-- tonelaje, pero el tiempo queda guardado porque es la progresión del
-- ejercicio.

create or replace function dur_seg(t text)
returns numeric language sql immutable as $q$
  select case
    when t is null then null
    when t ~* '^\s*\d+(?:[.,]\d+)?\s*(s|seg|segs|segundos?)\s*$'
      then replace((regexp_match(t, '\d+(?:[.,]\d+)?'))[1], ',', '.')::numeric
    when t ~* '^\s*\d+(?:[.,]\d+)?\s*(m|min|mins|minutos?)\s*$'
      then replace((regexp_match(t, '\d+(?:[.,]\d+)?'))[1], ',', '.')::numeric * 60
    else null end;
$q$;

create or replace function reps_num(t text)
returns numeric language plpgsql immutable as $q$
declare limpio text; a numeric; b numeric; total numeric;
begin
  if t is null then return null; end if;
  if dur_seg(t) is not null then return null; end if;
  limpio := regexp_replace(t, '\(.*?\)', '', 'g');
  if limpio ~* '^\s*\d+\s*x\s*\d+\s*$' then
    a := (regexp_match(limpio, '^\s*(\d+)'))[1]::numeric;
    b := (regexp_match(limpio, 'x\s*(\d+)\s*$', 'i'))[1]::numeric;
    return a * b;
  end if;
  select sum(replace(m[1], ',', '.')::numeric) into total
    from regexp_matches(limpio, '\d+(?:[.,]\d+)?', 'g') as m;
  return total;
end;
$q$;

drop view if exists v_estancamiento, v_adherencia, v_records,
                    v_progresion, v_tonelaje_bloque, v_series cascade;

create view v_series as
select s.id, s.perfil_id, se.id as sesion_id, se.ciclo, se.fecha,
  d.id as dia_id, d.nombre as dia, r.id as rutina_id, r.nombre as rutina,
  e.bloque,
  coalesce(s.ejercicio_alt, e.nombre) as ejercicio,
  e.nombre as ejercicio_rutina,
  s.ejercicio_alt is not null as es_alternativo,
  sp.aproximacion, sp.tecnica,
  s.peso, s.peso_texto, s.reps,
  reps_num(s.reps) as reps_n,
  dur_seg(s.reps)  as segundos,
  s.rir, rir_num(s.rir) as rir_n, s.ajuste, s.auto,
  case when s.peso is not null then s.peso * reps_num(s.reps) end as tonelaje,
  (rir_num(s.rir) is not null and rir_num(s.rir) <= 3
   and not coalesce(sp.aproximacion,false)) as efectiva,
  (se.gimnasio_libre is null and (se.gimnasio_id is null or g.habitual)) as habitual,
  coalesce(g.nombre, se.gimnasio_libre) as gimnasio,
  s.registrada_en
from series s
join sesiones se on se.id = s.sesion_id
join dias d on d.id = se.dia_id
join rutinas r on r.id = d.rutina_id
left join series_prescritas sp on sp.id = s.serie_prescrita_id
left join ejercicios e on e.id = sp.ejercicio_id
left join gimnasios g on g.id = se.gimnasio_id;

create view v_tonelaje_bloque as
select perfil_id, rutina_id, ciclo, dia_id, dia, bloque,
  count(*) as series, count(*) filter (where efectiva) as series_efectivas,
  sum(tonelaje) as tonelaje, min(fecha) as fecha
from v_series group by perfil_id, rutina_id, ciclo, dia_id, dia, bloque;

create view v_progresion as
select perfil_id, rutina_id, ejercicio, es_alternativo, ciclo,
  min(fecha) as fecha, bool_and(habitual) as todo_habitual,
  count(*) as series, sum(tonelaje) as tonelaje, max(peso) as peso_max,
  max(segundos) as segundos_max,
  avg(peso) filter (where not coalesce(aproximacion,false)) as peso_medio,
  avg(rir_n) as rir_medio
from v_series group by perfil_id, rutina_id, ejercicio, es_alternativo, ciclo;

create view v_records as
select distinct on (perfil_id, ejercicio)
  perfil_id, ejercicio, peso as peso_record, reps_n as reps_record, rir, fecha, ciclo,
  round(peso * (1 + reps_n / 30.0), 1) as rm_estimado
from v_series
where habitual and not es_alternativo and not coalesce(aproximacion,false)
  and peso is not null and reps_n is not null
order by perfil_id, ejercicio, peso desc, reps_n desc, fecha;

create view v_adherencia as
select perfil_id, date_trunc('week', fecha)::date as semana,
  count(distinct sesion_id) as sesiones, sum(tonelaje) as tonelaje,
  count(*) filter (where efectiva) as series_efectivas, max(fecha) as ultima
from v_series where fecha is not null
group by perfil_id, date_trunc('week', fecha);

create view v_estancamiento as
with mejor as (
  select perfil_id, ejercicio, ciclo, max(peso_max) as peso
    from v_progresion where not es_alternativo and todo_habitual
   group by perfil_id, ejercicio, ciclo),
cumbre as (
  select perfil_id, ejercicio, max(peso) as techo, max(ciclo) as ultimo_ciclo
    from mejor group by perfil_id, ejercicio),
cuando as (
  select m.perfil_id, m.ejercicio, max(m.ciclo) as ciclo_techo
    from mejor m join cumbre c
      on c.perfil_id=m.perfil_id and c.ejercicio=m.ejercicio and m.peso=c.techo
   group by m.perfil_id, m.ejercicio)
select c.perfil_id, c.ejercicio, c.techo, w.ciclo_techo, c.ultimo_ciclo,
       c.ultimo_ciclo - w.ciclo_techo as ciclos_sin_subir
  from cumbre c join cuando w
    on w.perfil_id=c.perfil_id and w.ejercicio=c.ejercicio
 where c.ultimo_ciclo - w.ciclo_techo >= 3;

alter view v_series          set (security_invoker = on);
alter view v_tonelaje_bloque set (security_invoker = on);
alter view v_progresion      set (security_invoker = on);
alter view v_records         set (security_invoker = on);
alter view v_adherencia      set (security_invoker = on);
alter view v_estancamiento   set (security_invoker = on);
