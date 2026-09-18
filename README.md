# Bitácora de Barra

App de gestión diaria de bar: temperaturas, inventario, entradas (incl.
lectura de facturas), salidas, mermas, caducidades, inventario físico,
código de barras, checklists de apertura/cierre, limpieza y mantenimiento,
incidencias, historial completo, informes semanales, analítica, usuarios y
roles con PIN, copia de seguridad — **funciona sin conexión** y sincroniza
con Supabase cuando hay internet.

Este proyecto es la evolución de un prototipo (Artifact) ya funcional: toda
la lógica de negocio existente se ha conservado tal cual; lo que se ha
añadido es la capa de sincronización, autenticación, PWA y backend en la
nube descritas en este documento.

## Arquitectura

```
USUARIO
  │
  ▼
UI (index.html + css/styles.css)
  │
  ▼
js/app.js  ── capa de datos (put/del/getAll/getOne) ──►  IndexedDB (local)
  │                                                            │
  │ put()/del() también encolan el cambio                     │ fuente de verdad
  ▼                                                            │ mientras no hay red
js/sync.js ── sync_queue (IndexedDB) ──► processQueue() ───────┘
  │
  ▼ (solo si hay red y Supabase configurado)
js/supabaseClient.js ──► Supabase (Auth + PostgreSQL + Storage)
```

Puntos clave:

- **La interfaz nunca llama a Supabase directamente.** Todas las
  operaciones pasan por `js/app.js` (`put`/`del`/`getAll`/`getOne`), que es
  quien decide qué guardar en IndexedDB y qué encolar para sincronizar.
  `js/sync.js` es el único módulo que habla con Supabase para los datos
  operativos; `js/supabaseClient.js` se usa además para el login.
- **Cada escritura se considera guardada en cuanto está en IndexedDB**, sin
  esperar ninguna petición HTTP. La sincronización ocurre en segundo plano.
- **Los movimientos de stock son eventos inmutables**: nunca se
  sobrescriben ni se resuelven por "gana el más nuevo" — se acumulan sin
  más, igual que ya funcionaba en la versión local.

## Qué se ha conservado (sin cambios de comportamiento)

Todos los módulos ya existentes siguen funcionando exactamente igual:
Dashboard, Inventario/Productos, Entradas manuales, Entradas por factura
(OCR → propuesta → revisión humana → confirmación → movimientos de stock),
Salidas (incl. retirada rápida), Mermas, Temperaturas, Proveedores,
Caducidades, Inventario físico, Código de barras (BarcodeDetector nativo),
Checklists, Limpieza/Mantenimiento, Incidencias, Historial, Informes
semanales, Analítica, Usuarios/roles/PIN, Copia de seguridad (export/import
JSON). IndexedDB sigue siendo la base de datos operativa local — no se ha
sustituido por `localStorage` en ningún momento.

## Qué se ha añadido (Fase 5)

- `js/supabaseClient.js` — cliente de Supabase (Auth) configurable.
- `js/sync.js` — cola de sincronización offline-first (`sync_queue`), pull
  incremental, login/logout, indicador de estado en la barra superior.
- `manifest.json` + `sw.js` + `icons/` — PWA instalable, offline-first de
  verdad (el *shell* de la app, no los datos, se sirve desde caché).
- `config.example.js` / `config.js` — URL y clave pública de Supabase, sin
  secretos hardcodeados en el código.
- `supabase/schema.sql` — esquema completo en PostgreSQL con Row Level
  Security multi-negocio.

## Estrategia de sincronización (documentada, no improvisada)

- **Esquema híbrido v1**: cada tabla en Supabase tiene unas pocas columnas
  relacionales (`business_id`, y FKs como `product_id`, `equipment_id`,
  `checklist_id`, `supplier_id`, `invoice_id` donde aportan integridad real
  para RLS/joins) **+ una columna `data jsonb`** con el registro completo
  tal cual vive en IndexedDB (mismos nombres de campo en español que ya usa
  `js/app.js`). Esto evita traducir a mano decenas de columnas por cada una
  de las 11 entidades sincronizables mientras el modelo de datos SQL
  termina de asentarse. **Normalizar columna a columna es un paso natural
  futuro, no un requisito para que la sincronización funcione hoy.**
- **UUID v4** para todo lo creado en local (`crypto.randomUUID()`), así un
  registro creado offline conserva su identidad al sincronizarse — no hace
  falta "traducir" IDs al subir.
- **Borrado lógico (`deleted_at`)**: nunca se hace un DELETE físico de
  datos operativos; se propaga como un UPDATE con `deleted_at`, para que
  el "tombstone" llegue también a dispositivos que estaban offline.
- **Resolución de conflictos**: comparación de `updated_at` al bajar
  cambios (*last-write-wins*) — si el registro local es más nuevo que el
  que llega del servidor (porque se editó offline y aún no se ha podido
  subir), se descarta el remoto y gana el local. **Excepción explícita:
  los movimientos de stock (`stock_movements`) nunca se resuelven así** —
  son eventos que se acumulan, no un valor que se sobrescribe.
- **Disparo de sincronización**: al arrancar la app, al recuperar conexión
  (evento `online` del navegador) y cada `SYNC_INTERVAL_MS` (60s por
  defecto) mientras haya conexión.
- **`usuarios` (PIN local) queda fuera de la sincronización a propósito**:
  hoy es una lista local de PIN por rol con identidad propia, que no
  coincide con `auth.users` de Supabase. La autenticación multi-dispositivo
  real se hace con Supabase Auth + la tabla `profiles` (login por
  email/contraseña, ver `js/sync.js` → `ensureAuth()`). Son dos sistemas de
  permisos con propósitos distintos: el PIN es para "quién de los que están
  delante del mostrador está haciendo esta acción ahora mismo"; la sesión
  de Supabase es "qué dispositivo/persona tiene acceso a los datos de este
  negocio". Unificarlos es un cambio de producto, no solo técnico, así que
  se ha dejado documentado en vez de forzado.

### Alcance actual de la sincronización (transparencia sobre lo que falta)

- El backend de OCR de facturas no está conectado a ningún servicio de IA
  todavía (igual que en el prototipo): la estructura de datos y el flujo
  humano de revisión (`PROPUESTA → REVISIÓN → CONFIRMAR`) ya están listos
  para enchufar un proveedor de OCR real sin cambiar el resto de la app.
- Los adjuntos (fotos) que llegan de **otro** dispositivo no se
  redescargan automáticamente a base64 local en el pull — se guarda la
  referencia (`storage_path` en Supabase Storage) en IndexedDB, lista para
  que una pantalla futura de "ver adjuntos" pida la URL firmada bajo
  demanda. La foto tomada en *este* dispositivo sí queda siempre
  disponible en local, con o sin conexión.
- `js/sync.js` puede fallar al llamar a Supabase (red, RLS, timeouts) sin
  que eso rompa nunca la app: cada intento fallido queda marcado
  `FAILED` en `sync_queue` con backoff exponencial (10s → doblando hasta
  un tope de 30 min) y se reintenta solo, sin bucles agresivos.

### Fase 6 — auditoría y correcciones (ver informe entregado en el chat)

Tras una auditoría técnica completa del proyecto real (no solo sintaxis:
se revisó que cada flujo funcionara offline → cola → online → Supabase →
otro dispositivo), se corrigieron los dos huecos conocidos de la Fase 5 y
se reforzaron varios puntos:

- **`invoice_items` real**: cada línea de una factura confirmada crea
  ahora su propia fila sincronizable (store local `facturaLineas` →
  tabla `invoice_items`), enlazada a la factura, al producto y al
  movimiento de stock que generó (`factura → línea → movimiento`).
- **`waste_records` real**: cada merma crea su propia fila sincronizable
  (store local `mermaRegistros` → tabla `waste_records`), enlazada al
  movimiento de stock. El movimiento en sí (la fuente de verdad del
  stock) no cambia.
- **Adjuntos → Supabase Storage real**: facturas, mermas, incidencias y
  tareas de mantenimiento pueden llevar foto. Cada foto genera un
  registro `adjuntos` (store local) que `js/sync.js` sube al bucket
  privado `attachments` cuando hay conexión (`captura → IndexedDB →
  sync_queue → Supabase Storage → fila en la tabla attachments con su
  storage_path`). Si no hay conexión, la foto sigue disponible en local
  sin ninguna pérdida — simplemente queda pendiente de subir.
- **Backoff exponencial** en los reintentos de sincronización fallidos
  (antes solo había un tope de 8 intentos, sin espaciarlos).
- **Registro de dispositivo real** (tabla `devices`): cada sincronización
  actualiza `device_id`, usuario, versión de app y última sincronización
  para ese negocio — no solo estaba en el esquema, ahora se rellena.
- **PIN local hasheado**: el PIN de 4 dígitos (bloqueo rápido de
  pantalla, `usuarios`/`config`, nunca sincronizado) se guarda ahora como
  hash SHA-256, nunca en texto plano, y el formulario de edición ya no
  muestra el PIN existente en claro. Se mantiene explícitamente separado
  de Supabase Auth: el PIN es "quién de los que están delante del
  mostrador" y Supabase Auth es la autenticación real que protege los
  datos en la nube — nunca se ha usado el PIN como contraseña de
  Supabase ni al revés.
- **Idempotencia verificada**: cada fila sincronizada usa el id que ya
  tenía en IndexedDB (generado una sola vez, nunca al reintentar), así
  que repetir un push (por fallo de red, por ejemplo) nunca duplica una
  fila — `upsert(..., {onConflict:'id'})` siempre sobrescribe la misma.
  Esto es lo que garantiza también que dos movimientos de stock creados
  offline en dos dispositivos distintos (p. ej. dos salidas de "−10" y
  "−5" del mismo producto) lleguen a Supabase como **dos filas
  independientes que se suman**, nunca como una sobrescribiendo a la
  otra — porque cada una tiene su propio id.

## Estructura del proyecto

```
bitacora-barra/
├── index.html              # shell de la app (SPA)
├── manifest.json            # PWA
├── sw.js                    # Service Worker (cache del shell, offline)
├── config.example.js        # plantilla de configuración (sin secretos)
├── config.js                # tu configuración real (no subir con claves reales a repos públicos)
├── css/
│   └── styles.css
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── icon-512-maskable.png
├── js/
│   ├── app.js                # toda la lógica de negocio (igual que antes) + capa de datos
│   ├── supabaseClient.js      # cliente Supabase (Auth)
│   └── sync.js                 # cola de sincronización offline-first
└── supabase/
    └── schema.sql            # esquema PostgreSQL + RLS
```

## Migrar los datos del prototipo (Artifact) a esta app

El Artifact original y esta app son **orígenes web distintos**, así que
IndexedDB no se comparte automáticamente entre uno y otro (es una
protección normal del navegador, no un fallo). Para pasar los datos:

1. Abre el Artifact original → *Seguridad y datos* → **Exportar copia de
   seguridad** (descarga un `.json`).
2. Abre esta app ya desplegada → *Seguridad y datos* → **Importar copia de
   seguridad** → selecciona ese mismo `.json`.

Es el mismo mecanismo de backup que ya existía, reutilizado como ruta de
migración — no se ha construido nada nuevo para esto.

## Fase 7 — validación real y correcciones

A diferencia de la Fase 6 (auditada por código), en esta fase el proyecto se
**ejecutó de verdad**: navegador real (Chromium vía Playwright) sirviendo
la app por HTTP, PostgreSQL real (no simulado) para `supabase/schema.sql`
y RLS, y un cliente Supabase simulado para ejercitar `js/sync.js` sin
inventar credenciales. El informe completo (qué se probó, cómo y con qué
resultado) se entregó en la conversación; aquí solo el resumen de lo que
cambió en el código:

- **`sync_queue` no respetaba el orden real de las operaciones.** El
  object store usa `keyPath:'id'` con un UUID aleatorio como clave, e
  IndexedDB `getAll()` devuelve las filas ordenadas por esa clave, no por
  orden de creación. Si un mismo registro se creaba, editaba y borraba
  offline en la misma sesión, el orden en que esos cambios llegaban a
  Supabase podía no ser el real. Se añadió un campo `seq` monótono y se
  ordena la cola por él antes de procesarla.
- **`storage.objects` no tenía RLS activada explícitamente** en
  `supabase/schema.sql` — la política de aislamiento por negocio existía
  pero quedaba inerte sin `alter table storage.objects enable row level
  security;`. Se detectó ejecutando el escenario de aislamiento (negocio A
  no debe ver adjuntos de negocio B) contra un PostgreSQL real, y se
  corrigió. Vuelto a probar: confirmado que A ya no ve ni puede escribir
  en la carpeta de Storage de B.
- **El backup (exportar/importar) no incluía las entidades de la Fase 6**
  (`facturaLineas`/invoice_items, `mermaRegistros`/waste_records,
  `adjuntos`) — un backup restaurado en otro dispositivo perdía esa
  trazabilidad. Corregido: el export/import ya recorre las 17 entidades
  completas.
- **El diálogo "¿Importar copia de seguridad?" no se cerraba solo** al
  confirmar (a diferencia de los demás `confirmDialog()` de la app, a los
  que sí les faltaba o no les faltaba el `closeSheet()` correspondiente).
  Corregido.

Todo lo demás auditado en esta fase — inventario, entradas, salidas,
mermas, facturas con líneas y trazabilidad, incidencias con foto,
temperaturas con alerta y acción correctiva, PIN hasheado y su pantalla
de bloqueo, backoff real ante un fallo de red, registro de dispositivo,
badge de estado de conexión, aislamiento RLS multi-negocio (SELECT,
INSERT, UPDATE, Storage), idempotencia de movimientos de stock, Service
Worker realmente registrado y cacheando solo el *shell*, manifest válido,
funcionamiento con la red cortada de verdad (no un flag) y tras recargar
la página offline, y rendimiento con ~300 productos y ~800 movimientos —
**se ejecutó y pasó sin necesidad de cambios de código.**

Lo que esta fase **no** ha podido validar por no disponer de un proyecto
Supabase real ni de un segundo dispositivo físico (ver el informe en el
chat para el detalle exacto): sincronización real de extremo a extremo
contra tu proyecto, sincronización entre dos dispositivos físicos, y la
instalación/uso real en la Xiaomi Redmi Pad Pro.

### Arquitectura preparada para OCR/IA real (todavía no conectada)

El flujo humano ya existe y no cambia:
`FOTO → (OCR/IA) → líneas detectadas → coincidencia con productos
(matchProducto(), ya implementado) → confianza → PROPUESTA → REVISIÓN
HUMANA (openFacturaRevisionSheet, ya implementado) → CONFIRMACIÓN →
invoice + invoice_items + stock_movements`. Lo único que falta conectar es
el paso "foto → texto/líneas", que hoy se hace escribiendo las líneas a
mano en el textarea de `openFacturaSheet`.

Punto de enganche recomendado — **no directo desde el frontend**: la
clave de cualquier proveedor de OCR/IA es un secreto y nunca debe vivir en
`config.js` (código público del navegador). El adaptador debe ser una
Supabase Edge Function (p. ej. `supabase/functions/ocr-factura/index.ts`)
que reciba la imagen, llame al proveedor con la clave guardada como
variable de entorno de la función (`supabase secrets set
OCR_API_KEY=...`), y devuelva las líneas ya parseadas; el frontend la
invoca con `SB.client.functions.invoke('ocr-factura', {body:{imageBase64}})`
y rellena con la respuesta el mismo textarea/flujo que ya existe — la IA
en ningún momento toca `productos` ni `stock_movements` directamente.

Proveedores a valorar (sin credencial real puesta en el proyecto):
- **Google Cloud Vision — Document Text Detection**: buena relación
  precio/calidad para texto impreso de facturas, ~1.50 $/1000 imágenes
  tras el nivel gratuito mensual. Variable: `GOOGLE_CLOUD_VISION_API_KEY`.
- **Azure AI Document Intelligence (antes Form Recognizer)**: modelos
  preentrenados específicos para facturas (extrae proveedor/líneas/importes
  con más estructura de partida). Variable: `AZURE_DOC_INTEL_KEY` +
  `AZURE_DOC_INTEL_ENDPOINT`.
- **Un modelo multimodal (Claude/GPT-4o vision) vía API**: más flexible
  con facturas manuscritas o de formato irregular, coste por token+imagen
  variable y algo más alto por documento; más fácil de ajustar con un
  prompt que reentrenar un modelo especializado. Variable:
  `ANTHROPIC_API_KEY` u `OPENAI_API_KEY`.

Ninguna de estas claves está en el proyecto — se añaden cuando el usuario
decida cuál usar, como secreto de la Edge Function, nunca en `config.js`.

## Fase 8 — validación real contra Supabase y cierre de producción

A diferencia de la Fase 7 (PostgreSQL local + mock de `supabase-js`), esta
fase se ejecutó contra un **proyecto Supabase real** del usuario
(`config.js` apuntando a `https://gapwnrsxtkqmsrchzvnv.supabase.co`, solo
con `SUPABASE_URL` + `anon/publishable key`, nunca `service_role`).

**Bug real encontrado y corregido — reseed en dispositivo nuevo:**
`seedIfEmpty()` (en `init()`, `js/app.js`) se ejecutaba antes de que
`SyncQueue.start()` pudiera hacer el pull inicial. En un "dispositivo
nuevo" (IndexedDB vacía) con Supabase configurado, esto generaba 12
productos de demostración con IDs nuevos que además se subían como reales,
duplicando el catálogo en cada instalación/reinstalación. Reproducido
contra Supabase real con dos negocios de prueba (12 duplicados en cada
uno). **Fix**: `seedIfEmpty()` ahora solo se ejecuta si Supabase NO está
configurado; con Supabase configurado, el pull real es la única fuente de
verdad. Modo 100% local sin cambios. Verificado de nuevo tras el fix:
un dispositivo nuevo contra un negocio limpio recibe exactamente los datos
reales, sin duplicar.

**Bug real encontrado y corregido — `storage.objects` en Supabase real:**
`alter table storage.objects enable row level security;` fallaba con
`42501 must be owner of table objects` al ejecutar `schema.sql` contra un
proyecto Supabase real (esa tabla pertenece a `supabase_storage_admin`, no
al rol que usa el SQL Editor) — algo que el PostgreSQL local de la Fase 7
no podía revelar porque ahí sí había permisos de owner. Supabase ya trae
RLS activado por defecto en `storage.objects`, así que el ALTER es solo
defensa en profundidad; se envolvió en un `do $$ ... exception when
insufficient_privilege ...$$` para que ese permiso ausente (esperado y
correcto en un proyecto real) no aborte el resto del script.

**Verificado contra Supabase real** (dos usuarios reales A/B, RLS con
clientes autenticados normales, nunca administrador): login/sesión real;
aislamiento RLS de lectura/escritura entre negocios (incluido el intento
adversarial de forzar `business_id` de otro negocio, rechazado con 403);
aislamiento de Storage por carpeta de negocio (subida cruzada rechazada,
lectura cruzada devuelve 404 sin filtrar existencia); idempotencia real
(mismo UUID de movimiento reenviado → 1 sola fila); el escenario crítico
de stock multi-dispositivo −10/−5 → dos filas independientes, suma −15;
sincronización PUSH real desde la app (IndexedDB → cola → Supabase,
confirmado leyendo la tabla remota) incluido el registro real del
dispositivo en `devices`; PULL real hacia un dispositivo con IndexedDB
recién vaciada; propagación real de borrado lógico entre dos dispositivos
(tombstone confirmado en Supabase y el producto borrado nunca revive en
el segundo dispositivo).

**Desconexión de red real y PWA instalada — verificado en dispositivo real:**
probado en una tablet real (Android, Chrome) instalada como PWA desde el
icono de la pantalla de inicio, con el Wi-Fi físicamente desactivado (modo
avión, no un flag interno de la app): con la app ya abierta y sin red, se
crearon un producto nuevo, un movimiento de entrada y uno de salida, y una
incidencia de temperatura; todo se guardó con normalidad y quedó pendiente
de sincronizar. Al reactivar el Wi-Fi, todo llegó a Supabase sin pérdidas
ni duplicados (contrastado contra un recuento antes/después: productos
+1, movimientos +2, incidencias +1 — exactamente lo creado offline).
**VERIFIED_REAL.**

**Dos bugs reales más encontrados y corregidos durante estas pruebas en
dispositivo real** (ninguno relacionado con la desconexión en sí, ambos
rompían el guardado de cualquier registro en cuanto el dispositivo tenía
en IndexedDB algún registro con el campo `fecha` vacío — algo que puede
pasar por datos de prueba, una migración parcial, etc.):
- `reloadAll()` (`js/app.js`) usaba `b.fecha.localeCompare(a.fecha)` sin
  proteger contra `fecha` ausente; como se llama tras cada `put()`, un solo
  registro sin fecha rompía el guardado de CUALQUIER cosa (crear un
  producto se guardaba bien en IndexedDB, pero la pantalla se quedaba
  colgada sin cerrar ni avisar, porque el código posterior nunca se
  ejecutaba). Mismo patrón en el listado de "Historial" y en el listado de
  tareas de mantenimiento (`proximaRealizacion`).
- El panel principal y los informes (`render()`, generación de informes)
  hacían `m.fecha.slice(0,10)` igual de desprotegido, rompiendo la
  pantalla de inicio entera (mensaje "No se pudo iniciar la base de datos
  local", engañoso — el fallo real no era la base de datos sino el
  renderizado posterior).
Corregido en los 8 puntos con `(x.fecha||'')` antes de `.localeCompare`/
`.slice`. Verificado de nuevo en dispositivo real tras el fix: crear
producto, ver panel principal e Historial funcionan con normalidad.

**Bug real encontrado y corregido — last-write-wins NO se aplicaba en el
servidor:** el diseño documentaba "última escritura gana por `updated_at`"
pero eso solo estaba implementado en el *pull* del cliente (`js/sync.js`,
`pullTable()`), nunca en el *push*. Demostrado contra Supabase real: un
dispositivo A sube una edición reciente de un producto; después, un
dispositivo B sincroniza (tarde) una edición que había hecho offline hace
3 días — el `upsert` del servidor, al no comparar fechas, aceptaba sin más
la de B y **sobrescribía la de A**, aunque fuera objetivamente más vieja.
Cualquier tercer dispositivo o instalación nueva que sincronizara en ese
momento se habría quedado con el dato incorrecto — pérdida silenciosa de
datos real, no hipotética.

**Corrección**: trigger `reject_stale_update()` en PostgreSQL, aplicado a
las 16 tablas editables (todas menos `stock_movements`, que nunca se
actualiza — solo se inserta, es un registro de eventos inmutable y ajeno
a este mecanismo). Un `UPDATE` cuyo `updated_at` entrante sea igual o
anterior al que ya hay en la fila se convierte en no-op (se conserva la
fila existente) en vez de sobrescribir — sin romper los reintentos
idempotentes (mismo id + mismo `updated_at` → no-op silencioso, no error).
Reproducido el mismo escenario tras el fix: ahora gana correctamente la
edición más reciente. **VERIFIED_REAL.**

Qué gana y qué se puede perder, documentado explícitamente: gana siempre
el `updated_at` más alto, sea cual sea el orden real en que los cambios
llegan al servidor. Esto significa que una edición offline muy antigua que
finalmente sincroniza **nunca sobrescribirá** una edición más reciente ya
subida — pero también significa que, si dos dispositivos editan el MISMO
registro casi al mismo tiempo, la edición "perdedora" se descarta por
completo (no se fusiona campo a campo); quien pierda esa carrera debe
volver a aplicar su cambio si aún lo necesita. `stock_movements` es la
única entidad exenta de esta pérdida posible, precisamente porque nunca
se resuelve por conflicto: todo movimiento se suma, nunca se sobrescribe.

**Bug real encontrado y corregido — orden de escritura local rompía la
FK `invoice_items_invoice_id_fkey` al sincronizar:** al confirmar una
factura desde la UI real, el código local escribía primero todas las
líneas de factura (`facturaLineas`/`invoice_items`, que referencian
`facturaId`/`invoice_id`) y solo al final el registro de la propia
factura (`facturas`/`invoices`). En local (IndexedDB, sin FK) esto no
daba error, pero al sincronizar a Supabase, `sync_queue` procesa los
elementos en el orden en que se encolaron: los `invoice_items` llegaban
al servidor antes que su `invoices` padre, y PostgREST rechazaba el
insert con `insert or update on table "invoice_items" violates foreign
key constraint "invoice_items_invoice_id_fkey"` — la factura y sus
líneas quedaban en `FAILED` sin sincronizar, y el inventario del
servidor no reflejaba la entrada de mercancía aunque la app local
mostrara "Factura confirmada" sin avisar del problema.

**Corrección**: en `js/app.js`, dentro del confirm handler de
`openFacturaRevisionSheet()`, se movió el `await put('facturas', ...)`
para que se ejecute (y por tanto se encole) ANTES del bucle que crea
las líneas (`facturaLineas`) y sus movimientos de stock asociados, en
vez de después. Reproducido el escenario exacto contra Supabase real:
factura de prueba `FASE8-TEST-001` (antes del fix) quedó con `FAILED` y
el error de FK citado arriba. Tras el fix, una segunda factura de
prueba (`FASE8-TEST-002`, 2 líneas — un producto existente y uno
nuevo) se creó desde la UI real servida en el dispositivo, y se
verificó directamente contra Supabase (autenticado como el usuario de
negocio, no admin): la fila de `invoices` sincronizó correctamente, sus
2 `invoice_items` sincronizaron con `invoice_id` apuntando a esa
factura y `product_id` a los productos correctos (incluido el producto
creado al vuelo desde la línea de factura), y los 2 `stock_movements`
generados sincronizaron con `stockAnterior`/`stockPosterior` correctos
(0→3 y 0→2). Cola de sincronización (`sync_queue`) vacía tras el
proceso — 0 pendientes, 0 fallidos. **VERIFIED_REAL.**

### Despliegue en producción: GitHub Pages

Además del servidor local usado para las primeras pruebas, la app se
publicó en GitHub Pages (`https://<usuario>.github.io/<repo>/`) para poder
probarla desde la tablet en el negocio sin depender de tener el PC
encendido y en la misma red. Es una app 100% estática (HTML/JS/CSS), así
que no requiere build ni servidor propio — solo subir los archivos al
repositorio y activar Pages. `config.js` es seguro de publicar: solo
contiene la URL de Supabase y la "publishable key", pensada para ser
pública (la seguridad real la da RLS). Cada cambio de código debe
resubirse manualmente al repositorio para que se refleje en la URL
pública — no hay despliegue automático configurado.

**Bug real encontrado y corregido — rendimiento a 600+ productos rompía
la sincronización de bajada (pull) de forma permanente:** al sembrar 601
productos reales en Supabase en lotes de 100 (mismo patrón que tendría una
futura importación masiva), se descubrió que Postgres asigna el mismo
`now()` a todas las filas de una misma sentencia `INSERT` — así que 100
productos quedaron con un `updated_at` idéntico. `pullTable()` en
`js/sync.js` bajaba como máximo 500 filas por ciclo (`.limit(500)`, sin
paginar) y usaba `updated_at > cursor` para saber qué faltaba. El corte de
500 cayó en medio de ese grupo de 100 con timestamp idéntico: el cursor
avanzó hasta ese timestamp exacto y, como el filtro era "estrictamente
mayor que", las filas restantes del grupo —y todo lo posterior— dejaban de
bajar **para siempre**. Verificado contra Supabase real: 113 de 601
productos quedaron atascados de forma permanente, sin recuperarse ni
esperando minutos ni recargando. **Corrección**: 1) paginar dentro de la
misma llamada con `.range()` hasta agotar todo lo pendiente en vez de
bajar como mucho 500 por ciclo, y 2) usar `.gte()` en vez de `.gt()`, con
`id` como desempate de orden — reaplicar una fila ya conocida en local es
inofensivo (sobrescribe con los mismos datos), así que ninguna fila con
timestamp empatado en el borde se pierde. Reproducido el mismo escenario
tras el fix: los 601 productos terminan bajando por completo. **VERIFIED_REAL.**

**Bug real encontrado y corregido — 5 tablas nunca podían sincronizar
bajada entre dispositivos:** mientras se investigaba el bug anterior,
apareció en consola un error `400` recurrente para `equipos`,
`proveedores`, `inventariosFisicos`, `checklists` y `tareasMantenimiento`:
`"failed to parse select parameter (id,updated_at,deleted_at,data,)"`. La
causa: estas 5 tablas no añaden columnas propias al `select` de Supabase
(`extra: r => ({})`), y `Object.keys({}).join(',')` da una cadena vacía,
dejando una coma colgando al final del `select` sin nada detrás —
PostgREST rechaza esa sintaxis con `400`. El fallo era silencioso (solo un
`console.warn`), así que un segundo dispositivo llevaba sin poder bajar
NUNCA equipos, proveedores, conteos de inventario, checklists ni tareas de
mantenimiento creados en otro dispositivo — únicamente veía los suyos
propios. Esto explica, en parte, lo que reportaste al probar la tablet en
el negocio. **Corrección**: construir la lista de columnas sin coma
sobrante cuando no hay columnas extra. Reproducido contra Supabase real
tras el fix: las 5 tablas bajan sus datos correctamente (equipos,
proveedores, checklists y tareas de mantenimiento verificados con datos
reales del negocio de prueba). **VERIFIED_REAL.**

**Bug real encontrado y corregido — `pullAll()` sin protección contra
ejecuciones simultáneas:** a diferencia de `processQueue()` (que ya usaba
una bandera `syncing` para no solaparse consigo misma), `pullAll()` no
tenía ninguna protección equivalente — el temporizador periódico y la
llamada a `pullAll()` que hace `processQueue()` tras un push con éxito
podían solaparse. No provocaba pérdida de datos (cada ciclo es idempotente
y se autocorrige en el siguiente), pero sí trabajo duplicado y
escrituras de cursor que se pisaban entre sí innecesariamente — se detectó
al ver que, tras el fix de paginación, 13 productos tardaban un ciclo
extra de más en llegar sin motivo aparente. **Corrección**: misma técnica
de bandera (`pulling`) que ya usa `processQueue()`. **VERIFIED_REAL.**

### "Cerrar sesión" invisible para roles no-administrador

**Bug real encontrado y corregido:** al preparar la matriz de recuperación
se descubrió que la tarjeta "Usuarios y seguridad" de la pestaña "Más" —
que contenía el botón "Cerrar sesión" de la cuenta Supabase — solo se
muestra para el rol ADMINISTRADOR (`PERMISOS_POR_ROL`). Con el rol
habitual del día a día (Encargado o Empleado) no había forma de cerrar
sesión para cambiar de cuenta/negocio, aunque esa acción no tiene nada que
ver con los permisos de gestión del catálogo que sí tiene sentido
restringir. **Corrección**: la cuenta Supabase y "Cerrar sesión" pasan a
su propia tarjeta, siempre visible con Supabase configurado,
independiente del rol local. De paso se corrigió el texto de la tarjeta
"Sincronización", que databa de antes de Fase 6 y seguía diciendo "no hay
sincronización en tiempo real" incluso con la sincronización real activa
y funcionando. **VERIFIED_REAL.**

### Matriz de recuperación de 7 casos

Probados los 7 casos (A: creado offline: B: internet vuelve durante push;
C: internet desaparece a media subida; D: cierre forzado de la app con
pendientes; E: reinicio del navegador; F: reapertura offline; G: internet
vuelve después de D-F) contra la app real publicada en GitHub Pages, con
desconexión de Wi-Fi física y real en una tablet física — nunca una bandera
simulada. A-C, D/E (cubiertos juntos: forzar cierre de la app cubre ambos),
F superados sin incidencias: los datos se crean, persisten y sincronizan
correctamente sin duplicados ni pérdidas en cada uno.

**Bug real encontrado y corregido en el caso G — sincronización sin sesión
válida devolvía error permanente engañoso:** al forzar el cierre de la app
y reabrirla offline, el usuario puede elegir "Seguir sin conectar (solo
local)" en vez de iniciar sesión — diseño correcto, los datos siguen
creándose con normalidad. Pero al recuperar la conexión, la app intentaba
subir esos datos IGUAL, sin sesión válida de Supabase. Reproducido contra
Supabase real: un push sin sesión válida es rechazado con
`401 — new row violates row-level security policy`, un error que el
reintento con backoff nunca iba a resolver solo (no es un fallo de red
temporal, hace falta volver a iniciar sesión) — el registro se quedaba
"pendiente con error" de forma permanente y sin explicación clara.
**Corrección**: `readyToSync()` ahora comprueba que hay una sesión activa
antes de intentar sincronizar; si no la hay, los datos se quedan a salvo
en la cola local sin marcarse con un error falso, hasta que alguien
inicie sesión de nuevo. Reproducido el escenario completo tras el fix:
al volver a iniciar sesión, el registro pendiente sincroniza
correctamente. **VERIFIED_REAL.**

### Bug real #6: el pull periódico no se ejecutaba si el dispositivo no tenía nada propio que subir

Encontrado en la prueba de dos dispositivos físicos simultáneos (tablet +
móvil, ambos como PWA instalada, ambos con la cuenta de pruebas de
Negocio B, con los 608 productos ya sincronizados de antes). Cada
dispositivo creó un producto de prueba (`SYNC-TAB-01` en la tablet,
`SYNC-TEL-01` en el móvil). El móvil, al subir el suyo, terminó viendo
ambos productos (610 en total) porque su propio push exitoso disparó un
`pullAll()`. La tablet se quedó **permanentemente atascada en 609**
(608 + el suyo propio) y nunca bajó el del móvil, incluso con varios
minutos de espera, la app abierta y conexión activa.

**Causa raíz**: el diseño documentado al inicio de `sync.js` dice que el
pull se dispara "al cargar la app, al recuperar conexión, y cada
`SYNC_INTERVAL_MS`" — pero en el código, tanto el listener `'online'`
como el temporizador periódico solo llamaban a `processQueue()`.
`pullAll()` únicamente se ejecutaba *dentro* de `processQueue()` cuando
hubo algo propio que subir con éxito (`if (okCount) await pullAll();`).
Un dispositivo sin cambios locales pendientes en su cola (como la
tablet, tras subir su único producto de prueba) nunca vuelve a tener
`okCount > 0`, así que `pullAll()` deja de ejecutarse para siempre en
ese dispositivo hasta que recargue la app entera — nunca baja cambios
hechos en OTRO dispositivo mientras permanece abierto.

Reproducido de forma aislada contra Supabase real: una consulta idéntica
a la que hace `pullTable('productos', ...)` con el cursor exacto que
tendría la tablet tras su propio push (`updated_at >= '...14:21:48.700Z'`)
devuelve correctamente ambas filas (`SYNC-TAB-01` y `SYNC-TEL-01`),
confirmando que la consulta de pull en sí es correcta — el problema era
exclusivamente que nadie la ejecutaba en el ciclo periódico sin un push
exitoso de por medio.

**Corrección**: se añade una llamada explícita a `pullAll()`, independiente
de `processQueue()`, tanto en el listener `'online'` como en cada tick
del temporizador periódico (`setInterval`), para que el pull ocurra
siempre que haya conexión, tenga o no el dispositivo algo propio que
subir. **VERIFIED_REAL** (query aislada confirmada contra Supabase real;
pendiente reconfirmar en los dos dispositivos físicos tras desplegar
el fix, ver abajo).

**Pendiente de esta fase** (ver el informe entregado en el chat para el
detalle completo con la taxonomía VERIFIED_REAL/BLOCKED/NOT_TESTED):
reconfirmar en los dos dispositivos físicos (tablet + móvil) que, tras
desplegar el fix del bug #6, un producto creado en un dispositivo
aparece en el otro sin necesidad de que este último tenga algo propio
que subir.

## Siguientes pasos recomendados

- Ver `SETUP.md` para desplegar Supabase + la app paso a paso.
- Cuando haya presupuesto para ello: normalizar columna a columna las
  tablas que hoy dependen de `data jsonb`, y mover `invoice_items` /
  `waste_records` a su flujo propio de sincronización.
- Conectar un proveedor real de OCR/IA para la lectura de facturas.
