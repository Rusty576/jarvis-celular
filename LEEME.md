# JARVIS en el celular

Una app web instalable (PWA) para hablar con JARVIS desde el celular:

- **Charla**: escribile, hablale (el micrófono) o mandale una foto.
- **Llamar**: una llamada con manos libres. Te escucha, piensa y te contesta hablando, hasta que digas «chau».
- **Mi día**: el clima, tus recordatorios y tus pendientes (tildalos, agregá o borrá).
- **PC**: cómo está tu PC y órdenes rápidas para JARVIS en la PC.

No tiene nada adentro: no hay claves, direcciones ni datos. Todo lo hace el bot de JARVIS (Google Apps Script), y la
app se conecta con él con el link que manda `/app` en Telegram. La parte del link después del `#` (la dirección del
bot y la llave) no viaja a ningún servidor, y queda guardada solo en tu celular.

## Instalarla

1. En Telegram, mandale `/app` a tu JARVIS y tocá el link desde el celular.
2. En Chrome: ⋮ > «Instalar app» (o «Agregar a la pantalla principal»).

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La página: las cuatro pestañas y la pantalla de la llamada |
| `estilo.css` | Los colores y las letras de JARVIS |
| `app.js` | Todo lo que hace: hablar con el bot, la voz, la llamada, Mi día y la PC |
| `reactor.js` | El reactor animado de la llamada |
| `sw.js` | Guarda la app en el celular para que abra al toque |
| `manifest.webmanifest` | El nombre, el ícono y los colores de la app instalada |

Las letras Orbitron y Rajdhani tienen licencia libre (SIL Open Font License 1.1): ver `fuentes/LICENCIA.txt`.
