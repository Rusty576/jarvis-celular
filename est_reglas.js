"use strict";
// Copia EXACTA del bloque de reglas de estudio de bot_celular/Codigo.gs (no editar acá: se copia de allá; una
// prueba revisa que sean iguales). Con esto la app calcula repasos, dominio y racha sola, sin internet.
// ---- estudio: las reglas (iguales en el bot y en la app: la app las usa sin internet) ----
const EST_DIAS_CAJA = [0, 1, 3, 7, 16];   // cuándo vuelve cada caja (en días): la 1 hoy mismo, la 5 en dos semanas

function estVacio() {
  return {sets: [], repaso: {}, intentos: [], dias: [], meta: 20};
}

function estSumarDias(fecha, dias) {
  const d = new Date(fecha + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function estDiasEntre(desde, hasta) {
  return Math.round((new Date(hasta + "T12:00:00Z") - new Date(desde + "T12:00:00Z")) / 86400000);
}

function estAplicarResultado(e, r, hoy) {
  // r: {id (el número del resultado), set, modo, respuestas: [{id, set?, bien}], dificultad, nota}. true si cambió algo
  if (!r || !r.id || e.intentos.some((x) => x.id === r.id)) return false;
  const respuestas = (r.respuestas || []).filter((x) => x && x.id);
  respuestas.forEach((x) => {
    const clave = (x.set || r.set) + "/" + x.id;
    const v = e.repaso[clave] || {caja: 1, bien: 0, mal: 0};
    if (x.bien) {
      v.caja = Math.min(5, v.caja + 1);
      v.bien++;
    } else {
      v.caja = 1;
      v.mal++;
    }
    v.proxima = estSumarDias(hoy, EST_DIAS_CAJA[v.caja - 1]);
    e.repaso[clave] = v;
  });
  if (respuestas.length && e.dias.indexOf(hoy) < 0) e.dias.push(hoy);
  if (e.dias.length > 120) e.dias.splice(0, e.dias.length - 120);
  e.intentos.push({id: r.id, set: r.set || "", modo: r.modo || "quiz", fecha: hoy, total: respuestas.length,
                   bien: respuestas.filter((x) => x.bien).length, dificultad: Number(r.dificultad) || 0,
                   fallados: respuestas.filter((x) => !x.bien).map((x) => x.id).slice(0, 40),
                   nota: r.nota === undefined ? undefined : Math.max(0, Math.min(100, Math.round(Number(r.nota) || 0)))});
  if (e.intentos.length > 200) e.intentos.splice(0, e.intentos.length - 200);
  return true;
}

function estClaves(set) {
  return set.preguntas.map((q) => set.id + "/" + q.id).concat(set.tarjetas.map((t) => set.id + "/" + t.id));
}

function estDominio(e, set) {
  // cuánto lo dominás (%): según la caja de cada pregunta y tarjeta (lo que nunca respondiste cuenta cero)
  const claves = estClaves(set);
  if (!claves.length) return 0;
  return Math.round(100 * claves.reduce((t, k) => t + ((e.repaso[k] || {caja: 1}).caja - 1) / 4, 0) / claves.length);
}

function estParaHoy(e, hoy, soloSet) {
  // lo que toca repasar hoy (ya lo viste y le llegó la fecha): [{set, tipo: "pregunta"|"tarjeta", id}]
  const lista = [];
  e.sets.forEach((s) => {
    if (soloSet && s.id !== soloSet) return;
    s.preguntas.forEach((q) => { const v = e.repaso[s.id + "/" + q.id]; if (v && v.proxima <= hoy) lista.push({set: s.id, tipo: "pregunta", id: q.id}); });
    s.tarjetas.forEach((t) => { const v = e.repaso[s.id + "/" + t.id]; if (v && v.proxima <= hoy) lista.push({set: s.id, tipo: "tarjeta", id: t.id}); });
  });
  return lista;
}

function estRacha(e, hoy) {
  // días seguidos estudiando (si hoy todavía no estudiaste, cuenta hasta ayer)
  let d = e.dias.indexOf(hoy) >= 0 ? hoy : estSumarDias(hoy, -1), n = 0;
  while (e.dias.indexOf(d) >= 0) {
    n++;
    d = estSumarDias(d, -1);
  }
  return n;
}

function estResumen(e, hoy) {
  return {
    racha: estRacha(e, hoy), meta: e.meta || 20, para_hoy: estParaHoy(e, hoy).length,
    hoy: e.intentos.filter((x) => x.fecha === hoy).reduce((t, x) => t + (x.total || 0), 0),
    sets: e.sets.map((s) => ({id: s.id, dominio: estDominio(e, s), para_hoy: estParaHoy(e, hoy, s.id).length,
                              dias_examen: s.examen ? estDiasEntre(hoy, s.examen.fecha) : null})),
  };
}
// ---- fin de las reglas de estudio ----
