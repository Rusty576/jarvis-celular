// ============================================================
//  JARVIS en el celular
// ------------------------------------------------------------
//  Una página web que se instala como una app (PWA). Le habla al bot de JARVIS (bot_celular/Codigo.gs, en Google
//  Apps Script): el mismo cerebro (Gemini), tus pendientes, recordatorios, mails y órdenes para la PC, y la misma
//  charla que Telegram.
//  La dirección del bot y la llave llegan en el link que manda /app en Telegram, después del # (esa parte del link
//  no viaja a ningún servidor), y quedan guardadas solo en este celular.
//  La voz: el celular escucha (el reconocimiento de voz de Chrome) y habla (las voces del celular). Si no puede
//  escuchar solo, graba y el bot pasa la grabación a texto.
// ============================================================
"use strict";

const VERSION_APP = "2026.10.24";
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

const ajustes = Object.assign({leer: "auto", nombreVoz: "", velocidad: 1.05, idioma: "es-UY"}, leerGuardado("ajustes", {}));
let conexion = leerGuardado("conexion", null);         // {u: la dirección del bot, k: la llave}
let mensajes = leerGuardado("mensajes", []);           // la charla, como se ve en este celular
let ultimaCharla = leerGuardado("ultimaCharla", null); // el último mensaje de la charla del bot que ya está acá
let datosDia = leerGuardado("dia", null);              // lo último de «Mi día» y la PC (se ve aunque no haya internet)

// Las órdenes rápidas de la pestaña PC (solo las que JARVIS entiende en la PC)
const ORDENES = ["¿Cómo está la compu?", "Pausá la música", "Siguiente tema", "Modo juego", "Salí del modo juego",
                 "Bloqueá la pantalla", "Sacá una captura de pantalla", "Apagá la compu en 10 minutos", "Cancelá el apagado"];


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

  escuchar(alOir) {
    // Una frase: termina sola cuando dejás de hablar. Devuelve {texto, error}
    return new Promise((listo) => {
      const rec = new Reco();
      this.rec = rec;
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
        Reactor.voz(0.7);
        if (alOir) alOir((final + " " + parcial).trim());
      };
      rec.onsoundstart = () => Reactor.voz(0.4);
      rec.onerror = (e) => { error = e.error; };
      rec.onend = () => {
        this.rec = null;
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
        this.rec = null;
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
          Reactor.voz(Math.min(1, nivel * 8));
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
    if (llamada.activa) Voz.decir(t.resultado);
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
  // Le manda algo a JARVIS y muestra la respuesta. opciones: {foto, audio, llamada, porVoz}
  const foto = opciones.foto || null;
  const mio = agregar({quien: "vos", texto: texto || (opciones.audio ? "🎙️ ..." : ""), imagen: foto ? foto.miniatura : null});
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
    pensando(false);
    agregar({quien: "jarvis", texto: respuesta, tarjetas: r.tarjetas || []});
    if (!opciones.llamada && respuesta && (ajustes.leer === "siempre" || (ajustes.leer === "auto" && opciones.porVoz))) {
      Voz.decir(respuesta);
    }
    return {texto: respuesta, tarjetas: r.tarjetas || [], pedido: r.pedido};
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


// ---------- La llamada: manos libres ----------

const llamada = {activa: false, pausada: false, silencios: 0, inicio: 0, reloj: null, pantalla: null, tocar: null};

function estadoLlamada(estado, texto) {
  const etiquetas = {escuchando: "TE ESCUCHO", pensando: "PENSANDO", hablando: "JARVIS", libre: "EN PAUSA"};
  $("llamada-estado").textContent = etiquetas[estado] || estado;
  $("llamada-estado").className = "llamada-estado " + estado;
  Reactor.estado(estado);
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
  $("aviso").hidden = true;
  $("llamada").hidden = false;
  $("llamada-tarjetas").innerHTML = "";
  $("boton-pausa").classList.remove("pausado");
  Reactor.prender();
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
  const t = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\s]/g, " ").trim();
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
  Reactor.apagar();
  $("llamada").hidden = true;
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


// ---------- Pestañas, ajustes e instalar ----------

function cambiarVista(nombre) {
  document.querySelectorAll(".vista").forEach((v) => v.classList.toggle("activa", v.id === "vista-" + nombre));
  document.querySelectorAll(".pestana[data-vista]").forEach((b) => b.classList.toggle("activa", b.dataset.vista === nombre));
  if (nombre === "charla") bajar();
  else cargarDatos();
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
  $("ajuste-velocidad").value = ajustes.velocidad;
  $("velocidad-valor").textContent = ajustes.velocidad.toFixed(2) + "x";
  $("ajustes-info").textContent = `Versión ${VERSION_APP}. ` + (Reco ? "Te escucha con el reconocimiento de voz del celular."
    : "Este celular no tiene reconocimiento de voz: graba y JARVIS lo pasa a texto.");
  $("ajustes").showModal();
}

function guardarAjustes() {
  ajustes.leer = $("ajuste-leer").value;
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
  $("desconectar").onclick = () => {
    if (!confirm("¿Desconecto este celular de tu JARVIS? Para volver a conectarlo, mandá /app en Telegram.")) return;
    ["conexion", "mensajes", "ultimaCharla", "dia"].forEach((c) => localStorage.removeItem(GUARDADO + c));
    conexion = null;
    $("ajustes").close();
    mostrarConectar();
  };
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
      if (!$("vista-charla").classList.contains("activa")) cargarDatos();
    }
  });
}

// si la app ya estaba abierta y tocás el link de /app, solo cambia lo de después del #: se vuelve a arrancar con eso
window.addEventListener("hashchange", () => { if (/[#&]k=/.test(location.hash)) location.reload(); });

function arrancar() {
  leerLink();
  Reactor.iniciar($("reactor"));
  conectarBotones();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!conexion) return mostrarConectar();
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
  if (new URLSearchParams(location.search).get("llamar")) {   // el atajo «Llamar» del ícono
    avisar("Tocá Llamar para empezar (el celular pide un toque antes de usar el micrófono).", 5);
  }
}

arrancar();
