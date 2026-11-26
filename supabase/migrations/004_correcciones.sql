-- TRACKER XLIV · 004 correcciones tras ver la hoja real · 26/11/2026
--
-- Tres cosas que el esquema de papel no recogía y que solo se ven mirando
-- los datos de verdad:
--
-- 1. La técnica va POR SERIE, no por ejercicio. En PULL 1, "rest pause" está
--    en la fila de la serie 2 de Remo en punta unilateral, no en el
--    ejercicio entero.
-- 2. El RIR registrado ADMITE TEXTO. La LEYENDA ya lo decía ("Morado:
--    FALLO, RP, RPP o DS"). Guardarlo como número perdía justamente las
--    series que más importan.
-- 3. Las opciones de dieta necesitan etiqueta ("Proteína ISO = 30 g ...") y
--    el catálogo necesita alias ("crema de arroz; harina de arroz").

alter table series_prescritas add column if not exists tecnica text;
alter table series_prescritas add column if not exists notas   text;
alter table items             add column if not exists etiqueta text;
alter table alimentos         add column if not exists alias    text[];

-- Hay que tirar las vistas antes de cambiar el tipo de la columna.
drop view if exists v_estancamiento, v_adherencia, v_records,
                    v_progresion, v_tonelaje_bloque, v_series cascade;

alter table series alter column rir type text using rir::text;

-- RIR en número. Las técnicas al fallo cuentan como RIR 0, que es lo que son.
create or replace function rir_num(t text)
returns numeric language sql immutable as $q$
  select case
    when t is null or btrim(t) = '' then null
    when upper(btrim(t)) in ('RP','RPP','DS','F','FALLO') then 0
    when btrim(replace(t, ',', '.')) ~ '^[0-9]+(\.[0-9]+)?$'
      then btrim(replace(t, ',', '.'))::numeric
    else null end;
$q$;

-- Las vistas se recrean en 005, que es el estado final.
