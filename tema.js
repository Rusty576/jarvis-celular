// El fondo negro (el de la píldora y el modo oscuro de JARVIS en la PC). No es una copia aparte del CSS (se quedaría
// vieja cuando cambie estilo.css): toma estilo.css tal como está y pasa los azules oscuros a negros neutros. El color
// de JARVIS (los acentos: íconos, títulos, el reactor) queda. Se carga en el <head>: así el negro está antes de que se
// vea la página (lo convertido queda guardado; la primera vez se arma y se guarda)
const Tema = {
  CLAVE: "jarvis.cssNegro",

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

  convertir(css) {
    css = css.replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/g, (todo, r, g, b, a) =>
      Tema.color(+r, +g, +b, a === undefined ? 1 : +a) || todo);
    css = css.replace(/#([0-9a-f]{6})\b/gi, (todo, h) => {
      const nuevo = Tema.color(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1);
      if (!nuevo) return todo;
      return "#" + nuevo.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("");
    });
    // los textos celestes pasan a blanco y gris (como en la píldora), y el fondo a negro puro
    return css + `
:root { --fondo: #000000; --panel: rgba(14, 15, 17, 0.78); --panel-borde: rgba(255, 255, 255, 0.09);
  --texto: #eef3f6; --texto-2: #9aa4ab; --texto-3: #6b747b; }
html, body { background: #000; }
`;
  },

  poner(css) {
    let estilo = document.getElementById("tema-negro");
    if (!estilo) {
      estilo = document.createElement("style");
      estilo.id = "tema-negro";
      document.head.appendChild(estilo);
    }
    estilo.textContent = css;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = "#000000";
  },

  sacar() {
    const estilo = document.getElementById("tema-negro");
    if (estilo) estilo.remove();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = "#02070d";
  },

  async aplicar(fondo, version) {
    // fondo: "negro" (de fábrica) o "azul" (el de antes). version: la de la app (si cambió estilo.css, se rearma)
    if (fondo === "azul") return Tema.sacar();
    try {
      const guardado = JSON.parse(localStorage.getItem(Tema.CLAVE) || "null");
      if (guardado && guardado.v === version && guardado.css) return Tema.poner(guardado.css);
    } catch (e) { /* (sin lo guardado: se arma) */ }
    try {
      const r = await fetch("estilo.css", {cache: "no-store"});
      const css = Tema.convertir(await r.text());
      Tema.poner(css);
      try {
        localStorage.setItem(Tema.CLAVE, JSON.stringify({v: version, css: css}));
      } catch (e) { /* sin lugar: se arma cada vez */ }
    } catch (e) { /* sin el CSS: queda el azul */ }
  },
};

// apenas carga (antes de que se vea la página): lo que estaba guardado
try {
  const ajustes = JSON.parse(localStorage.getItem("jarvis.ajustes") || "{}") || {};
  const guardado = JSON.parse(localStorage.getItem(Tema.CLAVE) || "null");
  if (ajustes.fondo !== "azul" && guardado && guardado.css) Tema.poner(guardado.css);
} catch (e) { /* (la primera vez lo pone app.js) */ }
