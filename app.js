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

const VERSION_APP = "2026.10.25.7";
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
let puedeOir = Nativo.hay || !!Reco;   // (en Android, sin reconocimiento de voz en el celular: graba y lo pasa el bot)
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

// Las órdenes rápidas de la pestaña PC (solo las que JARVIS entiende en la PC). «¿Cómo está la compu?» no es una orden:
// se contesta acá, con lo último que mandó la PC. La captura llega como imagen a la charla
const ORDENES = [{texto: "¿Cómo está la compu?", local: true}, "Sacá una captura de pantalla", "Pausá la música",
                 "Siguiente tema", "Modo juego", "Salí del modo juego", "Bloqueá la pantalla", "Apagá la compu en 10 minutos",
                 "Cancelá el apagado"];

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
        const imagenes = await prepararImagenes(r.acciones || []);
        // (la respuesta tal cual, con la pregunta aparte: así, cuando llega la charla de Telegram, no se repite)
        agregar({quien: "jarvis", texto: respuesta, deCola: String(p.datos.texto).slice(0, 80), tarjetas: r.tarjetas || [],
                 acciones: r.acciones || [], imagenes: imagenes.length ? imagenes : undefined});
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
  // en la charla, arriba de donde escribís (antes lo tapaba); en lo demás, arriba de las pestañas
  const tapa = vistaActual === "charla" ? $("barra").offsetHeight + ($("foto-lista").hidden ? 0 : $("foto-lista").offsetHeight + 8) : 0;
  aviso.style.bottom = tapa ? `calc(${86 + tapa}px + var(--abajo))` : "";
  aviso.hidden = false;
  clearTimeout(avisar.reloj);
  avisar.reloj = setTimeout(() => { aviso.hidden = true; }, segundos * 1000);
}


// ---------- El reactor de Inicio (y la luz de Live) ----------

let reactorInicio = null;
function vozReactores(nivel) {
  if (reactorInicio) reactorInicio.voz(nivel);
  if (llamada.activa) nivelLive(nivel);   // (en Live, la luz de abajo)
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
        u.pitch = ajustes.tono || 1;
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
      reiniciar: () => {   // lo dicho hasta ahora no sirve: se calla y arranca de cero (sin cortar lo que viene)
        resto = "";
        primera = true;
        ultima = Promise.resolve();
        if (Nativo.hay) window.JarvisNativo.callar();
      },
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
    const microfono = (si) => { if (Nativo.hay && window.JarvisNativo.microfono) window.JarvisNativo.microfono(si); };
    if (Nativo.hay) {   // en la app de Android: primero el permiso de Android, y «Hey Jarvis» suelta el micrófono
      if (!Nativo.ya("permisos").microfono && !(await Nativo.cuando("pedirPermiso", "microfono")).si) return "no-permitido";
      microfono(true);
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}});
    } catch (e) {
      microfono(false);
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
        microfono(false);
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
    const donde = APPS[musicaDonde(a).app];
    return {texto: `Poner «${a.busqueda}» en ${donde.nombre}`, url: donde.buscar(q)};
  }
  if (a.tipo === "navegar") {   // (en la web, o si no está Maps: la ruta en la página de Maps)
    return {texto: `Cómo llegar a ${a.destino}`, url: "https://www.google.com/maps/dir/?api=1&destination="
            + encodeURIComponent(a.destino || "")};
  }
  const app = appDe(a.app);
  if (!app) return {texto: `Buscar «${a.app}» en Play Store`, url: APPS["play store"].buscar(encodeURIComponent(a.app))};
  return {texto: `Abrir ${app.nombre}`, url: a.busqueda && app.buscar ? app.buscar(q) : app.url};
}

// La música: en qué app se pone (la que nombraste, «en Spotify», o la de Ajustes)
const MUSICA = {youtube: {app: "youtube", paquete: "com.google.android.youtube"},
                ytmusic: {app: "youtube music", paquete: "com.google.android.apps.youtube.music"},
                spotify: {app: "spotify", paquete: "com.spotify.music"}};

function musicaDonde(a) {
  const pedida = a.app ? appDe(a.app) : null;
  const clave = pedida && Object.keys(MUSICA).find((k) => MUSICA[k].app === pedida.clave);
  return MUSICA[clave || ajustes.musica] || MUSICA.youtube;
}

let musicaPausadaPorMi = 0;   // cuándo JARVIS pausó la música del celular («seguí con la música» la vuelve a poner)

function musicaEnElCelular() {
  // si está sonando algo en el celular (si no, «pausá la música» puede ser la de la PC: eso lo ve el bot)
  return Nativo.hay && !!window.JarvisNativo.musicaSonando && Nativo.ya("musicaSonando") === true;
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
    if (!this.lasApps) {
      this.lasApps = (Nativo.ya("apps") || []).map((a) => ({nombre: a.n, paquete: a.p, clave: normalizar(a.n)}));
      this.leidas = Date.now();
    }
    return this.lasApps;
  },

  buscarApp(nombre) {
    // la que nombraste, entre las instaladas («wsp» -> WhatsApp, «la cámara» -> Cámara). Si no está, se vuelve a leer
    // la lista una vez (una app que instalaste con JARVIS abierto no estaba)
    const conocida = appDe(nombre);
    const nombres = [nombre].concat(conocida ? [conocida.nombre].concat(conocida.alias || []) : []);
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      for (const n of nombres) {
        const app = elMejor(this.apps(), n, (a) => a.clave);
        if (app) return app;
      }
      if (Date.now() - (this.leidas || 0) < 5000) break;
      this.lasApps = null;
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
  almacenamiento: "almacenamiento", asistente: "asistente", nfc: "nfc"};

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
    case "musica": {
      // la app de música lo busca y lo pone sola (Spotify y YouTube Music saben); si no sabe, se abre la búsqueda
      if (a.busqueda && window.JarvisNativo.reproducir) {
        const r = Nativo.ya("reproducir", a.busqueda, musicaDonde(a).paquete);
        if (r.ok) return {ok: true, texto: `Poniendo «${a.busqueda}».`, callado: true};
      }
      return ok(abrirUrl(accionAUrl(a).url), "");
    }
    case "medios": {   // pausar, seguir, pasar de canción (la que esté sonando en el celular)
      const r = window.JarvisNativo.medios ? Nativo.ya("medios", a.que) : {ok: false};
      if (!r.ok) return {ok: false, texto: "No pude manejar la música del celular."};
      if (a.que !== "seguir" && !r.sonaba) return {ok: true, texto: "No hay música sonando en el celular."};
      musicaPausadaPorMi = a.que === "pausa" ? Date.now() : 0;
      const dicho = {pausa: "Pausé la música.", seguir: "Sigue la música.", siguiente: "Siguiente canción.",
                     anterior: "Canción anterior."}[a.que];
      return {ok: true, texto: dicho, callado: true};   // (la música misma avisa: JARVIS no habla encima)
    }
    case "navegar": {   // «llevame a...»: el GPS de Maps, ya andando; «cómo llego a...»: la ruta para elegir cómo ir
      if (!a.ruta) {
        const r = abrirUrl("google.navigation:q=" + encodeURIComponent(a.destino || ""));
        if (r.ok !== false) return {ok: true, texto: `Vamos a ${a.destino}.`, callado: true};
      }
      return Object.assign(ok(abrirUrl(accionAUrl(a).url), `Te muestro cómo llegar a ${a.destino}.`), {callado: true});
    }
    case "whatsapp": {
      const n = await numeroDe(a);
      const texto = encodeURIComponent(a.mensaje || "");
      if (n.problema && a.para) {   // no está con ese nombre: WhatsApp se abre igual, con el mensaje, y elegís a quién
        abrirUrl(`https://wa.me/?text=${texto}`);
        return {ok: false, texto: `No encontré a «${a.para}» en tus contactos: elegilo vos en WhatsApp (el mensaje ya está escrito).`};
      }
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

// ---------- Las imágenes: las que hizo JARVIS, las fotos que encontró y las capturas de la PC ----------
// En la charla queda una copia chica (las grandes no entran en lo guardado del celular). La grande queda a mano un rato
// (y si no, se le pide al bot: las guarda 6 horas) para verla entera, guardarla o compartirla.

const imagenesGrandes = new Map();

function guardarGrande(ref, imagen) {
  imagenesGrandes.set(ref, imagen);
  while (imagenesGrandes.size > 24) imagenesGrandes.delete(imagenesGrandes.keys().next().value);   // (las más viejas)
}

async function prepararImagenes(acciones) {
  // Lo que vino en la respuesta: [{ref, mini, texto, url, prompt, formato}] para la galería del mensaje
  const lista = [];
  const varias = acciones.filter((a) => a.tipo === "imagen" && a.datos).length > 1;
  for (const a of acciones) {
    if (a.tipo !== "imagen" || !a.datos) continue;
    const ref = a.ref || "img" + Date.now() + Math.random().toString(36).slice(2, 6);
    guardarGrande(ref, {mime: a.mime, datos: a.datos});
    let mini = null;
    try {
      mini = await miniaturaDe(await (await fetch(`data:${a.mime};base64,${a.datos}`)).blob(), varias ? 360 : 640);
    } catch (e) { /* sin copia chica: se ve al tocarla */ }
    delete a.datos;
    a.ref = ref;
    lista.push({ref: ref, mini: mini, texto: a.texto || "", url: a.url || null, prompt: a.prompt || null, formato: a.formato || null});
  }
  return lista;
}

async function miniaturaDe(blob, lado = 640) {
  const img = await new Promise((listo, error) => {
    const i = new Image();
    i.onload = () => listo(i);
    i.onerror = error;
    i.src = URL.createObjectURL(blob);
  });
  const escala = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight));
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.round(img.naturalWidth * escala);
  lienzo.height = Math.round(img.naturalHeight * escala);
  lienzo.getContext("2d").drawImage(img, 0, 0, lienzo.width, lienzo.height);
  URL.revokeObjectURL(img.src);
  return lienzo.toDataURL("image/jpeg", lado > 400 ? 0.8 : 0.72);
}

async function traerImagen(im) {
  // La imagen entera: la que vino recién, o la del buzón del bot (las que se hicieron en Telegram o en la PC)
  if (!im || !im.ref) return null;
  if (imagenesGrandes.has(im.ref)) return imagenesGrandes.get(im.ref);
  if (!/^i[a-z0-9]{6,20}$/.test(im.ref) || !conexion || !hayInternet()) return null;
  try {
    const r = await apiLeer("app_imagen", {id: im.ref});
    if (!r.ok) return null;
    guardarGrande(im.ref, {mime: r.mime, datos: r.datos});
    return imagenesGrandes.get(im.ref);
  } catch (e) {
    return null;
  }
}

async function completarImagenes(m) {
  // Un mensaje que llegó con imágenes que todavía no están acá (de la charla de Telegram, de la PC, de un aviso)
  let cambio = false;
  for (const im of m.imagenes || []) {
    if (im.mini || im.perdida) continue;
    const grande = await traerImagen(im);
    try {
      if (grande) im.mini = await miniaturaDe(await (await fetch(`data:${grande.mime};base64,${grande.datos}`)).blob(),
                                              m.imagenes.length > 1 ? 360 : 640);
    } catch (e) { /* queda sin copia chica */ }
    if (!grande) im.perdida = true;
    cambio = true;
  }
  if (cambio) {
    redibujar(m);
    guardarCharla();
  }
}

function pintarGaleria(m) {
  const caja = document.createElement("div");
  caja.className = "galeria n" + Math.min(m.imagenes.length, 4);
  m.imagenes.forEach((im, i) => {
    const cuadro = document.createElement("button");
    cuadro.type = "button";
    cuadro.className = "foto-cuadro" + (im.formato === "vertical" ? " vertical" : "");
    cuadro.setAttribute("aria-label", im.texto || "Ver la imagen entera");
    if (im.mini) {
      const img = document.createElement("img");
      img.src = im.mini;
      img.alt = "";
      img.decoding = "async";
      cuadro.appendChild(img);
    } else {
      cuadro.classList.add("sin-foto");
      cuadro.textContent = im.perdida ? "Esta imagen ya no está" : "Trayendo la imagen...";
    }
    cuadro.onclick = () => abrirVisor(m, i);
    caja.appendChild(cuadro);
  });
  if (m.imagenes.length === 1 && m.imagenes[0].ref) {   // una sola (la que hizo JARVIS): los botones a mano
    const im = m.imagenes[0];
    const botones = document.createElement("div");
    botones.className = "foto-botones";
    const boton = (texto, hacer) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "accion chica";
      b.textContent = texto;
      b.onclick = hacer;
      botones.appendChild(b);
    };
    boton("⤓ Guardar", () => guardarImagenEntera(im));
    if (Nativo.hay || navigator.share) boton("↗ Compartir", () => compartirImagen(im));
    if (im.prompt) boton("↻ Otra versión", () => otraVersion(im));
    caja.appendChild(botones);
  }
  return caja;
}

async function guardarImagenEntera(im) {
  const grande = await traerImagen(im);
  if (!grande) return avisar("Esa imagen ya no la tengo entera (quedan 6 horas): pedímela de nuevo.", 4);
  if (Nativo.hay) {
    const r = Nativo.ya("guardarImagen", grande.datos, grande.mime);
    return avisar(r.ok ? "Guardada en la galería (carpeta JARVIS)." : "No pude guardarla en este celular.", 4);
  }
  const enlace = document.createElement("a");   // en la web: se baja
  enlace.href = `data:${grande.mime};base64,${grande.datos}`;
  enlace.download = "jarvis." + (grande.mime.split("/")[1] || "png");
  enlace.click();
}

async function compartirImagen(im) {
  const grande = await traerImagen(im);
  if (!grande) return avisar("Esa imagen ya no la tengo entera: pedímela de nuevo.", 4);
  if (Nativo.hay && window.JarvisNativo.compartirImagen) {
    const r = Nativo.ya("compartirImagen", grande.datos, grande.mime);
    if (!r.ok) avisar("No pude compartirla.", 3);
    return;
  }
  try {
    const blob = await (await fetch(`data:${grande.mime};base64,${grande.datos}`)).blob();
    await navigator.share({files: [new File([blob], "jarvis.jpg", {type: grande.mime})]});
  } catch (e) { /* (cancelaste) */ }
}

async function otraVersion(im) {
  // la misma descripción, otra semilla: otra imagen parecida (sin gastar Gemini)
  if (!hayInternet()) return avisar("Para hacer otra versión hace falta internet.", 4);
  cambiarVista("charla");
  pensando(true);
  try {
    const r = await api("app_crear_imagen", {descripcion: im.prompt, formato: im.formato || "cuadrada"}, 120);
    pensando(false);
    if (!r.ok) throw new Error(r.error || "No pude.");
    const imagenes = await prepararImagenes(r.acciones || []);
    agregar({quien: "jarvis", texto: "Otra versión:", imagenes: imagenes});
  } catch (e) {
    pensando(false);
    agregar({quien: "aviso", texto: e.message || "No pude hacer otra versión."});
  }
}

// ---------- El visor: la imagen entera, a pantalla completa ----------

const visor = {m: null, i: 0};

async function abrirVisor(m, i) {
  visor.m = m;
  visor.i = i;
  $("visor").hidden = false;
  await mostrarEnVisor();
}

async function mostrarEnVisor() {
  const lista = visor.m.imagenes, im = lista[visor.i];
  const img = $("visor-img");
  img.src = im.mini || "";
  img.classList.remove("zoom");
  $("visor-texto").textContent = im.texto || "";
  $("visor-cuenta").textContent = lista.length > 1 ? `${visor.i + 1} de ${lista.length}` : "";
  $("visor-anterior").hidden = $("visor-siguiente").hidden = lista.length < 2;
  $("visor-fuente").hidden = !im.url;
  $("visor-otra").hidden = !im.prompt;
  $("visor-guardar").hidden = $("visor-compartir").hidden = !im.ref;
  const grande = await traerImagen(im);
  if (grande && visor.m && visor.m.imagenes[visor.i] === im) img.src = `data:${grande.mime};base64,${grande.datos}`;
}

function cerrarVisor() {
  $("visor").hidden = true;
  $("visor-img").src = "";
  visor.m = null;
}

function moverVisor(paso) {
  const n = visor.m.imagenes.length;
  visor.i = (visor.i + paso + n) % n;
  mostrarEnVisor();
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
  (acciones || []).filter((a) => a.tipo !== "imagen").forEach((a) => {   // (las imágenes van en la galería)
    const boton = document.createElement("button");
    boton.className = "accion";
    if (a.tipo === "abrir_url") {   // un documento que hizo JARVIS
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
  if (a.tipo === "medios") {
    return {pausa: "Pausar la música", seguir: "Seguir la música", siguiente: "Siguiente canción",
            anterior: "Canción anterior"}[a.que] || "Música";
  }
  if (a.tipo === "navegar") return (a.ruta ? "Cómo llegar a " : "Ir a ") + a.destino;
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
  {re: /^(?:(?:abr[ie]\w*|anda a|mostra\w*|prend[ei]\w*|activa\w*|apaga\w*|desactiva\w*)\s+)?(?:(?:los |el |la )?(?:ajustes|configuracion|opciones) (?:de(?:l)? |de la )?|el |la |los )?(wi fi|wifi|bluetooth|ubicacion|gps|sonido|brillo|pantalla|bateria|modo avion|avion|datos moviles|datos|no molestar|notificaciones|almacenamiento|nfc)$/,
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
  // la música del celular: pausar, seguir y pasar de canción. Si no suena nada en el celular (y no dijiste «del
  // celular»), puede ser la música de la PC: eso lo resuelve el bot
  {re: /^(?:pausa\w*|pone(?:le)? pausa(?: a)?|para(?:la)?|frena\w*|deten\w*|corta\w*|apaga\w*)(?:\s+(?:la|el|esta|este))?\s+(?:musica|cancion|tema|video|reproduccion|spotify|youtube)((?:\s+(?:del|en el) (?:celu|celular|telefono)))?$|^pausa$/,
   nativo: true, solo: (m) => !!m[1] || musicaEnElCelular(), accion: () => ({tipo: "medios", que: "pausa"})},
  {re: /^(?:segui\w*|continua\w*|reanuda\w*|retoma\w*|despausa\w*|volve a poner|dale play a|pone(?:le)? play a)(?:\s+con)?(?:\s+(?:la|el))?\s+(?:musica|cancion|tema|video|reproduccion)((?:\s+(?:del|en el) (?:celu|celular|telefono)))?$|^(?:play|dale play|despausa\w*)$/,
   nativo: true, solo: (m) => !!m[1] || Date.now() - musicaPausadaPorMi < 3 * 3600000 || musicaEnElCelular(),
   accion: () => ({tipo: "medios", que: "seguir"})},
  {re: /^(?:(?:pasa\w*|pone\w*|salta\w*|cambia\w*)\s+(?:a\s+)?)?(?:la\s+|el\s+)?(?:siguiente|proxima|proximo)(?:\s+(?:cancion|tema|video))?((?:\s+(?:del|en el) (?:celu|celular|telefono)))?$|^(?:pone\w*|pasa\w*)\s+otr[oa](?:\s+(?:cancion|tema))?$|^(?:saltea\w*|salta\w*|pasa\w*)\s+(?:esta|este|la|el)?\s*(?:cancion|tema)$/,
   nativo: true, solo: (m) => !!m[1] || musicaEnElCelular(), accion: () => ({tipo: "medios", que: "siguiente"})},
  {re: /^(?:(?:volve\w*|pone\w*|pasa\w*)\s+(?:a\s+)?)?(?:la\s+|el\s+)?(?:cancion\s+|tema\s+)?anterior((?:\s+(?:del|en el) (?:celu|celular|telefono)))?$/,
   nativo: true, solo: (m) => !!m[1] || musicaEnElCelular(), accion: () => ({tipo: "medios", que: "anterior"})},
  // poner música: «poné música de Queen», «reproducí Bohemian Rhapsody», «poné Queen en Spotify» (la de la PC, «en la
  // compu», va al bot). Sin nada más («poné música»), sigue con la última que sonó
  {re: /^(?!.*\b(?:compu|computadora|pc|notebook)\b)(?:pone(?:me)?|reproduci\w*|toca(?:me)?|quiero escuchar)\s+(?:en el (?:celu|celular|telefono)\s+)?(?:(?:un poco de|algo de|la|el|los|las|unas?)\s+)?(?:musica|canciones|cancion|tema|temas|album|disco|playlist)(?:\s+(?:de|del|que se llama|llamad[oa]))?\s*(.*?)(?:\s+en\s+(spotify|youtube music|youtube|yt music))?$/,
   accion: (m) => m[1] ? {tipo: "musica", busqueda: m[1], app: m[2] || ""} : Nativo.hay && {tipo: "medios", que: "seguir"}},
  {re: /^(?!.*\b(?:compu|computadora|pc|notebook)\b)(?:reproduci\w*\s+(.+?)(?:\s+en\s+(spotify|youtube music|youtube|yt music))?|pone(?:me)?\s+(.+?)\s+en\s+(spotify|youtube music|youtube|yt music))$/,
   accion: (m) => ({tipo: "musica", busqueda: m[1] || m[3], app: m[2] || m[4] || ""})},
  // «llevame a la plaza»: el GPS de Maps, ya andando; «cómo llego al shopping»: la ruta, para elegir cómo ir
  {re: /^(?:llevame|lleva me|guiame|navega\w*|quiero ir)\s+(?:hasta |hacia |a la |al |a )(.+)$/,
   accion: (m) => ({tipo: "navegar", destino: m[1]})},
  {re: /^(?:como (?:llego|se llega|hago para (?:llegar|ir))|indicaciones para (?:ir|llegar))\s+(?:hasta |hacia |a la |al |a )(.+)$/,
   accion: (m) => ({tipo: "navegar", destino: m[1], ruta: true})},
];

function respuestaLocal(t) {
  // Lo que se contesta sin preguntarle a nadie: la hora, la fecha, la batería
  const ahora = new Date();
  if (/^(?:que hora es|me (?:decis|das) la hora|hora|la hora)$/.test(t)) {
    return `Son las ${String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}.`;
  }
  if (/^(?:que (?:dia|fecha) es(?: hoy)?|que fecha tenemos|en que dia estamos)$/.test(t)) {
    return `Hoy es ${DIAS[ahora.getDay()]} ${ahora.getDate()} de ${MESES[ahora.getMonth()]}.`;
  }
  if (/^(?:que (?:dia|fecha) (?:es|cae|sera) manana|manana que dia es)$/.test(t)) {   // (llega sin la ñ)
    const manana = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1);
    return `Mañana es ${DIAS[manana.getDay()]} ${manana.getDate()} de ${MESES[manana.getMonth()]}.`;
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
    return {texto: r.texto || "Listo.", acciones: r.ok ? [accion] : [], callado: !!r.callado};
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

  async preguntar(texto, alPedazo, alReinicio) {
    this.alPedazo = alPedazo;
    this.alReinicio = alReinicio || null;
    try {
      return await Nativo.cuando("cerebroPreguntar", this.modelo(), sistemaDelCelular(), claveDelCelular(),
                                 JSON.stringify(historiaDelCelular()), texto, 400);
    } finally {
      this.alPedazo = this.alReinicio = null;
    }
  },
};
Nativo.al("cerebro", (d) => {
  // reinicio: lo que venía escribiendo salía roto (la placa de video): lo repite con el procesador, desde cero
  if (d.reinicio) { if (Cerebro.alReinicio) Cerebro.alReinicio(); return; }
  if (Cerebro.alPedazo) Cerebro.alPedazo(d.pedazo);
});

function pareceBasura(t) {
  // Lo mismo que mira el cerebro del celular (Motor.java): una respuesta rota no se usa como historia
  const s = String(t || "").trim();
  const letras = (s.match(/\p{L}/gu) || []).length;
  if (letras < 2) return s.length > 0;
  if (s.length >= 20 && letras < s.length * 0.4) return true;
  if (s.includes("```") && letras < 25) return true;
  const lineas = s.split("\n").map((x) => x.trim()).filter(Boolean);
  const cortas = lineas.filter((x) => (x.match(/\p{L}/gu) || []).length <= 2).length;
  if (lineas.length >= 3 && cortas * 2 >= lineas.length) return true;
  const veces = {};
  return lineas.some((x) => x.length <= 12 && (veces[x] = (veces[x] || 0) + 1) >= 4);
}

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
  if (ajustesBot && ajustesBot.nombre) lineas.push(`Llamalo «${ajustesBot.nombre}».`);
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
  // (sin las respuestas rotas de antes: con ellas el cerebro se confundía más)
  const lista = mensajes.slice(0, -1).filter((m) => (m.quien === "vos" || m.quien === "jarvis") && m.texto
                                                 && !(m.local && pareceBasura(m.texto)))
    .slice(-6).map((m) => ({r: m.quien === "vos" ? "user" : "model", t: m.texto.replace(/^🎙️ /, "").replace(/^⏳ «[^»]*»\s*/, "")}));
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
      burbuja = $("mensajes").lastElementChild.querySelector(".texto-msg");
    }
    escrito += pedazo;
    burbuja.textContent = escrito;
    bajar();
    if (opciones.alEscribir) opciones.alEscribir(escrito);
    if (voz) voz.agregar(pedazo);
  }, () => {
    // salía roto con la placa de video: se borra y lo vuelve a pensar con el procesador (más lento, pero bien)
    escrito = "";
    if (burbuja) burbuja.textContent = "";
    pensando(true);
    if (opciones.alEscribir) opciones.alEscribir("Lo pienso de nuevo...");
    if (voz) voz.reiniciar();
  });
  pensando(false);
  const respuesta = r.error === "basura" ? "" : (r.texto || escrito).trim();
  if (!respuesta) {
    if (burbuja) {   // (lo que quedó a medias, roto, no se queda en la charla)
      burbuja.closest(".msg").remove();
      mensajes.pop();
      guardar("mensajes", mensajes);
    }
    const aviso = r.error === "basura"
      ? "El cerebro del celular no pudo armar una respuesta que se entienda. Probá preguntarlo de otra forma."
      : "El cerebro del celular no pudo contestar" + (r.error ? ` (${r.error})` : "") + ". Probá de nuevo.";
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

const ETIQUETA_AVISO = {buen_dia: "BUEN DÍA", noche: "PARA MAÑANA", cuidado: "CUIDATE", pc: "LA PC", recordatorio: "RECORDATORIO"};
const divDe = new WeakMap();   // el mensaje -> cómo se ve (para redibujarlo cuando llega su imagen)

function pintarMensaje(m, indice) {
  const div = document.createElement("div");
  div.className = "msg " + m.quien + (m.local ? " local" : "") + (m.aviso ? " de-aviso" : "");
  divDe.set(m, div);
  if (m.quien !== "aviso") {
    const quien = document.createElement("span");
    quien.className = "quien";
    quien.textContent = m.quien === "vos" ? "VOS" : m.local ? "JARVIS · SIN INTERNET"
      : m.aviso ? "🔔 JARVIS · " + (ETIQUETA_AVISO[m.aviso] || "AVISO") : "JARVIS";
    if (m.en) {
      const hora = document.createElement("time");
      hora.textContent = horaLinda(new Date(m.en));
      quien.appendChild(hora);
    }
    div.appendChild(quien);
  }
  if (m.deCola) {   // (lo pediste sin internet y salió después)
    const deCola = document.createElement("span");
    deCola.className = "de-cola";
    deCola.textContent = "⏳ Respuesta a «" + m.deCola + "»";
    div.appendChild(deCola);
  }
  const texto = document.createElement("span");
  texto.className = "texto-msg";
  texto.innerHTML = conFormato(m.texto || "");
  div.appendChild(texto);
  if (m.imagen) {   // (una foto que mandaste)
    const img = document.createElement("img");
    img.className = "foto";
    img.src = m.imagen;
    img.alt = "";
    img.decoding = "async";
    img.onclick = () => abrirVisor({imagenes: [{ref: null, mini: m.imagen, texto: "Tu foto"}]}, 0);
    div.appendChild(img);
  }
  if (m.imagenes && m.imagenes.length) div.appendChild(pintarGaleria(m));
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

function listaDeMensajes() {
  // (en la ventanita, lo que se habla se ve en su tarjeta; la charla de la app se redibuja al volver)
  return burbuja.activa ? $("burbuja-charla") : $("mensajes");
}

function bajar() {
  const lista = listaDeMensajes();
  lista.scrollTop = lista.scrollHeight;
}

const VISIBLES = 60;   // los mensajes que se dibujan al abrir (los de antes, con «Ver mensajes anteriores»)
let desdeVisible = 0;

function pintarCharla() {
  const lista = $("mensajes");
  lista.innerHTML = "";
  if (!mensajes.length) {
    lista.appendChild(pintarMensaje({quien: "jarvis", texto: "Hola, soy JARVIS. Escribime, tocá el micrófono para "
      + "hablarme, o tocá Llamar para charlar con manos libres."}, -1));
  }
  desdeVisible = Math.max(0, mensajes.length - VISIBLES);
  if (desdeVisible) lista.appendChild(botonAnteriores());
  const pedazo = document.createDocumentFragment();   // (todo junto: el celular dibuja una sola vez)
  for (let i = desdeVisible; i < mensajes.length; i++) pedazo.appendChild(pintarMensaje(mensajes[i], i));
  lista.appendChild(pedazo);
  bajar();
}

function botonAnteriores() {
  const boton = document.createElement("button");
  boton.className = "chip anteriores";
  boton.textContent = "Ver mensajes anteriores";
  boton.onclick = () => {
    const lista = $("mensajes"), alto = lista.scrollHeight, hasta = desdeVisible;
    desdeVisible = Math.max(0, desdeVisible - VISIBLES);
    const pedazo = document.createDocumentFragment();
    for (let i = desdeVisible; i < hasta; i++) pedazo.appendChild(pintarMensaje(mensajes[i], i));
    boton.after(pedazo);
    if (!desdeVisible) boton.remove();
    lista.scrollTop = lista.scrollHeight - alto;   // (queda donde estabas)
  };
  return boton;
}

function agregar(m) {
  m.en = m.en || Date.now();
  mensajes.push(m);
  if (mensajes.length > 150) mensajes = mensajes.slice(-150);
  guardarCharla();
  if (burbuja.activa) {
    burbuja.charlaSucia = true;
    $("burbuja-charla").appendChild(pintarMensaje(m, mensajes.length - 1));
  } else if (mensajes.length === 1) {
    pintarCharla();
  } else {
    $("mensajes").appendChild(pintarMensaje(m, mensajes.length - 1));
  }
  bajar();
  if ((m.aviso || m.sincronizado) && vistaActual !== "charla") marcarNovedad(true);
  return m;
}

function redibujar(m) {
  // (llegó la imagen de un mensaje que ya se ve)
  const viejo = divDe.get(m);
  if (viejo && viejo.isConnected) viejo.replaceWith(pintarMensaje(m, mensajes.indexOf(m)));
}

let guardandoCharla = null;
function guardarCharla(ya) {
  // Guardar los 150 mensajes en cada uno trababa la app un instante: se juntan y se guardan una vez. Si no entran (las
  // fotos ocupan lugar), se sacan las copias chicas de las fotos más viejas
  clearTimeout(guardandoCharla);
  const guardarYa = () => {
    try {
      localStorage.setItem(GUARDADO + "mensajes", JSON.stringify(mensajes));
    } catch (e) {
      mensajes.slice(0, Math.floor(mensajes.length / 2)).forEach((m) => {
        delete m.imagen;
        (m.imagenes || []).forEach((im) => { im.mini = null; im.perdida = true; });
      });
      guardar("mensajes", mensajes);
    }
  };
  if (ya) guardarYa();
  else guardandoCharla = setTimeout(guardarYa, 500);
}

function marcarNovedad(si) {
  // el puntito en la pestaña Charla: hay algo nuevo que todavía no viste (un aviso, algo de Telegram o de la PC)
  const pestana = document.querySelector(".pestana[data-vista=charla]");
  if (pestana) pestana.classList.toggle("con-novedad", si);
}

function pensando(si) {
  $("logo").classList.toggle("pensando", si);
  const viejo = document.querySelector(".msg.pensando");
  if (viejo) viejo.remove();
  if (si) {
    const div = document.createElement("div");
    div.className = "msg jarvis pensando";
    div.textContent = "Pensando";
    listaDeMensajes().appendChild(div);
    bajar();
  }
}

async function mandar(texto, opciones = {}) {
  // Le manda algo a JARVIS y muestra la respuesta. opciones: {foto, archivo, audio, llamada, porVoz, sinVoz, vista}
  // (vista: Live, lo que ve la cámara o la pantalla; se pide recién si no era algo para hacer en el celular)
  // Devuelve siempre {texto, tarjetas, acciones}: si falló, texto es el motivo de verdad (y error: true)
  let foto = opciones.foto || null, contexto = "";
  const archivo = opciones.archivo || null;
  const mio = agregar({quien: "vos", texto: texto || (opciones.audio ? "🎙️ ..." : ""), imagen: foto ? foto.miniatura : null,
                       archivo: archivo ? archivo.nombre : null});
  // un archivo de texto, sin internet: lo lee el cerebro del celular
  const textoDelArchivo = archivo && !hayInternet() ? leerTexto(archivo) : null;
  const local = !foto && !archivo && !opciones.audio && texto ? await hacerLocal(texto) : null;   // «abrí WhatsApp», «linterna»: al toque
  if (local) {
    agregar({quien: "jarvis", texto: local.texto, acciones: local.acciones});
    return {texto: local.texto, tarjetas: [], acciones: local.acciones, local: true, callado: local.callado};
  }
  if (!foto && opciones.vista && hayInternet()) {
    const vista = await opciones.vista();
    if (vista) {
      foto = vista.foto;
      contexto = vista.contexto;
      if (foto.miniatura) {
        mio.imagen = foto.miniatura;
        redibujar(mio);
      }
    }
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
    const r = await api("app_mensaje", {texto: (contexto && texto ? contexto + " " : "") + (texto || ""),
                                         llamada: !!opciones.llamada, audio: opciones.audio || null,
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
    const imagenes = await prepararImagenes(acciones);   // (las imágenes que hizo o encontró JARVIS)
    pensando(false);
    agregar({quien: "jarvis", texto: respuesta, tarjetas: r.tarjetas || [], acciones: acciones,
             imagenes: imagenes.length ? imagenes : undefined});
    const problema = await hacerAcciones(acciones);   // abrir la app, llamar, la alarma...
    if (problema) {
      agregar({quien: "aviso", texto: problema});
      respuesta = problema;   // (lo que se dice en voz alta: el problema, no «listo»)
    }
    // (si arrancó la música o el GPS en el celular, JARVIS no habla encima: queda escrito)
    const callado = !problema && Nativo.hay && acciones.some((a) => ["musica", "medios", "navegar"].includes(a.tipo));
    if (!opciones.llamada && !opciones.sinVoz && respuesta && !callado
        && (ajustes.leer === "siempre" || (ajustes.leer === "auto" && opciones.porVoz))) {
      Voz.decir(respuesta);
    }
    return {texto: respuesta, tarjetas: r.tarjetas || [], acciones: acciones, pedido: r.pedido, callado: callado,
            imagenes: imagenes};
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

// ---------- Los avisos de JARVIS (el buen día con el clima, lo que hizo la PC, los cuidados): en la charla ----------

let ultimoAviso = leerGuardado("ultimoAviso", 0);   // el número del último aviso que ya se ve acá
let ajustesBot = leerGuardado("ajustesBot", null);  // lo que se elige en Ajustes y vale también para Telegram

function mostrarAvisos(lista) {
  const nuevos = (lista || []).filter((a) => a.id > ultimoAviso).sort((a, b) => a.id - b.id);
  if (!nuevos.length) return;
  nuevos.forEach((a) => {
    const m = agregar({quien: "jarvis", texto: a.texto, aviso: a.tipo || "aviso", en: a.en,
                       imagenes: a.img ? [{ref: a.img, mini: null, texto: a.tipo === "pc" ? "Lo que mandó la PC" : ""}] : undefined});
    if (m.imagenes) completarImagenes(m);
  });
  ultimoAviso = nuevos[nuevos.length - 1].id;
  guardar("ultimoAviso", ultimoAviso);
  if (vistaActual !== "charla") {
    const ultimo = nuevos[nuevos.length - 1];
    avisar((ultimo.tipo === "pc" ? "🖥️ " : "🔔 ") + ultimo.texto.split("\n")[0].slice(0, 90), 6,
           {texto: "Ver", hacer: () => cambiarVista("charla")});
  }
}

async function traerAvisos() {
  // lo nuevo de la bandeja (cada minuto con la app a la vista, y al volver a la app)
  if (!conexion || !hayInternet()) return;
  try {
    const r = await api("app_avisos", {desde: ultimoAviso}, 40);
    if (r.ok) mostrarAvisos(r.avisos);
  } catch (e) { /* la próxima */ }
}

function configurarBuzon() {
  // la app de Android: los avisos llegan también con la app cerrada (como notificación), si los querés acá
  if (!Nativo.hay || !window.JarvisNativo.configurarBuzon) return;
  const activo = !!conexion && (!ajustesBot || ajustesBot.avisos_en !== "telegram");
  window.JarvisNativo.configurarBuzon(conexion ? conexion.u : "", conexion ? conexion.k : "", activo, ajustes.avisos !== false,
                                      String(ultimoAviso || 0));
}

async function guardarAjustesBot(cambios, aviso) {
  // lo que vale para el bot (dónde avisarte, el buen día, cómo te llama, el largo de las respuestas)
  if (!hayInternet()) return avisar("Para cambiar eso hace falta internet.", 4);
  try {
    const r = await api("app_ajustes", cambios, 40);
    if (!r.ok) throw new Error(r.error || "No pude guardarlo.");
    ponerAjustesBot(r.ajustes);
    configurarBuzon();
    if (aviso) avisar(aviso, 2.5);
  } catch (e) {
    avisar(e.message || "No pude guardarlo.", 4);
  }
}

function ponerAjustesBot(nuevos) {
  // si Inicio todavía muestra el saludo, lo vuelve a escribir (con el nombre nuevo)
  const saludo = saludoInicial();
  ajustesBot = nuevos;
  guardar("ajustesBot", ajustesBot);
  if ($("inicio-texto").textContent === saludo) $("inicio-texto").textContent = saludoInicial();
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
  // lo que ya se ve acá (también lo que contestó al tocar Confirmar, y las respuestas de lo que salió de la cola)
  const limpio = (t) => String(t || "").replace(/^🎙️ /, "").replace(/^⏳ «[^»]*»\s*/, "").trim();
  const yaEstan = new Set();
  mensajes.slice(-80).forEach((m) => {
    yaEstan.add(m.quien + "|" + limpio(m.texto));
    (m.tarjetas || []).forEach((t) => { if (t.resultado) yaEstan.add("jarvis|" + t.resultado); });
  });
  charla.slice(desde).forEach((m) => {
    const quien = m.r === "user" ? "vos" : "jarvis";
    const texto = m.t.replace(/^\(Te mandó [^)]*\)\s*/, "").replace(/^\(La PC hizo lo que pediste\)\s*/, "")
      .replace(/^\(Desde la app, orden para la PC\)\s*/, "🖥️ Orden para la PC: ");
    if (yaEstan.has(quien + "|" + limpio(texto))) return;
    yaEstan.add(quien + "|" + limpio(texto));
    // (las imágenes de ese mensaje —una de Telegram, la captura de la PC— se traen del bot)
    const nuevo = agregar({quien: quien, texto: texto, sincronizado: true,
                           imagenes: (m.img || []).length ? m.img.map((id) => ({ref: id, mini: null})) : undefined});
    if (nuevo.imagenes) completarImagenes(nuevo);
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
    if (r.imagenes && r.imagenes.length) {   // la imagen que hizo (o las fotos que encontró), también acá
      $("inicio-acciones").prepend(pintarGaleria({imagenes: r.imagenes}));
    }
    r.tarjetas.forEach((t, i) => $("inicio-acciones").appendChild(pintarTarjeta(t, mensajes.length - 1, i)));
    estadoInicio("hablando", respuesta);
    if (!r.dicho && !r.callado) await Voz.decir(respuesta);
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
  const umbral = UMBRALES[ajustes.sensibilidad] || UMBRALES.normal, pantalla = ajustes.pantallaApagada !== false;
  // (la app nueva espera a que Android la arranque y dice qué pasó; preguntar enseguida siempre daba «no»)
  const r = si && window.JarvisNativo.prenderEscucha ? await Nativo.cuando("prenderEscucha", umbral, pantalla)
    : Nativo.ya("escuchaFondo", si, umbral, pantalla);
  const anda = !!r.prendida || ["lista", "arrancando", "ocupado"].includes(r.arranque);
  ajustes.escucharJarvis = si && anda;
  guardar("ajustes", ajustes);
  $("escuchar-jarvis").checked = ajustes.escucharJarvis;
  if (callado || !si) return;
  if (!anda) {
    avisar({
      "error:microfono": `Para escucharte, dale permiso al micrófono (${DONDE_PERMISOS}).`,
      "error:android": "Android no dejó prender la escucha. En Ajustes del celular › Apps › JARVIS › Permisos, fijate que "
        + "el micrófono diga «Permitir mientras la app está en uso», y probá de nuevo.",
      "error:detector": "No pude cargar el detector de «Hey Jarvis» en este celular. Igual podés tocar HABLAR."
        + (r.detalle ? ` (El error: ${r.detalle})` : ""),
    }[r.arranque] || "No pude prender la escucha. Probá de nuevo en un momento.", r.detalle ? 20 : 9);
  } else if (r.arranque === "ocupado") {
    avisar("Quedó prendido, pero otra app está usando el micrófono: te escucha apenas lo suelte.", 7);
  } else if (!r.sobreApps) {
    avisar("Listo: decí «Hey Jarvis». Para que se abra sola aunque estés en otra app, dale el permiso «Mostrar sobre otras apps».",
           14, {texto: "Dar permiso", hacer: () => window.JarvisNativo.permisoSobreApps()});
  } else if (r.sinAhorro === false && window.JarvisNativo.pedirSinAhorro) {
    avisar("Listo: decí «Hey Jarvis». Para que el ahorro de batería no lo apague, tocá «Permitir» y aceptá.",
           14, {texto: "Permitir", hacer: () => window.JarvisNativo.pedirSinAhorro()});
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
  imagen: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/><path d="M17 2l.7 1.8L19.5 4.5l-1.8.7L17 7l-.7-1.8-1.8-.7 1.8-.7z"/>',
  fotos: '<rect x="3" y="6" width="13" height="13" rx="1.5"/><path d="M7 3h11a3 3 0 0 1 3 3v11"/><circle cx="14" cy="16" r="3"/><path d="M16.2 18.2L19 21"/>',
  captura: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4M6.5 9.5v-3h3M17.5 10.5v3h-3"/>',
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
  {id: "imagen", nombre: "Crear imagen", hacer: () => preguntarYHacer("¿Qué imagen te hago?", (t) => "Haceme una imagen de " + t)},
  {id: "fotos", nombre: "Buscar fotos", hacer: () => preguntarYHacer("¿De qué querés ver fotos?", (t) => "Mostrame fotos de " + t)},
  {id: "captura", nombre: "Captura PC", soloPc: true, hacer: () => ordenParaLaPc("Sacá una captura de pantalla")},
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


// ---------- Live: charlar manos libres (como Gemini Live) ----------
// Te escucha, piensa y te contesta hablando, una y otra vez, hasta que digas «chau» o toques la X. Le podés mostrar lo
// que ve la cámara o (en la app de Android) tu pantalla: cada vez que le hablás, le manda una foto de eso.

const llamada = {activa: false, pausada: false, silencios: 0, inicio: 0, reloj: null, pantalla: null, tocar: null,
                 camara: null, frente: false, viendo: false, mini: false, subtitulos: leerGuardado("subtitulos", true)};
const ETIQUETAS_LIVE = {escuchando: "Te escucho", pensando: "Pensando", hablando: "", libre: "En pausa"};

function estadoLlamada(estado, texto) {
  const live = $("live");
  live.classList.remove("escuchando", "pensando", "hablando", "libre");
  live.classList.add(estado);
  $("live-estado").textContent = ETIQUETAS_LIVE[estado] !== undefined ? ETIQUETAS_LIVE[estado] : estado;
  if (llamada.mini && Nativo.hay && window.JarvisNativo.pildora) {   // (Live chiquito: lo dice la píldora de arriba)
    window.JarvisNativo.pildora(estado === "libre" ? "En pausa · tocá para seguir" : ETIQUETAS_LIVE[estado] || "Hablando");
  }
  if (texto !== undefined) $("live-texto").textContent = texto;
  nivelLive(estado === "libre" ? 0.05 : estado === "pensando" ? 0.45 : 0.3);
}

let bajarLuz = null;
function nivelLive(nivel) {
  // la luz de abajo late con la voz: sube con cada sonido y vuelve sola
  if (!llamada.activa) return;
  $("live").style.setProperty("--nivel", Math.max(0, Math.min(1, nivel)).toFixed(2));
  clearTimeout(bajarLuz);
  bajarLuz = setTimeout(() => $("live").style.setProperty("--nivel", "0.3"), 260);
}

function esperarToque() {
  return new Promise((listo) => { llamada.tocar = listo; });
}

async function llamar(opciones = {}) {
  // opciones.pantalla: arranca mostrándole la pantalla (el botón «Compartir pantalla con Live» de la ventanita)
  if (!conexion) return mostrarConectar();
  if (llamada.activa) return;
  Voz.callar();
  Object.assign(llamada, {activa: true, pausada: false, silencios: 0, inicio: Date.now(), mini: false});
  Oido.soltar();   // si estaba esperando «Jarvis», deja el micrófono
  $("aviso").hidden = true;
  const live = $("live");
  live.hidden = false;
  live.classList.toggle("sin-subtitulos", !llamada.subtitulos);
  $("live-subtitulos").classList.toggle("activo", llamada.subtitulos);
  $("live-tarjetas").innerHTML = "";
  $("live-pantalla").hidden = !puedeVerPantalla();
  $("live-viendo").hidden = true;
  if (reactorInicio) reactorInicio.apagar();
  $("live-tiempo").textContent = "00:00";
  llamada.reloj = setInterval(() => {
    const s = Math.floor((Date.now() - llamada.inicio) / 1000);
    $("live-tiempo").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
  calentar();
  if (burbuja.activa && Nativo.hay) window.JarvisNativo.ventana("live");
  if (Nativo.hay) {   // que la pantalla no se apague mientras hablan
    window.JarvisNativo.pantallaPrendida(true);
  } else {
    try {
      llamada.pantalla = await navigator.wakeLock.request("screen");
    } catch (e) { /* no se puede: sigue igual */ }
  }
  estadoLlamada("escuchando", "");
  if (opciones.pantalla) await verPantallaLive(true);
  cicloLlamada();
}

function esCortar(texto) {
  const t = normalizar(texto);
  return /^(chau|chao|adios|nos vemos|hasta luego|colga|colgamos|corta|corta la llamada|corto|termina|terminamos|termina la llamada|fin)( jarvis)?$/.test(t);
}

async function cicloLlamada() {
  while (llamada.activa) {
    if (llamada.pausada) {
      estadoLlamada("libre", "Tocá ▶ (o la pantalla) para seguir.");
      await esperarToque();
      llamada.pausada = false;
      continue;
    }
    estadoLlamada("escuchando", "");
    if (navigator.vibrate) navigator.vibrate(25);
    const oido = await Oido.oir((parcial) => { $("live-texto").textContent = parcial; });
    if (!llamada.activa) return;
    if (oido.error === "not-allowed" || oido.error === "service-not-allowed") {
      await Voz.decir("No tengo permiso para usar el micrófono.");
      avisar(`Dale permiso al micrófono a la app (${DONDE_PERMISOS}) y abrí Live de nuevo.`, 7);
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
    const r = await mandar(oido.texto, {llamada: true, audio: oido.audio, hablarYa: true, vista: vistaDeLive,
                                        alEscribir: (t) => estadoLlamada("hablando", t)});
    if (!llamada.activa) return;
    let respuesta = r ? r.texto : "Uy, no me pude conectar. ¿Probamos de nuevo?";
    $("live-tarjetas").innerHTML = "";
    if (r && r.acciones.length) {   // abrir una app, música, WhatsApp: el botón aparece en Live
      pintarAcciones($("live-tarjetas"), r.acciones);
    }
    if (r && r.tarjetas.length) {   // hay que confirmar algo: los botones aparecen en Live también
      r.tarjetas.forEach((t, i) => $("live-tarjetas").appendChild(pintarTarjeta(t, mensajes.length - 1, i)));
      if (!respuesta) respuesta = "Confirmalo en la pantalla.";
    }
    estadoLlamada("hablando", respuesta);
    if (!(r && (r.dicho || r.callado))) await Voz.decir(respuesta);
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
  camaraLive(false);
  if (llamada.viendo) {
    llamada.viendo = false;
    if (Nativo.hay && window.JarvisNativo.dejarDeCompartir) window.JarvisNativo.dejarDeCompartir();
  }
  if (llamada.mini && Nativo.hay) window.JarvisNativo.ventana("live");   // (saca la píldora)
  llamada.mini = false;
  if (Nativo.hay) window.JarvisNativo.pantallaPrendida(false);
  if (llamada.tocar) llamada.tocar();
  $("live").hidden = true;
  $("live").classList.remove("con-camara");
  if (burbuja.activa) return cerrarBurbuja();   // (Live desde la ventanita: termina y volvés a lo que estabas)
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
  if ($("live").classList.contains("hablando")) Voz.callar();
  else if ($("live").classList.contains("escuchando")) Oido.cortar();
}

function pausar() {
  if (!llamada.activa) return;
  if (llamada.pausada || llamada.tocar) {
    tocarReactor();
    return;
  }
  llamada.pausada = true;
  Oido.cancelar();
  Voz.callar();
}

function subtitulosLive() {
  llamada.subtitulos = !llamada.subtitulos;
  guardar("subtitulos", llamada.subtitulos);
  $("live").classList.toggle("sin-subtitulos", !llamada.subtitulos);
  $("live-subtitulos").classList.toggle("activo", llamada.subtitulos);
}

// La cámara: lo que ve, se lo muestra a JARVIS cada vez que le hablás («¿qué planta es esta?», «¿cómo lo armo?»)
async function camaraLive(si) {
  const video = $("live-video");
  if (!si) {
    if (!llamada.camara) return;   // (no estaba prendida: el <video> ni se toca)
    llamada.camara.getTracks().forEach((t) => t.stop());
    llamada.camara = null;
    video.srcObject = null;
    video.hidden = true;
    $("live").classList.remove("con-camara");
    $("live-camara").classList.remove("activo");
    $("live-girar").hidden = true;
    return;
  }
  if (llamada.viendo) await verPantallaLive(false);   // (o la cámara o la pantalla)
  if (Nativo.hay && !Nativo.ya("permisos").camara && !(await Nativo.cuando("pedirPermiso", "camara")).si) {
    avisar(`Para mostrarle lo que ves, dale permiso a la cámara (${DONDE_PERMISOS}).`, 6);
    return;
  }
  try {
    const flujo = await navigator.mediaDevices.getUserMedia({audio: false,
      video: {facingMode: llamada.frente ? "user" : "environment", width: {ideal: 1280}, height: {ideal: 720}}});
    if (llamada.camara) llamada.camara.getTracks().forEach((t) => t.stop());
    llamada.camara = flujo;
  } catch (e) {
    avisar("No pude prender la cámara.", 4);
    return;
  }
  video.srcObject = llamada.camara;
  video.hidden = false;
  video.play().catch(() => {});
  $("live").classList.add("con-camara");
  $("live-camara").classList.add("activo");
  $("live-girar").hidden = false;
}

function fotoDeLaCamara() {
  // lo que se ve ahora en la cámara, como foto (para mandársela con lo que preguntaste)
  const video = $("live-video");
  if (!video.videoWidth) return null;
  const dibujar = (lado, calidad) => {
    const escala = Math.min(1, lado / Math.max(video.videoWidth, video.videoHeight));
    const lienzo = document.createElement("canvas");
    lienzo.width = Math.round(video.videoWidth * escala);
    lienzo.height = Math.round(video.videoHeight * escala);
    lienzo.getContext("2d").drawImage(video, 0, 0, lienzo.width, lienzo.height);
    return lienzo.toDataURL("image/jpeg", calidad);
  };
  return {datos: dibujar(1024, 0.8).split(",")[1], miniatura: dibujar(220, 0.6)};
}

async function miniaturaDeDatos(base64) {
  const img = new Image();
  await new Promise((listo, error) => { img.onload = listo; img.onerror = error; img.src = "data:image/jpeg;base64," + base64; });
  const escala = Math.min(1, 220 / Math.max(img.naturalWidth, img.naturalHeight));
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.round(img.naturalWidth * escala);
  lienzo.height = Math.round(img.naturalHeight * escala);
  lienzo.getContext("2d").drawImage(img, 0, 0, lienzo.width, lienzo.height);
  return lienzo.toDataURL("image/jpeg", 0.6);
}

async function vistaDeLive() {
  // Lo que Live le muestra a JARVIS con cada cosa que le decís: la cámara, o la pantalla (mientras Live está chiquito;
  // agrandado, en la pantalla se ve Live)
  if (llamada.camara) {
    const foto = fotoDeLaCamara();
    if (foto) return {foto: foto, contexto: "(Te muestro lo que ve ahora la cámara de mi celular.)"};
  }
  if (llamada.viendo && llamada.mini && Nativo.hay) {
    const r = await Nativo.cuando("capturarPantalla");
    if (r.ok && r.imagen) {
      let miniatura = null;
      try { miniatura = await miniaturaDeDatos(r.imagen); } catch (e) { /* sin miniatura */ }
      return {foto: {datos: r.imagen, miniatura: miniatura}, contexto: "(Te muestro lo que hay ahora en la pantalla de mi celular.)"};
    }
  }
  return null;
}

// La pantalla (solo en la app de Android): Android pregunta si se la mostrás; Live queda chiquito flotando arriba (la
// píldora de Android) y usás el celular mientras le hablás
const puedeVerPantalla = () => Nativo.hay && !!window.JarvisNativo.compartirPantalla;

async function verPantallaLive(si) {
  if (!si) {
    if (llamada.viendo && Nativo.hay) window.JarvisNativo.dejarDeCompartir();
    llamada.viendo = false;
    $("live-pantalla").classList.remove("activo");
    $("live-viendo").hidden = true;
    if (llamada.mini) liveMini(false);
    return;
  }
  if (!puedeVerPantalla()) return;
  await camaraLive(false);
  const r = await Nativo.cuando("compartirPantalla");
  if (!r.ok) {
    if (r.error !== "cancelado") avisar("Android no dejó compartir la pantalla.", 5);
    return;
  }
  llamada.viendo = true;
  $("live-pantalla").classList.add("activo");
  liveMini(true);
}

function liveMini(si) {
  // Chiquito: JARVIS se va atrás y queda la píldora flotando arriba (Android), para usar el celular mientras le hablás.
  // Sin el permiso «Mostrar sobre otras apps» no hay píldora: primero se ofrece (después, «Achicar» va igual, y se
  // vuelve tocando la notificación)
  if (si && Nativo.hay && window.JarvisNativo.pantallaEstado && !Nativo.ya("pantallaEstado").sobreApps && !llamada.pedidoSobreApps) {
    llamada.pedidoSobreApps = true;
    $("live-viendo").hidden = false;
    avisar("Para que Live quede arriba mientras usás el celular, dale el permiso «Mostrar sobre otras apps» y tocá «Achicar».",
           14, {texto: "Dar permiso", hacer: () => window.JarvisNativo.permisoSobreApps()});
    return;
  }
  llamada.mini = si;
  $("live-viendo").hidden = si || !llamada.viendo;
  if (!Nativo.hay) return;
  window.JarvisNativo.ventana(si ? "mini" : "live");
  if (si) estadoLlamada([...$("live").classList].find((c) => ETIQUETAS_LIVE[c] !== undefined) || "escuchando");
}

Nativo.al("pildora", (d) => {   // tocaste la píldora: ⤢ (Live grande), ✕ (terminar) o el texto (si estaba en pausa, sigue)
  if (!llamada.activa) return;
  if (d.accion === "abrir") liveMini(false);
  else if (d.accion === "fin") colgar();
  else tocarReactor();
});

Nativo.al("pantalla", (d) => {   // dejaste de compartir desde la notificación (o desde Android)
  if (d.compartiendo || !llamada.viendo) return;
  llamada.viendo = false;
  $("live-pantalla").classList.remove("activo");
  $("live-viendo").hidden = true;
  if (llamada.activa && llamada.mini) colgar();   // (Live chiquito sin la pantalla no tiene sentido: termina)
});


// ---------- La ventanita (como la del asistente de Google) ----------
// En la app de Android: al mantener apretado inicio, al decir «Hey Jarvis», o con el widget, JARVIS se abre como una
// barrita abajo, encima de la app en la que estabas (sin taparla). Es la misma página que la app (la misma charla):
// Android la pasa a una ventana transparente y avisa con el evento «modo».

const burbuja = {activa: false, sesion: null, ocupada: false, adjunto: null, charlaSucia: false};

function ponerModo(d) {
  const enBurbuja = !!d && d.modo === "burbuja";
  const antes = burbuja.activa;
  burbuja.activa = enBurbuja;
  document.documentElement.classList.toggle("modo-burbuja", enBurbuja);
  $("burbuja").hidden = !enBurbuja;
  if (!enBurbuja) {
    if (antes) {
      if (burbuja.charlaSucia) pintarCharla();   // (lo que hablaste en la ventanita, ahora en la charla)
      burbuja.charlaSucia = false;
      if (llamada.activa && llamada.mini) liveMini(false);   // Live chiquito y abriste la app: Live grande, en la app
    }
    if (vistaActual === "inicio" && reactorInicio && !llamada.activa) reactorInicio.prender();
    return;
  }
  if (!conexion) return abrirEnLaApp();   // (todavía no está conectada: eso se hace en la app)
  if (reactorInicio) reactorInicio.apagar();
  $("aviso").hidden = true;
  if (d.sesion !== burbuja.sesion) {   // una ventanita nueva: empieza de cero (la charla de la app sigue igual)
    burbuja.sesion = d.sesion;
    $("burbuja-charla").innerHTML = "";
    $("burbuja-hoja").hidden = true;
    $("burbuja-caja").value = "";
    sacarAdjuntoBurbuja();
    barraBurbuja();
  }
  $("burbuja-compartir").hidden = !puedeVerPantalla() || llamada.activa;
  if (d.ventana === "mini" || d.ventana === "live") {
    if (!llamada.activa) llamar();
    else liveMini(d.ventana === "mini" && llamada.viendo);
    return;
  }
  if (llamada.activa) return;   // (Live sigue: la ventanita lo muestra)
  if (Nativo.hay) window.JarvisNativo.ventana("barra");
  if (d.escuchar) escucharEnBurbuja();
}

function cerrarBurbuja() {
  Voz.callar();
  Oido.cancelar();
  burbuja.sesion = null;   // (la próxima vez, de cero)
  if (Nativo.hay) window.JarvisNativo.ventana("cerrar");
}

function abrirEnLaApp() {
  // como «Abrir en Gemini»: la app entera, en la charla (con lo que hablaste acá)
  Voz.callar();
  Oido.cancelar();
  burbuja.sesion = null;
  if (Nativo.hay) window.JarvisNativo.ventana("app");
}

function barraBurbuja() {
  $("burbuja-barra").classList.toggle("con-texto", !!$("burbuja-caja").value.trim() || !!burbuja.adjunto);
}

function mostrarAdjuntoBurbuja(adjunto) {
  burbuja.adjunto = adjunto;
  $("burbuja-adjunto").hidden = false;
  $("burbuja-adjunto-img").src = adjunto.tipo === "foto" ? adjunto.miniatura : "";
  $("burbuja-adjunto-texto").textContent = adjunto.tipo === "foto" ? "Foto lista" : "📄 " + adjunto.nombre;
  $("burbuja-caja").placeholder = "¿Qué querés saber de esto?";
  barraBurbuja();
}

function sacarAdjuntoBurbuja() {
  burbuja.adjunto = null;
  $("burbuja-adjunto").hidden = true;
  $("burbuja-archivo").value = "";
  $("burbuja-caja").placeholder = "Preguntarle a JARVIS";
  barraBurbuja();
}

async function preguntarEnBurbuja(texto, porVoz) {
  if (burbuja.ocupada) return;
  const adjunto = burbuja.adjunto;
  if (!texto && !adjunto) return;
  burbuja.ocupada = true;
  $("burbuja-caja").value = "";
  sacarAdjuntoBurbuja();
  $("burbuja-hoja").hidden = false;
  $("burbuja-compartir").hidden = true;
  try {
    const opciones = {porVoz: porVoz, sinVoz: !porVoz};
    if (adjunto && adjunto.tipo === "foto") opciones.foto = adjunto;
    else if (adjunto) opciones.archivo = adjunto;
    await mandar(texto || "", opciones);
  } finally {
    burbuja.ocupada = false;
  }
}

async function escucharEnBurbuja() {
  // el micrófono de la barrita: te escucha, y lo que dijiste va al toque (la respuesta se dice en voz alta)
  if (burbuja.ocupada) {
    Voz.callar();
    Oido.cortar();
    Cerebro.parar();
    return;
  }
  burbuja.ocupada = true;
  Voz.callar();
  calentar();
  const barra = $("burbuja-barra"), caja = $("burbuja-caja");
  barra.classList.add("escuchando");
  caja.placeholder = "Te escucho…";
  let r;
  try {
    await Oido.soltar();
    r = await Oido.oir((parcial) => { caja.value = parcial; });
  } finally {
    barra.classList.remove("escuchando");
    caja.placeholder = burbuja.adjunto ? "¿Qué querés saber de esto?" : "Preguntarle a JARVIS";
    burbuja.ocupada = false;
  }
  caja.value = "";
  barraBurbuja();
  if (sinOidoSinInternet(r)) return avisoOidoSinInternet();
  if (r.error === "not-allowed") return avisar(`Dale permiso al micrófono para hablarme (${DONDE_PERMISOS}).`, 6);
  if (r.audio) {
    burbuja.ocupada = true;
    $("burbuja-hoja").hidden = false;
    try { await mandar("", {audio: r.audio, porVoz: true}); } finally { burbuja.ocupada = false; }
    return;
  }
  if (r.texto) await preguntarEnBurbuja(r.texto, true);
}

function conectarBurbuja() {
  $("burbuja-fuera").onclick = cerrarBurbuja;
  $("burbuja-cerrar").onclick = cerrarBurbuja;
  $("burbuja-abrir").onclick = abrirEnLaApp;
  $("burbuja-live").onclick = () => llamar();
  $("burbuja-compartir").onclick = () => llamar({pantalla: true});
  $("burbuja-caja").addEventListener("input", barraBurbuja);
  $("burbuja-barra").addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = $("burbuja-caja").value.trim();
    if (texto || burbuja.adjunto) preguntarEnBurbuja(texto, false);
    else escucharEnBurbuja();
  });
  $("burbuja-mas").onclick = () => $("burbuja-archivo").click();
  $("burbuja-archivo").onchange = async () => {
    const archivo = $("burbuja-archivo").files[0];
    if (!archivo) return;
    try {
      mostrarAdjuntoBurbuja(await prepararAdjunto(archivo));
    } catch (e) {
      $("burbuja-archivo").value = "";
      avisar(e.message && !/onload|Event/.test(e.message) ? e.message : "No pude abrir ese archivo.", 5);
    }
  };
  $("burbuja-adjunto-sacar").onclick = sacarAdjuntoBurbuja;
  Nativo.al("modo", ponerModo);
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
  pintarHud();   // (el clima y lo próximo de Inicio salen de acá también)
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

async function comoEstaLaPc() {
  // no hace falta mandarle una orden: lo último que contó la PC (se actualiza cada minuto mientras está prendida)
  await cargarDatos();
  const pc = datosDia && datosDia.pc;
  if (!pc || pc.nota) return avisar("Todavía no sé nada de la PC: se conecta cuando abrís JARVIS en la compu.", 5);
  let texto = `La PC está ${pc.prendida ? "prendida" : "apagada"} (última noticia: ${pc.ultimo_contacto}).`;
  if (pc.jugando) texto += ` Estás jugando${pc.juego ? " " + pc.juego : ""}.`;
  if (pc.bateria !== undefined) texto += ` Batería ${pc.bateria}%${pc.enchufada ? ", enchufada" : ""}.`;
  avisar(texto, 7);
}

let esperandoLaPc = null;
function esperarRespuestaDeLaPc() {
  // la PC lo hace en el próximo minuto: mientras tanto se pregunta más seguido, así la respuesta (o la captura) aparece
  // apenas llega, y no un minuto después
  clearInterval(esperandoLaPc);
  const hasta = Date.now() + 3 * 60000;
  esperandoLaPc = setInterval(() => {
    if (Date.now() > hasta) return clearInterval(esperandoLaPc);
    const antes = ultimoAviso;
    traerAvisos().then(() => { if (ultimoAviso !== antes) clearInterval(esperandoLaPc); });
  }, 15000);
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
    esperarRespuestaDeLaPc();
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


// ---------- Inicio: la hora, el clima, la batería y lo próximo, alrededor del reactor (como un HUD) ----------

function pintarHud() {
  const ahora = new Date();
  $("hud-hora").textContent = horaLinda(ahora);
  $("hud-fecha").textContent = `${DIAS[ahora.getDay()]} ${ahora.getDate()} de ${MESES[ahora.getMonth()]}`;
  const d = datosDia || {};
  if (d.clima && d.clima.ahora) {
    $("hud-clima").textContent = d.clima.ahora.temperatura + "°";
    $("hud-cielo").textContent = d.clima.lugar || "";
    $("hud-der").hidden = false;
  } else {
    $("hud-der").hidden = true;
  }
  let bateria = "";
  if (Nativo.hay && window.JarvisNativo.bateria) {
    try {
      const b = Nativo.ya("bateria");
      bateria = (b.cargando ? "⚡ " : "🔋 ") + b.nivel + "%";
    } catch (e) { /* sin batería */ }
  }
  $("hud-bateria").textContent = bateria;
  const proximo = (d.recordatorios || []).find((r) => new Date(String(r.cuando).slice(0, 16)) > ahora);
  $("hud-proximo").textContent = proximo ? "⏰ " + cuandoLindo(proximo.cuando).replace(/^hoy a las /, "") + " · " + proximo.texto : "";
}

function saludoInicial() {
  // «Buenas tardes, Rusty.» (con el nombre que elegiste en Ajustes)
  const h = new Date().getHours();
  const saludo = h < 6 ? "Buenas noches" : h < 13 ? "Buen día" : h < 20 ? "Buenas tardes" : "Buenas noches";
  const nombre = ajustesBot && ajustesBot.nombre ? ", " + ajustesBot.nombre : "";
  return `${saludo}${nombre}. Tocá el micrófono y hablame.`;
}

// Los colores (como las armaduras): el de siempre, el rojo del Mark III, dorado, verde y violeta
const COLORES = {
  celeste: {cian: "#29d9ff", fuerte: "#7ae9ff", oscuro: "#1aa6cf", rgb: "41, 217, 255"},
  rojo: {cian: "#ff4d5e", fuerte: "#ff8f99", oscuro: "#c9283b", rgb: "255, 77, 94"},
  dorado: {cian: "#ffc24a", fuerte: "#ffdb8f", oscuro: "#c98d18", rgb: "255, 194, 74"},
  verde: {cian: "#3dffa8", fuerte: "#94ffcf", oscuro: "#17b874", rgb: "61, 255, 168"},
  violeta: {cian: "#a77bff", fuerte: "#cbb0ff", oscuro: "#7448d6", rgb: "167, 123, 255"},
};

function aplicarApariencia() {
  const c = COLORES[ajustes.color] || COLORES.celeste;
  const raiz = document.documentElement;
  raiz.style.setProperty("--cian", c.cian);
  raiz.style.setProperty("--cian-fuerte", c.fuerte);
  raiz.style.setProperty("--cian-oscuro", c.oscuro);
  raiz.style.setProperty("--cian-rgb", c.rgb);
  raiz.dataset.animaciones = ajustes.animaciones || "completas";
  raiz.dataset.letra = ajustes.letra || "normal";
  [reactorInicio].forEach((r) => { if (r && r.apariencia) r.apariencia(c.rgb, raiz.dataset.animaciones); });
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
  if (nombre === "charla") {
    bajar();
    marcarNovedad(false);
  }
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
  $("ajuste-tono").value = ajustes.tono || 1;
  $("tono-valor").textContent = Number(ajustes.tono || 1).toFixed(2);
  // lo que vale también para el bot (y Telegram): si el bot todavía es el de antes, no se puede
  const b = ajustesBot;
  document.querySelectorAll(".del-bot").forEach((x) => { x.disabled = !b; });
  $("ajustes-bot-viejo").hidden = !!b;
  if (b) {
    $("ajuste-nombre").value = b.nombre || "";
    $("ajuste-largo").value = b.estilo || "normal";
    $("ajuste-avisos-en").value = b.avisos_en || "telegram";
    $("ajuste-avisos-en").closest("label").hidden = !b.telegram;   // (sin Telegram, todo va a la app)
    $("ajuste-buen-dia").value = String(b.buen_dia === undefined ? 8 : b.buen_dia);
    $("ajuste-noche").checked = b.noche !== false;
    $("ajuste-cuidados").checked = b.cuidados !== false;
  }
  document.querySelectorAll("#ajuste-colores [data-color]").forEach((x) => {
    x.classList.toggle("elegido", x.dataset.color === (ajustes.color || "celeste"));
  });
  $("ajuste-animaciones").value = ajustes.animaciones || "completas";
  $("ajuste-letra").value = ajustes.letra || "normal";
  $("ajuste-vibrar").checked = ajustes.vibrar !== false;
  $("ajuste-avisos").checked = ajustes.avisos !== false;
  $("ajuste-sensibilidad").value = ajustes.sensibilidad || "normal";
  $("ajuste-pantalla-apagada").checked = ajustes.pantallaApagada !== false;
  $("ajustes-nativos").hidden = !Nativo.hay;
  if (Nativo.hay) {   // el cerebro sin internet: cómo va la bajada, mientras están abiertos los ajustes
    const e = Nativo.ya("escuchaEstado");   // (el botón de la batería, solo si hace falta)
    $("ajuste-bateria").hidden = e.sinAhorro !== false || !window.JarvisNativo.pedirSinAhorro;
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
  ajustes.tono = Number($("ajuste-tono").value);
  if (Nativo.hay && window.JarvisNativo.tonoVoz) window.JarvisNativo.tonoVoz(ajustes.tono);
  ajustes.vibrar = $("ajuste-vibrar").checked;
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
  // la placa de video: más rápida, pero en algunos celulares calcula mal (y las respuestas salían rotas)
  $("ajuste-placa").checked = e.placaModo !== "cpu";
  $("ajuste-placa").closest("label").hidden = e.placaModo === undefined;   // (una app vieja no lo sabe)
  if ((e.placaMala || []).includes(m.id) && e.placaModo !== "cpu") {
    texto += " En este celular la placa de video contestaba mal, así que uso el procesador (más lento, pero bien).";
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
    if (!$("visor").hidden) { cerrarVisor(); return true; }
    if ($("ajustes").open) { $("ajustes").close(); return true; }
    if (llamada.activa) { colgar(); return true; }
    if (burbuja.activa) { cerrarBurbuja(); return true; }
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
  Nativo.al("escucha", (d) => {   // «Hey Jarvis» se prendió o se apagó desde afuera (la notificación, el widget)
    ajustes.escucharJarvis = !!d.prendida;
    guardar("ajustes", ajustes);
    $("escuchar-jarvis").checked = ajustes.escucharJarvis;
  });
  Nativo.al("ir", (d) => {   // tocaste un aviso de JARVIS (la notificación): la charla, con lo nuevo
    cambiarVista(d.vista || "charla");
    traerAvisos();
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
    if (Nativo.hay && ajustes.vibrar !== false) window.JarvisNativo.toque();
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
  $("boton-llamar").onclick = () => llamar();
  $("live-fin").onclick = colgar;
  $("live-pausa").onclick = pausar;
  $("live-centro").onclick = (e) => { if (!e.target.closest("button")) tocarReactor(); };   // tocar: interrumpe o sigue
  $("live-subtitulos").onclick = subtitulosLive;
  $("live-camara").onclick = () => camaraLive(!llamada.camara);
  $("live-girar").onclick = () => { llamada.frente = !llamada.frente; camaraLive(true); };
  $("live-pantalla").onclick = () => verPantallaLive(!llamada.viendo);
  $("live-achicar").onclick = () => liveMini(true);
  $("live-dejar").onclick = () => verPantallaLive(false);
  conectarBurbuja();
  $("boton-hablar").onclick = hablarEnInicio;
  $("inicio-reactor").onclick = () => { if (ocupado) { Voz.callar(); Oido.cortar(); Cerebro.parar(); } };
  $("hud-proximo").onclick = (e) => { e.stopPropagation(); cambiarVista("dia"); };
  $("hud-der").onclick = (e) => { e.stopPropagation(); cambiarVista("dia"); };
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
    chip.textContent = orden.texto || orden;
    chip.onclick = () => (orden.local ? comoEstaLaPc() : ordenParaLaPc(orden));
    $("ordenes-rapidas").appendChild(chip);
  });
  $("orden-libre").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await ordenParaLaPc($("caja-orden").value)) $("caja-orden").value = "";
  });

  $("boton-ajustes").onclick = abrirAjustes;
  $("ajustes").addEventListener("close", guardarAjustes);
  $("ajuste-velocidad").oninput = () => { $("velocidad-valor").textContent = Number($("ajuste-velocidad").value).toFixed(2) + "x"; };
  $("ajuste-tono").oninput = () => { $("tono-valor").textContent = Number($("ajuste-tono").value).toFixed(2); };
  // lo que vale también para el bot (se guarda allá, así sirve para Telegram)
  $("ajuste-nombre").onchange = () => guardarAjustesBot({nombre: $("ajuste-nombre").value.trim()}, "Listo: así te llamo.");
  $("ajuste-largo").onchange = () => guardarAjustesBot({estilo: $("ajuste-largo").value}, "Listo.");
  $("ajuste-avisos-en").onchange = () => guardarAjustesBot({avisos_en: $("ajuste-avisos-en").value},
    {app: "Listo: los avisos te llegan acá.", telegram: "Listo: los avisos van a Telegram.",
     ambos: "Listo: los avisos te llegan acá y a Telegram."}[$("ajuste-avisos-en").value]);
  $("ajuste-buen-dia").onchange = () => guardarAjustesBot({buen_dia: Number($("ajuste-buen-dia").value)},
    Number($("ajuste-buen-dia").value) < 0 ? "Listo: sin buen día." : `Listo: el buen día, a las ${$("ajuste-buen-dia").value}.`);
  $("ajuste-noche").onchange = () => guardarAjustesBot({noche: $("ajuste-noche").checked}, "Listo.");
  $("ajuste-cuidados").onchange = () => guardarAjustesBot({cuidados: $("ajuste-cuidados").checked}, "Listo.");
  // la apariencia (se ve al toque)
  document.querySelectorAll("#ajuste-colores [data-color]").forEach((x) => {
    x.onclick = () => {
      ajustes.color = x.dataset.color;
      guardar("ajustes", ajustes);
      document.querySelectorAll("#ajuste-colores [data-color]").forEach((y) => y.classList.toggle("elegido", y === x));
      aplicarApariencia();
    };
  });
  $("ajuste-animaciones").onchange = () => {
    ajustes.animaciones = $("ajuste-animaciones").value;
    guardar("ajustes", ajustes);
    aplicarApariencia();
  };
  $("ajuste-letra").onchange = () => {
    ajustes.letra = $("ajuste-letra").value;
    guardar("ajustes", ajustes);
    aplicarApariencia();
  };
  $("ajuste-placa").onchange = () => {   // el cerebro sin internet: con la placa de video (rápido) o el procesador
    if (window.JarvisNativo.cerebroPlaca) window.JarvisNativo.cerebroPlaca($("ajuste-placa").checked ? "auto" : "cpu");
    setTimeout(pintarCerebro, 300);
  };
  // el visor de imágenes
  $("visor-cerrar").onclick = cerrarVisor;
  $("visor-anterior").onclick = () => moverVisor(-1);
  $("visor-siguiente").onclick = () => moverVisor(1);
  $("visor-guardar").onclick = () => guardarImagenEntera(visor.m.imagenes[visor.i]);
  $("visor-compartir").onclick = () => compartirImagen(visor.m.imagenes[visor.i]);
  $("visor-fuente").onclick = () => abrirUrl(visor.m.imagenes[visor.i].url);
  $("visor-otra").onclick = () => {
    const im = visor.m.imagenes[visor.i];
    cerrarVisor();
    otraVersion(im);
  };
  $("visor-img").ondblclick = () => $("visor-img").classList.toggle("zoom");
  let tocado = null;   // deslizar para pasar de foto
  $("visor-foto").addEventListener("touchstart", (e) => { tocado = e.touches.length === 1 ? e.touches[0].clientX : null; },
                                   {passive: true});
  $("visor-foto").addEventListener("touchend", (e) => {
    if (tocado === null || !visor.m || visor.m.imagenes.length < 2 || $("visor-img").classList.contains("zoom")) return;
    const dx = e.changedTouches[0].clientX - tocado;
    if (Math.abs(dx) > 60) moverVisor(dx < 0 ? 1 : -1);
  }, {passive: true});
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
  $("ajuste-bateria").onclick = () => {
    window.JarvisNativo.pedirSinAhorro();
    avisar("Tocá «Permitir»: así el ahorro de batería no apaga «Hey Jarvis».", 6);
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
      traerAvisos();
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
    guardarCharla(true);   // (por si Android cierra la app mientras está por detrás)
  };
  document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? alVolver() : alIrse()));
  // (en la app de Android, Android avisa también: el WebView no siempre cambia la visibilidad de la página)
  Nativo.al("pausa", () => {
    enPausa = true;
    alIrse();
    if (burbuja.activa && !llamada.activa && !Nativo.ya("pantallaEstado").compartiendo) Voz.callar();
  });
  Nativo.al("vuelta", () => { enPausa = false; alVolver(); });
}

// si la app ya estaba abierta y tocás el link de /app, solo cambia lo de después del #: se vuelve a arrancar con eso
window.addEventListener("hashchange", () => { if (/[#&]k=/.test(location.hash)) location.reload(); });

async function primerosDatos() {
  // Todo lo del arranque en un solo pedido (la charla y Mi día). Si el bot todavía es el de antes, como antes
  let d = null;
  try {
    d = await apiLeer("app_inicio", {desde: ultimoAviso});
  } catch (e) {
    if (e.tipo === "sin_red") return;   // sin internet: queda lo último que se vio
  }
  if (d && d.ok) {
    const {charla, avisos, ajustes: delBot, ...datos} = d;
    sincronizarCharla({charla: charla});
    cargarDatos(datos);
    if (delBot) {
      ponerAjustesBot(delBot);
      // la primera vez: los avisos (el buen día, lo de la PC...) a la app, como pediste; en Ajustes se cambia
      if (!delBot.avisos_en && !leerGuardado("avisosElegidos", false)) {
        guardar("avisosElegidos", true);
        guardarAjustesBot({avisos_en: "app"});
      }
    }
    // (la primera vez, solo los últimos tres: no toda la semana de golpe)
    if (avisos) mostrarAvisos(ultimoAviso ? avisos : avisos.slice(-3));
    configurarBuzon();
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
    if (Nativo.info.oido === false && window.JarvisNativo.microfono) puedeOir = false;   // (un celular sin el de Google)
  }
  leerLink();
  reactorInicio = crearReactor($("reactor-inicio"));
  conectarBotones();
  pintarProtocolos();
  if (!Nativo.hay && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!conexion) {
    const copiado = linkDelPortapapeles();   // copiaste el link de /app: se conecta solo
    if (copiado && confirm("¿Conecto la app con el JARVIS del link que copiaste?") && conectarCon(copiado.u, copiado.k)) return;
    return mostrarConectar();
  }
  reactorInicio.prender();
  $("inicio-texto").textContent = saludoInicial();
  if (Nativo.hay && window.JarvisNativo.tonoVoz && ajustes.tono) window.JarvisNativo.tonoVoz(ajustes.tono);
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
  // cada minuto, mientras la app está a la vista: lo nuevo de la charla (lo que contó la PC, lo de Telegram) y los avisos
  setInterval(() => {
    if (document.visibilityState === "visible" && !llamada.activa && hayInternet()) {
      sincronizarCharla();
      traerAvisos();
      mandarCola();   // (lo que se anotó mientras Google no contestaba)
    }
    pintarHud();   // (la hora y lo demás de Inicio)
  }, 60000);
  pintarHud();
  aplicarApariencia();
  if (Nativo.hay) {   // «Hey Jarvis» con la app cerrada (si estaba prendido: después de reiniciar el celular, vuelve acá)
    $("escuchar-jarvis").nextElementSibling.textContent = "Escuchar «Hey Jarvis» (también con la app cerrada)";
    // lo que dice Android manda: si lo apagaste desde la notificación o el widget, queda apagado; si lo prendiste
    // desde el widget, queda prendido (quiere: null en las apps de antes, que no lo anotaban)
    const e = Nativo.ya("escuchaEstado");
    if (typeof e.quiere === "boolean" || e.prendida) {
      ajustes.escucharJarvis = !!(e.prendida || e.quiere);
      guardar("ajustes", ajustes);
      $("escuchar-jarvis").checked = ajustes.escucharJarvis;
    }
    if (ajustes.escucharJarvis && !e.prendida) activarEscuchaFondo(true, true);
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
