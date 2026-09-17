# Guía de puesta en marcha — Bitácora de Barra

Esta guía lleva el proyecto desde "archivos descargados" hasta "PWA
instalada y funcionando, con o sin Supabase, en una tablet Xiaomi Redmi Pad
Pro 5G (12,1") u otro dispositivo".

La app **funciona sin hacer nada de lo de abajo**: si `config.js` se deja
con los valores vacíos de fábrica, todo funciona 100% en local con
IndexedDB, igual que el prototipo. Los pasos de Supabase son solo para
tener sincronización en la nube y multi-dispositivo.

---

## 0. Requisitos

- Una cuenta gratuita en [supabase.com](https://supabase.com) (solo si
  quieres sincronización en la nube).
- Node.js en tu ordenador (solo para servir la app en local durante las
  pruebas) o cualquier hosting estático (Vercel, Netlify, GitHub Pages,
  Cloudflare Pages...).
- Un navegador Chrome/Chromium reciente.

---

## 1. Probar en local (sin Supabase)

No hace falta ningún build. Es HTML/CSS/JS plano.

```bash
cd bitacora-barra
python3 -m http.server 8080
# o: npx serve .
```

Abre `http://localhost:8080` en Chrome. La app debe cargar y funcionar
exactamente igual que el prototipo (Dashboard, Inventario, etc.), con el
indicador de sincronización (junto al reloj) mostrando "Solo local".

> Nota sobre el Service Worker: algunos navegadores solo registran
> Service Workers en `https://` o en `http://localhost`. Para probar en tu
> móvil/tablet en la misma red local necesitarás desplegarlo con HTTPS
> (paso 4) o usar una herramienta como `ngrok`/`cloudflared` para exponer
> `localhost` con HTTPS temporalmente.

---

## 2. Crear el proyecto en Supabase

1. Entra en [supabase.com](https://supabase.com) → **New project**.
2. Elige nombre, contraseña de base de datos (guárdala) y región (la más
   cercana a tu bar).
3. Espera a que el proyecto termine de aprovisionarse (1-2 minutos).

### 2.1. Ejecutar el esquema

1. En el panel de Supabase, abre **SQL Editor** → **New query**.
2. Copia y pega **todo** el contenido de `supabase/schema.sql`.
3. Pulsa **Run**. Debe terminar sin errores y crear todas las tablas,
   políticas de RLS y el bucket de almacenamiento `attachments`.

### 2.2. Obtener la URL y la clave pública (anon key)

1. **Project Settings** (icono de engranaje) → **API**.
2. Copia:
   - **Project URL** → algo como `https://xxxxx.supabase.co`
   - **anon public key** (la clave larga que empieza por `eyJ...`)
3. **Importante**: nunca copies la `service_role key` a ningún archivo de
   este proyecto — esa clave tiene acceso total y se salta RLS.

### 2.3. Rellenar `config.js`

Edita `config.js` (si no existe, cópialo de `config.example.js`):

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...tu-clave-anon...',
  APP_NAME: 'Bitácora de Barra',
  SYNC_INTERVAL_MS: 60000,
};
```

### 2.4. Primer negocio y primer usuario administrador

El esquema no crea negocios ni usuarios automáticamente (cada bar es un
negocio distinto). Para dar de alta el primero:

1. **Authentication** → **Users** → **Add user** → crea el usuario con
   email y contraseña (el que usará como administrador).
2. **SQL Editor** → ejecuta (sustituyendo el email y el nombre del bar):

   ```sql
   -- 1) Crear el negocio
   insert into businesses (name) values ('Mi Bar') returning id;
   -- Copia el "id" que devuelve esta consulta ↓

   -- 2) Vincular el usuario al negocio como administrador
   insert into profiles (id, business_id, role, display_name)
   select u.id, '<PEGA-AQUI-EL-ID-DEL-NEGOCIO>', 'ADMINISTRADOR', 'Nombre del admin'
   from auth.users u
   where u.email = 'admin@tubar.com';
   ```

3. A partir de aquí, cualquier otro usuario que quieras dar de alta para
   ese mismo negocio sigue el mismo patrón (paso 1 de Authentication +
   este `insert into profiles` con el mismo `business_id` y el rol que
   corresponda: `ADMINISTRADOR`, `ENCARGADO` o `EMPLEADO`).

---

## 3. Probar la sincronización

1. Sirve la app en local (paso 1) con `config.js` ya relleno.
2. Al abrir la app debería aparecer una pantalla de **Iniciar sesión**
   (con opción "Seguir sin conectar" si quieres seguir en modo solo
   local). Entra con el email/contraseña del administrador creado arriba.
3. El indicador junto al reloj debe pasar de "Conectando…" a
   "Sincronizado".
4. Crea o edita algo (por ejemplo, un producto). En **Table Editor** de
   Supabase, comprueba que aparece la fila correspondiente en la tabla
   `products` (con tu `business_id`).
5. Prueba el caso offline: desconecta el wifi/datos, sigue trabajando en
   la app (debe funcionar exactamente igual), vuelve a conectar y observa
   que el indicador pasa a "Reconectado — sincronizando…" y de vuelta a
   "Sincronizado".

---

## 4. Desplegar en producción (HTTPS obligatorio para PWA instalable)

Cualquier hosting estático vale. Dos opciones rápidas:

### Opción A — Vercel

```bash
npm i -g vercel
cd bitacora-barra
vercel deploy --prod
```

### Opción B — Netlify

```bash
npm i -g netlify-cli
cd bitacora-barra
netlify deploy --prod
```

En ambos casos no hace falta configurar ningún build (`Build command`
vacío, `Publish directory` = la raíz del proyecto).

**No subas `config.js` con tus claves reales a un repositorio público.**
Si usas GitHub, añade `config.js` a `.gitignore` y sube solo
`config.example.js`; configura `config.js` directamente en el hosting (o
generándolo en el propio pipeline de despliegue a partir de variables de
entorno del proveedor).

---

## 5. Instalar como app en la Xiaomi Redmi Pad Pro 5G (12,1")

1. Abre **Chrome** en la tablet y navega a la URL de tu despliegue
   (`https://tu-app.vercel.app`, por ejemplo).
2. Espera unos segundos a que cargue del todo la primera vez (así el
   Service Worker termina de cachear el *shell* de la app).
3. Toca el menú de Chrome (⋮) → **Añadir a pantalla de inicio** / **Instalar
   aplicación** (Chrome suele ofrecerlo también como un banner/icono en la
   barra de direcciones).
4. Confirma. Aparecerá un icono de "Bitácora de Barra" en el escritorio,
   con su propio icono (el mismo que `icons/icon-512.png`).
5. Ábrelo desde ese icono: debe abrir **en modo standalone** (sin la barra
   de direcciones de Chrome), como una app nativa.
6. Prueba a activar el modo avión: la app debe seguir abriendo y
   funcionando con los datos ya guardados localmente. Al desactivar el
   modo avión, debe volver a sincronizar sola.

Esto mismo funciona igual en otras tablets/móviles Android, en Chrome de
escritorio (Windows/macOS/Linux) y en iPadOS/iOS vía Safari → *Compartir* →
*Añadir a pantalla de inicio* (con alguna limitación conocida de Apple en
Service Workers, pero el modo offline básico funciona igual).

---

## 6. Migrar los datos del prototipo (Artifact) anterior

Ver `README.md` → sección "Migrar los datos del prototipo (Artifact) a
esta app" — se hace con el export/import de copia de seguridad que ya
existía en la app, sin pasos nuevos.

---

## 7. Resolución de problemas

- **El indicador de sincronización se queda en "Sin negocio vinculado"**:
  el usuario ha iniciado sesión pero no tiene fila en `profiles` para ese
  `business_id` — repite el paso 2.4.
- **El Service Worker no se registra**: comprueba que estás sirviendo por
  HTTPS (o `localhost`) y mira la consola del navegador — `sw.js` avisa
  con `console.warn` si el registro falla, nunca rompe la app.
- **Cambié algo en Supabase (RLS, columnas) y la sincronización falla**:
  revisa la consola — `sync.js` deja avisos con `console.warn('[sync] ...')`
  con el mensaje de error exacto de Supabase para cada fila que falle.
- **Quiero forzar una re-sincronización completa**: en el navegador, borra
  el `IndexedDB` de la app (DevTools → Application → IndexedDB → eliminar
  `bitacora_barra_db`) — la próxima carga volverá a bajar todo desde
  Supabase desde cero. (Esto borra también lo que hubiera solo en local sin
  sincronizar, así que hazlo solo si estás seguro.)
