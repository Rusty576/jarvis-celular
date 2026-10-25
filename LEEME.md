# JARVIS en el celular

Dos formas de tener a JARVIS en el celular, con la misma pantalla:

- **La app de Android** (`android/JARVIS.apk`, el código está en `app_android/`): una app de verdad. Escucha y
  habla con la voz del celular. Llama a tus contactos por su nombre, pone alarmas y temporizadores, prende la
  linterna, cambia el volumen y abre cualquier app. Los recordatorios suenan aunque no haya internet, y se puede
  elegir como asistente del celular. Además: «Hey Jarvis» con la app cerrada (como «Ok Google») y un cerebro que
  contesta sin internet (Gemma, en el mismo celular).
- **La web app** (esta carpeta): se instala desde Chrome, en Android o en iPhone. Hace lo mismo menos lo del
  teléfono: para abrir otra app hay que tocar un botón.

Las pestañas:

- **Inicio**: como JARVIS en la PC. Tocás HABLAR (o decís «Jarvis…» con el manos libres prendido) y los protocolos.
- **Charla**: escribile, hablale o mandale un archivo (el clip: fotos, PDF, audio, video o textos, hasta 15 MB).
  Te hace documentos de Google Docs (botón para abrirlos) e imágenes (botón «Guardar imagen»). Al lado de mandar
  está **Llamar** (el teléfono): manos libres, te escucha, piensa y te contesta hablando, hasta que digas «chau».
- **Mi día**: el clima, tus recordatorios y tus pendientes.
- **Mails**: los no leídos; te los lee, los resume o los contesta (mandar siempre con tu OK).

No tiene nada adentro: ni claves, ni direcciones, ni datos. Todo lo hace el bot de JARVIS (Google Apps Script), y la
app se conecta con él con el link que manda `/app` en Telegram. La parte del link después del `#` (la dirección del
bot y la llave) no viaja a ningún servidor y queda guardada solo en tu celular.

Sin internet, en la app de Android contesta el cerebro del celular (si lo bajaste, en Ajustes); si no, lo que
escribas queda en una cola y sale solo cuando vuelve. Lo del teléfono (abrir apps, llamar, alarmas, la hora) anda
igual.

## Instalarla

**App de Android**

1. En el celular, abrí https://rusty576.github.io/jarvis-celular/android/JARVIS.apk y bajala.
2. Abrí el archivo. Android pide permitir que Chrome instale apps: permitilo. Si Play Protect avisa que no la
   conoce, tocá «Instalar de todos modos» (la hiciste vos: no está en Play Store).
3. En Telegram, mandale `/app` a tu JARVIS, mantené apretado el link y tocá «Copiar».
4. Abrí la app: se conecta sola con el link copiado.

Para actualizarla: cuando hay una versión nueva, la app te lo avisa con un botón «Actualizar».

**Web app**

1. En Telegram, mandale `/app` a tu JARVIS y tocá el link desde el celular.
2. En Chrome: ⋮ > «Instalar app» (o «Agregar a la pantalla principal»).

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La página: las pestañas, la pantalla de la llamada y los ajustes |
| `estilo.css` | Los colores y las letras de JARVIS |
| `app.js` | Todo lo que hace: hablar con el bot, la voz, el teléfono, la llamada, Mi día y los mails |
| `reactor.js` | El reactor animado |
| `sw.js` | Guarda la web app en el celular para que abra al toque |
| `manifest.webmanifest` | El nombre, el ícono y los colores de la web app instalada |
| `android/` | La app de Android ya compilada (`JARVIS.apk`) y su versión (`version.json`) |

La versión de las dos es `VERSION_APP` en `app.js`. Para publicar cambios: subí ese número (y el de `sw.js`),
compilá la app de Android (`Compilar app Android.bat`) y publicá (`Publicar app del celular.bat`).

Las letras Orbitron y Rajdhani tienen licencia libre (SIL Open Font License 1.1): ver `fuentes/LICENCIA.txt`.
