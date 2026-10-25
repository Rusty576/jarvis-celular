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
// ============================================================
"use strict";

const VERSION_APP = "2026.10.24.2";
const $ = (id) => document.getElementById(id);
const Reco = window.SpeechRecognition || window.webkitSpeechRecognition;

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
                               escucharJarvis: false}, leerGuardado("ajustes", {}));
let conexion = leerGuardado("conexion", null);         // {u: la dirección del bot, k: la llave}
let mensajes = leerGuardado("mensajes", []);           // la charla, como se ve en este celular
let ultimaCharla = leerGuardado("ultimaCharla", null); // el último mensaje de la charla del bot que ya está acá
let datosDia = leerGuardado("dia", null);              // lo último de «Mi día» y la PC (se ve aunque no haya internet)
let vistaActual = "inicio";
let ultimoToque = 0;   // el celular solo deja abrir otra app justo después de que tocaste algo

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

async function api(accion, datos = {}, segundos = 100) {
  // Un pedido al bot. Va como texto (sin encabezados raros): así Google lo acepta desde otra página
  if (!conexion) throw new Error("La app no está conectada.");
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), segundos * 1000);
  try {
    const r = await fetch(conexion.u, {method: "POST", body: JSON.stringify(Object.assign({accion: accion, app: conexion.k}, datos)),
                                       signal: control.signal});
    const d = await r.json();
    marcarConexion(true);
    if (!d.ok && d.error === "llave") {
      mostrarConectar(d.detalle);
      throw new Error(d.detalle);
    }
    return d;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("JARVIS tardó demasiado en contestar. Probá de nuevo.");
    if (e instanceof TypeError || e instanceof SyntaxError) {
      marcarConexion(false);
      throw new Error("No me pude conectar con JARVIS (¿hay internet?).");
    }
    throw e;
  } finally {
    clearTimeout(corte);
  }
}

function marcarConexion(bien) {
  $("punto").className = "punto " + (bien ? "bien" : "mal");
  $("estado-conexion").textContent = bien ? "en línea" : "sin conexión";
}

function mostrarConectar(detalle) {
  $("conectar").hidden = false;
  $("conectar-detalle").textContent = detalle || "";
}

function avisar(texto, segundos = 3.5) {
  const aviso = $("aviso");
  aviso.textContent = texto;
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
    if (window.speechSynthesis) speechSynthesis.cancel();
  },
};
if (window.speechSynthesis && speechSynthesis.addEventListener) speechSynthesis.addEventListener("voiceschanged", llenarVoces);


// ---------- El oído: reconocimiento de voz de Chrome, o grabar y que el bot lo pase a texto ----------

const Oido = {
  rec: null,
  fin: Promise.resolve(),   // se cumple cuando el reconocimiento que está andando termina del todo

  escuchar(alOir) {
    // Una frase: termina sola cuando dejás de hablar. Devuelve {texto, error}
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

  cortar() {   // termina y entrega lo que oyó
    if (this.rec) try { this.rec.stop(); } catch (e) { /* ya terminó */ }
    Grabadora.detener();
  },

  cancelar() {   // termina sin entregar nada
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
    // {texto} con el reconocimiento de Chrome, o {audio} grabado (lo pasa a texto el bot)
    if (Reco) return this.escuchar(alOir);
    const audio = await Grabadora.grabar();
    if (audio === "no-permitido") return {texto: "", error: "not-allowed"};
    return audio ? {texto: "", audio: audio} : {texto: "", error: "no-speech"};
  },
};

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
  if (a.tipo === "musica") {
    const donde = {youtube: APPS.youtube, ytmusic: APPS["youtube music"], spotify: APPS.spotify}[ajustes.musica] || APPS.youtube;
    return {texto: `Poner «${a.busqueda}» en ${donde.nombre}`, url: donde.buscar(q)};
  }
  const app = appDe(a.app);
  if (!app) return {texto: `Buscar «${a.app}» en Play Store`, url: APPS["play store"].buscar(encodeURIComponent(a.app))};
  return {texto: `Abrir ${app.nombre}`, url: a.busqueda && app.buscar ? app.buscar(q) : app.url};
}

function abrirUrl(url) {
  if (/^https?:/.test(url)) window.open(url, "_blank", "noopener");   // la app la agarra (o se abre en Chrome)
  else location.href = url;                                          // intent:, tel:, spotify:...
}

function intentarAbrir(accion) {
  // Recién tocaste algo: el celular deja abrirla sola. Si no, queda el botón para tocar
  if (Date.now() - ultimoToque < 4500) abrirUrl(accionAUrl(accion).url);
}

function pintarAcciones(contenedor, acciones) {
  contenedor.innerHTML = "";
  (acciones || []).forEach((a) => {
    const {texto, url} = accionAUrl(a);
    const boton = document.createElement("button");
    boton.className = "accion";
    boton.textContent = "▶ " + texto;
    boton.onclick = () => abrirUrl(url);
    contenedor.appendChild(boton);
  });
}

// "abrí WhatsApp", "abrime la cámara": se hace al toque, sin preguntarle al bot
const ABRIR = /^(?:jarvis\s+)?(?:abr[ie]\w*|entra(?:me)? a|anda a|pone(?:me)?|inicia)\s+(?:el |la |los |las |mi |el app de )?(.+)$/;

function comandoLocal(texto) {
  const m = ABRIR.exec(normalizar(texto));
  const app = m && appDe(m[1]);
  if (!app) return null;
  const accion = {tipo: "abrir", app: app.clave};
  abrirUrl(accionAUrl(accion).url);
  return {texto: `Abriendo ${app.nombre}.`, acciones: [accion]};
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
  div.className = "msg " + m.quien;
  if (m.quien !== "aviso") {
    const quien = document.createElement("span");
    quien.className = "quien";
    quien.textContent = m.quien === "vos" ? "VOS" : "JARVIS";
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
  // Le manda algo a JARVIS y muestra la respuesta. opciones: {foto, audio, llamada, porVoz, sinVoz}
  const foto = opciones.foto || null;
  const mio = agregar({quien: "vos", texto: texto || (opciones.audio ? "🎙️ ..." : ""), imagen: foto ? foto.miniatura : null});
  const local = !foto && !opciones.audio && comandoLocal(texto);   // "abrí WhatsApp": al toque
  if (local) {
    agregar({quien: "jarvis", texto: local.texto, acciones: local.acciones});
    return {texto: local.texto, tarjetas: [], acciones: local.acciones, local: true};
  }
  pensando(true);
  try {
    const r = await api("app_mensaje", {texto: texto || "", llamada: !!opciones.llamada, audio: opciones.audio || null,
                                         imagen: foto ? {mime: "image/jpeg", datos: foto.datos} : null});
    if (r.pedido && !texto) {   // lo que entendió de la grabación, o lo que se preguntó de la foto
      mio.texto = (opciones.audio ? "🎙️ " : "") + r.pedido;
      guardar("mensajes", mensajes);
      pintarCharla();
    }
    if (!r.ok) throw new Error(r.error || "No pude.");
    const respuesta = (r.mensajes || []).join("\n\n");
    const acciones = r.acciones || [];
    pensando(false);
    agregar({quien: "jarvis", texto: respuesta, tarjetas: r.tarjetas || [], acciones: acciones});
    if (acciones.length) intentarAbrir(acciones[0]);
    if (!opciones.llamada && !opciones.sinVoz && respuesta
        && (ajustes.leer === "siempre" || (ajustes.leer === "auto" && opciones.porVoz))) {
      Voz.decir(respuesta);
    }
    return {texto: respuesta, tarjetas: r.tarjetas || [], acciones: acciones, pedido: r.pedido};
  } catch (e) {
    pensando(false);
    agregar({quien: "aviso", texto: e.message});
    return null;
  }
}

async function sincronizarCharla() {
  // Lo que pasó en Telegram (o lo que contó la PC) aparece acá también
  if (!conexion) return;
  let d;
  try {
    d = await api("app_charla");
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


// ---------- La barra de abajo de la charla: escribir, hablar y fotos ----------

let fotoLista = null;   // {datos (base64), miniatura (dataURL)}
let dictando = false;

function ajustarCaja() {
  const caja = $("caja");
  caja.style.height = "auto";
  caja.style.height = Math.min(caja.scrollHeight, 130) + "px";
  $("barra").classList.toggle("con-texto", caja.value.trim() !== "" || fotoLista !== null);
}

async function enviarLoEscrito() {
  const texto = $("caja").value.trim();
  if (!texto && !fotoLista) return dictar();
  const foto = fotoLista;
  $("caja").value = "";
  sacarFoto();
  ajustarCaja();
  await mandar(texto, {foto: foto});
}

async function dictar() {
  // El micrófono de la charla: hablás, y lo manda solo cuando terminás
  if (dictando) {
    Oido.cortar();
    return;
  }
  Voz.callar();
  dictando = true;
  await Oido.soltar();   // si estaba esperando «Jarvis», deja el micrófono libre
  $("boton-enviar").classList.add("grabando");
  $("caja").placeholder = "Te escucho...";
  const r = await Oido.oir((parcial) => { $("caja").value = parcial; ajustarCaja(); });
  dictando = false;
  $("boton-enviar").classList.remove("grabando");
  $("caja").placeholder = "Escribile a JARVIS...";
  $("caja").value = "";
  ajustarCaja();
  if (r.error === "not-allowed") return avisar("Dale permiso al micrófono para hablarme (en los ajustes de Chrome).", 6);
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
  fotoLista = null;
  $("foto-lista").hidden = true;
  $("foto").value = "";
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
    const r = await mandar(texto, {porVoz: true, sinVoz: true});
    const respuesta = r ? (r.texto || (r.tarjetas.length ? "Confirmalo acá abajo." : "")) : "No me pude conectar. ¿Hay internet?";
    if (r) {
      pintarAcciones($("inicio-acciones"), r.acciones);
      r.tarjetas.forEach((t, i) => $("inicio-acciones").appendChild(pintarTarjeta(t, mensajes.length - 1, i)));
    }
    estadoInicio("hablando", respuesta);
    await Voz.decir(respuesta);
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
    return;
  }
  ocupado = true;
  Voz.callar();
  await Oido.soltar();   // si estaba esperando «Jarvis», deja de esperar
  estadoInicio("escuchando", "Te escucho...");
  const r = await Oido.oir((parcial) => { $("inicio-texto").textContent = parcial; });
  ocupado = false;
  if (r.error === "not-allowed") {
    estadoInicio("libre", "Dale permiso al micrófono para hablarme (en los ajustes de Chrome).");
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

function puedeEscuchar() {
  return escucha.activa && vistaActual === "inicio" && document.visibilityState === "visible" && !llamada.activa;
}

async function cicloJarvis() {
  if (escucha.corriendo || !Reco) return;
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
        estadoInicio("libre", "Dale permiso al micrófono para que te escuche (en los ajustes de Chrome).");
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

function activarEscucha(si) {
  escucha.activa = si && !!Reco;
  ajustes.escucharJarvis = escucha.activa;
  guardar("ajustes", ajustes);
  $("escuchar-jarvis").checked = escucha.activa;
  if (si && !Reco) avisar("Este celular no tiene reconocimiento de voz: usá el botón HABLAR.", 5);
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
      estadoInicio("hablando", r ? r.texto : "No me pude conectar.");
      if (r) await Voz.decir(r.texto);
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
  try {   // que la pantalla no se apague mientras hablan
    llamada.pantalla = await navigator.wakeLock.request("screen");
  } catch (e) { /* no se puede: sigue igual */ }
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
      avisar("Dale permiso al micrófono a la app (en los ajustes de Chrome) y llamame de nuevo.", 7);
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
    const r = await mandar(oido.texto, {llamada: true, audio: oido.audio});
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
    await Voz.decir(respuesta);
  }
}

function colgar() {
  if (!llamada.activa) return;
  llamada.activa = false;
  Oido.cancelar();
  Voz.callar();
  clearInterval(llamada.reloj);
  if (llamada.pantalla) llamada.pantalla.release().catch(() => {});
  llamada.pantalla = null;
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

async function cargarDatos() {
  if (!conexion) return;
  try {
    const d = await api("app_datos");
    if (d.ok) {
      datosDia = d;
      guardar("dia", d);
    }
  } catch (e) { /* queda lo último que se vio */ }
  pintarDia();
  pintarPc();
  pintarProtocolos();
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
    d = await api("app_mails");
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
  $("ajustes-info").textContent = `Versión ${VERSION_APP}. ` + (Reco ? "Te escucha con el reconocimiento de voz del celular."
    : "Este celular no tiene reconocimiento de voz: graba y JARVIS lo pasa a texto.");
  $("ajustes").showModal();
}

function guardarAjustes() {
  ajustes.leer = $("ajuste-leer").value;
  ajustes.musica = $("ajuste-musica").value;
  ajustes.nombreVoz = $("ajuste-voz").value;
  ajustes.velocidad = Number($("ajuste-velocidad").value);
  guardar("ajustes", ajustes);
}

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
  $("barra").addEventListener("submit", (e) => { e.preventDefault(); enviarLoEscrito(); });
  $("caja").addEventListener("input", ajustarCaja);
  $("caja").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {   // en la compu
      e.preventDefault();
      enviarLoEscrito();
    }
  });
  $("boton-foto").onclick = () => $("foto").click();
  $("foto").onchange = async () => {
    const archivo = $("foto").files[0];
    if (!archivo) return;
    try {
      fotoLista = await prepararFoto(archivo);
      $("foto-miniatura").src = fotoLista.miniatura;
      $("foto-lista").hidden = false;
      ajustarCaja();
      $("caja").placeholder = "¿Qué querés saber de la foto? (o mandala así)";
    } catch (e) {
      avisar("No pude abrir esa foto.");
    }
  };
  $("foto-sacar").onclick = () => { sacarFoto(); ajustarCaja(); };

  document.querySelectorAll(".pestana[data-vista]").forEach((b) => { b.onclick = () => cambiarVista(b.dataset.vista); });
  $("boton-llamar").onclick = llamar;
  $("boton-colgar").onclick = colgar;
  $("boton-pausa").onclick = pausar;
  $("llamada-reactor").onclick = tocarReactor;
  $("boton-hablar").onclick = hablarEnInicio;
  $("inicio-reactor").onclick = () => { if (ocupado) { Voz.callar(); Oido.cortar(); } };
  $("escuchar-jarvis").onchange = () => activarEscucha($("escuchar-jarvis").checked);
  $("actualizar-mails").onclick = cargarMails;

  $("nuevo-pendiente").addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = $("caja-pendiente").value.trim();
    if (!texto) return;
    $("caja-pendiente").value = "";
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
    ["conexion", "mensajes", "ultimaCharla", "dia"].forEach((c) => localStorage.removeItem(GUARDADO + c));
    conexion = null;
    $("ajustes").close();
    mostrarConectar();
  };
  $("form-a-mano").addEventListener("submit", (e) => {   // por si el link no anduvo: la dirección y la llave a mano
    e.preventDefault();
    const u = $("a-mano-url").value.trim(), k = $("a-mano-llave").value.trim();
    if (!/^https:\/\/script\.google(?:usercontent)?\.com\//.test(u) || k.length < 20) {
      $("conectar-detalle").textContent = "Fijate la dirección (empieza con https://script.google.com/) y la llave.";
      return;
    }
    guardar("conexion", {u: u, k: k});
    location.reload();
  });
  $("boton-instalar").onclick = async () => {
    if (!instalador) return;
    instalador.prompt();
    await instalador.userChoice;
    instalador = null;
    $("boton-instalar").hidden = true;
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && conexion) {
      sincronizarCharla();
      if (vistaActual === "dia" || vistaActual === "pc") cargarDatos();
      if (vistaActual === "inicio" && reactorInicio && !llamada.activa) reactorInicio.prender();
      if (escucha.activa) cicloJarvis();
    } else {
      if (reactorInicio) reactorInicio.apagar();
      pausarEscucha();
    }
  });
}

// si la app ya estaba abierta y tocás el link de /app, solo cambia lo de después del #: se vuelve a arrancar con eso
window.addEventListener("hashchange", () => { if (/[#&]k=/.test(location.hash)) location.reload(); });

function arrancar() {
  leerLink();
  reactorInicio = crearReactor($("reactor-inicio"));
  reactorLlamada = crearReactor($("reactor"));
  conectarBotones();
  pintarProtocolos();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!conexion) return mostrarConectar();
  reactorInicio.prender();
  pintarCharla();
  pintarDia();
  pintarPc();
  api("app_hola").catch(() => {});
  sincronizarCharla();
  cargarDatos();
  // cada minuto, mientras la app está a la vista: lo nuevo de la charla (lo que contó la PC, lo de Telegram)
  setInterval(() => {
    if (document.visibilityState === "visible" && !llamada.activa) sincronizarCharla();
  }, 60000);
  if (ajustes.escucharJarvis && Reco) {
    escucha.activa = true;
    $("escuchar-jarvis").checked = true;
    cicloJarvis();
  }
  if (new URLSearchParams(location.search).get("llamar")) {   // el atajo «Llamar» del ícono
    avisar("Tocá Llamar para empezar (el celular pide un toque antes de usar el micrófono).", 5);
  }
}

arrancar();
