// ============================================================
//  JARVIS en el celular
// ------------------------------------------------------------
//  Una página web que se instala como una app (PWA). Le habla al bot de JARVIS (bot_celular/Codigo.gs, en Google
//  Apps Script): el mismo cerebro (Gemini), tus pendientes, recordatorios, mails y órdenes para la PC, y la misma
//  charla que Telegram. Puede ser tu JARVIS o el de otra persona (cada uno con su bot, su llave y sus datos).
//  La dirección del bot y la llave llegan en el link que manda /app en Telegram, después del # (esa parte del link
//  no viaja a ningún servidor), y quedan guardadas solo en este celular.
//  La voz: el celular escucha (el reconocimiento de voz de Chrome) y habla (las voces del celular). Si no puede
//  escuchar solo, graba y el bot pasa la grabación a texto.
//  Lo que se hace en el celular (abrir una app, poner música, preparar un WhatsApp o una llamada) lo pide el bot como
//  "acciones" y lo hace esta página.
//  Esta misma página va adentro de la app de Android (app_android/): ahí el teléfono está a mano (window.JarvisNativo)
//  y JARVIS escucha y habla con la voz del sistema, llama, pone alarmas, abre cualquier app y anda sin internet.
// ============================================================
"use strict";

const VERSION_APP = "2026.10.25.3";
const ANDROID_WEB = "https://rusty576.github.io/jarvis-celular/android/";   // el APK y su version.json
const $ = (id) => document.getElementById(id);
const Reco = window.SpeechRecognition || window.webkitSpeechRecognition;


// ---------- La app de Android (si esta página corre adentro de ella) ----------
// Lo rápido contesta al toque (Nativo.ya). Lo que tarda (internet, escuchar, hablar, permisos) devuelve una promesa
// (Nativo.cuando) que se cumple cuando Android llama a Nativo.respuesta. Lo que pasa solo (lo que va oyendo, la red que
// vuelve, el botón del asistente) llega por Nativo.evento.
const Nativo = {
  hay: !!window.JarvisNativo,
  info: {},
  esperando: new Map(),
  numero: 0,
  oyentes: {},

  cuando(metodo, ...datos) {
    return new Promise((listo) => {
      const id = ++this.numero;
      this.esperando.set(id, listo);
      window.JarvisNativo[metodo](id, ...datos);
    });
  },

  ya(metodo, ...datos) {
    const r = window.JarvisNativo[metodo](...datos);
    if (typeof r !== "string") return r;
    try {
      return JSON.parse(r);
    } catch (e) {
      return r;
    }
  },

  respuesta(id, datos) {
    const listo = this.esperando.get(id);
    this.esperando.delete(id);
    if (listo) listo(datos || {});
  },

  evento(tipo, datos) {
    (this.oyentes[tipo] || []).forEach((f) => f(datos || {}));
  },

  al(tipo, f) {
    (this.oyentes[tipo] = this.oyentes[tipo] || []).push(f);
  },
};
window.Nativo = Nativo;
const puedeOir = Nativo.hay || !!Reco;
const DONDE_PERMISOS = Nativo.hay ? "en Ajustes del celular › Apps › JARVIS › Permisos" : "en los ajustes de Chrome";

// Lo que se guarda en este celular
const GUARDADO = "jarvis.";
function leerGuardado(clave, siNo) {
  try {
    const valor = JSON.parse(localStorage.getItem(GUARDADO + clave));
    return valor === null ? siNo : valor;
  } catch (e) {
    return siNo;
  }
}
function guardar(clave, valor) {
  try {
    localStorage.setItem(GUARDADO + clave, JSON.stringify(valor));
  } catch (e) { /* sin lugar: la app sigue andando */ }
}

const ajustes = Object.assign({leer: "auto", nombreVoz: "", velocidad: 1.05, idioma: "es-UY", musica: "youtube",
                               escucharJarvis: false, avisos: true, modelo: "", soloWifi: true},
                              leerGuardado("ajustes", {}));
let conexion = leerGuardado("conexion", null);         // {u: la dirección del bot, k: la llave}
let mensajes = leerGuardado("mensajes", []);           // la charla, como se ve en este celular
let ultimaCharla = leerGuardado("ultimaCharla", null); // el último mensaje de la charla del bot que ya está acá
let datosDia = leerGuardado("dia", null);              // lo último de «Mi día» y la PC (se ve aunque no haya internet)
let cola = leerGuardado("cola", []);                   // lo que pediste sin internet: sale solo cuando vuelve
let vistaActual = "inicio";
let ultimoToque = 0;   // el celular solo deja abrir otra app justo después de que tocaste algo
let ultimoPedido = 0;  // cuándo se le habló al bot por última vez (para despertarlo antes de que le hables)

// Las órdenes rápidas de la pestaña PC (solo las que JARVIS entiende en la PC)
const ORDENES = ["¿Cómo está la compu?", "Pausá la música", "Siguiente tema", "Modo juego", "Salí del modo juego",
                 "Bloqueá la pantalla", "Sacá una captura de pantalla", "Apagá la compu en 10 minutos", "Cancelá el apagado"];

const normalizar = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const tienePc = () => !datosDia || datosDia.tiene_pc !== false;


// ---------- Conectarse con el bot ----------

function leerLink() {
  // el link de /app: ...#u=<dirección del bot>&k=<llave>
  const datos = new URLSearchParams(location.hash.slice(1));
  if (!datos.get("u") || !datos.get("k")) return;
  conexion = {u: datos.get("u"), k: datos.get("k")};
  guardar("conexion", conexion);
  history.replaceState(null, "", location.pathname + location.search);   // que la llave no quede a la vista
}

class ErrorJarvis extends Error {
  // tipo: sin_red (no hay internet), tiempo, servidor (hay internet pero Google no contesta), http, no_json (el bot
  // contestó cualquier cosa), llave, bot (el bot dijo que no)
  constructor(tipo, mensaje) {
    super(mensaje);
    this.tipo = tipo;
  }
}

function errorDeRed(tipo, estado) {
  // El motivo de verdad (antes todo era «¿hay internet?», aunque hubiera)
  const mensajes = {
    sin_red: "No hay internet en el celular.",
    tiempo: "JARVIS tardó demasiado en contestar (Google anda lento). Probá de nuevo.",
    servidor: "Hay internet, pero Google no contesta ahora. Probá de nuevo en un ratito.",
    http: "Google contestó con un error" + (estado ? " (" + estado + ")" : "") + ". Probá de nuevo en un rato.",
    no_json: "El bot de JARVIS tuvo un problema y no contestó bien. Probá de nuevo.",
  };
  marcarConexion(tipo === "sin_red" ? "mal" : "problema");
  return new ErrorJarvis(tipo, mensajes[tipo] || "No pude hablar con JARVIS.");
}

function hayInternet() {
  if (Nativo.hay) return Nativo.ya("hayInternet") !== false;
  return navigator.onLine !== false;
}

async function api(accion, datos = {}, segundos = 100) {
  // Un pedido al bot. En la web va como texto (sin encabezados raros: así Google lo acepta desde otra página); en la
  // app de Android lo hace Android (sin las trabas del navegador, y si falla se sabe por qué)
  if (!conexion) throw new ErrorJarvis("llave", "La app no está conectada.");
  const cuerpo = JSON.stringify(Object.assign({accion: accion, app: conexion.k, nativo: Nativo.hay || undefined}, datos));
  ultimoPedido = Date.now();
  let texto;
  if (Nativo.hay) {
    const r = await Nativo.cuando("pedir", "POST", conexion.u, cuerpo, segundos);
    if (!r.ok) throw errorDeRed(r.error || "servidor", r.estado);
    texto = r.cuerpo;
  } else {
    if (!hayInternet()) throw errorDeRed("sin_red");
    const control = new AbortController();
    const corte = setTimeout(() => control.abort(), segundos * 1000);
    try {
      const r = await fetch(conexion.u, {method: "POST", body: cuerpo, signal: control.signal});
      if (!r.ok) throw errorDeRed("http", r.status);
      texto = await r.text();
    } catch (e) {
      if (e instanceof ErrorJarvis) throw e;
      if (e.name === "AbortError") throw errorDeRed("tiempo");
      // (Google, cuando falla, contesta una página sin el permiso para otras páginas: el navegador lo ve como un
      // error de red aunque haya internet)
      throw errorDeRed(hayInternet() ? "servidor" : "sin_red");
    } finally {
      clearTimeout(corte);
    }
  }
  let d;
  try {
    d = JSON.parse(texto);
  } catch (e) {
    throw errorDeRed("no_json");
  }
  marcarConexion("bien");
  if (!d.ok && d.error === "llave") {
    mostrarConectar(d.detalle);
    throw new ErrorJarvis("llave", d.detalle);
  }
  return d;
}

async function apiLeer(accion, datos = {}) {
  // Para pedidos que solo leen (la charla, Mi día, los mails): si Google falló de casualidad, una vez más
  try {
    return await api(accion, datos, 60);
  } catch (e) {
    if (!["servidor", "no_json", "http"].includes(e.tipo)) throw e;
    await esperar(1200);
    return api(accion, datos, 60);
  }
}

function calentar() {
  // Mientras le hablás, despierta al bot (Google tarda un poco más en contestar al primer pedido después de un rato)
  if (conexion && hayInternet() && Date.now() - ultimoPedido > 90000) api("app_hola", {}, 30).catch(() => {});
}

function marcarConexion(estado) {
  // bien: en línea · mal: sin internet · problema: hay internet pero el bot o Google fallaron
  $("punto").className = "punto " + estado;
  $("estado-conexion").textContent = {bien: "en línea", mal: "sin internet", problema: "con problemas"}[estado] || estado;
}

// ---------- Lo que pediste sin internet: se manda solo cuando vuelve ----------

function encolar(pedido) {
  cola.push(Object.assign({cuando: Date.now()}, pedido));
  cola = cola.slice(-20);
  guardar("cola", cola);
  marcarConexion("mal");
}

let mandandoCola = false;
async function mandarCola() {
  if (mandandoCola || !cola.length || !conexion || !hayInternet()) return;
  mandandoCola = true;
  let charlados = 0, anotados = 0;
  try {
    while (cola.length) {
      const p = cola[0];
      let r;
      try {
        r = await api(p.accion, p.datos || {});
      } catch (e) {
        if (e.tipo === "sin_red" || e.tipo === "tiempo" || e.tipo === "servidor") break;   // sigue esperando
        r = {ok: false, error: e.message};
      }
      cola.shift();
      guardar("cola", cola);
      if (p.silencioso) {   // lo que ya se anotó en el celular sin internet: ahora lo sabe también el bot (y la PC)
        anotados++;
      } else if (p.accion === "app_mensaje") {
        charlados++;
        const respuesta = r.ok ? (r.mensajes || []).join("\n\n") : (r.error || "No pude.");
        const imagen = await prepararImagenes(r.acciones || []);
        agregar({quien: "jarvis", texto: "⏳ «" + p.datos.texto + "»\n\n" + respuesta, tarjetas: r.tarjetas || [],
                 acciones: r.acciones || [], imagen: imagen});
        if (r.acciones && r.acciones.length) await hacerAcciones(r.acciones);
      } else if (r.ok && r.pendientes) {
        datosDia = r;
        guardar("dia", r);
        pintarDia();
      }
    }
    if (!cola.length && charlados) avisar("Ya mandé lo que me pediste sin internet.", 3);
    if (anotados) cargarDatos();   // Mi día, con lo del bot (que ya tiene lo anotado)
  } finally {
    mandandoCola = false;
  }
}

function mostrarConectar(detalle) {
  $("conectar").hidden = false;
  $("conectar-detalle").textContent = detalle || "";
}

function avisar(texto, segundos = 3.5, boton = null) {
  // El cartelito de abajo (como los de Android). boton: {texto, hacer} (por ejemplo «Actualizar»)
  const aviso = $("aviso");
  aviso.innerHTML = "";
  const t = document.createElement("span");
  t.textContent = texto;
  aviso.appendChild(t);
  if (boton) {
    const b = document.createElement("button");
    b.textContent = boton.texto;
    b.onclick = () => { aviso.hidden = true; boton.hacer(); };
    aviso.appendChild(b);
  }
  aviso.hidden = false;
  clearTimeout(avisar.reloj);
  avisar.reloj = setTimeout(() => { aviso.hidden = true; }, segundos * 1000);
}


// ---------- Los reactores (Inicio y la llamada) ----------

let reactorInicio = null, reactorLlamada = null;
function vozReactores(nivel) {
  if (reactorInicio) reactorInicio.voz(nivel);
  if (reactorLlamada) reactorLlamada.voz(nivel);
}


// ---------- La voz de JARVIS (las voces del celular) ----------

const Voz = {
  turno: 0,   // cada vez que habla o se calla cambia: así una frase vieja no sigue sonando

  voces() {
    if (Nativo.hay) {   // las del motor de voz de Android (las que piden internet, marcadas)
      return (Nativo.ya("voces") || []).map((v) => ({name: v.nombre, lang: v.idioma, red: v.red}));
    }
    if (!window.speechSynthesis) return [];
    return speechSynthesis.getVoices().filter((v) => (v.lang || "").toLowerCase().startsWith("es"));
  },

  elegida() {
    const voces = this.voces();
    const preferidas = ["es-us", "es-mx", "es-419", "es-ar", "es-uy", "es-es"];
    return voces.find((v) => v.name === ajustes.nombreVoz)
      || preferidas.map((p) => voces.find((v) => v.lang.toLowerCase().replace("_", "-") === p)).find(Boolean)
      || voces[0] || null;
  },

  limpiar(texto) {
    // lo que se dice: sin links, emojis ni símbolos
    return String(texto || "").replace(/https?:\/\/\S+/g, "el link")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, "")
      .replace(/[*_`#>•|~«»]/g, " ").replace(/\s+/g, " ").trim();
  },

  partir(texto) {
    // de a frases cortas: el celular corta las frases largas a la mitad
    const frases = texto.match(/[^.!?¿¡;:]+[.!?;:]*\s*/g) || [texto];
    const salida = [];
    frases.forEach((f) => {
      if (salida.length && (salida[salida.length - 1] + f).length < 180) salida[salida.length - 1] += f;
      else salida.push(f);
    });
    return salida.map((f) => f.trim()).filter(Boolean);
  },

  async decir(texto) {
    if (Nativo.hay) {   // la voz de Android: entero de una vez (sin cortes entre frases)
      this.callar();
      const limpio = this.limpiar(texto);
      if (limpio) await Nativo.cuando("hablar", limpio.slice(0, 3800), ajustes.velocidad, ajustes.nombreVoz || "");
      return;
    }
    if (!window.speechSynthesis) return;   // este navegador no habla: queda escrito
    this.callar();
    const mio = ++this.turno;
    const voz = this.elegida();
    for (const frase of this.partir(this.limpiar(texto))) {
      if (mio !== this.turno) return;
      await new Promise((listo) => {
        const u = new SpeechSynthesisUtterance(frase);
        if (voz) {
          u.voice = voz;
          u.lang = voz.lang;
        } else {
          u.lang = "es-ES";
        }
        u.rate = ajustes.velocidad;
        let terminado = false;
        const fin = () => {
          if (terminado) return;
          terminado = true;
          clearTimeout(reloj);
          listo();
        };
        u.onend = fin;
        u.onerror = fin;
        // por si el celular no avisa que terminó (pasa en algunos Android)
        const reloj = setTimeout(fin, 2500 + frase.length * 110 / ajustes.velocidad);
        speechSynthesis.speak(u);
      });
    }
  },

  callar() {
    this.turno++;
    if (Nativo.hay) window.JarvisNativo.callar();
    else if (window.speechSynthesis) speechSynthesis.cancel();
  },

  enPartes() {
    // Para el cerebro del celular, que va escribiendo: cada frase se dice apenas está completa (Android las pone en
    // fila). agregar(pedazo) con lo nuevo; terminar() dice lo que falta y espera a que termine de hablar
    this.callar();
    const mio = this.turno;
    let resto = "", ultima = Promise.resolve(), primera = true;
    const decir = (frase) => {
      const limpio = this.limpiar(frase);
      if (!limpio || mio !== this.turno) return;
      ultima = Nativo.cuando(primera ? "hablar" : "hablarMas", limpio, ajustes.velocidad, ajustes.nombreVoz || "");
      primera = false;
    };
    return {
      agregar: (pedazo) => {
        resto += pedazo;
        for (;;) {   // la primera frase de al menos 12 letras que ya terminó (las cortitas van con la siguiente)
          const fin = /[.!?…:;](?=\s)/g;
          let corte = -1, x;
          while ((x = fin.exec(resto))) {
            if (x.index + 1 >= 12) { corte = x.index + 1; break; }
          }
          if (corte < 0) break;
          decir(resto.slice(0, corte));
          resto = resto.slice(corte).replace(/^\s+/, "");
        }
      },
      terminar: async () => {
        if (resto.trim()) decir(resto);
        resto = "";
        await ultima;
      },
    };
  },
};
Nativo.al("voz", (d) => { if (d.estado === "palabra") vozReactores(0.55 + Math.random() * 0.35); });
if (window.speechSynthesis && speechSynthesis.addEventListener) speechSynthesis.addEventListener("voiceschanged", llenarVoces);


// ---------- El oído: reconocimiento de voz de Chrome, o grabar y que el bot lo pase a texto ----------

const Oido = {
  rec: null,
  fin: Promise.resolve(),   // se cumple cuando el reconocimiento que está andando termina del todo

  escuchar(alOir) {
    // Una frase: termina sola cuando dejás de hablar. Devuelve {texto, error}
    if (Nativo.hay) return this.escucharNativo(alOir);
    return new Promise((listo) => {
      const rec = new Reco();
      this.rec = rec;
      let termino;
      this.fin = new Promise((r) => { termino = r; });
      rec.lang = ajustes.idioma;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let final = "", error = null;
      rec.onresult = (e) => {
        let parcial = "";
        final = "";
        for (let i = 0; i < e.results.length; i++) {
          if (e.results[i].isFinal) final += e.results[i][0].transcript;
          else parcial += e.results[i][0].transcript;
        }
        vozReactores(0.7);
        if (alOir) alOir((final + " " + parcial).trim());
      };
      rec.onsoundstart = () => vozReactores(0.4);
      rec.onerror = (e) => { error = e.error; };
      rec.onend = () => {
        if (this.rec === rec) this.rec = null;   // (si ya arrancó otro, no lo pisa)
        termino();
        if (error === "language-not-supported" && ajustes.idioma !== "es-ES") {   // ese español no está: el de España
          ajustes.idioma = "es-ES";
          guardar("ajustes", ajustes);
          this.escuchar(alOir).then(listo);
          return;
        }
        listo({texto: final.trim(), error: error});
      };
      try {
        rec.start();
      } catch (e) {
        if (this.rec === rec) this.rec = null;
        termino();
        listo({texto: "", error: "no-arranca"});
      }
    });
  },

  alOir: null,   // (en Android) a quién le va pasando lo que oye

  async escucharNativo(alOir) {
    // El reconocimiento de Android: sin internet usa el del celular. La primera vez pide permiso para el micrófono
    let termino;
    this.fin = new Promise((r) => { termino = r; });
    try {
      if (!Nativo.ya("permisos").microfono && !(await Nativo.cuando("pedirPermiso", "microfono")).si) {
        return {texto: "", error: "not-allowed"};
      }
      this.alOir = alOir || null;
      const r = await Nativo.cuando("escuchar", ajustes.idioma);
      if (r.error === "language-not-supported" && ajustes.idioma !== "es-US") {   // ese español no está: el latino
        ajustes.idioma = "es-US";
        guardar("ajustes", ajustes);
        termino();
        return this.escucharNativo(alOir);
      }
      return {texto: (r.texto || "").trim(), error: r.error || null};
    } finally {
      this.alOir = null;
      termino();
    }
  },

  cortar() {   // termina y entrega lo que oyó
    if (Nativo.hay) return window.JarvisNativo.cortarEscucha();
    if (this.rec) try { this.rec.stop(); } catch (e) { /* ya terminó */ }
    Grabadora.detener();
  },

  cancelar() {   // termina sin entregar nada
    if (Nativo.hay) return window.JarvisNativo.cancelarEscucha();
    if (this.rec) try { this.rec.abort(); } catch (e) { /* ya terminó */ }
    Grabadora.cancelar();
  },

  async soltar() {
    // Deja libre el micrófono antes de usarlo para otra cosa: corta lo que esté escuchando (por ejemplo, esperando
    // «Jarvis») y espera a que termine del todo (si no, el viejo y el nuevo se pisan)
    this.cancelar();
    await Promise.race([this.fin, esperar(1500)]);
  },

  async oir(alOir) {
    // {texto} con el reconocimiento de Android o de Chrome, o {audio} grabado (lo pasa a texto el bot)
    if (puedeOir) return this.escuchar(alOir);
    const audio = await Grabadora.grabar();
    if (audio === "no-permitido") return {texto: "", error: "not-allowed"};
    return audio ? {texto: "", audio: audio} : {texto: "", error: "no-speech"};
  },
};

Nativo.al("oido", (d) => {
  if (d.parcial !== undefined && Oido.alOir) Oido.alOir(d.parcial);
  if (d.nivel !== undefined) vozReactores(d.nivel);
});

const Grabadora = {
  // Graba el micrófono hasta que dejás de hablar (o hasta 30 s) y lo pasa a WAV. Solo si el celular no tiene
  // reconocimiento de voz
  actual: null,

  async grabar(maximo = 30) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}});
    } catch (e) {
      return "no-permitido";
    }
    const contexto = new (window.AudioContext || window.webkitAudioContext)();
    const fuente = contexto.createMediaStreamSource(stream);
    const proceso = contexto.createScriptProcessor(4096, 1, 1);
    const pedazos = [];
    const inicio = performance.now();
    let ruido = null, hablo = false, ultimoSonido = 0;
    return new Promise((listo) => {
      const terminar = (entregar) => {
        proceso.disconnect();
        fuente.disconnect();
        stream.getTracks().forEach((p) => p.stop());
        contexto.close();
        this.actual = null;
        listo(entregar && hablo ? aWav(pedazos, contexto.sampleRate) : null);
      };
      this.actual = terminar;
      proceso.onaudioprocess = (e) => {
        const datos = new Float32Array(e.inputBuffer.getChannelData(0));
        pedazos.push(datos);
        const nivel = Math.sqrt(datos.reduce((s, x) => s + x * x, 0) / datos.length);
        const ahora = performance.now();
        if (ruido === null) ruido = nivel;
        else if (!hablo) ruido = ruido * 0.9 + nivel * 0.1;
        if (nivel > Math.max(0.02, ruido * 3)) {
          hablo = true;
          ultimoSonido = ahora;
          vozReactores(Math.min(1, nivel * 8));
        }
        if (hablo && ahora - ultimoSonido > 1300) terminar(true);              // dejaste de hablar
        else if (!hablo && ahora - inicio > 8000) terminar(false);             // no dijiste nada
        else if (ahora - inicio > maximo * 1000) terminar(true);
      };
      fuente.connect(proceso);
      proceso.connect(contexto.destination);
    });
  },

  detener() { if (this.actual) this.actual(true); },
  cancelar() { if (this.actual) this.actual(false); },
};

function aWav(pedazos, tasa) {
  // Float32 a WAV de 16 bits, 16000 por segundo (alcanza para la voz y pesa poco). Devuelve {mime, datos (base64)}
  const total = pedazos.reduce((s, p) => s + p.length, 0);
  const todo = new Float32Array(total);
  let pos = 0;
  pedazos.forEach((p) => { todo.set(p, pos); pos += p.length; });
  const salto = tasa / 16000;
  const largo = Math.floor(total / salto);
  const vista = new DataView(new ArrayBuffer(44 + largo * 2));
  const texto = (o, s) => [...s].forEach((c, i) => vista.setUint8(o + i, c.charCodeAt(0)));
  texto(0, "RIFF"); vista.setUint32(4, 36 + largo * 2, true); texto(8, "WAVE"); texto(12, "fmt ");
  vista.setUint32(16, 16, true); vista.setUint16(20, 1, true); vista.setUint16(22, 1, true);
  vista.setUint32(24, 16000, true); vista.setUint32(28, 32000, true); vista.setUint16(32, 2, true);
  vista.setUint16(34, 16, true); texto(36, "data"); vista.setUint32(40, largo * 2, true);
  for (let i = 0; i < largo; i++) {
    const x = Math.max(-1, Math.min(1, todo[Math.floor(i * salto)]));
    vista.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return {mime: "audio/wav", datos: aBase64(new Uint8Array(vista.buffer))};
}

function aBase64(bytes) {
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}


// ---------- Lo que se hace en el celular: abrir apps, música, WhatsApp, llamadas ----------

// Una página no puede abrir cualquier app por su nombre: estas sí (con su dirección o con un "intent" de Android).
// Las demás se buscan en Play Store (si la tenés, ahí aparece «Abrir»)
const lanzar = (paquete) => `intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;`
  + `package=${paquete};end`;
const APPS = {
  whatsapp: {nombre: "WhatsApp", url: "https://wa.me/", alias: ["wsp", "wasap", "whats"]},
  youtube: {nombre: "YouTube", url: "https://www.youtube.com/", buscar: (q) => "https://www.youtube.com/results?search_query=" + q},
  "youtube music": {nombre: "YouTube Music", url: "https://music.youtube.com/", buscar: (q) => "https://music.youtube.com/search?q=" + q},
  spotify: {nombre: "Spotify", url: "spotify:", buscar: (q) => "spotify:search:" + q},
  instagram: {nombre: "Instagram", url: "https://www.instagram.com/", alias: ["insta"]},
  tiktok: {nombre: "TikTok", url: "https://www.tiktok.com/", alias: ["tik tok"]},
  facebook: {nombre: "Facebook", url: "https://www.facebook.com/", alias: ["face"]},
  netflix: {nombre: "Netflix", url: "https://www.netflix.com/"},
  maps: {nombre: "Maps", url: "https://www.google.com/maps", alias: ["google maps", "mapas", "mapa", "gps"],
         buscar: (q) => "https://www.google.com/maps/search/?api=1&query=" + q},
  gmail: {nombre: "Gmail", url: lanzar("com.google.android.gm"), alias: ["correo", "mail", "mails"]},
  telegram: {nombre: "Telegram", url: "tg://resolve", alias: []},
  chrome: {nombre: "Chrome", url: lanzar("com.android.chrome"), alias: ["navegador", "google chrome"],
           buscar: (q) => "https://www.google.com/search?q=" + q},
  camara: {nombre: "Cámara", url: "intent:#Intent;action=android.media.action.STILL_IMAGE_CAMERA;end", alias: ["camera"]},
  telefono: {nombre: "Teléfono", url: "tel:", alias: ["llamadas", "marcador"]},
  mensajes: {nombre: "Mensajes", url: "sms:", alias: ["sms"]},
  calculadora: {nombre: "Calculadora", url: lanzar("com.google.android.calculator"), alias: []},
  calendario: {nombre: "Calendario", url: lanzar("com.google.android.calendar"), alias: ["agenda"]},
  fotos: {nombre: "Fotos", url: lanzar("com.google.android.apps.photos"), alias: ["galeria", "google fotos"]},
  reloj: {nombre: "Reloj", url: "intent:#Intent;action=android.intent.action.SHOW_ALARMS;end", alias: ["alarma", "alarmas"]},
  ajustes: {nombre: "Ajustes", url: "intent:#Intent;action=android.settings.SETTINGS;end", alias: ["configuracion"]},
  "play store": {nombre: "Play Store", url: "market://search?q=", alias: ["tienda"],
                 buscar: (q) => "https://play.google.com/store/search?c=apps&q=" + q},
};

function appDe(nombre) {
  const n = normalizar(nombre).replace(/^(?:la|el|mi|app de|aplicacion de|app)\s+/, "").trim();
  if (APPS[n]) return Object.assign({clave: n}, APPS[n]);
  for (const [clave, app] of Object.entries(APPS)) {
    if ((app.alias || []).includes(n) || normalizar(app.nombre) === n) return Object.assign({clave: clave}, app);
  }
  return null;
}

function accionAUrl(a) {
  // {texto del botón, url} de lo que pidió el bot
  const q = encodeURIComponent(a.busqueda || "");
  if (a.tipo === "whatsapp") {
    const texto = encodeURIComponent(a.mensaje || "");
    return {texto: `Abrir WhatsApp${a.para ? " (" + a.para + ")" : ""}`,
            url: a.numero ? `https://wa.me/${a.numero}?text=${texto}` : `https://wa.me/?text=${texto}`};
  }
  if (a.tipo === "llamar") return {texto: `Llamar${a.para ? " a " + a.para : ""}`, url: "tel:" + a.numero};
  if (a.tipo === "abrir_url") {   // (solo páginas https: nada de intent: ni javascript: que mande el bot)
    return {texto: a.texto || "Abrir", url: /^https:\/\//.test(a.url || "") ? a.url : "about:blank"};
  }
  if (a.tipo === "musica") {
    const donde = {youtube: APPS.youtube, ytmusic: APPS["youtube music"], spotify: APPS.spotify}[ajustes.musica] || APPS.youtube;
    return {texto: `Poner «${a.busqueda}» en ${donde.nombre}`, url: donde.buscar(q)};
  }
  const app = appDe(a.app);
  if (!app) return {texto: `Buscar «${a.app}» en Play Store`, url: APPS["play store"].buscar(encodeURIComponent(a.app))};
  return {texto: `Abrir ${app.nombre}`, url: a.busqueda && app.buscar ? app.buscar(q) : app.url};
}

function abrirUrl(url) {
  if (Nativo.hay) return Nativo.ya("abrirUrl", url);                 // Android la abre con su app (o Chrome)
  if (/^https?:/.test(url)) window.open(url, "_blank", "noopener");   // la app la agarra (o se abre en Chrome)
  else location.href = url;                                          // intent:, tel:, spotify:...
  return {ok: true};
}

// ---------- El teléfono (en la app de Android) ----------
// Las apps y los contactos se leen en el celular y quedan en el celular: al bot nunca le llegan.

const PREFIJOS = {uy: "598", ar: "54", br: "55", cl: "56", py: "595", bo: "591", pe: "51", ec: "593", co: "57", ve: "58",
                  mx: "52", es: "34", us: "1", it: "39", fr: "33", de: "49", gb: "44"};

function distancia(a, b) {
  // cuántas letras hay que cambiar para pasar de a a b (para «whatsap», «spotyfi»)
  const d = Array.from({length: a.length + 1}, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function elMejor(lista, buscado, clave) {
  // El que más se parece a lo que dijiste: igual, después empieza igual, después lo contiene, después casi igual
  const q = normalizar(buscado).replace(/^(?:la |el |mi |a |al |app |la app de |aplicacion de )+/, "").trim();
  if (!q) return null;
  const puntaje = (x) => {
    const n = clave(x);
    if (n === q) return 100;
    if (n.startsWith(q + " ")) return 90;            // «Juan» -> «Juan Pérez» (antes que «Juana»)
    if (n.split(" ").includes(q)) return 85;         // «Pérez» -> «Juan Pérez»
    if (n.startsWith(q)) return 75 - Math.min(20, n.length - q.length);
    if (q.length >= 4 && n.includes(q)) return 60;
    if (n.length >= 4 && q.length - n.length <= 4 && q.includes(n)) return 50;
    const d = distancia(q, n.slice(0, q.length + 1));
    return q.length >= 5 && d <= 2 ? 40 - d * 5 : 0;
  };
  let mejor = null, mejorPuntaje = 0;
  lista.forEach((x) => {
    const p = puntaje(x);
    if (p > mejorPuntaje) { mejor = x; mejorPuntaje = p; }
  });
  return mejor;
}

const Telefono = {
  lasApps: null,
  losContactos: null,

  apps() {
    if (!this.lasApps) this.lasApps = (Nativo.ya("apps") || []).map((a) => ({nombre: a.n, paquete: a.p, clave: normalizar(a.n)}));
    return this.lasApps;
  },

  buscarApp(nombre) {
    // la que nombraste, entre las instaladas («wsp» -> WhatsApp, «la cámara» -> Cámara)
    const conocida = appDe(nombre);
    const nombres = [nombre].concat(conocida ? [conocida.nombre].concat(conocida.alias || []) : []);
    for (const n of nombres) {
      const app = elMejor(this.apps(), n, (a) => a.clave);
      if (app) return app;
    }
    return null;
  },

  async contactos() {
    if (!this.losContactos) {
      let r = Nativo.ya("contactos");
      if (!r.permiso) {
        if (!(await Nativo.cuando("pedirPermiso", "contactos")).si) return null;
        r = Nativo.ya("contactos");
      }
      this.losContactos = (r.lista || []).map((c) => ({nombre: c.n, numeros: c.t, clave: normalizar(c.n)}));
    }
    return this.losContactos;
  },

  async buscarContacto(nombre) {
    const lista = await this.contactos();
    if (!lista) return {sinPermiso: true};
    const c = elMejor(lista, nombre.replace(/^(?:a |al |a la )/i, ""), (x) => x.clave);
    return c ? {contacto: c, numero: c.numeros[0]} : {};
  },

  paraWhatsapp(numero) {
    // wa.me pide el número completo con el código del país, sin + ni ceros adelante
    let n = String(numero || "").replace(/[^\d+]/g, "");
    if (n.startsWith("+")) return n.slice(1);
    if (n.startsWith("00")) return n.slice(2);
    const prefijo = PREFIJOS[Nativo.info.pais] || "598";
    if (n.startsWith("0")) return prefijo + n.slice(1);
    return n.length <= 9 && !n.startsWith(prefijo) ? prefijo + n : n;
  },
};

async function numeroDe(a) {
  // El número de una acción: el que dijo el bot, o el del contacto que nombraste. {numero, nombre} o {problema}
  if (a.numero) return {numero: a.numero, nombre: a.para || a.numero};
  if (!a.para) return {problema: "No sé a quién."};
  if (!Nativo.hay) return {problema: `No sé el número de ${a.para}.`};
  const r = await Telefono.buscarContacto(a.para);
  if (r.sinPermiso) return {problema: `Para encontrar a ${a.para} necesito permiso para ver tus contactos (${DONDE_PERMISOS}).`};
  if (!r.numero) return {problema: `No encontré a «${a.para}» en tus contactos.`};
  return {numero: r.numero, nombre: r.contacto.nombre};
}

function horaDe(hora) {
  // "07:30" -> [7, 30]
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const AJUSTES_CELULAR = {wifi: "wifi", "wi fi": "wifi", bluetooth: "bluetooth", ubicacion: "ubicacion", gps: "ubicacion",
  sonido: "sonido", pantalla: "pantalla", brillo: "pantalla", bateria: "bateria", "modo avion": "avion", avion: "avion",
  datos: "datos", "datos moviles": "datos", "no molestar": "no_molestar", notificaciones: "notificaciones",
  almacenamiento: "almacenamiento", asistente: "asistente"};

async function hacerEnElTelefono(a) {
  // Lo que pidió el bot (o vos): en la app de Android se hace solo, sin tocar nada. Devuelve {ok, texto}
  const ok = (r, texto) => ({ok: !r || r.ok !== false, texto: texto});
  switch (a.tipo) {
    case "abrir": {
      const app = Telefono.buscarApp(a.app);
      const conocida = appDe(a.app);
      if (a.busqueda && conocida && conocida.buscar) return ok(abrirUrl(conocida.buscar(encodeURIComponent(a.busqueda))), `Abriendo ${conocida.nombre}.`);
      if (app) return ok(Nativo.ya("abrirApp", app.paquete), `Abriendo ${app.nombre}.`);
      if (conocida) return ok(abrirUrl(conocida.url), `Abriendo ${conocida.nombre}.`);
      return {ok: false, texto: `No encontré «${a.app}» en el celular.`};
    }
    case "musica":
      return ok(abrirUrl(accionAUrl(a).url), "");
    case "whatsapp": {
      const n = await numeroDe(a);
      if (n.problema && a.para) return {ok: false, texto: n.problema};
      const texto = encodeURIComponent(a.mensaje || "");
      const url = n.numero ? `https://wa.me/${Telefono.paraWhatsapp(n.numero)}?text=${texto}` : `https://wa.me/?text=${texto}`;
      return ok(abrirUrl(url), "");
    }
    case "llamar": {
      const n = await numeroDe(a);
      if (n.problema) return {ok: false, texto: n.problema};
      if (!Nativo.ya("permisos").telefono) await Nativo.cuando("pedirPermiso", "telefono");   // sin permiso: el marcador
      return ok(Nativo.ya("llamar", n.numero), `Llamando a ${n.nombre}.`);
    }
    case "alarma": {
      const h = horaDe(a.hora);
      if (!h) return {ok: false, texto: "No entendí la hora de la alarma."};
      const r = Nativo.ya("alarma", h[0], h[1], a.mensaje || "");
      return r.ok ? {ok: true, texto: `Alarma a las ${a.hora}.`} : {ok: false, texto: "Tu celular no me dejó poner la alarma."};
    }
    case "temporizador": {
      const r = Nativo.ya("temporizador", a.segundos, a.mensaje || "");
      return r.ok ? {ok: true, texto: `Temporizador de ${duracionLinda(a.segundos)}.`} : {ok: false, texto: "Tu celular no me dejó poner el temporizador."};
    }
    case "linterna": {
      const r = Nativo.ya("linterna", a.prender === undefined ? "cambiar" : a.prender ? "prender" : "apagar");
      if (!r.ok) return {ok: false, texto: r.error === "ocupada" ? "La linterna la está usando la cámara." : "Este celular no tiene linterna."};
      return {ok: true, texto: r.prendida ? "Linterna prendida." : "Linterna apagada."};
    }
    case "volumen": {
      const r = Nativo.ya("volumen", String(a.accion));
      return r.ok ? {ok: true, texto: a.accion === "silencio" ? "Silencio." : `Volumen al ${r.nivel}%.`} : {ok: false, texto: "No pude cambiar el volumen."};
    }
    case "ajustes":
      return ok(Nativo.ya("ajustes", a.que || "general"), "");
  }
  return {ok: false, texto: ""};
}

const imagenesGrandes = new Map();   // las imágenes que hizo JARVIS, enteras (en la charla queda una chica)

async function prepararImagenes(acciones) {
  // Una imagen que hizo JARVIS: en la charla, una copia chica (la grande no entra en lo guardado del celular); la
  // grande queda a mano para «Guardar»
  let miniatura = null;
  for (const a of acciones) {
    if (a.tipo !== "imagen" || !a.datos) continue;
    const ref = "img" + Date.now() + Math.random().toString(36).slice(2, 6);
    imagenesGrandes.set(ref, {mime: a.mime, datos: a.datos});
    try {
      miniatura = await miniaturaDe(await (await fetch(`data:${a.mime};base64,${a.datos}`)).blob());
    } catch (e) { /* sin miniatura: queda el botón */ }
    delete a.datos;
    a.ref = ref;
  }
  return miniatura;
}

async function miniaturaDe(blob) {
  // (más grande que la de las fotos que mandás: es para verla en la charla)
  const img = await new Promise((listo, error) => {
    const i = new Image();
    i.onload = () => listo(i);
    i.onerror = error;
    i.src = URL.createObjectURL(blob);
  });
  const escala = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.round(img.naturalWidth * escala);
  lienzo.height = Math.round(img.naturalHeight * escala);
  lienzo.getContext("2d").drawImage(img, 0, 0, lienzo.width, lienzo.height);
  URL.revokeObjectURL(img.src);
  return lienzo.toDataURL("image/jpeg", 0.8);
}

function guardarImagen(a) {
  const grande = imagenesGrandes.get(a.ref);
  if (!grande) return avisar("Esa imagen ya no la tengo entera: pedímela de nuevo.", 4);
  if (Nativo.hay) {
    const r = Nativo.ya("guardarImagen", grande.datos, grande.mime);
    return avisar(r.ok ? "Guardada en la galería (carpeta JARVIS)." : "No pude guardarla en este celular.", 4);
  }
  const enlace = document.createElement("a");   // en la web: se baja
  enlace.href = `data:${grande.mime};base64,${grande.datos}`;
  enlace.download = "jarvis." + (grande.mime.split("/")[1] || "png");
  enlace.click();
}

async function hacerAcciones(acciones) {
  // Lo que pidió el bot: en Android se hace ya; en la web, solo si recién tocaste algo (si no, queda el botón).
  // (Un documento o una imagen: solo el botón.) Devuelve el problema, si hubo (por ejemplo, un contacto que no está)
  acciones = (acciones || []).filter((a) => a.tipo !== "abrir_url" && a.tipo !== "imagen");
  if (!acciones.length) return null;
  if (!Nativo.hay) {
    if (Date.now() - ultimoToque < 4500) abrirUrl(accionAUrl(acciones[0]).url);
    return null;
  }
  let problema = null;
  for (const a of acciones) {
    const r = await hacerEnElTelefono(a);
    if (!r.ok && r.texto) problema = r.texto;
  }
  return problema;
}

function pintarAcciones(contenedor, acciones) {
  contenedor.innerHTML = "";
  (acciones || []).forEach((a) => {
    const boton = document.createElement("button");
    boton.className = "accion";
    if (a.tipo === "imagen") {
      boton.textContent = "⤓ Guardar imagen";
      boton.onclick = () => guardarImagen(a);
    } else if (a.tipo === "abrir_url") {   // un documento que hizo JARVIS
      const {texto, url} = accionAUrl(a);
      boton.textContent = "▶ " + texto;
      boton.onclick = () => abrirUrl(url);
    } else if (Nativo.hay) {   // (ya se hizo solo: el botón es para repetirlo)
      boton.textContent = "▶ " + textoDeAccion(a);
      boton.onclick = () => hacerEnElTelefono(a).then((r) => { if (r.texto) avisar(r.texto, 2.5); });
    } else {
      const {texto, url} = accionAUrl(a);
      boton.textContent = "▶ " + texto;
      boton.onclick = () => abrirUrl(url);
    }
    contenedor.appendChild(boton);
  });
}

function textoDeAccion(a) {
  if (a.tipo === "alarma") return "Alarma " + a.hora;
  if (a.tipo === "temporizador") return "Temporizador " + duracionLinda(a.segundos);
  if (a.tipo === "linterna") return "Linterna";
  if (a.tipo === "volumen") return "Volumen";
  if (a.tipo === "ajustes") return "Abrir ajustes";
  if (a.tipo === "llamar") return "Llamar" + (a.para ? " a " + a.para : "");
  return accionAUrl(a).texto;
}

function duracionLinda(segundos) {
  const h = Math.floor(segundos / 3600), m = Math.floor((segundos % 3600) / 60), s = segundos % 60;
  return [h ? h + (h === 1 ? " hora" : " horas") : "", m ? m + (m === 1 ? " minuto" : " minutos") : "",
          s ? s + " segundos" : ""].filter(Boolean).join(" y ") || "0 segundos";
}

// ---------- Lo que se resuelve en el celular, al toque y sin internet (sin preguntarle al bot) ----------

const NUMEROS = {un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
                 diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, media: 0.5};

function duracionDe(t) {
  // "10 minutos", "una hora y media", "2 minutos y 30 segundos" -> segundos
  let total = 0, encontro = false;
  const re = /(\d+(?:[.,]\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|media)\s*(horas?|h|minutos?|min|segundos?|seg|s)\b/g;
  for (const m of t.matchAll(re)) {
    const n = NUMEROS[m[1]] !== undefined ? NUMEROS[m[1]] : Number(m[1].replace(",", "."));
    const u = m[2].startsWith("h") ? 3600 : m[2].startsWith("m") ? 60 : 1;
    total += n * u;
    encontro = true;
  }
  if (/\b(?:hora|horas|minuto|minutos) y media\b/.test(t)) total += /hora y media|horas y media/.test(t) ? 1800 : 30;
  if (!encontro && /^media hora$/.test(t.trim())) total = 1800;
  return total > 0 ? Math.round(total) : null;
}

function horaDicha(t) {
  // "7", "7:30", "7 y media", "las 9 de la noche", "19", "8 menos cuarto" -> "HH:MM"
  // (los minutos pueden venir como "7:30" o, ya sin signos, "7 30")
  const m = /(\d{1,2})(?:(?:[:.]|\s+)(\d{2})(?!\d))?(?:\s*(?:y\s*(media|cuarto)|menos\s*cuarto))?\s*(am|pm|de la manana|de la tarde|de la noche|de la madrugada)?/.exec(t);
  if (!m) return null;
  let h = Number(m[1]), min = m[2] ? Number(m[2]) : 0;
  if (m[3] === "media") min = 30;
  else if (m[3] === "cuarto") min = 15;
  else if (/menos\s*cuarto/.test(m[0])) { h -= 1; min = 45; }
  if ((m[4] === "pm" || m[4] === "de la tarde" || m[4] === "de la noche") && h < 12) h += 12;
  if (m[4] === "am" && h === 12) h = 0;
  if (h < 0) h = 23;
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

const LOCALES = [
  // los ajustes: «abrí el wifi», «ajustes de bluetooth» (una app no puede prender el wifi sola: abre su ajuste)
  {re: /^(?:(?:abr[ie]\w*|anda a|mostra\w*|prend[ei]\w*|activa\w*|apaga\w*|desactiva\w*)\s+)?(?:(?:los |el |la )?(?:ajustes|configuracion|opciones) (?:de(?:l)? |de la )?|el |la |los )?(wi fi|wifi|bluetooth|ubicacion|gps|sonido|brillo|pantalla|bateria|modo avion|avion|datos moviles|datos|no molestar|notificaciones|almacenamiento)$/,
   nativo: true, accion: (m) => ({tipo: "ajustes", que: AJUSTES_CELULAR[m[1]]})},
  // «abrí WhatsApp», «abrime la cámara»
  {re: /^(?:abr[ie]\w*|entra(?:me)? a|anda a|inicia\w*|ejecuta\w*)\s+(?:el |la |los |las |mi |la app de |la aplicacion de |el app de )?(.+)$/,
   accion: (m) => ({tipo: "abrir", app: m[1]}), solo: (m) => Nativo.hay ? !!Telefono.buscarApp(m[1]) || !!appDe(m[1]) : !!appDe(m[1])},
  // «llamá a mamá», «llamar a Juan»
  {re: /^(?:llama(?:le)?|llamar|marca(?:le)?|hace(?:me)? una llamada)\s+(?:a |al |a la )?(.+)$/, nativo: true,
   accion: (m) => /^[\d ]{6,}$/.test(m[1]) ? {tipo: "llamar", numero: m[1].replace(/\D/g, "")} : {tipo: "llamar", para: m[1]}},
  // «poné una alarma a las 7», «despertame a las 7 y media», «alarma para las 6:15»
  {re: /^(?:(?:pone(?:me)?|crea(?:me)?|programa(?:me)?|activa(?:me)?)\s+)?(?:una\s+)?alarma\s+(?:a|para)\s+(?:las?\s+)?(.+)$|^desperta(?:me)?\s+(?:a|para)\s+(?:las?\s+)?(.+)$/,
   nativo: true, accion: (m) => { const h = horaDicha(m[1] || m[2]); return h && {tipo: "alarma", hora: h}; }},
  // «temporizador de 10 minutos», «poné un timer de 5 minutos»
  {re: /^(?:(?:pone(?:me)?|activa\w*|inicia\w*)\s+)?(?:un\s+)?(?:temporizador|timer|cronometro)\s+(?:de|por|en)\s+(.+)$/, nativo: true,
   accion: (m) => { const s = duracionDe(m[1]); return s && {tipo: "temporizador", segundos: s}; }},
  // la linterna
  {re: /^(?:prend[ei]\w*|encend[ei]\w*|activa\w*|pone(?:me)?)\s+(?:la\s+)?linterna$/, nativo: true, accion: () => ({tipo: "linterna", prender: true})},
  {re: /^(?:apag\w*|desactiva\w*|saca(?:me)?)\s+(?:la\s+)?linterna$/, nativo: true, accion: () => ({tipo: "linterna", prender: false})},
  {re: /^linterna$/, nativo: true, accion: () => ({tipo: "linterna"})},
  // el volumen
  {re: /^(?:subi\w*|sube|aumenta\w*|mas)\s+(?:el\s+)?volumen$|^volumen\s+(?:mas\s+)?alto$/, nativo: true, accion: () => ({tipo: "volumen", accion: "subir"})},
  {re: /^(?:baja\w*|disminu\w*|menos)\s+(?:el\s+)?volumen$|^volumen\s+(?:mas\s+)?bajo$/, nativo: true, accion: () => ({tipo: "volumen", accion: "bajar"})},
  {re: /^(?:silencio|silencia\w*|mute\w*)(?:\s+el\s+celular)?$/, nativo: true, accion: () => ({tipo: "volumen", accion: "silencio"})},
  {re: /^(?:pone(?:me)?\s+)?(?:el\s+)?volumen\s+(?:al|a|en)\s+(\d{1,3})\s*(?:%|por ciento)?$/, nativo: true,
   accion: (m) => ({tipo: "volumen", accion: m[1]})},
  {re: /^(?:pone(?:me)?\s+)?(?:el\s+)?volumen\s+(?:al\s+)?maximo$/, nativo: true, accion: () => ({tipo: "volumen", accion: "maximo"})},
];

function respuestaLocal(t) {
  // Lo que se contesta sin preguntarle a nadie: la hora, la fecha, la batería
  const ahora = new Date();
  if (/^(?:que hora es|me (?:decis|das) la hora|hora|la hora)$/.test(t)) {
    return `Son las ${String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}.`;
  }
  if (/^(?:que (?:dia|fecha) es(?: hoy)?|que fecha tenemos|en que dia estamos|que dia es mañana)$/.test(t)) {
    const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    return `Hoy es ${DIAS[ahora.getDay()]} ${ahora.getDate()} de ${meses[ahora.getMonth()]}.`;
  }
  if (Nativo.hay && /^(?:(?:cuanta|que|cuanto de|como (?:esta|anda) (?:la|mi))\s+)?bateria(?:\s+(?:tengo|me queda|hay|queda|tiene el celular))?$/.test(t)) {
    const b = Nativo.ya("bateria");
    return `Tenés ${b.nivel}% de batería${b.cargando ? " y se está cargando" : ""}.`;
  }
  return null;
}

async function hacerLocal(texto) {
  // {texto, acciones} si se resolvió en el celular; null si es para el bot
  const t = normalizar(texto).replace(/^(?:jarvis\s+|che\s+|dale\s+|por favor\s+)+/, "").replace(/\s+por favor$/, "")
    .replace(/^(?:podes|podrias|me podes|me podrias|queres)\s+/, "");
  const dicho = respuestaLocal(t);
  if (dicho) return {texto: dicho, acciones: []};
  for (const l of LOCALES) {
    if (l.nativo && !Nativo.hay) continue;
    const m = l.re.exec(t);
    if (!m || (l.solo && !l.solo(m))) continue;
    const accion = l.accion(m);
    if (!accion) continue;
    if (!Nativo.hay) {   // (en la web solo se abren apps conocidas)
      const r = accionAUrl(accion);
      abrirUrl(r.url);
      return {texto: r.texto.replace(/^Abrir/, "Abriendo") + ".", acciones: [accion]};
    }
    const r = await hacerEnElTelefono(accion);
    return {texto: r.texto || "Listo.", acciones: r.ok ? [accion] : []};
  }
  return null;
}


// ---------- El cerebro del celular: sin internet, JARVIS piensa en el celular (como en la PC, con Gemma) ----------
// En la app de Android: Gemma 4 corre en el teléfono (se baja una vez, con wifi). Sabe lo que el celular tiene guardado
// (tus recuerdos, pendientes, recordatorios, el último clima, la PC). Con internet contesta Gemini, como siempre.

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
               "noviembre", "diciembre"];

const Cerebro = {
  alPedazo: null,   // a quién le va pasando lo que escribe

  estado() {
    if (!Nativo.hay) return null;
    try {
      return Nativo.ya("cerebroEstado");
    } catch (e) {
      return null;   // (una app vieja, sin cerebro)
    }
  },

  modelo() {
    // el que elegiste; si no, Gemma 4 (o el liviano, si el celular tiene poca memoria)
    return ajustes.modelo || (Nativo.info.ram && Nativo.info.ram < 5 ? "qwen3" : "gemma4");
  },

  info() {
    const e = this.estado();
    return e && e.modelos ? e.modelos.find((m) => m.id === this.modelo()) || null : null;
  },

  listo() {
    const m = this.info();
    return !!(m && m.listo);
  },

  bajar() {
    return Nativo.ya("cerebroBajar", this.modelo(), ajustes.soloWifi !== false);
  },

  preparar() {
    if (this.listo()) window.JarvisNativo.cerebroPreparar(this.modelo());
  },

  parar() {
    if (Nativo.hay && window.JarvisNativo.cerebroParar) window.JarvisNativo.cerebroParar();
  },

  async preguntar(texto, alPedazo) {
    this.alPedazo = alPedazo;
    try {
      return await Nativo.cuando("cerebroPreguntar", this.modelo(), sistemaDelCelular(), claveDelCelular(),
                                 JSON.stringify(historiaDelCelular()), texto, 400);
    } finally {
      this.alPedazo = null;
    }
  },
};
Nativo.al("cerebro", (d) => { if (Cerebro.alPedazo) Cerebro.alPedazo(d.pedazo); });

function horaLinda(fecha) {
  return String(fecha.getHours()).padStart(2, "0") + ":" + String(fecha.getMinutes()).padStart(2, "0");
}

function cuandoLindo(iso) {
  // "2026-10-26T09:00" -> "mañana a las 09:00" (calculado ahora: lo guardado puede ser de ayer)
  const f = new Date(String(iso).slice(0, 16));
  if (isNaN(f)) return String(iso);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const dias = Math.round((new Date(f.getFullYear(), f.getMonth(), f.getDate()) - hoy) / 86400000);
  const dia = dias === 0 ? "hoy" : dias === 1 ? "mañana" : dias === -1 ? "ayer"
    : `el ${DIAS[f.getDay()]} ${f.getDate()}/${f.getMonth() + 1}`;
  return `${dia} a las ${horaLinda(f)}`;
}

function sistemaDelCelular() {
  // Quién es y lo que sabe (lo que el celular tiene guardado), como lo lee el cerebro del celular
  const d = datosDia || {};
  const ahora = new Date();
  const lineas = [
    "Sos J.A.R.V.I.S., el asistente personal del usuario, y le hablás desde su celular. Ahora estás funcionando "
      + "adentro del celular, sin internet.",
    "Hablá en español rioplatense (voseo: «tenés», «querés»), cálido y breve: de una a cuatro oraciones, como se habla "
      + "en voz alta, sin listas, sin asteriscos y sin emojis.",
    "Preguntas sobre el mundo (historia, ciencia, geografía, libros, idiomas, cuentas, recetas, consejos, cómo hacer "
      + "algo): contestalas con lo que sabés, directo, como siempre. Para eso no hace falta internet: no lo menciones.",
    "Sobre su vida, usá solo lo que está abajo; si no está, decí que no lo sabés. Sin internet no podés ver datos que "
      + "cambian (precios, cotizaciones, noticias, resultados de partidos), sus mails ni mandarle órdenes a la PC: eso, "
      + "cuando vuelva internet.",
    `Hoy es ${DIAS[ahora.getDay()]} ${ahora.getDate()} de ${MESES[ahora.getMonth()]} de ${ahora.getFullYear()}. `
      + `Cuando empezó esta charla eran las ${horaLinda(ahora)}.`,
  ];
  const recuerdos = (d.recuerdos || []).slice(-40);
  if (recuerdos.length) lineas.push("", "Lo que sabés del usuario:", ...recuerdos.map((r) => "- " + r));
  const pendientes = d.pendientes || [];
  lineas.push("Sus pendientes: " + (pendientes.length ? pendientes.map((p) => p.texto.replace(/ ⏳$/, "")
    + (p.para ? ` (para ${fechaLinda(p.para)})` : "")).join("; ") : "ninguno") + ".");
  const recordatorios = (d.recordatorios || []).filter((r) => new Date(String(r.cuando).slice(0, 16)) > ahora);
  lineas.push("Sus recordatorios: " + (recordatorios.length ? recordatorios.map((r) => `${cuandoLindo(r.cuando)}, ${r.texto}`)
    .join("; ") : "ninguno") + ".");
  if (d.clima) {
    // cada día con su nombre de hoy («mañana (lunes 26)») y sin los que ya pasaron: así no se confunde
    const c = d.clima, hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const dias = c.dias.map((x) => {
      const f = new Date(x.fecha + "T12:00");
      const dif = Math.round((new Date(f.getFullYear(), f.getMonth(), f.getDate()) - hoy) / 86400000);
      if (dif < 0) return null;
      const dia = `${DIAS[f.getDay()]} ${f.getDate()}`;
      return `${dif === 0 ? `hoy (${dia})` : dif === 1 ? `mañana (${dia})` : `el ${dia}`}: de ${x.minima} a ${x.maxima} grados, `
        + `${x.lluvia} por ciento de probabilidad de lluvia`;
    }).filter(Boolean);
    const visto = d.ahora ? cuandoLindo(d.ahora) : "hace un rato";
    lineas.push(`El pronóstico en ${c.lugar} (visto ${visto}, cuando hacía ${c.ahora.temperatura} grados y estaba `
      + `${c.ahora.cielo}): ${dias.length ? dias.join("; ") : "no hay de estos días"}.`);
  }
  if (d.pc && !d.pc.nota) lineas.push(`Su PC: la última vez estaba ${d.pc.prendida ? "prendida" : "apagada"}.`);
  return lineas.join("\n");
}

function claveDelCelular() {
  // Cambia cuando cambia lo que sabe (otro día, o se actualizó Mi día): entonces el cerebro arma la charla de nuevo
  const d = datosDia || {};
  return [new Date().toDateString(), d.ahora || "", (d.pendientes || []).length, (d.recordatorios || []).length,
          (d.recuerdos || []).length].join("|");
}

function historiaDelCelular() {
  // Lo último de la charla (sin el mensaje que se está contestando), para que siga el hilo
  const lista = mensajes.slice(0, -1).filter((m) => (m.quien === "vos" || m.quien === "jarvis") && m.texto)
    .slice(-6).map((m) => ({r: m.quien === "vos" ? "user" : "model", t: m.texto.replace(/^🎙️ /, "")}));
  const limpia = [];
  lista.forEach((m) => {
    if (limpia.length && limpia[limpia.length - 1].r === m.r) limpia[limpia.length - 1].t += "\n" + m.t;
    else if (limpia.length || m.r === "user") limpia.push(m);
  });
  // las viejas, cortitas (la última va entera: así sabe que la charla sigue desde ahí)
  return limpia.map((m, i) => (i < limpia.length - 1 ? {r: m.r, t: m.t.slice(0, 400)} : m));
}

// Lo que cambia datos (pendientes, recordatorios, recuerdos): sin internet se hace igual en el celular, y cuando
// vuelve internet se le pasa al bot solo, sin avisar (así queda también en la PC y en Telegram)
const paraAnotar = (t) => String(t || "").trim().replace(/^jarvis[,\s]+/i, "").replace(/[.!¡¿?]+$/g, "").trim();

function cuandoDelRecordatorio(t) {
  // "mañana a las 9 llamar al dentista" -> {fecha, texto}. null si no dice cuándo
  let resto = " " + t + " ";
  const ahora = new Date();
  let fecha = null, hora = null;
  const en = /\s(?:en|dentro de)\s+((?:\d+|un|una|media)\s*(?:horas?|h|minutos?|min)(?:\s+y\s+(?:media|\d+\s*minutos?))?)\s/i.exec(resto);
  if (en) {
    const s = duracionDe(normalizar(en[1]));
    if (s) {
      fecha = new Date(ahora.getTime() + s * 1000);
      resto = resto.replace(en[0], " ");
    }
  }
  if (!fecha) {
    // primero la hora (así «9 de la mañana» no se confunde con el día de mañana), después el día
    const lahora = /\s(?:a\s+las?|tipo|para\s+las?)\s+(\d{1,2}(?:[:.]\d{2})?(?:\s*y\s*(?:media|cuarto)|\s*menos\s*cuarto)?(?:\s*(?:am|pm|de\s+la\s+(?:ma[ñn]ana|tarde|noche|madrugada)))?)\s/i.exec(resto);
    if (lahora) {
      hora = horaDicha(normalizar(lahora[1]));
      resto = resto.replace(lahora[0], " ");
    }
    const dia = /\s(hoy|pasado\s+ma[ñn]ana|ma[ñn]ana|el\s+(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo))\s/i.exec(resto);
    if (dia) {
      resto = resto.replace(dia[0], " ");
      fecha = new Date(ahora);
      const d = normalizar(dia[1]);
      if (d.startsWith("pasado")) fecha.setDate(fecha.getDate() + 2);
      else if (d.startsWith("manana")) fecha.setDate(fecha.getDate() + 1);
      else if (dia[2]) {
        const quiere = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"].indexOf(normalizar(dia[2]));
        fecha.setDate(fecha.getDate() + ((quiere - fecha.getDay() + 7) % 7 || 7));
      }
    }
    if (!fecha && !hora) return null;
    const [h, m] = (hora || "09:00").split(":").map(Number);   // (un día sin hora: a las 9, como en la PC)
    if (!fecha) {
      fecha = new Date(ahora);
      fecha.setHours(h, m, 0, 0);
      if (fecha <= ahora) fecha.setDate(fecha.getDate() + 1);   // (esa hora ya pasó hoy: mañana)
    } else {
      fecha.setHours(h, m, 0, 0);
    }
  }
  const texto = resto.replace(/\s+/g, " ").trim().replace(/^(?:que|de|para|el|la)\s+/i, "").trim();
  return texto ? {fecha, texto: texto.charAt(0).toUpperCase() + texto.slice(1)} : null;
}

function isoLocal(f) {
  const d = (n) => String(n).padStart(2, "0");
  return `${f.getFullYear()}-${d(f.getMonth() + 1)}-${d(f.getDate())}T${d(f.getHours())}:${d(f.getMinutes())}`;
}

function datoSinInternet(texto) {
  // {texto} si era para anotar algo (y ya quedó anotado en el celular); null si es para pensar
  const t = paraAnotar(texto);
  if (!datosDia) datosDia = {pendientes: [], recordatorios: [], recuerdos: []};
  const sincronizar = () => encolar({accion: "app_mensaje", datos: {texto: t}, silencioso: true});
  let m = /^(?:agreg[aá](?:me)?|anot[aá](?:me)?|sum[aá](?:me)?|pon[eé](?:me)?)\s+(.+?)\s+(?:a|en)\s+(?:mis\s+|los\s+|la\s+lista\s+de\s+)?pendientes$/i.exec(t);
  if (m) {
    const p = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    datosDia.pendientes.push({id: "cel" + Date.now(), texto: p, para: null});
    guardar("dia", datosDia);
    pintarDia();
    encolar({accion: "app_pendiente", datos: {que: "agregar", texto: p}, silencioso: true});
    return `Listo, agregué «${p}» a tus pendientes.`;
  }
  m = /^acord[aá]te\s+(?:de\s+)?que\s+(.+)$/i.exec(t);
  if (m) {
    datosDia.recuerdos = (datosDia.recuerdos || []).concat(m[1]);
    guardar("dia", datosDia);
    sincronizar();
    return "Dale, me lo acuerdo.";
  }
  m = /^(?:record[aá]me|acord[aá]me|avis[aá]me)\s+(.+)$/i.exec(t);
  if (m) {
    const r = cuandoDelRecordatorio(m[1]);
    if (!r) return "¿Para cuándo? Decímelo así: «recordame mañana a las 9 llamar al dentista».";
    datosDia.recordatorios = (datosDia.recordatorios || []).concat({id: "cel" + Date.now(), cuando: isoLocal(r.fecha),
                                                                     texto: r.texto, falta: cuandoLindo(isoLocal(r.fecha))});
    guardar("dia", datosDia);
    pintarDia();
    programarAvisos();   // suena desde el celular a esa hora, haya o no internet
    sincronizar();
    return `Listo, te lo recuerdo ${cuandoLindo(isoLocal(r.fecha))}: ${r.texto}.`;
  }
  return null;
}

async function contestarEnElCelular(texto, opciones) {
  // Sin internet (o si Google no contesta): lo piensa el cerebro del celular, que va escribiendo (y, si le estás
  // hablando, lo va diciendo frase por frase). opciones: {hablarYa, alEscribir, porVoz, sinVoz, llamada}
  pensando(true);
  const voz = opciones.hablarYa ? Voz.enPartes() : null;
  let escrito = "", burbuja = null;
  const r = await Cerebro.preguntar(texto, (pedazo) => {
    if (!burbuja) {
      pensando(false);
      agregar({quien: "jarvis", texto: "", local: true});
      burbuja = $("mensajes").lastElementChild.querySelector("span:last-child");
    }
    escrito += pedazo;
    burbuja.textContent = escrito;
    bajar();
    if (opciones.alEscribir) opciones.alEscribir(escrito);
    if (voz) voz.agregar(pedazo);
  });
  pensando(false);
  const respuesta = (r.texto || escrito).trim();
  if (!respuesta) {
    const aviso = "El cerebro del celular no pudo contestar" + (r.error ? ` (${r.error})` : "") + ". Probá de nuevo.";
    agregar({quien: "aviso", texto: aviso});
    return {texto: aviso, tarjetas: [], acciones: [], error: true};
  }
  if (!burbuja) agregar({quien: "jarvis", texto: respuesta, local: true});
  else {
    mensajes[mensajes.length - 1].texto = respuesta;
    guardar("mensajes", mensajes);
  }
  if (voz) await voz.terminar();
  else if (!opciones.sinVoz && !opciones.llamada && (ajustes.leer === "siempre" || (ajustes.leer === "auto" && opciones.porVoz))) {
    Voz.decir(respuesta);
  }
  return {texto: respuesta, tarjetas: [], acciones: [], local: true, dicho: !!voz};
}


// ---------- La charla ----------

function escapar(texto) {
  return String(texto).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function conFormato(texto) {
  return escapar(texto)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function pintarMensaje(m, indice) {
  const div = document.createElement("div");
  div.className = "msg " + m.quien + (m.local ? " local" : "");
  if (m.quien !== "aviso") {
    const quien = document.createElement("span");
    quien.className = "quien";
    quien.textContent = m.quien === "vos" ? "VOS" : m.local ? "JARVIS · SIN INTERNET" : "JARVIS";
    div.appendChild(quien);
  }
  const texto = document.createElement("span");
  texto.innerHTML = conFormato(m.texto || "");
  div.appendChild(texto);
  if (m.imagen) {
    const img = document.createElement("img");
    img.className = "foto";
    img.src = m.imagen;
    div.appendChild(img);
  }
  if (m.archivo) {
    const archivo = document.createElement("span");
    archivo.className = "archivo-adjunto";
    archivo.textContent = "📄 " + m.archivo;
    div.appendChild(archivo);
  }
  if (m.acciones && m.acciones.length) {
    const caja = document.createElement("div");
    caja.className = "acciones";
    pintarAcciones(caja, m.acciones);
    div.appendChild(caja);
  }
  (m.tarjetas || []).forEach((t, i) => div.appendChild(pintarTarjeta(t, indice, i)));
  return div;
}

function pintarTarjeta(t, indiceMensaje, indiceTarjeta) {
  // Algo que hay que confirmar (mandar un mail, borrar, una orden para la PC): no se hace sin tu botón
  const caja = document.createElement("div");
  caja.className = "tarjeta-confirmar";
  caja.textContent = t.texto;
  if (t.resultado) {
    const r = document.createElement("div");
    r.className = "resultado";
    r.textContent = "→ " + t.resultado;
    caja.appendChild(r);
    return caja;
  }
  const botones = document.createElement("div");
  botones.className = "botones";
  const si = document.createElement("button");
  si.className = "boton principal";
  si.textContent = t.si || "Confirmar";
  const no = document.createElement("button");
  no.className = "boton";
  no.textContent = "Cancelar";
  const responder = async (confirmar) => {
    si.disabled = no.disabled = true;
    try {
      const r = await api("app_confirmar", {id: t.id, si: confirmar});
      t.resultado = (r.mensajes || []).join(" ") || (confirmar ? "Hecho." : "Cancelado.");
    } catch (e) {
      si.disabled = no.disabled = false;
      avisar(e.message);
      return;
    }
    if (mensajes[indiceMensaje] && mensajes[indiceMensaje].tarjetas) mensajes[indiceMensaje].tarjetas[indiceTarjeta] = t;
    guardar("mensajes", mensajes);
    caja.replaceWith(pintarTarjeta(t, indiceMensaje, indiceTarjeta));
    if (llamada.activa || vistaActual === "inicio") Voz.decir(t.resultado);
  };
  si.onclick = () => responder(true);
  no.onclick = () => responder(false);
  botones.append(si, no);
  caja.appendChild(botones);
  return caja;
}

function bajar() {
  const lista = $("mensajes");
  lista.scrollTop = lista.scrollHeight;
}

function pintarCharla() {
  const lista = $("mensajes");
  lista.innerHTML = "";
  if (!mensajes.length) {
    lista.appendChild(pintarMensaje({quien: "jarvis", texto: "Hola, soy JARVIS. Escribime, tocá el micrófono para "
      + "hablarme, o tocá Llamar para charlar con manos libres."}, -1));
  }
  mensajes.forEach((m, i) => lista.appendChild(pintarMensaje(m, i)));
  bajar();
}

function agregar(m) {
  mensajes.push(m);
  if (mensajes.length > 150) mensajes = mensajes.slice(-150);
  guardar("mensajes", mensajes);
  if (mensajes.length === 1) pintarCharla();
  else $("mensajes").appendChild(pintarMensaje(m, mensajes.length - 1));
  bajar();
  return m;
}

function pensando(si) {
  $("logo").classList.toggle("pensando", si);
  const viejo = document.querySelector(".msg.pensando");
  if (viejo) viejo.remove();
  if (si) {
    const div = document.createElement("div");
    div.className = "msg jarvis pensando";
    div.textContent = "Pensando";
    $("mensajes").appendChild(div);
    bajar();
  }
}

async function mandar(texto, opciones = {}) {
  // Le manda algo a JARVIS y muestra la respuesta. opciones: {foto, archivo, audio, llamada, porVoz, sinVoz}
  // Devuelve siempre {texto, tarjetas, acciones}: si falló, texto es el motivo de verdad (y error: true)
  const foto = opciones.foto || null, archivo = opciones.archivo || null;
  const mio = agregar({quien: "vos", texto: texto || (opciones.audio ? "🎙️ ..." : ""), imagen: foto ? foto.miniatura : null,
                       archivo: archivo ? archivo.nombre : null});
  // un archivo de texto, sin internet: lo lee el cerebro del celular
  const textoDelArchivo = archivo && !hayInternet() ? leerTexto(archivo) : null;
  const local = !foto && !archivo && !opciones.audio && texto ? await hacerLocal(texto) : null;   // «abrí WhatsApp», «linterna»: al toque
  if (local) {
    agregar({quien: "jarvis", texto: local.texto, acciones: local.acciones});
    return {texto: local.texto, tarjetas: [], acciones: local.acciones, local: true};
  }
  const sinInternet = () => {
    // sin internet y sin el cerebro del celular: lo escrito queda en la cola y sale solo cuando vuelve
    if (foto || archivo || opciones.audio) {
      return "No hay internet, así que no pude mandarte " + (foto ? "la foto" : archivo ? "el archivo" : "la grabación")
        + ". Probá cuando vuelva." + (archivo ? " (Sin internet leo archivos de texto, no PDFs ni audios.)" : "");
    }
    encolar({accion: "app_mensaje", datos: {texto: texto}});
    return "No hay internet. Te lo mando apenas vuelva." + (Nativo.hay && Cerebro.estado()
      ? " (Para que te conteste sin internet, bajá el cerebro del celular: Ajustes › Cerebro sin internet.)" : "");
  };
  const soloTexto = (texto && !foto && !archivo && !opciones.audio) || !!textoDelArchivo;
  const enElCelular = async (motivo) => {
    // anotar algo se hace igual (y se sincroniza solo después); lo demás lo piensa el cerebro del celular
    if (textoDelArchivo) {
      if (!Cerebro.listo()) return null;
      return contestarEnElCelular((texto || "Resumime este archivo en pocas líneas.") + `\n\n(Archivo «${archivo.nombre}»:)\n`
                                  + textoDelArchivo, opciones);
    }
    const dato = Nativo.hay ? datoSinInternet(texto) : null;
    if (dato) {
      agregar({quien: "jarvis", texto: dato, local: true});
      if (!opciones.llamada && !opciones.sinVoz && (ajustes.leer === "siempre" || (ajustes.leer === "auto" && opciones.porVoz))) {
        Voz.decir(dato);
      }
      return {texto: dato, tarjetas: [], acciones: [], local: true};
    }
    if (!Cerebro.listo()) return null;
    if (motivo) agregar({quien: "aviso", texto: motivo});
    return contestarEnElCelular(texto, opciones);
  };
  if (!hayInternet()) {
    const r = soloTexto ? await enElCelular() : null;
    if (r) return r;
    const aviso = sinInternet();
    agregar({quien: "aviso", texto: "⏳ " + aviso});
    return {texto: aviso, tarjetas: [], acciones: [], error: true, enCola: soloTexto};
  }
  pensando(true);
  try {
    const r = await api("app_mensaje", {texto: texto || "", llamada: !!opciones.llamada, audio: opciones.audio || null,
                                         imagen: foto ? {mime: "image/jpeg", datos: foto.datos} : null,
                                         archivo: archivo ? {mime: archivo.mime, datos: archivo.datos, nombre: archivo.nombre} : null},
                        archivo ? 180 : 100);
    if (r.pedido && !texto) {   // lo que entendió de la grabación, o lo que se preguntó de la foto
      mio.texto = (opciones.audio ? "🎙️ " : "") + r.pedido;
      guardar("mensajes", mensajes);
      pintarCharla();
    }
    if (!r.ok) throw new ErrorJarvis("bot", r.error === "mensaje vacío" ? "No te escuché bien. ¿Me lo repetís?" : (r.error || "No pude."));
    if (r.sin_cerebro && soloTexto) {   // Gemini no contestó (sin cupo, saturado): contesta el cerebro del celular
      pensando(false);
      const local = await enElCelular("Gemini no está contestando ahora: te contesto desde el celular.");
      if (local) return local;
    }
    let respuesta = (r.mensajes || []).join("\n\n");
    const acciones = r.acciones || [];
    const imagen = await prepararImagenes(acciones);   // (una imagen que hizo JARVIS)
    pensando(false);
    agregar({quien: "jarvis", texto: respuesta, tarjetas: r.tarjetas || [], acciones: acciones, imagen: imagen});
    const problema = await hacerAcciones(acciones);   // abrir la app, llamar, la alarma...
    if (problema) {
      agregar({quien: "aviso", texto: problema});
      respuesta = problema;   // (lo que se dice en voz alta: el problema, no «listo»)
    }
    if (!opciones.llamada && !opciones.sinVoz && respuesta
        && (ajustes.leer === "siempre" || (ajustes.leer === "auto" && opciones.porVoz))) {
      Voz.decir(respuesta);
    }
    return {texto: respuesta, tarjetas: r.tarjetas || [], acciones: acciones, pedido: r.pedido};
  } catch (e) {
    pensando(false);
    if (soloTexto && ["sin_red", "servidor", "http", "no_json", "tiempo"].includes(e.tipo)) {
      // se cortó internet, o Google no contesta: contesta el celular (si tiene el cerebro bajado)
      const r = await enElCelular(e.tipo === "sin_red" ? null : e.message.replace(/\s*Probá.*$/, "") + " Te contesto desde el celular.");
      if (r) return r;
    }
    const aviso = e.tipo === "sin_red" ? sinInternet() : e.message;
    agregar({quien: "aviso", texto: (e.tipo === "sin_red" ? "⏳ " : "") + aviso});
    return {texto: aviso, tarjetas: [], acciones: [], error: true};
  }
}

async function sincronizarCharla(datos) {
  // Lo que pasó en Telegram (o lo que contó la PC) aparece acá también. datos: la charla, si ya vino (al arrancar)
  if (!conexion) return;
  let d;
  try {
    d = datos || await apiLeer("app_charla");
  } catch (e) {
    return;
  }
  const firma = (m) => m.r + "|" + m.t;
  const charla = (d.charla || []).filter((m) => !/^\(Toc[oó] (Confirmar|Cancelar)\.\)$/.test(m.t)
                                                 && m.t !== "(Te pedí confirmación con un botón.)");
  let desde = 0;
  if (ultimaCharla) {
    const i = charla.map(firma).lastIndexOf(ultimaCharla);
    desde = i >= 0 ? i + 1 : 0;
  }
  const yaEstan = new Set();   // lo que ya se ve acá (también lo que contestó al tocar Confirmar en una tarjeta)
  mensajes.slice(-40).forEach((m) => {
    yaEstan.add(m.quien + "|" + m.texto.replace(/^🎙️ /, ""));
    (m.tarjetas || []).forEach((t) => { if (t.resultado) yaEstan.add("jarvis|" + t.resultado); });
  });
  charla.slice(desde).forEach((m) => {
    const quien = m.r === "user" ? "vos" : "jarvis";
    const texto = m.t.replace(/^\(Te mandó [^)]*\)\s*/, "").replace(/^\(La PC hizo lo que pediste\)\s*/, "")
      .replace(/^\(Desde la app, orden para la PC\)\s*/, "🖥️ Orden para la PC: ");
    if (!yaEstan.has(quien + "|" + texto)) agregar({quien: quien, texto: texto});
  });
  if (charla.length) {
    ultimaCharla = firma(charla[charla.length - 1]);
    guardar("ultimaCharla", ultimaCharla);
  }
}


// ---------- La barra de abajo de la charla: escribir, hablar, adjuntar y llamar ----------

let adjuntoListo = null;   // {tipo: "foto", datos, miniatura} o {tipo: "archivo", mime, datos, nombre, tam}
let dictando = false;
const MAX_ARCHIVO = 15 * 1024 * 1024;   // (lo mismo que acepta el bot)

function ajustarCaja() {
  const caja = $("caja");
  caja.style.height = "auto";
  caja.style.height = Math.min(caja.scrollHeight, 130) + "px";
  $("barra").classList.toggle("con-texto", caja.value.trim() !== "" || adjuntoListo !== null);
}

async function enviarLoEscrito() {
  const texto = $("caja").value.trim();
  if (!texto && !adjuntoListo) return dictar();
  const adjunto = adjuntoListo;
  $("caja").value = "";
  sacarFoto();
  ajustarCaja();
  await mandar(texto, adjunto && adjunto.tipo === "foto" ? {foto: adjunto} : {archivo: adjunto});
}

function tamanoLindo(bytes) {
  return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
}

async function prepararAdjunto(archivo) {
  // Una foto se achica (como mucho 1280 de lado); lo demás (PDF, audio, video, texto) va tal cual, hasta 15 MB
  if (/^image\/(jpeg|png|webp|heic|heif)$/.test(archivo.type)) return Object.assign({tipo: "foto"}, await prepararFoto(archivo));
  if (archivo.size > MAX_ARCHIVO) throw new Error(`Es muy grande (${tamanoLindo(archivo.size)}): hasta 15 MB.`);
  const datos = await new Promise((listo, error) => {
    const lector = new FileReader();
    lector.onload = () => listo(String(lector.result).split(",")[1] || "");
    lector.onerror = () => error(new Error("No pude abrir ese archivo."));
    lector.readAsDataURL(archivo);
  });
  const mime = archivo.type || ({txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json"}
    [(archivo.name.split(".").pop() || "").toLowerCase()] || "application/octet-stream");
  return {tipo: "archivo", mime: mime, datos: datos, nombre: archivo.name || "archivo", tam: archivo.size};
}

function leerTexto(archivo) {
  // Lo que dice un archivo de texto (para el cerebro del celular, sin internet): null si no es de texto
  if (!/^(text\/|application\/(json|xml|csv))/.test(archivo.mime || "")) return null;
  try {
    const bytes = Uint8Array.from(atob(archivo.datos), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes).slice(0, 6000);
  } catch (e) {
    return null;
  }
}

function mostrarAdjunto(adjunto) {
  adjuntoListo = adjunto;
  const esFoto = adjunto.tipo === "foto";
  $("foto-miniatura").hidden = !esFoto;
  if (esFoto) $("foto-miniatura").src = adjunto.miniatura;
  $("adjunto-texto").textContent = esFoto ? "Foto lista para mandar" : `📄 ${adjunto.nombre} (${tamanoLindo(adjunto.tam)})`;
  $("foto-lista").hidden = false;
  ajustarCaja();
  $("caja").placeholder = esFoto ? "¿Qué querés saber de la foto? (o mandala así)" : "¿Qué hago con el archivo? (o mandalo así)";
}

async function dictar() {
  // El micrófono de la charla: hablás, y lo manda solo cuando terminás
  if (dictando) {
    Oido.cortar();
    return;
  }
  Voz.callar();
  dictando = true;
  calentar();
  await Oido.soltar();   // si estaba esperando «Jarvis», deja el micrófono libre
  $("boton-enviar").classList.add("grabando");
  $("caja").placeholder = "Te escucho...";
  const r = await Oido.oir((parcial) => { $("caja").value = parcial; ajustarCaja(); });
  dictando = false;
  $("boton-enviar").classList.remove("grabando");
  $("caja").placeholder = "Escribile a JARVIS...";
  $("caja").value = "";
  ajustarCaja();
  if (sinOidoSinInternet(r)) return avisoOidoSinInternet();
  if (r.error === "not-allowed") return avisar(`Dale permiso al micrófono para hablarme (${DONDE_PERMISOS}).`, 6);
  if (r.audio) return mandar("", {audio: r.audio, porVoz: true});
  if (r.texto) return mandar(r.texto, {porVoz: true});
  avisar("No te escuché. Tocá el micrófono y hablá.");
}

async function prepararFoto(archivo) {
  // La achica (como mucho 1280 de lado) y la pasa a JPG: más rápido y sin gastar datos de más
  const imagen = await new Promise((listo, error) => {
    const img = new Image();
    img.onload = () => listo(img);
    img.onerror = error;
    img.src = URL.createObjectURL(archivo);
  });
  const dibujar = (lado, calidad) => {
    const escala = Math.min(1, lado / Math.max(imagen.naturalWidth, imagen.naturalHeight));
    const lienzo = document.createElement("canvas");
    lienzo.width = Math.round(imagen.naturalWidth * escala);
    lienzo.height = Math.round(imagen.naturalHeight * escala);
    lienzo.getContext("2d").drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
    return lienzo.toDataURL("image/jpeg", calidad);
  };
  const grande = dibujar(1280, 0.85);
  URL.revokeObjectURL(imagen.src);
  return {datos: grande.split(",")[1], miniatura: dibujar(220, 0.6)};
}

function sacarFoto() {
  adjuntoListo = null;
  $("foto-lista").hidden = true;
  $("archivo").value = "";
  $("caja").placeholder = "Escribile a JARVIS...";
}


// ---------- Inicio: como JARVIS en la PC ----------

let ocupado = false;   // está escuchando, pensando o hablando (por el botón o por «Jarvis»)

function estadoInicio(estado, texto) {
  const etiquetas = {escuchando: "TE ESCUCHO", pensando: "PENSANDO", hablando: "JARVIS", libre: "EN LÍNEA",
                     esperando: "DECÍ «JARVIS»"};
  $("inicio-estado").textContent = etiquetas[estado] || estado;
  $("inicio-estado").className = "inicio-estado " + estado;
  if (reactorInicio) reactorInicio.estado(estado === "esperando" ? "libre" : estado);
  if (texto !== undefined) $("inicio-texto").textContent = texto;
  $("boton-hablar").classList.toggle("grabando", estado === "escuchando" && !escucha.esperandoNombre);
}

async function procesarDicho(texto) {
  // Lo que le dijiste en Inicio (con el botón o con «Jarvis, ...»): piensa, lo dice en voz alta y hace lo que pidió
  ocupado = true;
  try {
    await Oido.soltar();   // que no quede escuchando mientras JARVIS habla (se oiría a sí mismo)
    estadoInicio("pensando", "«" + texto + "»");
    $("inicio-acciones").innerHTML = "";
    // (si contesta el cerebro del celular, se ve y se dice mientras lo va escribiendo)
    const r = await mandar(texto, {porVoz: true, sinVoz: true, hablarYa: true, alEscribir: (t) => estadoInicio("hablando", t)});
    const respuesta = r.texto || (r.tarjetas.length ? "Confirmalo acá abajo." : "Listo.");
    pintarAcciones($("inicio-acciones"), r.acciones);
    r.tarjetas.forEach((t, i) => $("inicio-acciones").appendChild(pintarTarjeta(t, mensajes.length - 1, i)));
    estadoInicio("hablando", respuesta);
    if (!r.dicho) await Voz.decir(respuesta);
  } finally {
    ocupado = false;
    estadoInicio(escucha.activa ? "esperando" : "libre");
  }
}

async function hablarEnInicio() {
  // El botón grande HABLAR
  if (ocupado) {
    Voz.callar();
    Oido.cortar();
    Cerebro.parar();
    return;
  }
  ocupado = true;
  Voz.callar();
  calentar();
  await Oido.soltar();   // si estaba esperando «Jarvis», deja de esperar
  estadoInicio("escuchando", "Te escucho...");
  const r = await Oido.oir((parcial) => { $("inicio-texto").textContent = parcial; });
  ocupado = false;
  if (sinOidoSinInternet(r)) {
    estadoInicio("libre", avisoOidoSinInternet());
    return;
  }
  if (r.error === "not-allowed") {
    estadoInicio("libre", `Dale permiso al micrófono para hablarme (${DONDE_PERMISOS}).`);
    return;
  }
  if (r.audio) {
    ocupado = true;
    estadoInicio("pensando", "");
    const respuesta = await mandar("", {audio: r.audio, porVoz: true, sinVoz: true});
    ocupado = false;
    estadoInicio("hablando", respuesta ? respuesta.texto : "No te entendí.");
    if (respuesta) {
      pintarAcciones($("inicio-acciones"), respuesta.acciones);
      await Voz.decir(respuesta.texto);
    }
    estadoInicio("libre");
    return;
  }
  if (!r.texto) {
    estadoInicio("libre", "No te escuché. Tocá el micrófono y hablá.");
    return;
  }
  await procesarDicho(r.texto);
}

async function preguntarYHacer(pregunta, armar) {
  // Un protocolo que necesita un dato: «¿Qué música te pongo?» -> lo que digas
  cambiarVista("inicio");
  if (ocupado) return;
  ocupado = true;
  await Oido.soltar();
  estadoInicio("hablando", pregunta);
  await Voz.decir(pregunta);
  estadoInicio("escuchando", pregunta);
  const r = await Oido.oir((parcial) => { $("inicio-texto").textContent = parcial; });
  ocupado = false;
  if (r.texto) await procesarDicho(armar(r.texto));
  else estadoInicio("libre", "No te escuché. Probá de nuevo.");
}

// «Jarvis, ...»: con la app abierta en Inicio, escucha todo el tiempo y responde cuando lo nombrás (como el manos
// libres de la PC). Android hace un pitidito cada vez que vuelve a escuchar: es del celular, no se puede sacar
const escucha = {activa: false, corriendo: false, esperandoNombre: false};
const NOMBRE = /\b(?:j|y|h|ch)ar[vb]is\b[\s,.:!¡¿?]*(.*)$/i;

let enPausa = false;   // (la app de Android) quedó por detrás de otra app

function puedeEscuchar() {
  return escucha.activa && vistaActual === "inicio" && document.visibilityState === "visible" && !enPausa && !llamada.activa;
}

async function cicloJarvis() {
  // (en la web: el reconocimiento de Chrome, con la app abierta. En la app de Android lo hace Escucha.java)
  if (escucha.corriendo || !puedeOir || Nativo.hay) return;
  escucha.corriendo = true;
  let errores = 0;
  try {
    while (puedeEscuchar()) {
      if (ocupado) {
        await esperar(400);
        continue;
      }
      escucha.esperandoNombre = true;
      estadoInicio("esperando");
      const r = await Oido.escuchar();
      escucha.esperandoNombre = false;
      if (!puedeEscuchar()) break;
      if (r.error === "not-allowed" || r.error === "service-not-allowed") {
        activarEscucha(false);
        estadoInicio("libre", `Dale permiso al micrófono para que te escuche (${DONDE_PERMISOS}).`);
        break;
      }
      if (r.error && !["no-speech", "aborted"].includes(r.error)) {
        if (++errores > 3) await esperar(4000);   // sin internet o algo raro: que no quede dando vueltas
        continue;
      }
      errores = 0;
      const m = NOMBRE.exec(r.texto || "");
      if (!m || ocupado) continue;
      let pedido = m[1].trim();
      if (!pedido) {   // dijiste solo «Jarvis»: te escucha el pedido
        ocupado = true;
        if (navigator.vibrate) navigator.vibrate(30);
        estadoInicio("escuchando", "¿Sí?");
        const r2 = await Oido.escuchar((parcial) => { $("inicio-texto").textContent = parcial; });
        ocupado = false;
        pedido = (r2.texto || "").trim();
        if (!pedido) continue;
      }
      await procesarDicho(pedido);
    }
  } finally {
    escucha.corriendo = false;
    escucha.esperandoNombre = false;
    if (!ocupado) estadoInicio("libre");
  }
}

const UMBRALES = {alta: 0.08, normal: 0.15, baja: 0.3};   // «Hey Jarvis»: qué tan seguro tiene que estar para despertarse

async function activarEscuchaFondo(si, callado) {
  // En la app de Android, «Hey Jarvis» lo escucha el celular: también con la app cerrada, sin internet y sin mandar el
  // audio a ningún lado (como «Ok Google»). Android muestra una notificación mientras escucha
  if (si) {
    if (!Nativo.ya("permisos").microfono && !(await Nativo.cuando("pedirPermiso", "microfono")).si) {
      si = false;
      if (!callado) avisar(`Para escucharte, dale permiso al micrófono (${DONDE_PERMISOS}).`, 6);
    } else if (!Nativo.ya("permisos").notificaciones && !callado) {
      await Nativo.cuando("pedirPermiso", "notificaciones");
    }
  }
  const r = Nativo.ya("escuchaFondo", si, UMBRALES[ajustes.sensibilidad] || UMBRALES.normal, ajustes.pantallaApagada !== false);
  ajustes.escucharJarvis = si && !!r.prendida;
  guardar("ajustes", ajustes);
  $("escuchar-jarvis").checked = ajustes.escucharJarvis;
  if (callado || !si) return;
  if (!r.prendida) avisar("No pude prender la escucha. Probá de nuevo con la app abierta.", 5);
  else if (!r.sobreApps) {
    avisar("Listo: decí «Hey Jarvis». Para que se abra sola aunque estés en otra app, dale el permiso «Mostrar sobre otras apps».",
           14, {texto: "Dar permiso", hacer: () => window.JarvisNativo.permisoSobreApps()});
  } else {
    avisar("Listo: decí «Hey Jarvis» cuando quieras, aunque la app esté cerrada.", 5);
  }
}

function activarEscucha(si) {
  if (Nativo.hay) return activarEscuchaFondo(si);
  escucha.activa = si && puedeOir;
  ajustes.escucharJarvis = escucha.activa;
  guardar("ajustes", ajustes);
  $("escuchar-jarvis").checked = escucha.activa;
  if (si && !puedeOir) avisar("Este celular no tiene reconocimiento de voz: usá el botón HABLAR.", 5);
  if (escucha.activa) cicloJarvis();
  else if (escucha.esperandoNombre) Oido.cancelar();
}

function pausarEscucha() {
  // otra cosa usa el micrófono (la charla, la llamada): deja de esperar «Jarvis» (vuelve solo después)
  if (escucha.esperandoNombre) Oido.cancelar();
}

// Los protocolos de Inicio (como los de la PC)
const ICONOS = {
  llamar: '<path d="M6.6 3.5l3 3.3-1.8 2.4a12 12 0 0 0 7 7l2.4-1.8 3.3 3-1.8 3.1C11 21 3 13 3.5 5.3z"/>',
  musica: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  whatsapp: '<path d="M4 20l1.4-4A8 8 0 1 1 8 18.6z"/><path d="M9 9c0 3 3 6 6 6l1-1.5-2-1-1 1c-1 0-2-1-2-2l1-1-1-2z"/>',
  clima: '<circle cx="9" cy="10" r="3.5"/><path d="M9 3v1.5M3.5 10H2M5 5l1 1M13 5l-1 1M8 20h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.4 1.8A2.6 2.6 0 0 0 8 20z"/>',
  noticias: '<rect x="3" y="5" width="15" height="14" rx="1.5"/><path d="M18 9h3v8a2 2 0 0 1-4 0M7 9h7M7 13h7M7 16h4"/>',
  recordar: '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M5 4L3 6M19 4l2 2"/>',
  dia: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M8 14h3"/>',
  mails: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  abrir: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><path d="M17 14v6M14 17h6"/>',
  foto: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  juego: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 10v4M5 12h4M15 11h.01M18 13h.01"/>',
};
const PROTOCOLOS = [
  {id: "llamar", nombre: "Llamar", hacer: () => llamar()},
  {id: "musica", nombre: "Música", hacer: () => preguntarYHacer("¿Qué música te pongo?", (t) => "Poné en el celular música de " + t)},
  {id: "whatsapp", nombre: "WhatsApp", hacer: () => preguntarYHacer("¿A quién le escribo y qué le digo?", (t) => "Mandá un WhatsApp: " + t)},
  {id: "clima", nombre: "Clima", hacer: () => procesarDichoDesdeToque("¿Cómo está el clima hoy y mañana?")},
  {id: "noticias", nombre: "Noticias", hacer: () => procesarDichoDesdeToque("Contame en pocas oraciones las noticias más importantes de hoy.")},
  {id: "recordar", nombre: "Recordame", hacer: () => preguntarYHacer("¿Qué te recuerdo y cuándo?", (t) => "Recordame " + t)},
  {id: "dia", nombre: "Mi día", hacer: () => procesarDichoDesdeToque("¿Qué tengo hoy? Contame mi día en pocas oraciones.")},
  {id: "mails", nombre: "Mails", hacer: () => cambiarVista("mails")},
  {id: "abrir", nombre: "Abrir app", hacer: () => preguntarYHacer("¿Qué app abro?", (t) => "Abrí " + t)},
  {id: "foto", nombre: "¿Qué es esto?", hacer: () => fotoYPreguntar()},
  {id: "pc", nombre: "Mi PC", soloPc: true, hacer: () => cambiarVista("pc")},
  {id: "juego", nombre: "Modo juego", soloPc: true, hacer: () => ordenParaLaPc("Modo juego")},
];

async function procesarDichoDesdeToque(texto) {
  cambiarVista("inicio");
  if (ocupado) return;
  ocupado = true;
  await Oido.soltar();
  ocupado = false;
  procesarDicho(texto);
}

function pintarProtocolos() {
  const caja = $("protocolos");
  caja.innerHTML = "";
  PROTOCOLOS.filter((p) => !p.soloPc || tienePc()).forEach((p) => {
    const boton = document.createElement("button");
    boton.className = "protocolo";
    boton.innerHTML = `<span class="hex"><svg viewBox="0 0 24 24">${ICONOS[p.id]}</svg></span><span>${p.nombre}</span>`;
    boton.onclick = p.hacer;
    caja.appendChild(boton);
  });
}

function fotoYPreguntar() {
  // la cámara: sacás una foto y JARVIS te dice qué es (y lo dice en voz alta)
  const entrada = document.createElement("input");
  entrada.type = "file";
  entrada.accept = "image/*";
  entrada.capture = "environment";
  entrada.onchange = async () => {
    if (!entrada.files[0]) return;
    cambiarVista("inicio");
    ocupado = true;
    try {
      await Oido.soltar();
      const foto = await prepararFoto(entrada.files[0]);
      estadoInicio("pensando", "Mirando la foto...");
      const r = await mandar("¿Qué es esto? Contámelo breve.", {foto: foto, porVoz: true, sinVoz: true});
      estadoInicio("hablando", r.texto);
      await Voz.decir(r.texto);
    } catch (e) {
      avisar("No pude abrir esa foto.");
    } finally {
      ocupado = false;
      estadoInicio(escucha.activa ? "esperando" : "libre");
    }
  };
  entrada.click();
}


// ---------- La llamada: manos libres ----------

const llamada = {activa: false, pausada: false, silencios: 0, inicio: 0, reloj: null, pantalla: null, tocar: null};

function estadoLlamada(estado, texto) {
  const etiquetas = {escuchando: "TE ESCUCHO", pensando: "PENSANDO", hablando: "JARVIS", libre: "EN PAUSA"};
  $("llamada-estado").textContent = etiquetas[estado] || estado;
  $("llamada-estado").className = "llamada-estado " + estado;
  reactorLlamada.estado(estado);
  if (texto !== undefined) $("llamada-texto").textContent = texto;
}

function esperarToque() {
  return new Promise((listo) => { llamada.tocar = listo; });
}

async function llamar() {
  if (!conexion) return mostrarConectar();
  if (llamada.activa) return;
  Voz.callar();
  Object.assign(llamada, {activa: true, pausada: false, silencios: 0, inicio: Date.now()});
  Oido.soltar();   // si estaba esperando «Jarvis», deja el micrófono (para cuando termine el saludo ya está libre)
  $("aviso").hidden = true;
  $("llamada").hidden = false;
  $("llamada-tarjetas").innerHTML = "";
  $("boton-pausa").classList.remove("pausado");
  reactorLlamada.prender();
  if (reactorInicio) reactorInicio.apagar();
  llamada.reloj = setInterval(() => {
    const s = Math.floor((Date.now() - llamada.inicio) / 1000);
    $("llamada-tiempo").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
  calentar();
  if (Nativo.hay) {   // que la pantalla no se apague mientras hablan
    window.JarvisNativo.pantallaPrendida(true);
  } else {
    try {
      llamada.pantalla = await navigator.wakeLock.request("screen");
    } catch (e) { /* no se puede: sigue igual */ }
  }
  estadoLlamada("hablando", "Hola, te escucho.");
  await Voz.decir("Hola, te escucho.");
  cicloLlamada();
}

function esCortar(texto) {
  const t = normalizar(texto);
  return /^(chau|chao|adios|nos vemos|hasta luego|colga|colgamos|corta|corta la llamada|corto|termina la llamada)( jarvis)?$/.test(t);
}

async function cicloLlamada() {
  while (llamada.activa) {
    if (llamada.pausada) {
      estadoLlamada("libre", "El micrófono está en pausa. Tocá el reactor (o el micrófono) para seguir.");
      await esperarToque();
      llamada.pausada = false;
      $("boton-pausa").classList.remove("pausado");
      continue;
    }
    estadoLlamada("escuchando", "");
    if (navigator.vibrate) navigator.vibrate(25);
    const oido = await Oido.oir((parcial) => { $("llamada-texto").textContent = parcial; });
    if (!llamada.activa) return;
    if (oido.error === "not-allowed" || oido.error === "service-not-allowed") {
      await Voz.decir("No tengo permiso para usar el micrófono.");
      avisar(`Dale permiso al micrófono a la app (${DONDE_PERMISOS}) y llamame de nuevo.`, 7);
      return colgar();
    }
    if (sinOidoSinInternet(oido)) {
      await Voz.decir("Sin internet todavía no te puedo escuchar. Mirá la pantalla.");
      avisoOidoSinInternet();
      return colgar();
    }
    if (!oido.texto && !oido.audio) {   // silencio: después de 3, se pone en pausa (no queda escuchando de más)
      if (++llamada.silencios >= 3 && !llamada.pausada) llamada.pausada = true;
      continue;
    }
    llamada.silencios = 0;
    if (oido.texto && esCortar(oido.texto)) {
      estadoLlamada("hablando", "Dale, corto.");
      await Voz.decir("Dale, corto. Cualquier cosa me llamás.");
      return colgar();
    }
    estadoLlamada("pensando", oido.texto ? "«" + oido.texto + "»" : "");
    const r = await mandar(oido.texto, {llamada: true, audio: oido.audio, hablarYa: true,
                                        alEscribir: (t) => estadoLlamada("hablando", t)});
    if (!llamada.activa) return;
    let respuesta = r ? r.texto : "Uy, no me pude conectar. ¿Probamos de nuevo?";
    $("llamada-tarjetas").innerHTML = "";
    if (r && r.acciones.length) {   // abrir una app, música, WhatsApp: el botón aparece en la llamada
      pintarAcciones($("llamada-tarjetas"), r.acciones);
    }
    if (r && r.tarjetas.length) {   // hay que confirmar algo: los botones aparecen en la llamada también
      r.tarjetas.forEach((t, i) => $("llamada-tarjetas").appendChild(pintarTarjeta(t, mensajes.length - 1, i)));
      if (!respuesta) respuesta = "Confirmalo en la pantalla.";
    }
    estadoLlamada("hablando", respuesta);
    if (!r.dicho) await Voz.decir(respuesta);
  }
}

function colgar() {
  if (!llamada.activa) return;
  llamada.activa = false;
  Oido.cancelar();
  Voz.callar();
  Cerebro.parar();
  clearInterval(llamada.reloj);
  if (llamada.pantalla) llamada.pantalla.release().catch(() => {});
  llamada.pantalla = null;
  if (Nativo.hay) window.JarvisNativo.pantallaPrendida(false);
  if (llamada.tocar) llamada.tocar();
  reactorLlamada.apagar();
  $("llamada").hidden = true;
  if (vistaActual === "inicio" && reactorInicio) reactorInicio.prender();
  if (escucha.activa) cicloJarvis();
}

function tocarReactor() {
  // Mientras habla: lo interrumpís. En pausa: sigue escuchando. Escuchando: manda lo que ya dijiste
  if (!llamada.activa) return;
  if (llamada.tocar) {
    const seguir = llamada.tocar;
    llamada.tocar = null;
    return seguir();
  }
  if ($("llamada-estado").classList.contains("hablando")) Voz.callar();
  else if ($("llamada-estado").classList.contains("escuchando")) Oido.cortar();
}

function pausar() {
  if (!llamada.activa) return;
  if (llamada.pausada || llamada.tocar) {
    tocarReactor();
    return;
  }
  llamada.pausada = true;
  $("boton-pausa").classList.add("pausado");
  Oido.cancelar();
  Voz.callar();
}


// ---------- Mi día y la PC ----------

async function cargarDatos(datos) {
  // datos: lo de Mi día, si ya vino (al arrancar). Sin internet queda lo último que se vio
  if (!conexion) return;
  try {
    const d = datos || await apiLeer("app_datos");
    if (d.ok) {
      datosDia = d;
      guardar("dia", d);
      programarAvisos();
    }
  } catch (e) { /* queda lo último que se vio */ }
  pintarDia();
  pintarPc();
  pintarProtocolos();
}

async function programarAvisos() {
  // En la app de Android, los recordatorios suenan desde el celular a la hora justa, aunque no haya internet
  if (!Nativo.hay || !datosDia || !datosDia.recordatorios) return;
  if (ajustes.avisos === false) return window.JarvisNativo.programarAvisos("[]");
  if (!ajustes.avisosPedido && !Nativo.ya("permisos").notificaciones) {   // la primera vez: el permiso para avisar
    ajustes.avisosPedido = true;
    guardar("ajustes", ajustes);
    await Nativo.cuando("pedirPermiso", "notificaciones");
  }
  window.JarvisNativo.programarAvisos(JSON.stringify(datosDia.recordatorios.map((r) => ({id: r.id, cuando: r.cuando, texto: r.texto}))));
}

const DIAS_CORTOS = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function fechaLinda(iso) {
  // "2026-10-30" -> "el jueves 30/10"
  const d = new Date(String(iso).slice(0, 10) + "T12:00");
  if (isNaN(d)) return String(iso);
  return `el ${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

function pintarDia() {
  const d = datosDia;
  if (!d) return;
  const clima = $("clima");
  if (d.clima) {
    const c = d.clima, hoy = c.dias[0];
    clima.innerHTML = `<div class="clima-ahora"><div class="clima-grados">${c.ahora.temperatura}°</div>
      <div class="clima-detalle"><b>${escapar(c.lugar)}</b><br>${escapar(c.ahora.cielo)}<br>Hoy de ${hoy.minima}° a
      ${hoy.maxima}° · lluvia ${hoy.lluvia}%</div></div><div class="clima-dias">${c.dias.map((x, i) => `<div><b>${i === 0 ? "HOY"
      : DIAS_CORTOS[new Date(x.fecha + "T12:00").getDay()]}</b>${x.minima}° / ${x.maxima}°<br>💧 ${x.lluvia}%</div>`).join("")}</div>`;
  } else {
    clima.innerHTML = '<div class="cargando">No pude ver el clima.</div>';
  }

  const recordatorios = $("recordatorios");
  recordatorios.innerHTML = "";
  if (!d.recordatorios.length) recordatorios.innerHTML = '<div class="vacio">No tenés recordatorios.</div>';
  d.recordatorios.forEach((r) => {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<span class="texto"><span class="cuando">${escapar(r.falta.toUpperCase())}</span>${escapar(r.texto)}</span>`;
    item.appendChild(botonBorrar(`¿Borro el recordatorio «${r.texto}»?`, () => api("app_recordatorio", {id: r.id})));
    recordatorios.appendChild(item);
  });

  const pendientes = $("pendientes");
  pendientes.innerHTML = "";
  if (!d.pendientes.length) pendientes.innerHTML = '<div class="vacio">No tenés pendientes. ¡Bien ahí!</div>';
  d.pendientes.forEach((p) => {
    const item = document.createElement("div");
    item.className = "item";
    const tilde = document.createElement("button");
    tilde.className = "tilde";
    tilde.setAttribute("aria-label", "Hecho");
    tilde.onclick = async () => {
      tilde.classList.add("hecho");
      await accionDia(() => api("app_pendiente", {que: "hecho", id: p.id}), "¡Hecho!");
    };
    const texto = document.createElement("span");
    texto.className = "texto";
    texto.innerHTML = escapar(p.texto) + (p.para ? `<span class="para">para ${escapar(fechaLinda(p.para))}</span>` : "");
    item.append(tilde, texto, botonBorrar(`¿Borro el pendiente «${p.texto}»?`, () => api("app_pendiente", {que: "borrar", id: p.id})));
    pendientes.appendChild(item);
  });
}

function botonBorrar(pregunta, accion) {
  const boton = document.createElement("button");
  boton.className = "borrar";
  boton.setAttribute("aria-label", "Borrar");
  boton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';
  boton.onclick = () => { if (confirm(pregunta)) accionDia(accion, "Borrado."); };
  return boton;
}

async function accionDia(accion, aviso) {
  try {
    const d = await accion();
    if (!d.ok) throw new Error(d.error || "No pude.");
    datosDia = d;
    guardar("dia", d);
    pintarDia();
    if (aviso) avisar(aviso, 2);
  } catch (e) {
    avisar(e.message);
    pintarDia();
  }
}

function pintarPc() {
  const d = datosDia;
  $("ver-pc").hidden = !tienePc();
  if (!d || !d.pc) return;
  const pc = d.pc;
  let html;
  if (pc.nota) {
    html = `<div class="pc-linea"><i class="punto"></i>Todavía no sé nada de la PC</div><div class="pc-detalle">${escapar(pc.nota)}.</div>`;
  } else {
    html = `<div class="pc-linea"><i class="punto ${pc.prendida ? "bien" : "mal"}"></i>La PC está ${pc.prendida ? "prendida" : "apagada"}</div>`;
    const detalles = ["Última noticia: " + pc.ultimo_contacto + "."];
    if (pc.jugando) detalles.push("🎮 Estás jugando" + (pc.juego ? " " + pc.juego : "") + (pc.juego_minutos ? " hace " + pc.juego_minutos + " min" : "") + ".");
    if (pc.bateria !== undefined) detalles.push("🔋 Batería " + pc.bateria + "%" + (pc.enchufada ? " (enchufada)" : "") + ".");
    if (pc.resumen) detalles.push(pc.resumen);
    html += `<div class="pc-detalle">${escapar(detalles.join("\n"))}</div>`;
  }
  $("pc-estado").innerHTML = html;
}

async function ordenParaLaPc(orden) {
  orden = orden.trim();
  if (!orden || !confirm(`¿Le mando esto a JARVIS en la PC?\n\n«${orden}»`)) return false;
  try {
    const r = await api("app_orden", {orden: orden});
    if (!r.ok) throw new Error(r.error || "No pude.");
    const texto = (r.mensajes || []).join(" ");
    agregar({quien: "vos", texto: "🖥️ Orden para la PC: " + orden});
    agregar({quien: "jarvis", texto: texto});
    avisar(texto, 5);
    return true;
  } catch (e) {
    avisar(e.message);
    return false;
  }
}


// ---------- Mails ----------

async function cargarMails() {
  const lista = $("mails");
  lista.innerHTML = '<div class="cargando">Buscando tus mails...</div>';
  let d;
  try {
    d = await apiLeer("app_mails");
    if (!d.ok) throw new Error(d.error || "No pude ver los mails.");
  } catch (e) {
    lista.innerHTML = `<div class="vacio">${escapar(e.message)}</div>`;
    return;
  }
  lista.innerHTML = "";
  if (!d.mails.length) lista.innerHTML = '<div class="vacio">No tenés mails sin leer. 📭</div>';
  d.mails.forEach((m) => {
    const item = document.createElement("div");
    item.className = "item mail";
    item.innerHTML = `<div class="texto"><span class="cuando">${escapar(m.de.toUpperCase())} · ${escapar(m.fecha)}</span>
      <b>${escapar(m.asunto)}</b><span class="para">${escapar(m.resumen)}</span></div>
      <div class="mail-botones"><button class="boton" data-que="leer">Leer en voz alta</button>
      <button class="boton" data-que="resumir">Resumir</button><button class="boton" data-que="responder">Responder</button></div>
      <form class="fila-agregar mail-respuesta" hidden autocomplete="off"><input placeholder="¿Qué le contesto?">
      <button class="boton principal">Mandar</button></form>`;
    item.querySelector(".texto").onclick = () => item.classList.toggle("abierto");
    item.querySelector('[data-que="leer"]').onclick = async () => {
      try {
        const r = await api("app_mail", {id: m.id});
        Voz.decir(`Mail de ${m.de}. ${m.asunto}. ${(r.mail && r.mail.texto || "").slice(0, 900)}`);
      } catch (e) {
        avisar(e.message);
      }
    };
    item.querySelector('[data-que="resumir"]').onclick = () => {
      cambiarVista("charla");
      mandar(`Resumime en pocas oraciones el mail de ${m.de} con asunto «${m.asunto}» (id ${m.id}).`, {porVoz: true});
    };
    const form = item.querySelector(".mail-respuesta");
    item.querySelector('[data-que="responder"]').onclick = () => {
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("input").focus();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const texto = form.querySelector("input").value.trim();
      if (!texto) return;
      cambiarVista("charla");
      mandar(`Respondé el mail id ${m.id} (de ${m.de}, «${m.asunto}») diciendo: ${texto}`);
    };
    lista.appendChild(item);
  });
}


// ---------- Pestañas, ajustes e instalar ----------

function cambiarVista(nombre) {
  if (nombre === "pc" && !tienePc()) nombre = "inicio";
  vistaActual = nombre;
  document.querySelectorAll(".vista").forEach((v) => v.classList.toggle("activa", v.id === "vista-" + nombre));
  document.querySelectorAll(".pestana[data-vista]").forEach((b) => b.classList.toggle("activa", b.dataset.vista === nombre));
  if (reactorInicio) {
    if (nombre === "inicio" && !llamada.activa) reactorInicio.prender();
    else reactorInicio.apagar();
  }
  if (nombre !== "inicio") pausarEscucha();
  else if (escucha.activa) cicloJarvis();
  if (nombre === "charla") bajar();
  else if (nombre === "mails") cargarMails();
  else if (nombre === "dia" || nombre === "pc") cargarDatos();
}

function llenarVoces() {
  const select = $("ajuste-voz");
  if (!select) return;
  const voces = Voz.voces();
  const elegida = Voz.elegida();
  select.innerHTML = voces.length ? "" : "<option>La del celular</option>";
  voces.forEach((v) => {
    const opcion = document.createElement("option");
    opcion.value = v.name;
    opcion.textContent = `${v.name} (${v.lang})`;
    opcion.selected = elegida && v.name === elegida.name;
    select.appendChild(opcion);
  });
}

function abrirAjustes() {
  llenarVoces();
  $("ajuste-leer").value = ajustes.leer;
  $("ajuste-musica").value = ajustes.musica;
  $("ajuste-velocidad").value = ajustes.velocidad;
  $("velocidad-valor").textContent = ajustes.velocidad.toFixed(2) + "x";
  $("ajuste-avisos").checked = ajustes.avisos !== false;
  $("ajuste-sensibilidad").value = ajustes.sensibilidad || "normal";
  $("ajuste-pantalla-apagada").checked = ajustes.pantallaApagada !== false;
  $("ajustes-nativos").hidden = !Nativo.hay;
  if (Nativo.hay) {   // el cerebro sin internet: cómo va la bajada, mientras están abiertos los ajustes
    pintarCerebro();
    clearInterval(abrirAjustes.reloj);
    abrirAjustes.reloj = setInterval(() => { if ($("ajustes").open) pintarCerebro(); else clearInterval(abrirAjustes.reloj); }, 1000);
  }
  $("ajustes-android").hidden = Nativo.hay || !/Android/i.test(navigator.userAgent);
  $("ajustes-info").textContent = (Nativo.hay ? `App de Android ${Nativo.info.version || VERSION_APP}. ` : `Versión ${VERSION_APP}. `)
    + (puedeOir ? "Te escucha con el reconocimiento de voz del celular."
       : "Este celular no tiene reconocimiento de voz: graba y JARVIS lo pasa a texto.");
  $("ajustes").showModal();
}

function guardarAjustes() {
  ajustes.leer = $("ajuste-leer").value;
  ajustes.musica = $("ajuste-musica").value;
  ajustes.nombreVoz = $("ajuste-voz").value;
  ajustes.velocidad = Number($("ajuste-velocidad").value);
  const avisos = $("ajuste-avisos").checked;
  if (avisos !== (ajustes.avisos !== false)) {
    ajustes.avisos = avisos;
    programarAvisos();
  }
  // «Hey Jarvis»: si cambió algo y está prendido, se vuelve a prender con lo nuevo
  const sensibilidad = $("ajuste-sensibilidad").value, pantallaApagada = $("ajuste-pantalla-apagada").checked;
  const cambio = sensibilidad !== (ajustes.sensibilidad || "normal") || pantallaApagada !== (ajustes.pantallaApagada !== false);
  ajustes.sensibilidad = sensibilidad;
  ajustes.pantallaApagada = pantallaApagada;
  guardar("ajustes", ajustes);
  if (cambio && Nativo.hay && ajustes.escucharJarvis) activarEscuchaFondo(true, true);
}

// ---------- La app de Android: actualizaciones, el botón atrás y lo que llega de afuera ----------

async function buscarActualizacion(aMano) {
  // ¿Hay un APK nuevo publicado? (una vez cada 12 horas, o cuando tocás «Buscar actualización»)
  if (!Nativo.hay || !hayInternet()) return;
  if (!aMano && Date.now() - (leerGuardado("revisada", 0) || 0) < 12 * 3600000) return;
  guardar("revisada", Date.now());
  const r = await Nativo.cuando("pedir", "GET", ANDROID_WEB + "version.json?" + Date.now(), null, 20);
  let v = null;
  try {
    v = r.ok ? JSON.parse(r.cuerpo) : null;
  } catch (e) { /* no se pudo leer */ }
  if (v && v.codigo > (Nativo.info.codigo || 0)) {
    avisar(`Hay una versión nueva de JARVIS (${v.version}).`, 20,
           {texto: "Actualizar", hacer: () => abrirUrl(ANDROID_WEB + (v.apk || "JARVIS.apk"))});
  } else if (aMano) {
    avisar(v ? "Tenés la última versión." : "No pude ver si hay una versión nueva.", 3);
  }
}

// ---------- El cerebro sin internet: bajarlo (una vez) y cómo va ----------

function ofrecerCerebro(intento = 0) {
  // La primera vez (y una vez por día, hasta que lo bajes): para que JARVIS te conteste sin internet
  if (!Nativo.hay || !Cerebro.estado()) return;
  const m = Cerebro.info();
  if (!m || m.listo || m.bajada || leerGuardado("ofrecido", "") === new Date().toDateString()) return;
  setTimeout(() => {
    if (!$("aviso").hidden) {   // (hay otro aviso, por ejemplo una actualización: más tarde)
      if (intento < 2) ofrecerCerebro(intento + 1);
      return;
    }
    guardar("ofrecido", new Date().toDateString());
    avisar(`Para que JARVIS te conteste sin internet, bajá su cerebro (${m.nombre}, ${(m.bytes / 1e9).toFixed(1)} GB, con wifi).`,
           25, {texto: "Bajar", hacer: bajarCerebro});
  }, intento ? 25000 : 4000);
}

function bajarCerebro() {
  const r = Cerebro.bajar();
  if (r.ok) avisar(r.ya ? "El cerebro ya está bajado." : "Bajando el cerebro (se ve en las notificaciones). Lo uso apenas termine.", 6);
  else if (r.error === "sin_lugar") avisar(`No hay lugar: hacen falta ${(r.falta / 1e9).toFixed(1)} GB libres en el celular.`, 8);
  else avisar("No pude empezar a bajarlo. Probá de nuevo.", 5);
  pintarCerebro();
}

function pintarCerebro() {
  // La parte de Ajustes: si está bajado, cuánto falta, cuál
  const e = Cerebro.estado();
  $("cerebro-caja").hidden = !e;
  if (!e) return;
  const m = Cerebro.info();
  $("ajuste-modelo").value = Cerebro.modelo();
  $("ajuste-solo-wifi").checked = ajustes.soloWifi !== false;
  const gb = (m.bytes / 1e9).toFixed(1);
  const bajando = m.bajada && m.bajada.estado !== "fallo";
  const pct = m.bajada ? Math.floor(100 * m.bajada.hecho / m.bytes) : 0;
  let texto;
  if (m.listo) {
    texto = `Listo: sin internet te contesta ${m.nombre}, desde el celular`
      + (e.cargado === m.id ? ` (cargado, con ${e.placa === "gpu" ? "la placa de video" : "el procesador"})` : "") + ".";
  } else if (m.bajada) {
    texto = {bajando: `Bajando ${m.nombre}: ${pct}% de ${gb} GB.`,
             pausada: m.bajada.motivo === "espera_wifi" ? `Esperando wifi para seguir bajando (${pct}%).`
               : `En pausa (${pct}%): sigue sola cuando haya internet.`,
             fallo: m.bajada.motivo === "sin_lugar" ? "No hubo lugar en el celular para bajarlo." : "No se pudo bajar. Probá de nuevo."}[m.bajada.estado];
  } else {
    texto = `Sin bajar. Pesa ${gb} GB (bajalo con wifi). Con él, JARVIS te contesta sin internet, como en la PC.`;
  }
  if (Nativo.info.ram && Nativo.info.ram < 5 && m.id === "gemma4") {
    texto += ` Tu celular tiene ${Nativo.info.ram} GB de memoria: si anda lento, probá el liviano.`;
  }
  $("cerebro-texto").textContent = texto;
  $("cerebro-progreso").hidden = !bajando;
  $("cerebro-progreso").firstElementChild.style.width = pct + "%";
  $("cerebro-bajar").hidden = m.listo || bajando;
  $("cerebro-cancelar").hidden = !bajando;
  $("cerebro-borrar").hidden = !m.listo;
}

function avisoOidoSinInternet() {
  // Android no siempre trae el español para escuchar sin conexión: se baja una vez
  const texto = "Sin internet, para escucharte el celular necesita el español sin conexión (Ajustes del celular › "
    + "Google › Voz › Reconocimiento sin conexión). Mientras, escribime en la Charla.";
  avisar(texto, 12, {texto: "Abrir", hacer: () => window.JarvisNativo.ajustes("voz")});
  return texto;
}

const sinOidoSinInternet = (r) => Nativo.hay && !hayInternet() && ["network", "language-not-supported"].includes(r.error);

window.JarvisApp = {
  atras() {
    // El botón atrás de Android: true si la app lo usó (si no, la app queda abierta por detrás)
    if ($("ajustes").open) { $("ajustes").close(); return true; }
    if (llamada.activa) { colgar(); return true; }
    if (vistaActual !== "inicio") { cambiarVista("inicio"); return true; }
    if (ocupado) { Voz.callar(); Oido.cancelar(); Cerebro.parar(); return true; }
    return false;
  },
};

function conectarCon(u, k) {
  // La dirección del bot y la llave (del link de /app)
  if (!/^https:\/\/script\.google(?:usercontent)?\.com\//.test(u || "") || String(k || "").length < 16) return false;
  guardar("conexion", {u: u, k: k});
  location.reload();
  return true;
}

function linkDelPortapapeles() {
  // ¿Copiaste el link de /app? (en Android: mantener apretado el link en Telegram > Copiar)
  const texto = Nativo.hay ? String(window.JarvisNativo.portapapeles() || "") : "";
  const m = /#u=([^&\s]+)&k=([\w-]+)/.exec(texto);
  return m ? {u: decodeURIComponent(m[1]), k: m[2]} : null;
}

function escucharEventosNativos() {
  Nativo.al("escuchar", () => {   // el botón del asistente o el atajo «Hablar»
    cambiarVista("inicio");
    if (!ocupado) hablarEnInicio();
  });
  Nativo.al("llamar", () => llamar());
  Nativo.al("conectar", (d) => {
    // (un link jarvis:// lo puede armar cualquiera: sin preguntar, alguien podría conectar tu app a SU bot y leer lo
    // que le decís)
    if (!confirm("¿Conecto la app con el JARVIS de este link? Hacelo solo si el link te lo mandó tu bot con /app.")) return;
    if (!conectarCon(d.u, d.k)) avisar("Ese link para conectar no anda. Pedí otro con /app.", 5);
  });
  Nativo.al("compartido", async (d) => {   // un texto, un link, una foto o un archivo compartidos desde otra app
    cambiarVista("charla");
    if (d.texto) {
      $("caja").value = d.texto;
      ajustarCaja();
    }
    if (d.imagen) {
      try {
        mostrarAdjunto(Object.assign({tipo: "foto"}, await prepararFoto(await (await fetch(d.imagen)).blob())));
      } catch (e) {
        avisar("No pude abrir esa foto.");
      }
    }
    if (d.archivo) mostrarAdjunto(Object.assign({tipo: "archivo"}, d.archivo));
    if (d.error) avisar(d.error, 5);
    $("caja").focus();
  });
  Nativo.al("aviso", (d) => {   // tocaste la notificación de un recordatorio
    cambiarVista("inicio");
    estadoInicio("hablando", "⏰ " + d.texto);
    Voz.decir("Recordatorio: " + d.texto).then(() => estadoInicio(escucha.activa ? "esperando" : "libre"));
  });
  Nativo.al("red", (d) => {
    if (d.hay) {
      marcarConexion("bien");
      mandarCola();
      if (escucha.activa) cicloJarvis();
    } else {
      marcarConexion("mal");
      Cerebro.preparar();   // se fue internet: el cerebro del celular se carga ya (tarda unos segundos)
    }
  });
}

let soltarCerebro = null;   // (la app quedó por detrás: el cerebro libera la memoria si no volvés en 5 minutos)
Nativo.al("pausa", () => {
  clearTimeout(soltarCerebro);
  soltarCerebro = setTimeout(() => { if (Nativo.hay && window.JarvisNativo.cerebroSoltar) window.JarvisNativo.cerebroSoltar(); },
                             5 * 60000);
});
Nativo.al("vuelta", () => {
  clearTimeout(soltarCerebro);
  if (!hayInternet()) Cerebro.preparar();
});

let instalador = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  instalador = e;
  $("boton-instalar").hidden = false;
});
window.addEventListener("appinstalled", () => { $("boton-instalar").hidden = true; });


// ---------- Arranque ----------

function conectarBotones() {
  document.addEventListener("pointerdown", () => { ultimoToque = Date.now(); }, true);
  // como en Android: la onda al tocar (y en la app, una vibración cortita)
  document.addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".pestana, .protocolo, .boton, .chip, .accion, .hablar, .icono-boton");
    if (!b || b.disabled) return;
    const destino = b.querySelector(".indicador") || b;   // en la barra de abajo, en la pastilla (como en Android)
    const r = destino.getBoundingClientRect(), lado = Math.max(r.width, r.height) * 2, onda = document.createElement("span");
    onda.className = "onda";
    onda.style.cssText = `width:${lado}px;height:${lado}px;left:${e.clientX - r.left - lado / 2}px;top:${e.clientY - r.top - lado / 2}px`;
    destino.appendChild(onda);
    setTimeout(() => onda.remove(), 600);
    if (Nativo.hay) window.JarvisNativo.toque();
  });
  $("barra").addEventListener("submit", (e) => { e.preventDefault(); enviarLoEscrito(); });
  $("caja").addEventListener("input", ajustarCaja);
  $("caja").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {   // en la compu
      e.preventDefault();
      enviarLoEscrito();
    }
  });
  $("boton-adjuntar").onclick = () => $("archivo").click();
  $("archivo").onchange = async () => {   // una foto, un PDF, un audio, un video o un texto
    const archivo = $("archivo").files[0];
    if (!archivo) return;
    try {
      mostrarAdjunto(await prepararAdjunto(archivo));
    } catch (e) {
      $("archivo").value = "";
      avisar(e.message && !/onload|Event/.test(e.message) ? e.message : "No pude abrir ese archivo.", 5);
    }
  };
  $("foto-sacar").onclick = () => { sacarFoto(); ajustarCaja(); };

  document.querySelectorAll(".pestana[data-vista]").forEach((b) => { b.onclick = () => cambiarVista(b.dataset.vista); });
  $("boton-llamar").onclick = llamar;
  $("boton-colgar").onclick = colgar;
  $("boton-pausa").onclick = pausar;
  $("llamada-reactor").onclick = tocarReactor;
  $("boton-hablar").onclick = hablarEnInicio;
  $("inicio-reactor").onclick = () => { if (ocupado) { Voz.callar(); Oido.cortar(); Cerebro.parar(); } };
  $("escuchar-jarvis").onchange = () => activarEscucha($("escuchar-jarvis").checked);
  $("actualizar-mails").onclick = cargarMails;

  $("nuevo-pendiente").addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = $("caja-pendiente").value.trim();
    if (!texto) return;
    $("caja-pendiente").value = "";
    if (!hayInternet()) {   // sin internet: se ve ya, y se manda cuando vuelve
      encolar({accion: "app_pendiente", datos: {que: "agregar", texto: texto}});
      if (datosDia) {
        datosDia.pendientes.push({id: "cola" + Date.now(), texto: texto + " ⏳", para: null});
        pintarDia();
      }
      return avisar("No hay internet: lo agrego apenas vuelva.", 3);
    }
    accionDia(() => api("app_pendiente", {que: "agregar", texto: texto}), "Agregado.");
  });
  ORDENES.forEach((orden) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = orden;
    chip.onclick = () => ordenParaLaPc(orden);
    $("ordenes-rapidas").appendChild(chip);
  });
  $("orden-libre").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await ordenParaLaPc($("caja-orden").value)) $("caja-orden").value = "";
  });

  $("boton-ajustes").onclick = abrirAjustes;
  $("ajustes").addEventListener("close", guardarAjustes);
  $("ajuste-velocidad").oninput = () => { $("velocidad-valor").textContent = Number($("ajuste-velocidad").value).toFixed(2) + "x"; };
  $("probar-voz").onclick = () => {
    guardarAjustes();
    Voz.decir("Hola, soy JARVIS. Así te voy a hablar.");
  };
  $("ver-pc").onclick = () => { $("ajustes").close(); cambiarVista("pc"); };
  $("desconectar").onclick = () => {
    if (!confirm("¿Desconecto este celular de este JARVIS? Para volver a conectarlo, mandá /app en Telegram.")) return;
    ["conexion", "mensajes", "ultimaCharla", "dia", "cola"].forEach((c) => localStorage.removeItem(GUARDADO + c));
    conexion = null;
    $("ajustes").close();
    mostrarConectar();
  };
  $("form-a-mano").addEventListener("submit", (e) => {   // por si el link no anduvo: la dirección y la llave a mano
    e.preventDefault();
    if (!conectarCon($("a-mano-url").value.trim(), $("a-mano-llave").value.trim())) {
      $("conectar-detalle").textContent = "Fijate la dirección (empieza con https://script.google.com/) y la llave.";
    }
  });
  $("pegar-link").onclick = () => {   // (la app de Android) el link de /app que copiaste en Telegram
    const copiado = linkDelPortapapeles();
    if (!copiado || !conectarCon(copiado.u, copiado.k)) {
      $("conectar-detalle").textContent = "No encontré el link copiado. En Telegram mantené apretado el link de /app y tocá «Copiar».";
    }
  };
  // la app de Android
  $("ajuste-asistente").onclick = () => {
    window.JarvisNativo.ajustes("asistente");
    avisar("Elegí JARVIS en «App de asistente digital». Después, mantener apretado inicio (o encendido) abre JARVIS escuchando.", 9);
  };
  $("ajuste-permisos").onclick = () => window.JarvisNativo.ajustes("app");
  $("ajuste-actualizar").onclick = () => buscarActualizacion(true);
  // el cerebro sin internet
  $("ajuste-modelo").onchange = () => {
    ajustes.modelo = $("ajuste-modelo").value;
    guardar("ajustes", ajustes);
    pintarCerebro();
  };
  $("ajuste-solo-wifi").onchange = () => {
    ajustes.soloWifi = $("ajuste-solo-wifi").checked;
    guardar("ajustes", ajustes);
  };
  $("cerebro-bajar").onclick = bajarCerebro;
  $("cerebro-cancelar").onclick = () => {
    window.JarvisNativo.cerebroCancelar(Cerebro.modelo());
    pintarCerebro();
  };
  $("cerebro-borrar").onclick = () => {
    const m = Cerebro.info();
    if (!confirm(`¿Borro el cerebro del celular (${m.nombre})? Libera ${(m.bytes / 1e9).toFixed(1)} GB, pero sin internet JARVIS no te va a poder contestar.`)) return;
    window.JarvisNativo.cerebroBorrar(m.id);
    setTimeout(pintarCerebro, 600);
  };
  // la web app en Android: bajar la app, y pasarle la conexión
  $("bajar-android").href = ANDROID_WEB + "JARVIS.apk";
  $("conectar-android").onclick = () => {
    if (!conexion) return;
    location.href = "intent://conectar?u=" + encodeURIComponent(conexion.u) + "&k=" + conexion.k
      + "#Intent;scheme=jarvis;package=com.rusty576.jarvis;end";
  };
  $("boton-instalar").onclick = async () => {
    if (!instalador) return;
    instalador.prompt();
    await instalador.userChoice;
    instalador = null;
    $("boton-instalar").hidden = true;
  };

  const alVolver = () => {
    if (!conexion) return;
    if (hayInternet()) {
      sincronizarCharla();
      mandarCola();
      buscarActualizacion();
    }
    if (vistaActual === "dia" || vistaActual === "pc") cargarDatos();
    if (vistaActual === "inicio" && reactorInicio && !llamada.activa) reactorInicio.prender();
    if (escucha.activa) cicloJarvis();
  };
  const alIrse = () => {
    if (reactorInicio) reactorInicio.apagar();
    pausarEscucha();
  };
  document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? alVolver() : alIrse()));
  // (en la app de Android, Android avisa también: el WebView no siempre cambia la visibilidad de la página)
  Nativo.al("pausa", () => { enPausa = true; alIrse(); });
  Nativo.al("vuelta", () => { enPausa = false; alVolver(); });
}

// si la app ya estaba abierta y tocás el link de /app, solo cambia lo de después del #: se vuelve a arrancar con eso
window.addEventListener("hashchange", () => { if (/[#&]k=/.test(location.hash)) location.reload(); });

async function primerosDatos() {
  // Todo lo del arranque en un solo pedido (la charla y Mi día). Si el bot todavía es el de antes, como antes
  let d = null;
  try {
    d = await apiLeer("app_inicio");
  } catch (e) {
    if (e.tipo === "sin_red") return;   // sin internet: queda lo último que se vio
  }
  if (d && d.ok) {
    const {charla, ...datos} = d;
    sincronizarCharla({charla: charla});
    cargarDatos(datos);
  } else {
    sincronizarCharla();
    cargarDatos();
  }
  mandarCola();
}

function arrancar() {
  if (Nativo.hay) {
    escucharEventosNativos();
    Nativo.info = Nativo.ya("listo") || {};   // (Android manda lo que estaba esperando: el asistente, algo compartido)
    document.documentElement.classList.add("nativa");
  }
  leerLink();
  reactorInicio = crearReactor($("reactor-inicio"));
  reactorLlamada = crearReactor($("reactor"));
  conectarBotones();
  pintarProtocolos();
  if (!Nativo.hay && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!conexion) {
    const copiado = linkDelPortapapeles();   // copiaste el link de /app: se conecta solo
    if (copiado && confirm("¿Conecto la app con el JARVIS del link que copiaste?") && conectarCon(copiado.u, copiado.k)) return;
    return mostrarConectar();
  }
  reactorInicio.prender();
  pintarCharla();
  pintarDia();
  pintarPc();
  if (!hayInternet()) {
    marcarConexion("mal");
    Cerebro.preparar();   // sin internet desde el arranque: el cerebro del celular, listo para cuando le hables
  }
  primerosDatos();
  buscarActualizacion();
  ofrecerCerebro();
  window.addEventListener("online", () => { marcarConexion("bien"); mandarCola(); });
  window.addEventListener("offline", () => marcarConexion("mal"));
  // cada minuto, mientras la app está a la vista: lo nuevo de la charla (lo que contó la PC, lo de Telegram)
  setInterval(() => {
    if (document.visibilityState === "visible" && !llamada.activa && hayInternet()) {
      sincronizarCharla();
      mandarCola();   // (lo que se anotó mientras Google no contestaba)
    }
  }, 60000);
  if (Nativo.hay) {   // «Hey Jarvis» con la app cerrada (si estaba prendido: después de reiniciar el celular, vuelve acá)
    $("escuchar-jarvis").nextElementSibling.textContent = "Escuchar «Hey Jarvis» (también con la app cerrada)";
    if (ajustes.escucharJarvis) activarEscuchaFondo(true, true);
  } else if (ajustes.escucharJarvis && puedeOir) {
    escucha.activa = true;
    $("escuchar-jarvis").checked = true;
    cicloJarvis();
  }
  if (new URLSearchParams(location.search).get("llamar")) {   // el atajo «Llamar» del ícono
    avisar("Tocá Llamar para empezar (el celular pide un toque antes de usar el micrófono).", 5);
  }
}

arrancar();
