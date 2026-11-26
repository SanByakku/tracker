# Supabase — migración del tracker

Estado a 26/11/2026. Contexto completo en el proyecto **APP Asesorías**:
`claude/supabase/plan-migracion.md`, `fase1-estado.md`, `proyectos.md` y
`plan-claude-code.md`.

## Proyectos

| | Referencia | URL de la API |
|---|---|---|
| Producción | `bjtokucrstzalmqctuvb` | `https://bjtokucrstzalmqctuvb.supabase.co` |
| Beta | `qxdbycfsnkjtoczbjkdv` | `https://qxdbycfsnkjtoczbjkdv.supabase.co` |

Claves publicables (públicas por diseño, van en el código de la app) en
`claude/supabase/proyectos.md`. La clave secreta y la contraseña de la base
**no están aquí ni deben estarlo**: este repositorio es público.

## Aplicar

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/001_esquema.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/002_reglas.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/003_vistas.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/004_correcciones.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f migrations/005_duraciones.sql
```

`SUPABASE_DB_URL` sale del botón **Connect** del panel (Session pooler),
guardada como variable de entorno. Nunca en un fichero del repositorio.

Las cinco están aplicadas en **beta**. En **producción** no se ha tocado
nada todavía.

## Orden y por qué hay correcciones

001-003 son el esquema de partida. 004 y 005 corrigen cosas que solo se
vieron al importar la hoja real:

- **004**: la técnica va por serie y no por ejercicio; el RIR registrado
  admite texto (`RP`, `DS`); las opciones de dieta necesitan etiqueta.
- **005**: en los isométricos la columna REPS lleva tiempo (`90s`, `2 min`),
  que no son repeticiones y no deben sumar tonelaje, pero sí son la
  progresión del ejercicio.

Se han dejado como migraciones sucesivas, no refundidas, porque aplicarlas
en orden reproduce exactamente el estado de beta y eso es comprobable.

## Comprobación tras aplicar

```sql
-- 15 tablas, las 15 con RLS, ninguna sin política
select count(*) filter (where c.relrowsecurity) as con_rls, count(*) as tablas
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r';

-- parseo
select t, reps_num(t), rir_num(t), dur_seg(t)
  from unnest(array['12','12+2','4x30','8+3','10+6+6','90s','2 min','RP','DS','-']) as t;
```

## Carpetas

- `migrations/` — esquema, reglas y vistas. Lo de arriba.
- `seed/` — volcados de datos (rutinas, dietas). Vacío: hasta ahora la
  importación se ha hecho a mano desde el editor SQL del panel.
- `importar/` — el importador de hojas, por escribir. Ver
  `claude/supabase/plan-claude-code.md` para las reglas de parseo que ya se
  han aprendido pestaña a pestaña.

## Lo que NO hay que hacer todavía

- Tocar la app en producción: sigue en Sheets y funciona.
- Configurar la entrada con Google hasta tener los datos completos.
