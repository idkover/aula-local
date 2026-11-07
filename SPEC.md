# Especificación: app de clase en red local con pizarrón

Oct 29, 2026

## Resumen

Construir una app web que corre en la laptop del profesor y funciona 100 % en red local, sin internet. Los alumnos se unen desde el navegador de su celular o tablet (escaneando un QR), siguen la presentación sincronizada y, cuando el profesor lanza una pregunta, responden en un pizarrón que el profesor ve en vivo.

Principios de diseño:

- Cero instalación del lado del alumno: solo navegador.
- Offline primero: ningún recurso se carga de internet (sin CDNs en runtime).
- Ligero en red: las diapositivas se descargan una vez; después solo viajan eventos pequeños y trazos vectoriales.
- Un solo comando para arrancar el servidor en Windows, macOS o Linux.

## Requisitos funcionales

### Profesor (`/teacher`, protegido con PIN)

1. Subir una presentación en PDF; el servidor la convierte a una imagen PNG por página.
2. Crear una sesión y mostrar un QR + URL (`http://<ip-local>:3000`) y un código de 4 dígitos.
3. Navegar diapositivas (flechas del teclado, botones); todos los alumnos cambian al instante.
4. Lanzar una pregunta sobre la diapositiva actual con tipo: pizarrón en blanco, pizarrón sobre la diapositiva, o respuesta corta de texto. Límite de tiempo opcional.
5. Ver una cuadrícula en vivo con el pizarrón de cada alumno (miniaturas que se actualizan mientras dibujan) y un contador de entregados / conectados.
6. Abrir una respuesta en grande para proyectarla, con o sin el nombre del alumno.
7. Cerrar la pregunta y volver a la presentación.
8. Exportar las respuestas de la sesión (PNG por alumno + CSV de entregas) en un ZIP.

### Alumno (`/`)

1. Unirse con nombre y código de sesión; reconectar automáticamente si se cae el Wi-Fi sin perder su lugar.
2. Ver la diapositiva actual a pantalla completa, ajustada al tamaño del dispositivo.
3. Al recibir una pregunta, cambiar a modo pizarrón: lápiz, colores (4–6), grosor, borrador, deshacer/rehacer, limpiar.
4. Dibujar con dedo o stylus (Pointer Events, sensibilidad a presión si existe) sin que la página haga scroll o zoom.
5. Botón "Entregar"; después puede editar y reenviar mientras la pregunta siga abierta.
6. Al cerrarse la pregunta, volver a la diapositiva.

### Fuera de alcance en la v1

- Animaciones y transiciones de PowerPoint.
- Cuentas de usuario o base de datos persistente entre sesiones.
- Transmitir la pantalla como video.

## Arquitectura y stack

Un solo proceso Node.js en la laptop del profesor sirve los archivos estáticos, la API de subida y un servidor Socket.IO; todo el estado de la sesión vive en memoria.

&#91;embedded content: arquitectura · laptop, red local y alumnos\]

La laptop manda diapositivas y eventos hacia abajo; los alumnos devuelven trazos y entregas por el mismo canal.

| Capa | Elección | Por qué |
| --- | --- | --- |
| Servidor | Node.js 22.13+ con Express y Socket.IO | Reconexión automática y salas por sesión listas de fábrica |
| Conversión de PDF | `pdftoppm` (Poppler) si está instalado; si no, `pdfjs-dist` + `@napi-rs/canvas` | Imágenes PNG a \~1600 px de ancho, generadas una sola vez |
| Frontend | HTML + TypeScript con Vite, sin framework (o Preact si crece) | Páginas ligeras que cargan rápido en celulares modestos |
| Pizarrón | Canvas 2D + Pointer Events + `perfect-freehand` | Trazos suaves con presión y bajo costo de CPU |
| QR | `qrcode` (generado en el servidor) | Unirse sin teclear la IP |
| Exportación | `archiver` para el ZIP | Un archivo por sesión |
| Pruebas | Vitest (unidad) + Playwright con varios clientes simulados | Validar sincronía con 40 conexiones |

Todas las dependencias del frontend se empaquetan con Vite: ninguna página pide recursos externos.

Detección de IP: al arrancar, el servidor lista las interfaces IPv4 no internas, prioriza la del hotspot (`192.168.137.x` en Windows) o la del router, y la imprime en consola junto con el QR.

## Protocolo de eventos (Socket.IO)

Cada sesión es una sala; el profesor y los alumnos se separan en los namespaces `/teacher` y `/student`. El servidor es la única fuente de verdad: al reconectar, el cliente recibe `state:sync` con el estado completo.

| Evento | Dirección | Payload | Efecto |
| --- | --- | --- | --- |
| `student:join` | alumno → servidor | `{ code, name, clientId }` | Registra o recupera al alumno por `clientId` (guardado en `localStorage`) |
| `state:sync` | servidor → cliente | `{ slideIndex, slideCount, question?, myAnswer? }` | Estado completo tras unirse o reconectar |
| `slide:goto` | profesor → servidor → alumnos | `{ index }` | Cambia la diapositiva de todos |
| `question:open` | profesor → servidor → alumnos | `{ id, type, slideIndex?, timeLimitSec? }` | Abre el pizarrón en cada alumno |
| `stroke:add` | alumno → servidor → profesor | `{ questionId, stroke }` | Trazo terminado; el profesor actualiza la miniatura |
| `stroke:undo` / `board:clear` | alumno → servidor → profesor | `{ questionId }` | Sincroniza deshacer y limpiar |
| `stroke:remove` | alumno → servidor → profesor | `{ questionId, strokeId }` | Borrador de trazo completo (agregado en la Fase 2) |
| `answer:submit` | alumno → servidor | `{ questionId, text? }` | Marca la respuesta como entregada |
| `answer:status` | servidor → profesor | `{ connected, submitted }` | Contador en vivo |
| `answer:spotlight` | profesor → servidor → profesor | `{ studentId, showName }` | Muestra una respuesta en grande en todas las vistas del profesor (`studentId: null` la quita) |
| `question:close` | profesor → servidor → alumnos | `{ id }` | Bloquea el pizarrón y regresa a la diapositiva |

Decisiones tomadas en la Fase 1 (aprobadas):

- `state:sync` incluye además `sessionId`. Con él, el cliente arma las URLs inmutables de las diapositivas (`/slides/<sessionId>/<n>.png`), que el navegador cachea una sola vez.
- El profesor entra a la sala de su sesión con el handshake de Socket.IO (`auth: { sessionId }`) en el namespace `/teacher`, sin un evento aparte. Si la sesión no existe, la conexión se rechaza con el error `SESSION_NOT_FOUND`.
- `student:join` responde por el *ack* de Socket.IO con `{ ok: true }` o `{ ok: false, error }`, sin un evento de error aparte.

Decisiones tomadas en la Fase 2 (aprobadas):

- El borrador elimina trazos completos con `stroke:remove`. Deshacer un borrado vuelve a enviar el trazo con `stroke:add`, que lo agrega al final. Deshacer un trazo que ya no es el último también usa `stroke:remove`, para que el servidor y el alumno queden siempre iguales.
- `answer:submit` responde por *ack*, igual que `student:join`. Después de entregar, la respuesta sigue contando como entregada aunque el alumno la edite; el botón cambia a "Reenviar".
- Si la pregunta tiene límite de tiempo, el servidor la cierra sola al vencer y emite `question:close`, igual que si la cerrara el profesor.
- `state:sync` incluye `serverNow`, el reloj del servidor, para calcular el tiempo restante aunque los relojes de los celulares no coincidan. El profesor también recibe `question:open` y `question:close`.
- El pizarrón usa siempre la proporción de la diapositiva de la pregunta, también en "pizarrón en blanco", para que los trazos normalizados se vean igual en todas las pantallas. `size` es el grosor en milésimas del ancho del pizarrón.
- Solo hay una pregunta abierta a la vez: abrir otra cierra la anterior.

Decisiones tomadas en la Fase 3 (aprobadas):

- Cada alumno tiene un `id` público, que es el `studentId` de los eventos del profesor. El `clientId` funciona como credencial de reconexión del alumno y nunca se envía al profesor.
- El servidor reenvía al profesor `stroke:add`, `stroke:undo`, `stroke:remove` y `board:clear` con `studentId` y el trazo ya validado, y avisa cada entrega con `answer:submitted { studentId, questionId, text?, submittedAt }`.
- Al conectarse, el profesor recibe además `roster:sync { students: [{ id, name, connected }] }` y `answers:sync { question, answers }` con la pregunta actual o la última cerrada. `roster:sync` se reenvía completo cada vez que un alumno entra o sale.
- `answer:spotlight` va de servidor a profesor y se reenvía a todas sus ventanas. `studentId: null` quita la respuesta en grande, y abrir otra pregunta también la quita.
- Hay dos modos de proyector. Con el proyector duplicado, la cuadrícula se proyecta con los nombres ocultos por defecto ("Alumno N"). Con pantalla extendida, `/teacher/proyector` muestra solo la diapositiva o la respuesta en grande, y la cuadrícula queda en la laptop.
- Después de cerrar una pregunta, sus respuestas siguen revisables ("Ver respuestas") hasta que se abre otra.
- Prueba de carga: la vista real del profesor corre en Chromium con Playwright, y 40 alumnos simulados con socket.io-client dibujan al mismo tiempo.

Decisiones de clases preparadas (aprobadas, adelantan parte de la Fase 4):

- **Biblioteca de clases (`/teacher/clases`).** Es el inicio del profesor. Una clase es un PDF con título y preguntas preparadas por diapositiva: `PreparedQuestion { id, slideIndex, type, timeLimitSec?, prompt? }`. Vive en `data/classes/<classId>/` (`class.json`, `original.pdf`, `slides/`). Hay una sola biblioteca por laptop, sin cuentas. El PDF de una clase no se reemplaza: un PDF nuevo es una clase nueva.
- **Enunciado.** Es un texto opcional de hasta 500 caracteres en las preguntas preparadas y en las improvisadas: `Question.prompt` y `QuestionOpenPayload.prompt`. Los alumnos lo ven arriba del pizarrón o del campo de texto.
- **Clase en vivo.** "Dar clase" crea la sesión, o retoma la que ya está en curso, con `POST /api/classes/:id/sessions`. Las preguntas preparadas de la diapositiva actual se lanzan con un clic. Cada lanzamiento lleva un id nuevo y guarda `preparedId`, y los ids de pregunta no se repiten dentro de una sesión. `POST /api/sessions` queda como "clase rápida": una clase sin título más su sesión.
- **Fin de clase.** "Terminar clase" emite `session:end`. El servidor cierra la pregunta abierta, guarda todo, avisa a los alumnos (`session:end`) y a las ventanas del profesor (`{ classId, sessionId }`), y borra la sesión de la memoria. Un profesor que se reconecta a una sesión terminada recibe el error `SESSION_ENDED` con `{ classId, sessionId }`.
- **Historial en disco.** Cada sesión se guarda en `classes/<classId>/sessions/<sessionId>/`:
  - `session.json` guarda los alumnos `{ id, name }` (sin `clientId`) y las preguntas, sin trazos.
  - `answers/<questionId>.json` guarda las respuestas por id público.
  - Se guarda como máximo cada 10 s mientras cambian las respuestas, de inmediato al cerrar una pregunta y al terminar la clase, y lo pendiente al apagar el servidor.
  - Una sesión que no se terminó se muestra como "interrumpida".
- **Resumen (`/teacher/resumen?c=&s=`).** Lista todas las preguntas de la sesión, con su cuadrícula y la respuesta en grande en solo lectura. Funciona días después y tras reiniciar el servidor.
- **Diapositivas.** `/slides/<id>/<n>.png` acepta el id de una sesión en curso o el de una clase.
- **Pendiente en la Fase 4.** El ZIP de respuestas, el PIN del profesor, restaurar una clase en vivo tras reiniciar el servidor y dibujar sin conexión.

Decisiones de la Fase 4 (aprobadas):

- **Retomar la clase tras un reinicio.**
  - El estado privado de cada clase en curso vive en `data/live/<sessionId>.json`, fuera de `classes/`, para que el historial se pueda copiar sin credenciales. Guarda código, diapositiva, spotlight y `clientId → id` de cada alumno.
  - Se guarda casi de inmediato (~300 ms) al cambiar de diapositiva, al entrar un alumno, con el spotlight y al abrir o cerrar una pregunta. Las respuestas siguen el ritmo de ≤10 s, y al apagar el servidor se guarda todo.
  - Al arrancar, cada clase guardada hace menos de 12 h se retoma con el mismo código, alumnos (desconectados hasta que su celular se reconecta con su `clientId`), respuestas y pregunta abierta, con el tiempo real restante. Una pregunta que venció mientras el servidor estaba apagado se cierra.
  - Pasadas las 12 h, la clase queda "interrumpida". `live.json` se borra al terminar la clase.
- **Dibujo sin conexión.**
  - El pizarrón ya no se bloquea sin conexión, solo al vencer el tiempo. El tablero local es la verdad del alumno mientras la pregunta siga abierta, y se guarda en `localStorage`.
  - En cada `state:sync` de la misma pregunta, el cliente reconcilia por estado (`diffBoard`): envía `stroke:remove` y `stroke:add` hasta que el servidor coincide, y después la entrega pendiente. Esto cubre los ~18 s que tarda en detectarse la caída del Wi-Fi y un servidor retomado con datos de unos segundos atrás.
  - El cliente deshace siempre con `stroke:remove` por id. `stroke:undo` queda solo por compatibilidad.
- **PIN del profesor.**
  - La propia laptop nunca lo pide: loopback, o su propia IP LAN (`remoteAddress === localAddress`).
  - Desde otros dispositivos protege las páginas `/teacher*` (salvo `/teacher/pin`), las APIs del profesor y el namespace `/teacher`.
  - Se crea la primera vez desde Mis clases y se guarda con scrypt en `data/config.json`.
  - Un dispositivo autorizado recibe la cookie firmada `aula_t` (HttpOnly, SameSite=Strict, 30 días). Cambiar el PIN invalida todas las cookies.
  - Se limitan los intentos fallidos por IP. Las peticiones que cambian datos con un `Origin` distinto del `Host` se rechazan.
  - Errores: `PIN_REQUIRED` (401) y `PIN_NOT_SET` (403).
- **ZIP de respuestas.**
  - Se descarga con `GET /api/classes/:cid/sessions/:sid/export.zip` desde el resumen.
  - Trae un PNG por alumno y pregunta de pizarrón, del tamaño de la diapositiva y dibujado con el mismo trazado que el navegador (`shared/freehand.ts`). El nombre del alumno va solo en el nombre del archivo.
  - Trae también `respuestas.csv`, separado por `;` (o `,` con `?sep=comma`), con BOM UTF-8 y protección contra fórmulas.

Decisión de código abierto (2026-11-06, aprobada):

- **Licencia del código:** MIT (`LICENSE`). La app es gratis y sin límites: se quitaron el plan gratis (8 alumnos, 3 clases, sin ZIP), las licencias firmadas Ed25519, la activación por laptop, `scripts/license-tool.ts` y la ruta `/api/license`. No habrá pasarela de pago.
- **Instalaciones anteriores:** el `data/license.json` que dejaron las versiones con licencias se ignora y no se borra.
- **Emisor en línea** (proyecto aparte `aula-licencias`, Cloudflare Worker): se queda como está. La app solo lo usa como servidor de versiones (`/api/version`) y de descargas (`/descargas`); sus rutas de licencias (`/activar`, `/api/activate`, `/admin`) ya no las llama la app.
- **Historial:** las licencias se diseñaron en las fases L1 (licencia local firmada) y L2 (emisor en línea con D1 y panel `/admin` con Cloudflare Access), y se retiraron antes de publicar el código.

Decisiones de la Fase L3, instalador para Windows (aprobadas):

- **Instalador Inno Setup** (`npm run package:win` → `build/win/aula-local-setup-<versión>.exe`, ~39 MB): incluye su propio Node (copia del de la laptop del vendedor), la app con dependencias de producción y el lanzador; pide administrador; accesos directos; regla de firewall `aula-local` solo para redes privadas y solo para su `node.exe`; actualizar = instalar encima (cierra la app abierta con `aula-local.exe --salir`); desinstalar conserva los datos.
- **Lanzador** (`packaging/windows/launcher`, C# 5 compilado con el csc de .NET Framework 4.x, sin dependencias): ícono en la bandeja (Abrir Mis clases, Conectar alumnos, Guía de red, Ver registro, Salir), una sola instancia, primer puerto libre entre 3000 y 3010, arranca Node sin ventana con `PORT`, `AULA_DATA_DIR` y `AULA_SHUTDOWN_TOKEN`; Salir pide `POST /api/app/shutdown` (token, solo la laptop) para guardar todo antes de cerrar.
- **Datos** en `%LOCALAPPDATA%\aula-local\` (`data`, `logs\server.log`, `run\port.txt`).
- **Actualizaciones:** la app consulta `GET <servidor de versiones>/api/version` (sin datos de la laptop) al arrancar y cada 24 h; Mis clases avisa si hay una versión más nueva. El servidor es el Worker `aula-licencias` (`DEFAULT_UPDATES_URL` en `server/update.ts`; se cambia con `AULA_UPDATES_URL`). El instalador se descarga de `<servidor>/descargas/<archivo>` (bucket R2 `aula-local-descargas`).
- **Páginas nuevas:** `/teacher/conectar` (dirección y QR para alumnos, sin código) y `/teacher/guia-red`.
- **Pendiente:** firma de código (hoy Windows muestra SmartScreen) e incluir el texto completo de la licencia MIT de Node en el instalador.

Formato de trazo: `{ id, color, size, points: [[x, y, presión], …] }`, con x e y normalizadas de 0 a 1 respecto al lienzo, para que se vea igual en cualquier pantalla. Los puntos se redondean a 3 decimales y se envía el trazo al soltar el dedo (no punto por punto) para ahorrar red.

## Estructura del repo y modelos de datos

Monorepo con tipos compartidos entre servidor y clientes, para que el protocolo no se desincronice.

```
aula-local/
  package.json            # scripts: dev, build, start, test
  shared/
    types.ts              # Session, Student, Question, Stroke, eventos tipados
  server/
    index.ts              # Express + Socket.IO, detección de IP, QR en consola
    session.ts            # estado en memoria y reglas de la sesión
    pdf.ts                # PDF → PNG por página
    export.ts             # ZIP con PNG por alumno + CSV
  client/
    student/              # index.html, main.ts, board.ts, slide.ts
    teacher/              # index.html, main.ts, grid.ts, controls.ts
    common/               # socket.ts (reconexión), render de trazos
  data/sessions/<id>/     # PDF original, PNG generados, exportaciones
  tests/
```

```ts
type Stroke = { id: string; color: string; size: number; points: [number, number, number][] };
type Question = { id: string; type: 'blank' | 'overSlide' | 'text'; slideIndex?: number; openedAt: number; timeLimitSec?: number; closed: boolean };
type Answer = { strokes: Stroke[]; text?: string; submittedAt?: number };
type Student = { clientId: string; name: string; socketId?: string; connected: boolean; answers: Record<string, Answer> };
type Session = { id: string; code: string; pinHash: string; slides: string[]; slideIndex: number; question?: Question; students: Map<string, Student> };
```

El estado se guarda en memoria y se vuelca a `data/sessions/<id>/state.json` cada 10 s y al cerrar una pregunta, para sobrevivir a un reinicio del servidor.

## Restricciones de red y despliegue

El hotspot de Windows sirve para probar con pocos equipos; para un grupo completo se usa un router sin internet.

| Restricción | Impacto | Cómo lo maneja la app |
| --- | --- | --- |
| Hotspot de Windows: máximo 8 dispositivos | No alcanza para un grupo de 30–40 | README con dos modos: hotspot (pruebas) y router dedicado (clase) |
| Windows pide conexión activa para encender el hotspot | Puede no arrancar en un aula sin internet | Documentar el uso de router; la app no depende de cómo se cree la red |
| Celulares que detectan "red sin internet" | Algunos se pasan a datos móviles y no cargan la página | Pantalla de ayuda en el QR: "mantente conectado a la red"; el cliente reintenta y avisa si pierde el servidor |
| Firewall de Windows / macOS | Bloquea el puerto 3000 la primera vez | Mensaje en consola indicando permitir el acceso en redes privadas |
| Red de la escuela con aislamiento de clientes | Los alumnos no ven la laptop | Recomendar router propio |
| HTTP sin HTTPS | APIs como Service Worker no disponibles | No usarlas; Canvas, Pointer Events y WebSocket funcionan en HTTP |

Objetivo de carga: 40 alumnos conectados, cambio de diapositiva visible en menos de 300 ms y miniaturas del profesor actualizadas en menos de 1 s.

Arranque: `npm install && npm run build && npm start`. Opcional en una fase posterior: empaquetar como ejecutable con `pkg` o Electron para profesores sin Node instalado.

## Plan por fases y criterios de aceptación

Cada fase termina con algo que se puede probar en un aula real.

1. **Esqueleto y sincronía de diapositivas.** Servidor, subida de PDF, conversión a PNG, QR, unión de alumnos y `slide:goto`.
   - [ ] Tres celulares en el hotspot siguen las diapositivas sin recargar.
   - [ ] Un alumno que recarga la página vuelve a la diapositiva actual.
2. **Pizarrón del alumno.** Herramientas de dibujo, deshacer, entregar; sin scroll ni zoom accidental en iOS y Android.
   - [ ] Dibujar con dedo y con stylus se siente fluido en un celular de gama media.
3. **Vista del profesor.** Cuadrícula en vivo, contador, respuesta en grande, cerrar pregunta.
   - [ ] Las miniaturas se actualizan en menos de 1 s con 40 clientes simulados (Playwright).
4. **Robustez y exportación.** Reconexión, volcado a disco, ZIP de respuestas, PIN del profesor.
   - [ ] Apagar y prender el Wi-Fi de un alumno no pierde sus trazos.
   - [ ] Reiniciar el servidor conserva la sesión.
5. **Empaquetado (opcional).** Ejecutable para Windows y guía de instalación del router. Hecha como Fase L3 (ver abajo).

## Prompt inicial para Claude Code

Exporta este documento como Markdown, guárdalo como `SPEC.md` en una carpeta vacía y pega esto en Claude Code:

```markdown
Lee SPEC.md completo. Es la especificación de "aula-local", una app web que corre en la laptop del profesor y funciona solo en red local, sin internet.

Antes de escribir código:
1. Resume en 5 líneas lo que entendiste y lista tus dudas.
2. Propón el plan de la Fase 1 con los archivos que vas a crear.

Después implementa SOLO la Fase 1 del plan, siguiendo la estructura del repo, el stack y el protocolo de eventos de SPEC.md al pie de la letra. Reglas:
- TypeScript estricto; tipos de eventos en shared/types.ts usados por servidor y clientes.
- Ningún recurso cargado de internet en runtime.
- Al terminar, corre las pruebas, dime cómo arrancarlo y cómo probarlo con mi celular conectado al hotspot de la laptop.

No avances a la Fase 2 hasta que yo confirme que la Fase 1 funciona.
```
