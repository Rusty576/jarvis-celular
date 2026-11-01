"use strict";
// Copia EXACTA del bloque de reglas de finanzas de bot_celular/Codigo.gs (no editar acá: se copia de allá; una
// prueba revisa que sean iguales). Con esto la app anota y calcula sola, sin internet, igual que el bot y la PC.
// ---- finanzas: las reglas (iguales en finanzas.py de la PC, en el bot y en la app: se prueba que den lo mismo) ----
// Cada cambio es una operación con su número ({id, tipo, ...}): aplicarla dos veces no duplica nada.
const FIN_MAX_VISTAS = 600, FIN_MAX_MOVIMIENTOS = 600;
const FIN_CATEGORIAS = {
  Comida: "comida super supermercado almuerzo cena desayuno merienda delivery pedidosya rappi restaurante pizza "
    + "hamburguesa almacen feria carniceria verduleria panaderia kiosco",
  Transporte: "nafta combustible taxi uber cabify bondi omnibus boleto stm estacionamiento peaje auto moto",
  Servicios: "luz ute agua ose internet antel telefono celular gas alquiler expensas",
  Suscripciones: "netflix spotify youtube disney prime hbo max suscripcion suscripciones icloud chatgpt",
  Salud: "farmacia medico remedios dentista mutualista emergencia",
  Ropa: "ropa championes zapatillas remera pantalon campera",
  Juegos: "juegos juego steam playstation xbox nintendo epic",
  Estudio: "liceo facultad libros cuadernos curso utiles fotocopias",
  Salidas: "salida salidas cine boliche bar cerveza fiesta",
  Regalos: "regalo regalos cumple cumpleanos",
};

function finVacio() {
  return {movimientos: [], pagos: [], presupuestos: {}, cuentas: {}, vistas: []};
}

function finDos(n) {
  return String(n).padStart(2, "0");
}

function finSumarDias(fecha, dias) {
  const d = new Date(fecha + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function finUltimoDia(anio, mes) {   // (mes: de 1 a 12)
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function finSiguiente(pago) {
  // la próxima vez que vence un pago que se repite (mensual: vuelve al día que elegiste, aunque un mes corto lo corra)
  const [a, m, d] = pago.vence.split("-").map(Number);
  if (pago.repetir === "semanal") return finSumarDias(pago.vence, 7);
  if (pago.repetir === "anual") return `${a + 1}-${finDos(m)}-${finDos(Math.min(d, finUltimoDia(a + 1, m)))}`;
  if (pago.repetir === "mensual") {
    const an = m === 12 ? a + 1 : a, me = m === 12 ? 1 : m + 1;
    return `${an}-${finDos(me)}-${finDos(Math.min(Number(pago.dia) || d, finUltimoDia(an, me)))}`;
  }
  return null;
}

function finRedondo(x) {
  return Math.round(Number(x) * 100) / 100;
}

function finOrdenar(movs) {
  movs.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function finAplicar(estado, op) {
  // aplica una operación (si no se aplicó ya): true si cambió algo
  if (!op || typeof op !== "object" || !op.id || estado.vistas.indexOf(op.id) >= 0) return false;
  estado.vistas.push(op.id);
  if (estado.vistas.length > FIN_MAX_VISTAS) estado.vistas.splice(0, estado.vistas.length - FIN_MAX_VISTAS);
  const tipo = op.tipo;
  if (tipo === "gasto" || tipo === "ingreso") {
    const monto = Math.abs(Number(op.monto) || 0);
    if (!monto) return false;
    estado.movimientos.push({id: op.id, fecha: op.fecha || "", monto: tipo === "ingreso" ? monto : -monto,
                             categoria: op.categoria || (tipo === "ingreso" ? "Ingresos" : "Otros"),
                             cuenta: op.cuenta || "", nota: op.nota || "", pago: op.pago || ""});
    finOrdenar(estado.movimientos);
    if (estado.movimientos.length > FIN_MAX_MOVIMIENTOS) estado.movimientos.splice(0, estado.movimientos.length - FIN_MAX_MOVIMIENTOS);
  } else if (tipo === "borrar_mov") {
    estado.movimientos = estado.movimientos.filter((m) => m.id !== op.mov);
  } else if (tipo === "pago") {
    if (!op.nombre || !/^\d{4}-\d{2}-\d{2}$/.test(String(op.vence || ""))) return false;
    estado.pagos.push({id: op.id, nombre: op.nombre, monto: Math.abs(Number(op.monto) || 0), vence: op.vence,
                       repetir: op.repetir || "", avisar: op.avisar === undefined ? 2 : parseInt(op.avisar, 10),
                       categoria: op.categoria || "Servicios", cuenta: op.cuenta || "", dia: Number(op.vence.slice(8, 10))});
  } else if (tipo === "pagado") {
    const pago = estado.pagos.find((p) => p.id === op.pago);
    if (!pago) return false;
    const monto = Math.abs(Number(op.monto || pago.monto) || 0);
    if (monto) {
      estado.movimientos.push({id: op.id, fecha: op.fecha || pago.vence, monto: -monto, categoria: pago.categoria,
                               cuenta: op.cuenta || pago.cuenta, nota: pago.nombre, pago: pago.id});
      finOrdenar(estado.movimientos);
    }
    const siguiente = finSiguiente(pago);
    if (siguiente) pago.vence = siguiente;
    else estado.pagos = estado.pagos.filter((p) => p.id !== pago.id);
  } else if (tipo === "borrar_pago") {
    estado.pagos = estado.pagos.filter((p) => p.id !== op.pago);
  } else if (tipo === "presupuesto") {
    const monto = Math.abs(Number(op.monto) || 0);
    if (!op.categoria) return false;
    if (monto) estado.presupuestos[op.categoria] = monto;
    else delete estado.presupuestos[op.categoria];
  } else if (tipo === "cuenta") {
    if (!op.nombre) return false;
    if (op.borrar) {
      delete estado.cuentas[op.nombre];
    } else {   // el saldo de hoy: lo que ya se movió en esa cuenta se descuenta del de arranque
      const movido = estado.movimientos.filter((m) => m.cuenta === op.nombre).reduce((t, m) => t + m.monto, 0);
      estado.cuentas[op.nombre] = finRedondo((Number(op.saldo) || 0) - movido);
    }
  } else {
    return false;
  }
  return true;
}

function finResumen(estado, hoy) {
  // lo del mes: ingresos, gastos, por categoría (con su presupuesto), el saldo de cada cuenta y los próximos pagos
  const mes = hoy.slice(0, 7);
  const delMes = estado.movimientos.filter((m) => m.fecha.slice(0, 7) === mes);
  const gastos = -delMes.filter((m) => m.monto < 0).reduce((t, m) => t + m.monto, 0);
  const ingresos = delMes.filter((m) => m.monto > 0).reduce((t, m) => t + m.monto, 0);
  const porCat = {};
  delMes.filter((m) => m.monto < 0).forEach((m) => { porCat[m.categoria] = (porCat[m.categoria] || 0) - m.monto; });
  const categorias = [...new Set(Object.keys(porCat).concat(Object.keys(estado.presupuestos)))]
    .sort((x, y) => (porCat[y] || 0) - (porCat[x] || 0));
  const cuentas = {};
  Object.keys(estado.cuentas).forEach((c) => {
    cuentas[c] = finRedondo(estado.cuentas[c] + estado.movimientos.filter((m) => m.cuenta === c).reduce((t, m) => t + m.monto, 0));
  });
  const pagos = estado.pagos.slice().sort((x, y) => (x.vence < y.vence ? -1 : x.vence > y.vence ? 1 : 0));
  return {mes: mes, gastos: finRedondo(gastos), ingresos: finRedondo(ingresos),
          categorias: categorias.map((c) => ({categoria: c, gastado: finRedondo(porCat[c] || 0), presupuesto: estado.presupuestos[c] || 0})),
          cuentas: cuentas, pagos: pagos, vencidos: pagos.filter((p) => p.vence < hoy)};
}

function finPlata(monto) {
  // $ 1.250 · $ 99,50
  monto = finRedondo(monto);
  const entero = String(Math.floor(Math.abs(monto))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const resto = finRedondo(Math.abs(monto) % 1);
  return (monto < 0 ? "-" : "") + "$ " + entero + (resto ? "," + resto.toFixed(2).slice(2) : "");
}

function finVencimientos(estado, pendientes) {
  // los avisos que tocan (iguales en la PC, el bot y el celular, con el mismo número): [{id, fecha, cuando, texto}]
  const avisos = [];
  estado.pagos.forEach((p) => {
    const plata = p.monto ? ` (${finPlata(p.monto)})` : "";
    if (p.avisar > 0) {
      avisos.push({id: `pago-${p.id}-${p.vence}-antes`, fecha: p.vence, cuando: finSumarDias(p.vence, -p.avisar) + "T09:00",
                   texto: `💸 En ${p.avisar} día${p.avisar !== 1 ? "s" : ""} vence ${p.nombre}${plata}`});
    }
    avisos.push({id: `pago-${p.id}-${p.vence}-hoy`, fecha: p.vence, cuando: p.vence + "T09:00", texto: `💸 Hoy vence ${p.nombre}${plata}`});
    avisos.push({id: `pago-${p.id}-${p.vence}-tarde`, fecha: p.vence, cuando: finSumarDias(p.vence, 1) + "T10:00",
                 texto: `⚠️ Se te pasó ${p.nombre}${plata}: venció ayer. Si ya lo pagaste, decime «pagué ${p.nombre}»`});
  });
  (pendientes || []).forEach((p) => {
    if (p.hecho || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.para || ""))) return;
    avisos.push({id: `pen-${p.id}-${p.para}-antes`, fecha: p.para, cuando: finSumarDias(p.para, -1) + "T20:00",
                 texto: `📌 Mañana vence: ${p.texto}`});
    avisos.push({id: `pen-${p.id}-${p.para}-hoy`, fecha: p.para, cuando: p.para + "T09:00", texto: `📌 Hoy vence: ${p.texto}`});
  });
  return avisos.sort((x, y) => (x.cuando < y.cuando ? -1 : x.cuando > y.cuando ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function finTocaAvisar(a, ahora) {
  // ya es la hora, no pasaron más de 12 horas, y uno de «antes» solo si todavía no es el día
  if (a.cuando > ahora.slice(0, 16)) return false;
  if (new Date(ahora.slice(0, 16) + ":00Z") - new Date(a.cuando + ":00Z") > 12 * 3600000) return false;
  return !(/-antes$/.test(a.id) && a.fecha <= ahora.slice(0, 10));
}

function finCategoria(texto) {
  // «el super» -> Comida, «nafta» -> Transporte; si no es de las de siempre, queda con su nombre
  const palabras = String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z]+/g) || [];
  for (const p of palabras) {
    for (const cat of Object.keys(FIN_CATEGORIAS)) if (FIN_CATEGORIAS[cat].split(" ").indexOf(p) >= 0) return cat;
  }
  const limpio = palabras.filter((w) => ["el", "la", "los", "las", "un", "una", "unos", "unas", "mi", "mis"].indexOf(w) < 0).join(" ");
  return limpio ? limpio.charAt(0).toUpperCase() + limpio.slice(1) : "Otros";
}
// ---- fin de las reglas de finanzas ----
