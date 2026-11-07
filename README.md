# aula-local

App de clase que corre en la laptop del profesor y funciona **solo en red local, sin internet**.
Los alumnos se unen desde el navegador del celular (escaneando un QR) y siguen la presentación sincronizada.
Especificación completa: [SPEC.md](SPEC.md).

Es **software libre y gratuito** (licencia [MIT](LICENSE)), sin límites de alumnos ni de clases.

Estado: **Fases 1–4 completas** (clases preparadas, pizarrón, cuadrícula en vivo, historial, ZIP de respuestas, PIN del profesor, dibujo sin conexión y clases que sobreviven a un reinicio) e **instalador para Windows** (no hace falta instalar Node.js; ver abajo). El instalador todavía no está firmado, así que Windows muestra un aviso al abrirlo.

## Instalar en Windows (profesores)

- **Descargar:** entra a [aula-licencias.aula-licencias.workers.dev/descargas](https://aula-licencias.aula-licencias.workers.dev/descargas) y baja el instalador más reciente (`aula-local-setup-<versión>.exe`).
- **Aviso de Windows:** como el instalador todavía no está firmado, Windows muestra "Windows protegió tu PC". Pulsa **Más información** y luego **Ejecutar de todas formas**.
- **Instalar:** sigue el asistente; pide permiso de administrador. Al terminar, abre **aula-local** desde el ícono del escritorio o del menú Inicio.
- **Al abrirla:** se abre **Mis clases** en el navegador y aparece un ícono verde junto al reloj. Con doble clic en ese ícono también se abre Mis clases. Su menú (clic derecho) tiene **Abrir Mis clases**, **Conectar alumnos**, **Guía de red**, **Ver registro** y **Salir**.
- **Tus datos:** viven en `%LOCALAPPDATA%\aula-local`. Se conservan al actualizar y al desinstalar.
- **Actualizar:** cuando Mis clases avise que hay una versión nueva, descarga el instalador nuevo e instálalo encima de la actual. El instalador cierra aula-local si está abierta.

## Desarrollo (desde el código)

Para correr o modificar la app desde el código fuente. Los profesores no lo necesitan: usen el instalador de arriba.

### Requisitos

- Node.js 22.13 o superior.
- Opcional: [Poppler](https://poppler.freedesktop.org/) (`pdftoppm`) para convertir PDFs más rápido. Sin él se usa `pdfjs-dist`.

`npm install` es el único paso que necesita internet. Después todo funciona sin conexión.

### Arranque

```bash
npm install
npm run build
npm start
```

La consola muestra la URL del profesor (`http://localhost:3000/teacher`), la URL para alumnos con la IP local detectada y un QR.
Otro puerto: `PORT=3001 npm start` (en PowerShell: `$env:PORT=3001; npm start`).

Desarrollo con recarga: `npm run dev`. Pruebas: `npm test`. Prueba de carga con 40 alumnos (Playwright): `npm run test:e2e`. Tipos: `npm run typecheck`.

## Uso

1. **Antes de la clase:** abre `http://localhost:3000/teacher` (lleva a **Mis clases**). Pulsa **Nueva clase**, sube el PDF con un título y luego **Preparar**. Elige una diapositiva y agrega sus preguntas: tipo, tiempo y un enunciado opcional.
2. **En el aula:** en **Mis clases** pulsa **Dar clase** y proyecta el QR. Al llegar a una diapositiva con preguntas preparadas aparecen sus botones (▶) junto a los controles: un clic la lanza. Con **Lanzar pregunta** puedes improvisar otras.
3. **Al final:** pulsa **Terminar clase**. Se abre el resumen con todas las preguntas y sus respuestas. Lo puedes volver a abrir cuando quieras desde **Mis clases → Historial**, aunque apagues la laptop.

Todo se guarda en `data/classes/` (copia esa carpeta para respaldar tus clases). En el resumen, **Descargar respuestas (ZIP)** baja un PNG por alumno y pregunta más `respuestas.csv` (separado por `;`; usa "CSV con comas" si tu Excel espera comas).

**Si se cae algo en plena clase:**
- *Un alumno pierde el Wi-Fi:* puede seguir dibujando; al volver la conexión su pizarrón y su entrega se envían solos.
- *Se apaga o reinicia el servidor:* al volver a ejecutar `npm start` la clase se retoma sola (mismo código, alumnos, respuestas y pregunta abierta) y los celulares se reconectan sin hacer nada. Si pasan más de 12 h, la clase queda como **interrumpida** en el historial, con lo guardado hasta ese momento.

**PIN del profesor:** en la laptop nunca se pide. La primera vez que abres Mis clases puedes crear un PIN (4 a 8 dígitos); se pedirá a cualquier otro dispositivo que intente abrir la vista del profesor (por ejemplo, un alumno que escriba `/teacher`). Se cambia desde Mis clases → "Cambiar PIN". Los datos del PIN viven en `data/config.json` (si lo olvidas, borra ese archivo en la laptop y crea uno nuevo).

**Proyector:** si el proyector duplica la pantalla, la cuadrícula se proyecta con los nombres ocultos. Si es una pantalla extendida, pulsa "Abrir ventana de proyección" y arrastra esa ventana al proyector: ahí solo se ven la diapositiva o la respuesta en grande.

## Dos modos de red

| Modo | Para qué | Límite |
| --- | --- | --- |
| **Hotspot de la laptop** | Probar con pocos equipos | Windows: máximo 8 dispositivos y pide una conexión activa para encenderse |
| **Router propio sin internet** | Clase completa (30–40 alumnos) | Ninguno práctico; la laptop y los celulares se conectan al mismo router |

La app no depende de cómo se cree la red: usa la IP que tenga la laptop. Si la red cambia después de crear la sesión,
pulsa **Proyectar QR** y el QR se regenera con la IP nueva.

### Problemas comunes

- **El celular no carga la página:** la primera vez Windows pregunta si Node.js puede usar la red. Permítelo en redes **privadas**
  (Firewall de Windows Defender → Permitir una aplicación a través del firewall → Node.js).
- **"Red sin internet":** algunos celulares cambian solos a datos móviles. Apaga los datos y elige "mantener conexión".
- **Red de la escuela:** muchas aíslan a los clientes entre sí y los celulares no ven la laptop. Usa un router propio.
- **El servidor se reinició:** vuelve a ejecutar `npm start`; la clase en curso se retoma sola y los celulares se reconectan (ver "Si se cae algo en plena clase").

## Licencia

[MIT](LICENSE): puedes usar, copiar, modificar y redistribuir aula-local libremente, también en escuelas y con fines comerciales, siempre que conserves el aviso de copyright. Se ofrece tal cual, sin garantía.
