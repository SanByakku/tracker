#!/usr/bin/env python3
"""
hoja_a_sql.py — importa una pestaña de entreno de Sheets a SQL de Supabase.

Uso:
  python hoja_a_sql.py <spreadsheet_id> <nombre_pestana> <perfil_id> <rutina_id> <dia_id> \
                       --ciclo N [--gimnasio-habitual <gimnasio_id>] [--out fichero.sql]

  python hoja_a_sql.py --ayuda

Requisitos:
  pip install google-auth google-auth-httplib2 google-api-python-client

Credenciales:
  Variable de entorno GOOGLE_SERVICE_ACCOUNT_JSON con la ruta al JSON de la
  cuenta de servicio, o GOOGLE_APPLICATION_CREDENTIALS (ADC).
  La cuenta debe tener acceso de lectura a la hoja.

Formato esperado en la hoja (el que entiende la app):
  Fila 1: rótulo en A1; «ROLL n» cada 4 columnas desde G (G, K, O, S…)
           La celda a la derecha de cada «ROLL n» guarda «fecha · gimnasio»
  Fila 2: cabeceras Ejercicio, Config, Reps, RIR, Descanso, Notas y, por cada
           ROLL, PESO, REPS, RIR, AJUSTE
  Filas 3+: fila de bloque (solo col A) o fila de serie
  Nombre del ejercicio solo en su primera serie; las demás lo heredan.
"""

import argparse
import json
import os
import re
import sys
import uuid
from datetime import datetime

# ---------------------------------------------------------------------------
# Parseo de valores de celda (misma lógica que las funciones SQL)
# ---------------------------------------------------------------------------

MESES_ES = {
    'ene': 1, 'feb': 2, 'mar': 3, 'abr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'ago': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dic': 12,
}

def parsear_fecha_roll(texto: str, anio: int | None = None) -> str | None:
    """«26NOV» o «26NOV · FP» → «2026-11-26». Sin año usa el actual."""
    if not texto:
        return None
    parte = texto.split('·')[0].strip()
    m = re.match(r'^(\d{1,2})([A-Za-záéíóú]{3})', parte)
    if not m:
        return None
    dia_n = int(m.group(1))
    mes_s = m.group(2).lower()[:3]
    mes_n = MESES_ES.get(mes_s)
    if not mes_n:
        return None
    if anio is None:
        anio = datetime.today().year
    return f'{anio:04d}-{mes_n:02d}-{dia_n:02d}'

def parsear_gimnasio(texto: str) -> str | None:
    """«26NOV · FP» → «FP». Nulo si no hay nombre."""
    if not texto or '·' not in texto:
        return None
    parte = texto.split('·', 1)[1].strip()
    return parte if parte else None

def es_duracion(texto: str) -> bool:
    """True si el texto es tiempo: «90s», «2min», etc."""
    if not texto:
        return False
    return bool(re.match(r'^\s*\d+(?:[.,]\d+)?\s*(s|seg|segs|segundos?|m|min|mins|minutos?)\s*$',
                         texto, re.IGNORECASE))

def es_numero(texto: str) -> bool:
    if not texto:
        return False
    return bool(re.match(r'^-?\d+([.,]\d+)?$', texto.strip()))

def sql_literal(v) -> str:
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"

def gen_uuid() -> str:
    return str(uuid.uuid4())

# ---------------------------------------------------------------------------
# Lectura de la hoja
# ---------------------------------------------------------------------------

def obtener_hoja(spreadsheet_id: str, nombre_pestana: str) -> list[list[str]]:
    try:
        import googleapiclient.discovery as disco
        import google.auth
    except ImportError:
        sys.exit('Faltan dependencias. Ejecuta: pip install google-auth google-auth-httplib2 google-api-python-client')

    sa_path = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON')
    if sa_path:
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_file(
            sa_path, scopes=['https://www.googleapis.com/auth/spreadsheets.readonly'])
    else:
        creds, _ = google.auth.default(
            scopes=['https://www.googleapis.com/auth/spreadsheets.readonly'])

    service = disco.build('sheets', 'v4', credentials=creds, cache_discovery=False)
    rango = f"'{nombre_pestana}'"
    resp = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=rango,
        valueRenderOption='UNFORMATTED_VALUE').execute()
    filas = resp.get('values', [])
    # Normaliza: todas las filas tienen la misma longitud
    ancho = max((len(f) for f in filas), default=0)
    return [f + [''] * (ancho - len(f)) for f in filas]

# ---------------------------------------------------------------------------
# Interpretación del formato de hoja
# ---------------------------------------------------------------------------

COL_EJERCICIO = 0  # A
COL_CONFIG    = 1  # B
COL_REPS      = 2  # C
COL_RIR       = 3  # D
COL_DESCANSO  = 4  # E
COL_NOTAS     = 5  # F
COL_ROLL_1    = 6  # G  (primer ROLL; los demás cada 4 columnas)
COLS_POR_ROLL = 4  # PESO, REPS, RIR, AJUSTE

def columnas_roll(n_roll: int) -> tuple[int, int, int, int]:
    """Índices (peso, reps, rir, ajuste) del ROLL n (base 1)."""
    base = COL_ROLL_1 + (n_roll - 1) * COLS_POR_ROLL
    return base, base + 1, base + 2, base + 3

def detectar_rolls(fila1: list[str]) -> list[int]:
    """Devuelve los índices de columna donde hay una cabecera «ROLL n»."""
    rolls = []
    for i, v in enumerate(fila1):
        if re.match(r'^ROLL\s*\d+$', str(v).strip(), re.IGNORECASE):
            rolls.append(i)
    return rolls

def parsear_pestana(filas: list[list[str]], num_rolls: int | None = None) -> dict:
    """
    Devuelve:
      {
        'rolls': [{'fecha': ..., 'gimnasio': ..., 'series': [{...}, ...]}, ...],
        'ejercicios': [{nombre, config, reps, rir, descanso, notas, bloque, series_prescritas}]
      }
    """
    if len(filas) < 2:
        return {'rolls': [], 'ejercicios': []}

    fila1 = filas[0]
    # fila2 = filas[1]  # cabeceras, no se leen

    # Detectar cuántos ROLLs hay
    indices_roll = detectar_rolls(fila1)
    if not indices_roll:
        sys.exit('No se encontraron cabeceras ROLL n en la fila 1.')
    n_rolls = num_rolls or len(indices_roll)

    # Cabecera de cada ROLL: celda a la derecha del «ROLL n»
    info_rolls = []
    for col_roll in indices_roll[:n_rolls]:
        cel = str(fila1[col_roll + 1]) if col_roll + 1 < len(fila1) else ''
        info_rolls.append({
            'fecha':    parsear_fecha_roll(cel),
            'gimnasio': parsear_gimnasio(cel),
            'series':   [],  # se rellena abajo
        })

    ejercicios = []
    bloque_actual = None
    aviso_actual  = None
    nombre_actual = None

    for fila in filas[2:]:
        cel_a = str(fila[COL_EJERCICIO]).strip() if len(fila) > COL_EJERCICIO else ''

        # Fila de bloque: solo col A, resto vacío en la zona de prescripción
        zona_presc = fila[COL_CONFIG:COL_ROLL_1]
        if cel_a and all(str(c).strip() == '' for c in zona_presc):
            # Puede llevar aviso tras guion largo
            if ' — ' in cel_a or ' – ' in cel_a or ' - ' in cel_a:
                sep = re.split(r' [—–-] ', cel_a, maxsplit=1)
                bloque_actual = sep[0].strip()
                aviso_actual  = sep[1].strip() if len(sep) > 1 else None
            else:
                bloque_actual = cel_a
                aviso_actual  = None
            nombre_actual = None
            continue

        # Fila de serie
        nombre_fila = cel_a
        if nombre_fila:
            nombre_actual = nombre_fila
        if nombre_actual is None:
            continue  # fila vacía antes del primer ejercicio

        config   = str(fila[COL_CONFIG]).strip()   if len(fila) > COL_CONFIG   else ''
        reps_p   = str(fila[COL_REPS]).strip()     if len(fila) > COL_REPS     else ''
        rir_p    = str(fila[COL_RIR]).strip()       if len(fila) > COL_RIR      else ''
        descanso = str(fila[COL_DESCANSO]).strip()  if len(fila) > COL_DESCANSO else ''
        notas    = str(fila[COL_NOTAS]).strip()     if len(fila) > COL_NOTAS    else ''

        # Detectar si esta es la primera serie del ejercicio (el nombre aparece)
        es_primera = bool(nombre_fila)

        # Buscar el ejercicio en la lista o crear uno nuevo
        if es_primera or not ejercicios:
            ejercicio = {
                'nombre':  nombre_actual,
                'config':  config  or None,
                'bloque':  bloque_actual,
                'aviso':   aviso_actual,
                'series_prescritas': [],
            }
            ejercicios.append(ejercicio)

        ejercicio = ejercicios[-1]

        # Técnica y notas van por serie (corrección 1 de fase1-estado)
        tecnica_serie = None
        notas_serie   = notas or None
        if reps_p.lower() in ('rp', 'rpp', 'ds'):
            tecnica_serie = reps_p.upper()
            reps_p = ''

        sp = {
            'reps':     reps_p   or None,
            'rir':      rir_p    or None,
            'descanso': int(descanso) if descanso.isdigit() else None,
            'tecnica':  tecnica_serie,
            'notas':    notas_serie,
        }
        ejercicio['series_prescritas'].append(sp)

        # Leer datos de cada ROLL para esta fila
        for n_roll, info in enumerate(info_rolls, start=1):
            col_peso, col_reps, col_rir, col_ajuste = columnas_roll(n_roll)
            peso_raw  = str(fila[col_peso]).strip()   if len(fila) > col_peso  else ''
            reps_raw  = str(fila[col_reps]).strip()   if len(fila) > col_reps  else ''
            rir_raw   = str(fila[col_rir]).strip()    if len(fila) > col_rir   else ''
            ajuste    = str(fila[col_ajuste]).strip() if len(fila) > col_ajuste else ''

            # Solo generar serie si hay algo
            if not any([peso_raw, reps_raw, rir_raw, ajuste]):
                continue

            # PESO: solo número va a peso; lo demás a peso_texto (corrección 2)
            peso_num   = None
            peso_texto = None
            if peso_raw:
                if es_numero(peso_raw):
                    peso_num = float(peso_raw.replace(',', '.'))
                else:
                    peso_texto = peso_raw

            # Ejercicio alternativo: «cambio: Variante»
            ejercicio_alt = None
            if ajuste and ajuste.lower().startswith('cambio:'):
                ejercicio_alt = ajuste.split(':', 1)[1].strip()

            serie_datos = {
                'peso':          peso_num,
                'peso_texto':    peso_texto,
                'reps':          reps_raw  or None,
                'rir':           rir_raw   or None,
                'ajuste':        ajuste    or None,
                'ejercicio_alt': ejercicio_alt,
                # índice de serie prescrita en este ejercicio (base 0)
                'sp_idx': len(ejercicio['series_prescritas']) - 1,
                # índice del ejercicio en la lista
                'ej_idx': len(ejercicios) - 1,
            }
            info['series'].append(serie_datos)

    return {'rolls': info_rolls, 'ejercicios': ejercicios}

# ---------------------------------------------------------------------------
# Generación de SQL
# ---------------------------------------------------------------------------

def generar_sql(datos: dict, perfil_id: str, rutina_id: str, dia_id: str,
                ciclo_base: int, gimnasio_habitual_id: str | None) -> list[str]:
    """
    Genera INSERT INTO ... para:
      ejercicios, series_prescritas  (prescripción, una vez)
      sesiones, series               (una sesion + sus series por cada ROLL con datos)
    """
    stmts = []
    rolls = datos['rolls']
    ejercicios = datos['ejercicios']

    # IDs de ejercicios y series_prescritas (referenciados desde las sesiones)
    ej_ids = []
    sp_ids_por_ej = []  # sp_ids_por_ej[i][j] = id de la j-ésima serie del ejercicio i

    stmts.append('-- ejercicios y series prescritas')
    for orden_ej, ej in enumerate(ejercicios, start=1):
        ej_id = gen_uuid()
        ej_ids.append(ej_id)
        stmts.append(
            f"INSERT INTO ejercicios (id, dia_id, perfil_id, orden, bloque, aviso, nombre, config) VALUES ("
            f"{sql_literal(ej_id)}, {sql_literal(dia_id)}, {sql_literal(perfil_id)}, "
            f"{orden_ej}, {sql_literal(ej.get('bloque'))}, {sql_literal(ej.get('aviso'))}, "
            f"{sql_literal(ej['nombre'])}, {sql_literal(ej.get('config'))});"
        )
        sp_ids = []
        for orden_sp, sp in enumerate(ej['series_prescritas'], start=1):
            sp_id = gen_uuid()
            sp_ids.append(sp_id)
            stmts.append(
                f"INSERT INTO series_prescritas "
                f"(id, ejercicio_id, perfil_id, orden, reps, rir, descanso, tecnica, notas) VALUES ("
                f"{sql_literal(sp_id)}, {sql_literal(ej_id)}, {sql_literal(perfil_id)}, "
                f"{orden_sp}, {sql_literal(sp.get('reps'))}, {sql_literal(sp.get('rir'))}, "
                f"{sql_literal(sp.get('descanso'))}, {sql_literal(sp.get('tecnica'))}, "
                f"{sql_literal(sp.get('notas'))});"
            )
        sp_ids_por_ej.append(sp_ids)

    # Sesiones y series por ROLL
    stmts.append('')
    stmts.append('-- sesiones y series registradas')
    for n_roll, roll in enumerate(rolls, start=1):
        ciclo = ciclo_base + n_roll - 1
        series_roll = roll.get('series', [])

        # Un ROLL sin ninguna serie no es una sesión (puede tener fecha pero
        # Diego no llegó a entrenar, caso LEG 1 25NOV)
        if not series_roll:
            stmts.append(f'-- ROLL {n_roll}: sin series, se omite la sesión')
            continue

        sesion_id = gen_uuid()

        # Gimnasio
        gym_literal = 'NULL'
        gym_libre   = 'NULL'
        nombre_gym  = roll.get('gimnasio')
        if nombre_gym:
            # Será el gestor quien sepa si es habitual o libre; aquí usamos gimnasio_libre
            # a menos que se pase --gimnasio-habitual y el roll no tiene nombre propio
            gym_libre = sql_literal(nombre_gym)
        elif gimnasio_habitual_id:
            gym_literal = sql_literal(gimnasio_habitual_id)

        stmts.append(
            f"INSERT INTO sesiones (id, perfil_id, dia_id, ciclo, fecha, gimnasio_id, gimnasio_libre) VALUES ("
            f"{sql_literal(sesion_id)}, {sql_literal(perfil_id)}, {sql_literal(dia_id)}, "
            f"{ciclo}, {sql_literal(roll.get('fecha'))}, {gym_literal}, {gym_libre});"
        )

        for orden_s, s in enumerate(series_roll, start=1):
            sp_id = None
            ej_idx = s.get('ej_idx')
            sp_idx = s.get('sp_idx')
            if ej_idx is not None and sp_idx is not None:
                if ej_idx < len(sp_ids_por_ej) and sp_idx < len(sp_ids_por_ej[ej_idx]):
                    sp_id = sp_ids_por_ej[ej_idx][sp_idx]

            stmts.append(
                f"INSERT INTO series "
                f"(id, sesion_id, serie_prescrita_id, perfil_id, orden, "
                f"peso, peso_texto, reps, rir, ajuste, ejercicio_alt) VALUES ("
                f"{sql_literal(gen_uuid())}, {sql_literal(sesion_id)}, {sql_literal(sp_id)}, "
                f"{sql_literal(perfil_id)}, {orden_s}, "
                f"{sql_literal(s.get('peso'))}, {sql_literal(s.get('peso_texto'))}, "
                f"{sql_literal(s.get('reps'))}, {sql_literal(s.get('rir'))}, "
                f"{sql_literal(s.get('ajuste'))}, {sql_literal(s.get('ejercicio_alt'))});"
            )

    return stmts

# ---------------------------------------------------------------------------
# Entrada principal
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(
        description='Importa una pestaña de entreno de Sheets a SQL de Supabase.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
        add_help=False,
    )
    p.add_argument('spreadsheet_id',   nargs='?')
    p.add_argument('nombre_pestana',   nargs='?')
    p.add_argument('perfil_id',        nargs='?')
    p.add_argument('rutina_id',        nargs='?')
    p.add_argument('dia_id',           nargs='?')
    p.add_argument('--ciclo',          type=int, default=1,
                   help='Ciclo del primer ROLL (por defecto 1)')
    p.add_argument('--gimnasio-habitual', dest='gimnasio_habitual_id',
                   help='UUID del gimnasio habitual (para ROLLs sin nombre de gym)')
    p.add_argument('--anio',           type=int, default=None,
                   help='Año para parsear las fechas (por defecto el actual)')
    p.add_argument('--out',            help='Fichero de salida (por defecto stdout)')
    p.add_argument('--dry-run',        action='store_true',
                   help='Solo parsea la hoja y muestra el resumen, no genera SQL')
    p.add_argument('--ayuda', '-h',    action='help',
                   help='Muestra esta ayuda')
    args = p.parse_args()

    for attr in ('spreadsheet_id', 'nombre_pestana', 'perfil_id', 'rutina_id', 'dia_id'):
        if not getattr(args, attr):
            p.error(f'Falta el argumento: {attr}')

    print(f'Leyendo «{args.nombre_pestana}» de {args.spreadsheet_id}…', file=sys.stderr)
    filas = obtener_hoja(args.spreadsheet_id, args.nombre_pestana)
    print(f'  {len(filas)} filas leídas.', file=sys.stderr)

    datos = parsear_pestana(filas)
    rolls  = datos['rolls']
    ejercicios = datos['ejercicios']

    # Resumen de lo que se va a importar
    n_sp = sum(len(e['series_prescritas']) for e in ejercicios)
    rolls_con_datos = [r for r in rolls if r['series']]
    print(f'  {len(ejercicios)} ejercicios, {n_sp} series prescritas.', file=sys.stderr)
    print(f'  {len(rolls)} ROLLs detectados, {len(rolls_con_datos)} con series.', file=sys.stderr)
    for i, r in enumerate(rolls, 1):
        fecha = r['fecha'] or '(sin fecha)'
        gym   = r['gimnasio'] or '(habitual)'
        ns    = len(r['series'])
        print(f'    ROLL {i}: {fecha}  gym={gym}  {ns} series', file=sys.stderr)

    if args.dry_run:
        return

    stmts = generar_sql(datos, args.perfil_id, args.rutina_id, args.dia_id,
                        args.ciclo, args.gimnasio_habitual_id)

    salida = '\n'.join(stmts)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(salida + '\n')
        print(f'SQL escrito en {args.out}', file=sys.stderr)
    else:
        print(salida)


if __name__ == '__main__':
    main()
