// ============================================================
//  El reactor de JARVIS para la llamada: el mismo dibujo que en la PC (interfaz/app.js, dibujarReactor), más
//  liviano. Se dibuja solo mientras la llamada está abierta.
//  Reactor.estado("escuchando" | "pensando" | "hablando" | "libre") cambia cómo se mueve;
//  Reactor.voz(0 a 1) dice cuánto se oye (las ondas cuando hablás).
// ============================================================
"use strict";

const Reactor = (() => {
  const BARRAS = 64;
  const alturas = new Float32Array(BARRAS);
  const particulas = Array.from({length: 14}, () => ({
    a: Math.random() * Math.PI * 2, v: 0.15 + Math.random() * 0.45, r: 1.04 + Math.random() * 0.16,
    achate: 0.82 + Math.random() * 0.18, tam: 0.9 + Math.random() * 1.6, fase: Math.random() * 6,
  }));
  let lienzo = null, ctx = null, ancho = 0, alto = 0, dpr = 1;
  let corriendo = false, ultimo = 0;
  let estado = "libre", voz = 0, energia = 0.2;
  let ondas = [], ultimaOnda = 0;

  const cian = (a) => `rgba(41,217,255,${a})`;
  const ambar = (a) => `rgba(255,181,71,${a})`;
  const verde = (a) => `rgba(77,255,184,${a})`;

  function ajustar() {
    const r = lienzo.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);   // más que eso no se nota y gasta batería
    ancho = r.width;
    alto = r.height;
    lienzo.width = Math.round(ancho * dpr);
    lienzo.height = Math.round(alto * dpr);
  }

  function arco(x, y, r, desde, hasta, color, grosor, brillo = 0) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r, 0.1), desde, hasta);
    ctx.strokeStyle = color;
    ctx.lineWidth = grosor;
    ctx.shadowBlur = brillo;
    ctx.shadowColor = color;
    ctx.stroke();
    ctx.shadowBlur = 0;
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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ancho, alto);
    const cx = ancho / 2, cy = alto / 2;
    const R = Math.max(50, Math.min(ancho, alto) * 0.4);
    const velocidad = estado === "pensando" ? 3.2 : estado === "hablando" ? 1.6 : 1;
    const color = estado === "escuchando" ? verde : cian;

    // halo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.25);
    halo.addColorStop(0, cian(0.10 + energia * 0.12));
    halo.addColorStop(0.5, cian(0.03));
    halo.addColorStop(1, cian(0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, ancho, alto);

    // 1) anillo exterior con marcas
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.05 * velocidad);
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const largo = i % 10 === 0 ? 12 : i % 5 === 0 ? 7 : 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
      ctx.lineTo(Math.cos(a) * (R - largo), Math.sin(a) * (R - largo));
      ctx.strokeStyle = cian(i % 10 === 0 ? 0.7 : 0.28);
      ctx.lineWidth = i % 10 === 0 ? 1.6 : 1;
      ctx.stroke();
    }
    ctx.restore();

    // partículas en órbita
    particulas.forEach((p) => {
      p.a += p.v * velocidad * (0.6 + energia) / 30;
      const x = cx + Math.cos(p.a) * R * p.r, y = cy + Math.sin(p.a) * R * p.r * p.achate;
      ctx.beginPath();
      ctx.arc(x, y, p.tam * (0.8 + 0.4 * Math.sin(t * 3 + p.fase)), 0, Math.PI * 2);
      ctx.fillStyle = estado === "pensando" && p.tam > 1.6 ? ambar(0.85) : cian(0.75);
      ctx.fill();
    });

    // 2) segmentos gruesos que giran
    const g1 = -t * 0.22 * velocidad;
    for (let i = 0; i < 3; i++) {
      const ini = g1 + i * (Math.PI * 2 / 3);
      arco(cx, cy, R * 0.88, ini, ini + 1.25, cian(0.55), 5, 10);
      arco(cx, cy, R * 0.88, ini + 1.4, ini + 1.55, cian(0.35), 5);
    }

    // 3) barras de audio radiales
    const base = R * 0.62;
    for (let i = 0; i < BARRAS; i++) {
      const ruido = 0.5 + 0.5 * Math.sin(t * 5 + i * 0.7) * Math.sin(t * 2.3 + i * 1.9);
      const obj = energia * (0.25 + ruido * 0.9) * (0.6 + Math.random() * 0.5);
      alturas[i] += (obj - alturas[i]) * 0.25;
      const h = 3 + alturas[i] * R * 0.2;
      const a = (i / BARRAS) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base);
      ctx.lineTo(cx + Math.cos(a) * (base + h), cy + Math.sin(a) * (base + h));
      ctx.strokeStyle = estado === "pensando" ? ambar(0.35 + alturas[i] * 0.5) : color(0.3 + alturas[i] * 0.6);
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }

    // 4) anillo punteado que gira al revés
    ctx.save();
    ctx.setLineDash([2, 6]);
    arco(cx, cy, R * 0.56, t * 0.3 * velocidad, t * 0.3 * velocidad + Math.PI * 2, cian(0.5), 1.5);
    ctx.restore();

    // pensando: el barrido ámbar
    if (estado === "pensando") {
      const a = t * 4;
      arco(cx, cy, R * 0.75, a, a + 1.1, ambar(0.85), 2.5, 12);
      arco(cx, cy, R * 0.75, a + Math.PI, a + Math.PI + 0.5, ambar(0.5), 2.5, 8);
    }
    // hablando: la onda de voz
    if (estado === "hablando") {
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 2;
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

    // 5) anillo interior con muescas
    arco(cx, cy, R * 0.44, 0, Math.PI * 2, cian(0.65), 2, 12);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.5 * velocidad);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.39, a, a + 0.38);
      ctx.strokeStyle = cian(0.45);
      ctx.lineWidth = R * 0.05;
      ctx.stroke();
    }
    ctx.restore();

    // 6) núcleo brillante con el triángulo
    const rn = R * (0.24 + energia * 0.05);
    const nucleo = ctx.createRadialGradient(cx, cy, 0, cx, cy, rn * 1.6);
    nucleo.addColorStop(0, "rgba(255,255,255,0.95)");
    nucleo.addColorStop(0.25, cian(0.85));
    nucleo.addColorStop(0.6, cian(0.25 + energia * 0.2));
    nucleo.addColorStop(1, cian(0));
    ctx.fillStyle = nucleo;
    ctx.beginPath();
    ctx.arc(cx, cy, rn * 1.6, 0, Math.PI * 2);
    ctx.fill();
    arco(cx, cy, rn, 0, Math.PI * 2, "rgba(220,250,255,0.9)", 1.5, 16);
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
    if (ms - ultimo < 32) return;   // 30 cuadros por segundo alcanzan (y cuidan la batería)
    ultimo = ms;
    if (ancho && alto) dibujar(ms / 1000);
  }

  return {
    iniciar(canvas) {
      lienzo = canvas;
      ctx = canvas.getContext("2d");
      new ResizeObserver(ajustar).observe(canvas);
    },
    prender() {
      if (corriendo) return;
      corriendo = true;
      ajustar();
      requestAnimationFrame(cuadro);
    },
    apagar() { corriendo = false; },
    estado(nuevo) { estado = nuevo; },
    voz(nivel) { voz = Math.max(voz, nivel); },
  };
})();
