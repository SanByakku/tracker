/* ============================================================
   TRACKER XLIV — adaptador de datos a Supabase
   26/11/2026 · solo canal beta
   ------------------------------------------------------------
   La app habla en filas y columnas de hoja de cálculo. La base habla de
   sesiones y series. Este fichero traduce entre los dos, de forma que para
   la app no cambia nada: sigue llamando a llama({action:...}) y sigue
   recibiendo matrices.

   La rejilla que se genera aquí NO tiene por qué coincidir con la de la
   hoja real: basta con que sea coherente entre lo que se entrega al leer y
   lo que se interpreta al escribir. El orden sale de bloque > ejercicio >
   serie, que ya está en la base.

   Perfiles servidos desde Supabase: los de PERFILES_SB. El resto siguen
   yendo contra Apps Script, intactos.
   ============================================================ */
(function(){
  'use strict';

  var URL_SB = 'https://qxdbycfsnkjtoczbjkdv.supabase.co';
  var KEY_SB = 'sb_publishable_1Qt7Jf6OBlyBbyl5olGwrw_8V56PJKA';
  var NROLLS = 12;                       // mismos ROLL que la hoja
  var PERFILES_SB = ['diegoalviterodriguez@gmail.com'];
  var SESK = 'trackerb.sb.sesion.v1';

  /* ---------- sesión ---------- */
  var ses = null;
  try { ses = JSON.parse(localStorage.getItem(SESK) || 'null'); } catch (e) {}
  function guardaSes(s){
    ses = s;
    try {
      if (s) localStorage.setItem(SESK, JSON.stringify(s));
      else localStorage.removeItem(SESK);
    } catch (e) {}
  }

  function cab(extra){
    var h = { 'apikey': KEY_SB, 'Content-Type': 'application/json' };
    if (ses && ses.access_token) h['Authorization'] = 'Bearer ' + ses.access_token;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  async function rest(ruta, opts){
    opts = opts || {};
    var r = await fetch(URL_SB + ruta, {
      method: opts.method || 'GET',
      headers: cab(opts.headers),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (r.status === 401 && ses) {          // sesión caducada: renovar
      if (await renueva()) return rest(ruta, opts);
      guardaSes(null);
      throw new Error('la sesión ya no es válida: vuelve a entrar');
    }
    if (!r.ok) {
      var t = '';
      try { t = (await r.json()).message || ''; } catch (e) {}
      throw new Error('base de datos: ' + (t || ('HTTP ' + r.status)));
    }
    if (r.status === 204) return null;
    return r.json();
  }

  async function renueva(){
    if (!ses || !ses.refresh_token) return false;
    try {
      var r = await fetch(URL_SB + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'apikey': KEY_SB, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: ses.refresh_token })
      });
      if (!r.ok) return false;
      guardaSes(await r.json());
      return true;
    } catch (e) { return false; }
  }

  /* El id_token de Google trae el nonce dentro; la app lo comprueba. */
  function nonceDe(idt){
    try {
      var p = idt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      return (JSON.parse(decodeURIComponent(escape(atob(p)))) || {}).nonce || '';
    } catch (e) { return ''; }
  }

  async function entraGoogle(idt){
    var cuerpo = { provider: 'google', id_token: idt };
    var n = nonceDe(idt);
    var r = await fetch(URL_SB + '/auth/v1/token?grant_type=id_token', {
      method: 'POST',
      headers: { 'apikey': KEY_SB, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    });
    if (!r.ok) {
      var t = '';
      try { t = (await r.json()).error_description || (await r.json()).msg || ''; } catch (e) {}
      throw new Error('Supabase rechazó la entrada con Google' + (t ? ': ' + t : ''));
    }
    guardaSes(await r.json());
    return { session: 'sb', nonce: n };
  }

  /* ---------- caché de la rutina ---------- */
  var cache = {};                          // perfil_id -> {dias, porDia, gimnasios}

  function limpia(){ cache = {}; }

  async function perfilDe(correo){
    var l = await rest('/rest/v1/perfiles?select=id,nombre,correo,sexo,servicio,gestor'
                     + '&correo=eq.' + encodeURIComponent(correo));
    return (l && l[0]) || null;
  }

  async function cargaRutina(pid){
    if (cache[pid]) return cache[pid];
    var sel = 'id,nombre,orden,es_descanso,'
            + 'ejercicios(id,orden,bloque,aviso,nombre,config,'
            + 'series_prescritas(id,orden,reps,rir,descanso,notas))';
    var dias = await rest('/rest/v1/dias?select=' + encodeURIComponent(sel)
                        + '&perfil_id=eq.' + pid
                        + '&order=orden.asc');
    var gim = await rest('/rest/v1/gimnasios?select=id,nombre,habitual,orden'
                        + '&perfil_id=eq.' + pid + '&order=orden.asc');
    var ses_ = await rest('/rest/v1/sesiones?select=id,dia_id,ciclo,fecha,gimnasio_id,gimnasio_libre,'
                        + 'series(id,serie_prescrita_id,peso,peso_texto,reps,rir,ajuste)'
                        + '&perfil_id=eq.' + pid);
    var c = { dias: dias || [], gimnasios: gim || [], sesiones: ses_ || [] };
    cache[pid] = c;
    return c;
  }

  /* ---------- construcción de la rejilla ---------- */
  var descTxt = function(s){
    if (s == null) return '';
    if (s % 60 === 0) return (s / 60) + ' min';
    return s + ' s';
  };

  /* Devuelve {filas, mapa} — mapa[indiceDeFila] = id de la serie prescrita */
  function rejilla(c, dia){
    var filas = [], mapa = {};
    var gimHab = (c.gimnasios.filter(function(g){ return g.habitual; })[0] || {}).nombre || '';

    // fila 0: banner y cabeceras ROLL
    var r0 = [dia.nombre, '', '', '', '', ''];
    for (var n = 1; n <= NROLLS; n++) {
      var s = c.sesiones.filter(function(x){ return x.dia_id === dia.id && x.ciclo === n; })[0];
      var et = '';
      if (s && s.fecha) {
        et = fechaTxt(s.fecha);
        var g = s.gimnasio_libre
              || (c.gimnasios.filter(function(x){ return x.id === s.gimnasio_id; })[0] || {}).nombre
              || '';
        if (g && g !== gimHab) et += ' · ' + g;
        else if (g) et += ' · ' + g;
      }
      r0.push('ROLL ' + n, et, '', '');
    }
    filas.push(r0);

    // fila 1: cabeceras
    var r1 = ['Ejercicio', 'Config', 'Reps', 'RIR', 'Descanso', 'Notas'];
    for (var k = 1; k <= NROLLS; k++) r1.push('PESO', 'REPS', 'RIR', 'AJUSTE');
    filas.push(r1);

    // filas de bloque y de serie
    var ejs = (dia.ejercicios || []).slice().sort(function(a, b){ return a.orden - b.orden; });
    var bloqueActual = null;
    ejs.forEach(function(e){
      if (e.bloque && e.bloque !== bloqueActual) {
        bloqueActual = e.bloque;
        var tit = e.aviso ? (e.bloque + ' — ' + e.aviso) : e.bloque;
        filas.push([tit, '', '', '', '', '']);
      }
      var sp = (e.series_prescritas || []).slice().sort(function(a, b){ return a.orden - b.orden; });
      sp.forEach(function(s, i){
        var fila = [
          i === 0 ? e.nombre : '',
          i === 0 ? (e.config || '') : '',
          s.reps || '', s.rir || '', descTxt(s.descanso), s.notas || ''
        ];
        for (var n2 = 1; n2 <= NROLLS; n2++) {
          var sesion = c.sesiones.filter(function(x){ return x.dia_id === dia.id && x.ciclo === n2; })[0];
          var reg = sesion && (sesion.series || []).filter(function(x){
            return x.serie_prescrita_id === s.id; })[0];
          if (reg) {
            var peso = reg.peso_texto != null && reg.peso_texto !== ''
                     ? reg.peso_texto
                     : (reg.peso == null ? '' : Number(reg.peso));
            fila.push(peso, reg.reps || '', reg.rir || '', reg.ajuste || '');
          } else fila.push('', '', '', '');
        }
        mapa[filas.length] = { id: s.id, orden: s.orden };   // índice 0-based
        filas.push(fila);
      });
    });
    return { filas: filas, mapa: mapa };
  }

  var MES = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  function fechaTxt(iso){
    var p = String(iso).split('-');
    if (p.length < 3) return String(iso);
    return String(parseInt(p[2], 10)) + MES[parseInt(p[1], 10) - 1];
  }
  function fechaIso(txt){
    var m = String(txt || '').trim().match(/^(\d{1,2})([A-ZÁÉÍÓÚ]{3})/i);
    if (!m) return null;
    var mes = MES.indexOf(m[2].toUpperCase());
    if (mes < 0) return null;
    var hoy = new Date(), y = hoy.getFullYear();
    var d = new Date(y, mes, parseInt(m[1], 10));
    if (d.getTime() > hoy.getTime() + 86400000) y--;
    return y + '-' + String(mes + 1).padStart(2, '0') + '-' + String(parseInt(m[1], 10)).padStart(2, '0');
  }

  function leyenda(c){
    var sp = c.dias.map(function(d, i){
      return 'D' + (i + 1) + ' ' + (d.es_descanso ? 'descanso' : d.nombre);
    }).join(' · ');
    var gs = c.gimnasios.map(function(g){ return g.nombre; }).join(' · ');
    return [
      ['LEYENDA', ''],
      ['Split', sp],
      ['Gimnasios', gs]
    ];
  }

  window.TRACKER_SB = {
    activo: function(correo){ return PERFILES_SB.indexOf(String(correo || '').toLowerCase()) >= 0; },
    entraGoogle: entraGoogle,
    haySesion: function(){ return !!(ses && ses.access_token); },
    salir: function(){ guardaSes(null); limpia(); },
    limpia: limpia,
    cargaRutina: cargaRutina,
    perfilDe: perfilDe,
    rejilla: rejilla,
    leyenda: leyenda,
    fechaIso: fechaIso,
    rest: rest,
    NROLLS: NROLLS
  };
})();


/* ============================================================
   Enganche: intercepta las peticiones a Apps Script.
   Se hace sobre fetch y NO sobre la función llama() de la app, porque la
   app dispara la entrada con Google en su última línea, antes de que este
   fichero pudiera sustituir nada. Interceptando la red da igual el orden.

   Solo actúa para los perfiles de PERFILES_SB. Para el resto deja pasar la
   petición original y la app funciona exactamente como siempre.
   ============================================================ */
(function(){
  'use strict';
  var SB = window.TRACKER_SB;
  if (!SB) return;

  var ES_SCRIPT = /^https:\/\/script\.google\.com\/macros\//;
  var MODO = 'trackerb.sb.modo.v1';
  var usaSB = false;
  try { usaSB = localStorage.getItem(MODO) === '1'; } catch (e) {}
  function ponModo(v){
    usaSB = !!v;
    try { if (v) localStorage.setItem(MODO, '1'); else localStorage.removeItem(MODO); } catch (e) {}
  }

  function cargaUtil(idt, campo){
    try {
      var p = idt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      return String((JSON.parse(decodeURIComponent(escape(atob(p)))) || {})[campo] || '');
    } catch (e) { return ''; }
  }

  var PERFIL = null;

  async function perfilActivo(){
    if (PERFIL) return PERFIL;
    var u = await SB.rest('/auth/v1/user');
    PERFIL = await SB.perfilDe(String((u && u.email) || '').toLowerCase());
    if (!PERFIL) throw new Error('tu cuenta no está dada de alta en la base');
    return PERFIL;
  }

  function cicloDeCol(col){ return Math.floor((col - 1 - 6) / 4) + 1; }

  async function accion(body){
    var a = body.action;

    if (a === 'perfiles') {
      var p = await perfilActivo();
      var c = await SB.cargaRutina(p.id);
      return { profiles: [{
          id: p.id, name: p.nombre,
          dias: c.dias.filter(function(d){ return !d.es_descanso; }).map(function(d){ return d.nombre; }),
          servicio: p.servicio, sexo: p.sexo || ''
        }], gestor: !!p.gestor };
    }

    if (a === 'load') {
      var p2 = await perfilActivo();
      var c2 = await SB.cargaRutina(p2.id);
      if (/^LEYENDA/i.test(body.day)) return { values: SB.leyenda(c2) };
      var d = c2.dias.filter(function(x){ return x.nombre === body.day; })[0];
      if (!d) throw new Error('no existe el día ' + body.day);
      return { values: SB.rejilla(c2, d).filas };
    }

    if (a === 'todo') {
      var p3 = await perfilActivo();
      SB.limpia();
      var c3 = await SB.cargaRutina(p3.id);
      return { pestanas: c3.dias.filter(function(x){ return !x.es_descanso; }).map(function(d2){
          return { nombre: d2.nombre, filas: SB.rejilla(c3, d2).filas, huella: String(Date.now()) };
        }) };
    }

    if (a === 'dieta') {
      var p4 = await perfilActivo();
      var sel = 'grupo,orden,etiqueta,texto,tipo_dia,comidas!inner(nombre,orden,hora)';
      var it = await SB.rest('/rest/v1/items?select=' + encodeURIComponent(sel)
                           + '&perfil_id=eq.' + p4.id
                           + '&order=' + encodeURIComponent('comidas(orden).asc,grupo.asc,orden.asc'));
      return { rows: (it || []).map(function(x){
        return [x.comidas.nombre, x.comidas.hora || '',
                (x.etiqueta ? x.etiqueta + ' = ' : '') + x.texto,
                x.tipo_dia === 'ambos' ? '' : x.tipo_dia];
      }) };
    }

    if (a === 'write') {
      var p5 = await perfilActivo();
      var c5 = await SB.cargaRutina(p5.id);
      var dia = c5.dias.filter(function(x){ return x.nombre === body.day; })[0];
      if (!dia) throw new Error('no existe el día ' + body.day);
      var ref = SB.rejilla(c5, dia).mapa[body.row - 1];
      if (!ref) throw new Error('fila fuera de la rutina (' + body.row + ')');
      var ciclo = cicloDeCol(body.col);
      if (ciclo < 1 || ciclo > SB.NROLLS) throw new Error('ROLL fuera de rango');

      var gimNom = '', fIso = null;
      if (body.date) {
        var pr = String(body.date).split('·');
        fIso = SB.fechaIso(pr[0]); gimNom = (pr[1] || '').trim();
      }
      var gim = c5.gimnasios.filter(function(g){
        return gimNom && g.nombre.toLowerCase() === gimNom.toLowerCase(); })[0];
      var fila = { perfil_id: p5.id, dia_id: dia.id, ciclo: ciclo };
      if (fIso) fila.fecha = fIso;
      if (gim) fila.gimnasio_id = gim.id;
      else if (gimNom) fila.gimnasio_libre = gimNom;

      var hechas = await SB.rest('/rest/v1/sesiones?on_conflict=' +
          encodeURIComponent('perfil_id,dia_id,ciclo'), {
        method: 'POST', body: [fila],
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } });
      var sid = hechas && hechas[0] && hechas[0].id;
      if (!sid) {
        var q = await SB.rest('/rest/v1/sesiones?select=id&perfil_id=eq.' + p5.id
                            + '&dia_id=eq.' + dia.id + '&ciclo=eq.' + ciclo);
        sid = q && q[0] && q[0].id;
      }
      if (!sid) throw new Error('no se pudo crear la sesión');

      if (body.clear) {
        await SB.rest('/rest/v1/series?sesion_id=eq.' + sid
                    + '&serie_prescrita_id=eq.' + ref.id, { method: 'DELETE' });
        SB.limpia(); return { ok: true };
      }
      var v = body.values || [], pb = v[0];
      var esNum = pb !== '' && pb != null && !isNaN(Number(String(pb).replace(',', '.')));
      await SB.rest('/rest/v1/series?on_conflict=' +
          encodeURIComponent('sesion_id,serie_prescrita_id'), {
        method: 'POST',
        body: [{ sesion_id: sid, serie_prescrita_id: ref.id, perfil_id: p5.id, orden: ref.orden,
                 peso: esNum ? Number(String(pb).replace(',', '.')) : null,
                 peso_texto: esNum ? null : (pb == null || pb === '' ? null : String(pb)),
                 reps: v[1] == null || v[1] === '' ? null : String(v[1]),
                 rir:  v[2] == null || v[2] === '' ? null : String(v[2]),
                 ajuste: v[3] == null || v[3] === '' ? null : String(v[3]) }],
        headers: { 'Prefer': 'resolution=merge-duplicates' } });
      SB.limpia(); return { ok: true };
    }

    if (a === 'salir') { SB.salir(); ponModo(false); PERFIL = null; return { ok: true }; }

    throw new Error('acción no disponible todavía en la base: ' + a);
  }

  function respuesta(obj){
    return new Response(JSON.stringify(obj),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  var fetchOriginal = window.fetch.bind(window);
  window.fetch = async function(entrada, opciones){
    var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';
    if (!ES_SCRIPT.test(url) || !opciones || !opciones.body) {
      return fetchOriginal(entrada, opciones);
    }
    var body;
    try { body = JSON.parse(opciones.body); } catch (e) { return fetchOriginal(entrada, opciones); }

    try {
      if (body.action === 'google' && body.id_token) {
        var correo = cargaUtil(body.id_token, 'email').toLowerCase();
        if (!SB.activo(correo)) { ponModo(false); return fetchOriginal(entrada, opciones); }
        var r = await SB.entraGoogle(body.id_token);
        ponModo(true); PERFIL = null; SB.limpia();
        return respuesta(r);
      }
      if (!usaSB || !SB.haySesion()) return fetchOriginal(entrada, opciones);
      return respuesta(await accion(body));
    } catch (e) {
      return respuesta({ error: (e && e.message) || String(e) });
    }
  };
})();
