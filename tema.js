// Los temas: el negro (el de la píldora y el modo oscuro de JARVIS en la PC) y el claro. No son copias aparte del CSS
// (se quedarían viejas cuando cambie estilo.css): toman estilo.css tal como está y pasan los colores. El color de JARVIS
// (los acentos: íconos, títulos, el reactor) queda. Se carga en el <head>: así el tema está antes de que se vea la
// página (lo convertido queda guardado; la primera vez se arma y se guarda). «auto»: claro u oscuro, como el celular
const Tema = {
  CLAVES: {negro: "jarvis.cssNegro", claro: "jarvis.cssClaro"},
  FONDOS: {negro: "#000000", azul: "#02070d", claro: "#f3f6f9"},

  resolver(fondo) {
    if (fondo === "auto") {
      return window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "claro" : "negro";
    }
    return ["negro", "azul", "claro"].includes(fondo) ? fondo : "negro";
  },

  color(r, g, b, a) {
    // el celeste de JARVIS: el fuerte se queda; el suave (bordes, rellenos) pasa a gris
    if (r === 41 && g === 217 && b === 255) return a <= 0.3 ? `rgba(255, 255, 255, ${(a * 0.45).toFixed(3)})` : null;
    // fondos azul oscuro -> negro / gris carbón (tus mensajes, #0f3550, también: quedan gris oscuro)
    if (b >= r && Math.max(r, g, b) <= 90) {
      const l = Math.round(((r + g + b) / 3) * 0.6);
      return `rgba(${l}, ${l}, ${l + 1}, ${a})`;
    }
    // resplandores azulados -> un gris apenas visible
    if (r < 60 && b > 150 && g > 80 && g < 200) return `rgba(255, 255, 255, ${(a * 0.2).toFixed(3)})`;
    return null;
  },

  colorClaro(r, g, b, a) {
    // claro: lo oscuro (fondos, paneles) pasa a claro y lo claro (las letras, los brillos blancos) a oscuro; los
    // colores vivos (el celeste, el verde) se oscurecen un poco para que se lean sobre blanco
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (max !== min) {
      const d = max - min, R = r / 255, G = g / 255, B = b / 255;
      h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    let nl, ns = s;
    if (l < 0.35) {
      nl = 0.97 - l * 0.4;
      ns = s * 0.35;
    } else if (s > 0.55 && l < 0.85) {
      nl = Math.min(l, 0.62) * 0.66;
    } else if (l > 0.6) {
      nl = 0.1 + (1 - l) * 0.55;
      ns = Math.min(s, 0.45);
    } else {
      return null;
    }
    const c = (1 - Math.abs(2 * nl - 1)) * ns, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = nl - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return `rgba(${Math.round((r1 + m) * 255)}, ${Math.round((g1 + m) * 255)}, ${Math.round((b1 + m) * 255)}, ${a})`;
  },

  convertir(css, tema = "negro") {
    const pasar = tema === "claro" ? Tema.colorClaro : Tema.color;
    css = css.replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/g, (todo, r, g, b, a) =>
      pasar(+r, +g, +b, a === undefined ? 1 : +a) || todo);
    css = css.replace(/#([0-9a-f]{6})\b/gi, (todo, h) => {
      const nuevo = pasar(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1);
      if (!nuevo) return todo;
      return "#" + nuevo.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("");
    });
    if (tema === "claro") {
      // (los resplandores, sobre blanco, ensucian: van sin ellos)
      return css + `
:root { --fondo: #f3f6f9; --panel: rgba(255, 255, 255, 0.9); --panel-borde: rgba(var(--cian-rgb), 0.3);
  --texto: #0e1c26; --texto-2: #3d5666; --texto-3: #66808f; }
html, body { background: #f3f6f9; }
* { text-shadow: none !important; }
`;
    }
    // los textos celestes pasan a blanco y gris (como en la píldora), y el fondo a negro puro
    return css + `
:root { --fondo: #000000; --panel: rgba(14, 15, 17, 0.78); --panel-borde: rgba(255, 255, 255, 0.09);
  --texto: #eef3f6; --texto-2: #9aa4ab; --texto-3: #6b747b; }
html, body { background: #000; }
`;
  },

  poner(css, tema = "negro") {
    let estilo = document.getElementById("tema-negro");
    if (!estilo) {
      estilo = document.createElement("style");
      estilo.id = "tema-negro";   // (el id quedó del primero: es el del tema que esté puesto)
      document.head.appendChild(estilo);
    }
    // (se pone al abrir, para que no se vea un destello, y app.js lo vuelve a poner: si es el mismo, no se toca;
    // cambiarlo hacía que el navegador leyera de nuevo los 90 KB de estilos y recalculara toda la página)
    if (estilo.textContent !== css) estilo.textContent = css;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = Tema.FONDOS[tema];
  },

  sacar() {
    const estilo = document.getElementById("tema-negro");
    if (estilo) estilo.remove();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = Tema.FONDOS.azul;
  },

  async leerEstilo() {
    // en la app de Android la página es un archivo (file://) y fetch() no puede leerlo: lo pasa el puente de Java
    const nativo = window.JarvisNativo && window.JarvisNativo.estiloDeLaApp;
    if (location.protocol === "file:" && nativo) return window.JarvisNativo.estiloDeLaApp();
    try {
      const r = await fetch("estilo.css", {cache: "no-store"});
      if (r.ok) return await r.text();
    } catch (e) { /* (abajo, el puente) */ }
    if (nativo) return window.JarvisNativo.estiloDeLaApp();
    throw new Error("no pude leer estilo.css");
  },

  async aplicar(fondo, version) {
    // fondo: "negro" (de fábrica), "claro", "auto" (como el celular) o "azul" (el de antes). version: la de la app (si
    // cambió estilo.css, se rearma)
    const tema = Tema.resolver(fondo);
    if (tema === "azul") return Tema.sacar();
    try {
      const guardado = JSON.parse(localStorage.getItem(Tema.CLAVES[tema]) || "null");
      if (guardado && guardado.v === version && guardado.css) return Tema.poner(guardado.css, tema);
    } catch (e) { /* (sin lo guardado: se arma) */ }
    try {
      const original = await Tema.leerEstilo();
      if (!original) throw new Error("estilo.css vacío");
      const css = Tema.convertir(original, tema);
      Tema.poner(css, tema);
      try {
        localStorage.setItem(Tema.CLAVES[tema], JSON.stringify({v: version, css: css}));
      } catch (e) { /* sin lugar: se arma cada vez */ }
    } catch (e) { /* sin el CSS: queda el azul */ }
  },
};

// apenas carga (antes de que se vea la página): lo que estaba guardado
try {
  const ajustes = JSON.parse(localStorage.getItem("jarvis.ajustes") || "{}") || {};
  const tema = Tema.resolver(ajustes.fondo || "negro");
  const guardado = tema === "azul" ? null : JSON.parse(localStorage.getItem(Tema.CLAVES[tema]) || "null");
  if (guardado && guardado.css) Tema.poner(guardado.css, tema);
  document.documentElement.dataset.tema = tema;
} catch (e) { /* (la primera vez lo pone app.js) */ }
