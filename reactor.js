// ============================================================
//  El reactor de JARVIS: el mismo dibujo que en la PC (interfaz/app.js, dibujarReactor), hecho para el celular. Hay
//  uno en Inicio y otro en la llamada (crearReactor(canvas) arma cada uno); se dibuja solo mientras se ve.
//  .estado("escuchando" | "pensando" | "hablando" | "libre") cambia cómo se mueve;
//  .voz(0 a 1) dice cuánto se oye (las ondas cuando hablás);
//  .apariencia("r, g, b", "completas" | "livianas" | "ninguna") el color (Ajustes) y cuánto se mueve.
//  Liviano: lo que no cambia (las marcas, el halo, el núcleo) se dibuja una sola vez en una capa aparte y después
//  solo se gira; los brillos son trazos anchos y suaves (la sombra difuminada era lo más caro); las barras van en
//  cuatro trazos en vez de 64. Quieto, a 20 cuadros por segundo; y nada cuando no se ve.
// ============================================================
"use strict";

function crearReactor(canvasInicial) {
  const BARRAS = 64;
  const alturas = new Float32Array(BARRAS);
  const particulas = Array.from({length: 14}, () => ({
    a: Math.random() * Math.PI * 2, v: 0.15 + Math.random() * 0.45, r: 1.04 + Math.random() * 0.16,
    achate: 0.82 + Math.random() * 0.18, tam: 0.9 + Math.random() * 1.6, fase: Math.random() * 6,
  }));
  let lienzo = null, ctx = null, ancho = 0, alto = 0, dpr = 1, R = 50;
  let corriendo = false, ultimo = 0, visible = true;
  let estado = "libre", voz = 0, energia = 0.2;
  let ondas = [], ultimaOnda = 0;
  let rgb = "41, 217, 255", modo = "completas";
  let capas = null;   // lo que no cambia, ya dibujado (se arma de nuevo si cambia el tamaño o el color)

  const cian = (a) => `rgba(${rgb},${a})`;
  const ambar = (a) => `rgba(255,181,71,${a})`;
  const verde = (a) => `rgba(77,255,184,${a})`;

  function ajustar() {
    const r = lienzo.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);   // más que eso no se nota y gasta batería
    ancho = r.width;
    alto = r.height;
    lienzo.width = Math.round(ancho * dpr);
    lienzo.height = Math.round(alto * dpr);
    R = Math.max(50, Math.min(ancho, alto) * 0.4);
    capas = null;
    if (!corriendo && ancho && alto) dibujar(performance.now() / 1000);   // (quieto: igual se ve)
  }

  function capa(lado, pintar) {
    // un lienzo aparte, centrado, con lo que no cambia
    const c = document.createElement("canvas");
    c.width = c.height = Math.ceil(lado * dpr);
    const x = c.getContext("2d");
    x.scale(dpr, dpr);
    x.translate(lado / 2, lado / 2);
    pintar(x);
    return c;
  }

  function armarCapas() {
    const lado = R * 2 + 24;
    capas = {
      halo: capa(R * 2.6, (x) => {
        const g = x.createRadialGradient(0, 0, R * 0.1, 0, 0, R * 1.25);
        g.addColorStop(0, cian(0.22));
        g.addColorStop(0.5, cian(0.05));
        g.addColorStop(1, cian(0));
        x.fillStyle = g;
        x.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
      }),
      marcas: capa(lado, (x) => {   // el anillo de afuera, con 120 marcas: dos trazos (las grandes y las chicas)
        [[true, 0.7, 1.6], [false, 0.28, 1]].forEach(([grandes, alfa, grosor]) => {
          x.beginPath();
          for (let i = 0; i < 120; i++) {
            if ((i % 10 === 0) !== grandes) continue;
            const a = (i / 120) * Math.PI * 2, largo = i % 10 === 0 ? 12 : i % 5 === 0 ? 7 : 3;
            x.moveTo(Math.cos(a) * R, Math.sin(a) * R);
            x.lineTo(Math.cos(a) * (R - largo), Math.sin(a) * (R - largo));
          }
          x.strokeStyle = cian(alfa);
          x.lineWidth = grosor;
          x.stroke();
        });
      }),
      muescas: capa(lado, (x) => {   // el anillo de adentro, con sus diez muescas
        brillo(x, 0, 0, R * 0.44, 0, Math.PI * 2, cian(0.65), 2);
        x.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          x.moveTo(Math.cos(a) * R * 0.39, Math.sin(a) * R * 0.39);
          x.arc(0, 0, R * 0.39, a, a + 0.38);
        }
        x.strokeStyle = cian(0.45);
        x.lineWidth = R * 0.05;
        x.stroke();
      }),
      nucleo: capa(R * 0.8, (x) => {   // el núcleo brillante (después se agranda o se achica con la energía)
        const rn = R * 0.25;
        const g = x.createRadialGradient(0, 0, 0, 0, 0, rn * 1.6);
        g.addColorStop(0, "rgba(255,255,255,0.95)");
        g.addColorStop(0.25, cian(0.85));
        g.addColorStop(0.6, cian(0.35));
        g.addColorStop(1, cian(0));
        x.fillStyle = g;
        x.beginPath();
        x.arc(0, 0, rn * 1.6, 0, Math.PI * 2);
        x.fill();
        brillo(x, 0, 0, rn, 0, Math.PI * 2, "rgba(220,250,255,0.9)", 1.5);
      }),
    };
  }

  function brillo(x, cx, cy, r, desde, hasta, color, grosor) {
    // un arco con brillo: un trazo ancho y suave abajo (en vez de la sombra difuminada, que era lo más caro)
    x.beginPath();
    x.arc(cx, cy, Math.max(r, 0.1), desde, hasta);
    x.strokeStyle = color;
    x.globalAlpha = 0.18;
    x.lineWidth = grosor * 3.5;
    x.stroke();
    x.globalAlpha = 1;
    x.lineWidth = grosor;
    x.stroke();
  }

  function arco(cx, cy, r, desde, hasta, color, grosor) {
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(r, 0.1), desde, hasta);
    ctx.strokeStyle = color;
    ctx.lineWidth = grosor;
    ctx.stroke();
  }

  function poner(c, cx, cy, giro, escala = 1) {
    // una capa ya dibujada, girada (y agrandada) en el centro
    const lado = c.width / dpr * escala;
    ctx.save();
    ctx.translate(cx, cy);
    if (giro) ctx.rotate(giro);
    ctx.drawImage(c, -lado / 2, -lado / 2, lado, lado);
    ctx.restore();
  }

  function dibujar(t) {
    // cuánta "energía" tiene según lo que hace JARVIS
    let objetivo;
    if (estado === "escuchando") objetivo = 0.3 + voz * 1.4;
    else if (estado === "hablando") objetivo = 0.45 + 0.35 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1)) + Math.random() * 0.2;
    else if (estado === "pensando") objetivo = 0.55 + 0.15 * Math.sin(t * 6);
    else objetivo = 0.18 + 0.06 * Math.sin(t * 1.4);
    energia += (Math.min(objetivo, 1.3) - energia) * 0.12;
    voz *= 0.92;   // se apaga sola si no llegan más sonidos
    if (!capas) armarCapas();
    const liviano = modo !== "completas";

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ancho, alto);
    const cx = ancho / 2, cy = alto / 2;
    const velocidad = estado === "pensando" ? 3.2 : estado === "hablando" ? 1.6 : 1;
    const color = estado === "escuchando" ? verde : cian;

    // el halo, más fuerte con más energía
    ctx.globalAlpha = Math.min(1, 0.45 + energia * 0.55);
    poner(capas.halo, cx, cy, 0);
    ctx.globalAlpha = 1;

    // 1) el anillo de afuera, girando despacio
    poner(capas.marcas, cx, cy, t * 0.05 * velocidad);

    // las partículas en órbita (dos trazos: las celestes y, pensando, las ámbar)
    if (!liviano) {
      const dorada = estado === "pensando";
      [false, true].forEach((ambares) => {
        ctx.beginPath();
        particulas.forEach((p) => {
          if ((dorada && p.tam > 1.6) !== ambares) return;
          const x = cx + Math.cos(p.a) * R * p.r, y = cy + Math.sin(p.a) * R * p.r * p.achate;
          const r = p.tam * (0.8 + 0.4 * Math.sin(t * 3 + p.fase));
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        });
        ctx.fillStyle = ambares ? ambar(0.85) : cian(0.75);
        ctx.fill();
      });
    }
    particulas.forEach((p) => { p.a += p.v * velocidad * (0.6 + energia) / 30; });

    // 2) los segmentos gruesos que giran (con brillo)
    const g1 = -t * 0.22 * velocidad;
    for (let i = 0; i < 3; i++) {
      const ini = g1 + i * (Math.PI * 2 / 3);
      ctx.globalAlpha = 0.25;
      arco(cx, cy, R * 0.88, ini, ini + 1.25, cian(0.55), 11);
      ctx.globalAlpha = 1;
      arco(cx, cy, R * 0.88, ini, ini + 1.25, cian(0.55), 5);
      arco(cx, cy, R * 0.88, ini + 1.4, ini + 1.55, cian(0.35), 5);
    }

    // 3) las barras de audio, en cuatro trazos (de menos a más fuertes)
    const base = R * 0.62;
    const tramos = [[], [], [], []];
    for (let i = 0; i < BARRAS; i++) {
      const ruido = 0.5 + 0.5 * Math.sin(t * 5 + i * 0.7) * Math.sin(t * 2.3 + i * 1.9);
      const obj = energia * (0.25 + ruido * 0.9) * (0.6 + Math.random() * 0.5);
      alturas[i] += (obj - alturas[i]) * 0.25;
      tramos[Math.min(3, Math.floor(alturas[i] * 4))].push(i);
    }
    tramos.forEach((lista, nivel) => {
      if (!lista.length) return;
      ctx.beginPath();
      lista.forEach((i) => {
        const h = 3 + alturas[i] * R * 0.2;
        const a = (i / BARRAS) * Math.PI * 2 - Math.PI / 2;
        ctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base);
        ctx.lineTo(cx + Math.cos(a) * (base + h), cy + Math.sin(a) * (base + h));
      });
      const alfa = 0.3 + (nivel + 0.5) / 4 * 0.6;
      ctx.strokeStyle = estado === "pensando" ? ambar(alfa * 0.85) : color(alfa);
      ctx.lineWidth = 2.4;
      ctx.stroke();
    });

    // 4) el anillo punteado que gira al revés
    ctx.save();
    ctx.setLineDash([2, 6]);
    arco(cx, cy, R * 0.56, t * 0.3 * velocidad, t * 0.3 * velocidad + Math.PI * 2, cian(0.5), 1.5);
    ctx.restore();

    // pensando: el barrido ámbar
    if (estado === "pensando") {
      const a = t * 4;
      ctx.globalAlpha = 0.3;
      arco(cx, cy, R * 0.75, a, a + 1.1, ambar(0.85), 8);
      ctx.globalAlpha = 1;
      arco(cx, cy, R * 0.75, a, a + 1.1, ambar(0.85), 2.5);
      arco(cx, cy, R * 0.75, a + Math.PI, a + Math.PI + 0.5, ambar(0.5), 2.5);
    }
    // hablando: la onda de voz
    if (estado === "hablando") {
      ctx.beginPath();
      for (let i = 0; i <= 90; i++) {
        const a = (i / 90) * Math.PI * 2;
        const r = R * 0.72 + Math.sin(a * 6 + t * 9) * energia * 9 + Math.sin(a * 11 - t * 6) * energia * 5;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.strokeStyle = cian(0.55);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    // escuchando: ondas desde el núcleo cuando hablás
    if (estado === "escuchando" && voz > 0.25 && t - ultimaOnda > 0.35) {
      ondas.push({nace: t});
      ultimaOnda = t;
    }
    ondas = ondas.filter((o) => t - o.nace < 1.4);
    ondas.forEach((o) => {
      const f = (t - o.nace) / 1.4;
      arco(cx, cy, R * (0.3 + f * 0.65), 0, Math.PI * 2, verde(0.5 * (1 - f)), 2 * (1 - f) + 0.5);
    });

    // 5) el anillo de adentro, con muescas, girando al revés
    poner(capas.muescas, cx, cy, -t * 0.5 * velocidad);

    // 6) el núcleo brillante (late con la energía) y el triángulo
    poner(capas.nucleo, cx, cy, 0, (0.24 + energia * 0.05) / 0.25);
    const rn = R * (0.24 + energia * 0.05);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.15);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * rn * 0.62, Math.sin(a) * rn * 0.62);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(2,40,60,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function cuadro(ms) {
    if (!corriendo) return;
    requestAnimationFrame(cuadro);
    if (!visible) return;
    // quieto, 20 cuadros por segundo (alcanza y cuida la batería); cuando hace algo, 30. Livianas: menos
    const quieto = estado === "libre" && voz < 0.05;
    const cada = modo === "livianas" ? (quieto ? 80 : 42) : quieto ? 50 : 32;
    if (ms - ultimo < cada) return;
    ultimo = ms;
    if (ancho && alto) dibujar(ms / 1000);
  }

  lienzo = canvasInicial;
  ctx = lienzo.getContext("2d");
  new ResizeObserver(ajustar).observe(lienzo);
  // (si Inicio está corrido y el reactor no se ve, no se dibuja)
  if (window.IntersectionObserver) new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(lienzo);
  return {
    prender() {
      if (modo === "ninguna") {   // sin animaciones: un solo dibujo, quieto
        if (ancho && alto) dibujar(performance.now() / 1000);
        return;
      }
      if (corriendo) return;
      corriendo = true;
      ajustar();
      requestAnimationFrame(cuadro);
    },
    apagar() { corriendo = false; },
    estado(nuevo) {
      estado = nuevo;
      if (modo === "ninguna" && ancho && alto) dibujar(performance.now() / 1000);
    },
    voz(nivel) { voz = Math.max(voz, nivel); },
    apariencia(nuevoRgb, nuevoModo) {
      const prendido = corriendo;
      rgb = nuevoRgb || rgb;
      modo = nuevoModo || modo;
      capas = null;
      if (modo === "ninguna") corriendo = false;
      if (ancho && alto) dibujar(performance.now() / 1000);
      if (prendido && modo !== "ninguna" && !corriendo) {
        corriendo = true;
        requestAnimationFrame(cuadro);
      }
    },
  };
}
