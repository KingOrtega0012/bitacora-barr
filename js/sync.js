/**
 * sync.js — Cola de sincronización offline-first ⇄ Supabase
 * =========================================================================
 * DISEÑO (v1, documentado a propósito — ver README.md "Estrategia de
 * sincronización" para el razonamiento completo):
 *
 *  - Cada tabla en Supabase tiene columnas relacionales mínimas para RLS
 *    y para los JOIN que de verdad se necesitan (business_id, y FKs como
 *    product_id / equipment_id / checklist_id donde aporta integridad
 *    real), MÁS una columna `data jsonb` que guarda el registro completo
 *    tal cual vive en IndexedDB (mismos nombres de campo en español que
 *    ya usa app.js). Esto evita traducir a mano decenas de columnas por
 *    cada una de las 11 entidades sincronizables mientras el modelo de
 *    datos SQL termina de asentarse — normalizar columna a columna es un
 *    paso natural posterior, no un requisito para que la sync funcione.
 *  - PUSH: cada escritura local (put/del en app.js) ya deja una fila en
 *    el store IndexedDB `sync_queue` con estado PENDING. processQueue()
 *    la drena hacia Supabase con upsert (o "borrado lógico" con
 *    deleted_at para los delete, nunca un DELETE físico — así el
 *    tombstone se puede propagar a otros dispositivos).
 *  - PULL: por cada tabla, se piden las filas con updated_at posterior al
 *    último cursor guardado (config.lastSyncAt:<tabla>) y se aplican en
 *    local. Si el registro local tiene un updated_at MÁS reciente que el
 *    que llega (p. ej. se editó offline y aún no se ha podido subir), se
 *    descarta el remoto: gana el cambio local más nuevo (last-write-wins
 *    por campo `updated_at`). Los movimientos de stock nunca "ganan" ni
 *    "pierden": son eventos inmutables, se acumulan sin más.
 *  - Dispara: al cargar la app, al recuperar conexión (evento 'online'),
 *    y cada APP_CONFIG.SYNC_INTERVAL_MS mientras haya conexión.
 * =========================================================================
 */
(function(){

  const TABLE_MAP = {
    productos:           { table:'products',            extra: r => ({ sku: r.codigoBarras || null }) },
    movimientos:         { table:'stock_movements',      extra: r => ({ product_id: r.productoId || null, type: r.tipo || null }) },
    equipos:              { table:'equipment',            extra: r => ({}) },
    temperaturas:        { table:'temperature_records',  extra: r => ({ equipment_id: r.equipoId || null, out_of_range: !!r.fueraDeRango }) },
    proveedores:         { table:'suppliers',             extra: r => ({}) },
    facturas:            { table:'invoices',              extra: r => ({ supplier_id: r.proveedorId || null }) },
    inventariosFisicos:  { table:'inventory_counts',      extra: r => ({}) },
    checklists:          { table:'checklists',            extra: r => ({}) },
    checklistRegistros:  { table:'checklist_records',     extra: r => ({ checklist_id: r.checklistId || null }) },
    tareasMantenimiento: { table:'tasks',                 extra: r => ({}) },
    incidencias:         { table:'incidents',             extra: r => ({ status: r.estado || null, priority: r.prioridad || null }) },
    /* Fase 6G/6H: invoice_items y waste_records dejan de ser un hueco —
       'facturaLineas'/'mermaRegistros' (ver js/app.js) son entidades
       propias con su propio id estable, así que sincronizan exactamente
       igual que el resto (upsert idempotente por id). */
    facturaLineas:       { table:'invoice_items',        extra: r => ({ invoice_id: r.facturaId || null, product_id: r.productoId || null }) },
    mermaRegistros:      { table:'waste_records',        extra: r => ({ product_id: r.productoId || null, reason: r.motivo || null }) },
    /* Fase 6I: 'adjuntos' recibe trato especial en processQueue() — antes
       de hacer upsert de la fila, se sube el binario a Supabase Storage y
       se guarda la ruta resultante en `storage_path`. */
    adjuntos:            { table:'attachments',          extra: r => ({ entity_table: r.entidadTipo || null, entity_id: r.entidadId || null }) },
  };

  /* Backoff exponencial para reintentos fallidos: 1er reintento ~10s,
     doblando hasta un tope de 30 min, para no machacar Supabase con un
     bucle agresivo si hay un error persistente (RLS, red inestable, etc.). */
  function backoffMs(intentos){
    return Math.min(10000 * Math.pow(2, Math.max(0, intentos - 1)), 30 * 60000);
  }

  let syncing = false;
  let intervalHandle = null;

  function setStatus(text, cls){
    const el = document.getElementById('syncStatus');
    if(!el) return;
    el.textContent = text;
    el.className = 'sync-badge ' + (cls||'');
  }

  async function getBusinessId(){
    try{
      const row = await getOne('config', 'businessId');
      return row ? row.value : null;
    }catch(e){ return null; }
  }

  /* Bug real encontrado en Fase 8 (matriz de recuperación, caso D→G): si se
     pierde la sesión de Supabase — p.ej. se fuerza el cierre de la app y,
     al reabrir sin conexión, se elige "Seguir sin conectar (solo local)" —
     la app seguía creando datos localmente sin problema (correcto), pero
     al recuperar la conexión intentaba subirlos IGUAL, sin sesión válida.
     Supabase los rechazaba con RLS: 401 "new row violates row-level
     security policy". No es un fallo de red temporal que el reintento con
     backoff vaya a resolver solo — hace falta volver a iniciar sesión — así
     que el registro se quedaba en un "pendiente con error" permanente y
     confuso (el mensaje no decía que hacía falta reconectar la cuenta).
     Reproducido contra Supabase real: un push sin sesión válida devuelve
     exactamente ese error 401/42501. Corrección: comprobar que hay una
     sesión activa antes de intentar sincronizar — si no la hay, la app se
     queda en modo local (los datos siguen a salvo y se quedan en la cola
     tal cual, sin marcarlos con un error falso) hasta que alguien vuelva a
     iniciar sesión explícitamente. */
  async function readyToSync(){
    if (!(window.SB && window.SB.isConfigured && navigator.onLine)) return false;
    try { return !!(await SB.getSession()); } catch(e) { return false; }
  }

  /* -------------------- ENCOLAR -------------------- */
  /* Contador monótono para poder ordenar sync_queue de forma fiable. Es
     necesario porque el object store 'sync_queue' usa keyPath:'id' con un
     UUID aleatorio (el id de la propia entrada de cola, no el del
     registro) — IndexedDB getAll() devuelve las filas ordenadas por esa
     clave, NO por orden de inserción. Sin esto, si un mismo registro se
     crea, edita y borra offline en la misma sesión, el orden en que esas
     tres operaciones llegan a Supabase sería el del UUID (esencialmente
     aleatorio), pudiendo aplicar el borrado antes que la creación y
     "resucitar" un registro que el usuario eliminó. `seq` combina el
     timestamp con un contador incremental para garantizar orden estricto
     incluso si dos put() ocurren en el mismo milisegundo. */
  let _syncSeqCounter = 0;
  function nextSeq(){ return Date.now() * 1000 + (_syncSeqCounter++ % 1000); }

  async function enqueue(store, op, payload){
    const entry = {
      id: uid(),
      seq: nextSeq(),
      store, op, payload,
      estado: 'PENDING',
      intentos: 0,
      creado: nowISO(),
    };
    await rawPut('sync_queue', entry);
    if (await readyToSync()) processQueue(); // intento inmediato, no bloqueante
    return entry;
  }

  /* -------------------- PUSH -------------------- */
  /* Idempotencia: el id de cada entrada de sync_queue es SIEMPRE el id del
     propio registro local (generado una sola vez con uid() en app.js, no
     al encolar). Reintentar una entrada no genera un id nuevo, así que
     upsert(..., {onConflict:'id'}) siempre sobrescribe la MISMA fila en
     vez de duplicarla — repetir el push tantas veces como haga falta es
     seguro. Los movimientos de stock (tabla stock_movements) son la
     prueba de fuego: dos dispositivos offline que registran cada uno su
     propia salida generan dos ids distintos → dos filas distintas → se
     SUMAN al llegar a Supabase, nunca se pisan entre sí (no hay ningún
     UPDATE de cantidad en esta tabla, solo upsert por id propio). */
  async function processQueue(){
    if (syncing || !(await readyToSync())) return;
    syncing = true;
    setStatus('Sincronizando…', 'busy');
    try{
      const businessId = await getBusinessId();
      if (!businessId){ setStatus('Sin negocio vinculado', 'warn'); return; }

      const now = nowISO();
      const all = await getAll('sync_queue');
      const pending = all.filter(e =>
        e.estado==='PENDING' ||
        (e.estado==='FAILED' && e.intentos < 8 && (!e.nextAttemptAt || e.nextAttemptAt <= now))
      );
      // Orden de creación real (ver nextSeq()), no el orden por id de IndexedDB.
      pending.sort((a,b) => (a.seq||0) - (b.seq||0));
      let okCount = 0, failCount = 0;

      for (const entry of pending) {
        entry.estado = 'SYNCING';
        await rawPut('sync_queue', entry);
        const map = TABLE_MAP[entry.store];
        if (!map) { await rawDelete('sync_queue', entry.id); continue; } // store no sincronizable colado por error

        try {
          if (entry.op === 'delete') {
            const { error } = await SB.client.from(map.table)
              .update({ deleted_at: entry.payload.deleted_at, updated_at: entry.payload.updated_at })
              .eq('id', entry.payload.id).eq('business_id', businessId);
            if (error) throw error;
          } else if (entry.store === 'adjuntos') {
            await pushAdjunto(entry, map, businessId);
          } else {
            const row = {
              id: entry.payload.id,
              business_id: businessId,
              updated_at: entry.payload.updated_at,
              deleted_at: null,
              data: stripInternal(entry.payload),
              ...map.extra(entry.payload),
            };
            const { error } = await SB.client.from(map.table).upsert(row, { onConflict: 'id' });
            if (error) throw error;
          }
          await rawDelete('sync_queue', entry.id);
          okCount++;
        } catch (err) {
          console.warn('[sync] fallo al subir', entry.store, entry.op, err.message||err);
          entry.estado = 'FAILED';
          entry.intentos = (entry.intentos||0) + 1;
          entry.ultimoError = String(err.message||err);
          entry.nextAttemptAt = new Date(Date.now() + backoffMs(entry.intentos)).toISOString();
          await rawPut('sync_queue', entry);
          failCount++;
        }
      }
      setStatus(failCount ? `${failCount} pendiente(s) con error` : 'Sincronizado', failCount ? 'warn' : 'ok');
      if (okCount) await pullAll(); // tras subir, bajamos por si hay más cambios de otros dispositivos
    } finally {
      syncing = false;
    }
  }
  function stripInternal(rec){
    const { device_id, updated_at, _prev, dataUrl, ...rest } = rec;
    return rest;
  }

  /* -------------------- ADJUNTOS → Supabase Storage (Fase 6I) --------------------
     Flujo: captura (app.js, dataUrl en base64) → guardado local en
     IndexedDB (ya "hecho", no depende de red) → esta función, cuando hay
     conexión, sube el binario al bucket "attachments" bajo
     <business_id>/<entidadTipo>/<id>.<ext> y guarda la fila en la tabla
     `attachments` con `storage_path` (nunca con el base64 dentro, para no
     hinchar la tabla) → si algo fallara, la entrada de sync_queue queda
     FAILED/pendiente de reintento igual que cualquier otro push, así que
     la foto nunca se pierde: sigue en IndexedDB hasta que la subida
     tenga éxito. */
  async function pushAdjunto(entry, map, businessId){
    const rec = entry.payload;
    let storagePath = rec.storagePath || null;
    if (rec.dataUrl && !storagePath) {
      const blob = await (await fetch(rec.dataUrl)).blob();
      const ext = (rec.contentType||'image/jpeg').split('/')[1] || 'jpg';
      storagePath = `${businessId}/${rec.entidadTipo||'otros'}/${rec.id}.${ext}`;
      const { error: upErr } = await SB.client.storage.from('attachments')
        .upload(storagePath, blob, { upsert: true, contentType: rec.contentType||'image/jpeg' });
      if (upErr) throw upErr;
      // Guardamos la ruta en local (sin re-encolar) para no volver a subir el binario si se reintenta el push.
      await rawPut('adjuntos', { ...rec, storagePath });
    }
    const row = {
      id: rec.id,
      business_id: businessId,
      updated_at: rec.updated_at,
      deleted_at: null,
      storage_path: storagePath,
      content_type: rec.contentType || null,
      data: { fecha: rec.fecha },
      ...map.extra(rec),
    };
    const { error } = await SB.client.from(map.table).upsert(row, { onConflict: 'id' });
    if (error) throw error;
  }

  /* -------------------- PULL -------------------- */
  /* Bug real encontrado en Fase 8: a diferencia de processQueue() (que usa
     la bandera `syncing` para no solaparse consigo misma), pullAll() no
     tenía ninguna protección contra ejecuciones simultáneas — el temporizador
     periódico y la llamada a pullAll() que hace processQueue() tras un push
     con éxito podían solaparse. No perdía datos (cada ciclo es idempotente
     y se autocorrige en el siguiente), pero sí generaba trabajo duplicado y
     escrituras de cursor que se pisaban entre sí innecesariamente. Se cierra
     con la misma técnica de bandera que ya usa processQueue(). */
  let pulling = false;
  async function pullAll(){
    if (pulling || !(await readyToSync())) return;
    pulling = true;
    try {
      const businessId = await getBusinessId();
      if (!businessId) return;
      for (const store of Object.keys(TABLE_MAP)) {
        await pullTable(store, businessId).catch(err => console.warn('[sync] fallo al bajar', store, err.message||err));
      }
    } finally {
      pulling = false;
    }
  }
  async function pullTable(store, businessId){
    const map = TABLE_MAP[store];
    const cursorKey = 'lastSyncAt:' + store;
    const cursorRow = await getOne('config', cursorKey);
    const since = cursorRow ? cursorRow.value : '1970-01-01T00:00:00.000Z';
    const isAdjuntos = store === 'adjuntos';
    /* Bug real encontrado en Fase 8 (visible en consola al probar con datos
       reales de equipos/neveras): para las tablas cuyo `extra()` no añade
       ninguna columna propia (equipos, proveedores, inventariosFisicos,
       checklists, tareasMantenimiento), `Object.keys({}).join(',')` da una
       cadena VACÍA, y el select quedaba como
       'id,updated_at,deleted_at,data,' — con una coma colgando al final sin
       nada detrás. PostgREST rechaza eso con 400 "failed to parse select
       parameter", así que el PULL de esas 5 tablas fallaba silenciosamente
       en cada ciclo (solo un console.warn) desde que se añadieron: un
       segundo dispositivo nunca podía bajar equipos, proveedores, conteos
       de inventario, checklists ni tareas de mantenimiento creados en otro
       dispositivo. Reproducido en consola real contra el proyecto de
       Supabase real. Corrección: construir la lista de columnas sin coma
       sobrante cuando no hay columnas extra. */
    const extraKeys = isAdjuntos ? ['storage_path','content_type'] : Object.keys(map.extra({}));
    const selectCols = ['id','updated_at','deleted_at','data', ...extraKeys].join(',');

    /* Bug real encontrado en Fase 8 (prueba de rendimiento con 600+ productos
       insertados en el mismo lote): varias filas insertadas en una misma
       sentencia SQL comparten idéntico `updated_at` (now() es constante
       dentro de una transacción en Postgres — puede pasar con cualquier alta
       masiva real, no solo con datos de prueba). Con `.gt('updated_at',
       since)` + `.limit(500)` SIN paginar, si el corte de 500 caía en medio
       de un grupo de filas con timestamp idéntico, el cursor avanzaba hasta
       ese timestamp exacto y las filas restantes de ese grupo —y todo lo que
       llegara después— dejaban de bajar PARA SIEMPRE (el filtro "> since"
       nunca vuelve a ser cierto para ese timestamp). Demostrado contra
       Supabase real: de 601 productos, 113 quedaron permanentemente
       atascados y el cursor no avanzaba más.
       Corrección: 1) paginar dentro de la misma llamada con `.range()` hasta
       agotar todo lo pendiente, en vez de bajar como mucho 500 por ciclo, y
       2) usar `.gte()` en vez de `.gt()`, con `id` como desempate de orden —
       reaplicar una fila con el mismo timestamp que ya se tiene en local es
       inofensivo (putFromRemote sobrescribe con los mismos datos), así que
       ninguna fila con timestamp empatado en el borde se pierde. */
    let data = [];
    let offset = 0;
    const PAGE = 500;
    while (true) {
      const { data: page, error } = await SB.client
        .from(map.table)
        .select(selectCols)
        .eq('business_id', businessId)
        .gte('updated_at', since)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!page || !page.length) break;
      data = data.concat(page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    if (!data.length) return;

    let maxSeen = since;
    for (const row of data) {
      if (row.updated_at > maxSeen) maxSeen = row.updated_at;
      const local = await getOne(store, row.id).catch(()=>null);
      if (local && local.updated_at && local.updated_at > row.updated_at) {
        continue; // el cambio local es más nuevo (aún no subido) → gana local
      }
      if (row.deleted_at) {
        await deleteFromRemote(store, row.id);
      } else if (isAdjuntos) {
        /* No se re-descarga el binario automáticamente al bajar (eso
           requeriría una URL firmada por adjunto) — se guarda la
           referencia (storage_path) para que una futura pantalla de
           "ver adjuntos de otro dispositivo" pueda pedirla bajo demanda.
           dataUrl se deja null: la foto original solo vive en base64 en
           el dispositivo donde se capturó, y en Storage para todos. */
        await putFromRemote(store, { id: row.id, updated_at: row.updated_at, storagePath: row.storage_path,
          contentType: row.content_type, dataUrl: local ? local.dataUrl : null });
      } else {
        await putFromRemote(store, { ...row.data, id: row.id, updated_at: row.updated_at });
      }
    }
    await rawPut('config', { key: cursorKey, value: maxSeen });
    if (typeof reloadAll === 'function') await reloadAll();
    if (typeof render === 'function') render();
  }

  /* -------------------- AUTENTICACIÓN (Supabase Auth) -------------------- */
  async function resolveBusinessId(session){
    if (!session) return;
    const { data, error } = await SB.client.from('profiles')
      .select('business_id, role, display_name').eq('id', session.user.id).single();
    if (!error && data) {
      await rawPut('config', { key:'businessId', value:data.business_id });
      await rawPut('config', { key:'authProfile', value:{ email: session.user.email, role:data.role, displayName:data.display_name } });
    } else {
      console.warn('[sync] la sesión no tiene fila en profiles — pide al administrador que te dé de alta en el establecimiento.');
    }
  }
  function showLoginOverlay(onDone){
    const root = document.getElementById('modalRoot');
    const overlay = document.createElement('div'); overlay.className='overlay'; overlay.id='authOverlay';
    overlay.style.alignItems='center';
    overlay.innerHTML = `<div class="sheet" style="border-radius:20px;max-width:360px;padding:26px 22px">
      <h3 style="font-size:18px;text-align:center">Iniciar sesión</h3>
      <div class="tiny" style="text-align:center;margin:6px 0 16px">Cuenta de tu establecimiento en Supabase</div>
      <div class="form-stack">
        <div class="field"><label>Email</label><input id="auth_email" type="email" autocomplete="username"></div>
        <div class="field"><label>Contraseña</label><input id="auth_pass" type="password" autocomplete="current-password"></div>
        <div id="auth_err" class="tiny" style="color:var(--crit);min-height:16px"></div>
        <button class="btn btn-primary btn-block" id="auth_go">Entrar</button>
        <button class="btn btn-outline btn-block" id="auth_skip">Seguir sin conectar (solo local)</button>
      </div>
    </div>`;
    root.appendChild(overlay);
    overlay.querySelector('#auth_go').addEventListener('click', async ()=>{
      const email = overlay.querySelector('#auth_email').value.trim();
      const pass = overlay.querySelector('#auth_pass').value;
      try{
        await SB.signInWithPassword(email, pass);
        overlay.remove();
        onDone();
      }catch(err){
        overlay.querySelector('#auth_err').textContent = 'No se pudo iniciar sesión: ' + (err.message||err);
      }
    });
    overlay.querySelector('#auth_skip').addEventListener('click', ()=>{ overlay.remove(); onDone(); });
  }
  async function ensureAuth(){
    if (!window.SB || !window.SB.isConfigured) return;
    const session = await SB.getSession();
    if (session) { await resolveBusinessId(session); return; }
    await new Promise(resolve => showLoginOverlay(async ()=>{ const s = await SB.getSession(); if (s) await resolveBusinessId(s); resolve(); }));
  }
  async function signOut(){
    await SB.signOut();
    await rawPut('config', { key:'businessId', value:null });
    await rawPut('config', { key:'authProfile', value:null });
    location.reload();
  }

  /* -------------------- DISPOSITIVO (Fase 6D) --------------------
     Registro de trazabilidad: qué tablet/dispositivo sincronizó qué
     negocio y cuándo (tabla `devices`). Es informativo/auditoría —
     nunca bloquea la sincronización de datos si falla. */
  async function registerDevice(businessId){
    try{
      const deviceId = (typeof STATE!=='undefined' && STATE.deviceId) || getDeviceIdSafe();
      if (!deviceId) return;
      const session = await SB.getSession();
      const { error } = await SB.client.from('devices').upsert({
        business_id: businessId,
        device_id: deviceId,
        user_id: session ? session.user.id : null,
        app_version: (window.APP_CONFIG && window.APP_CONFIG.APP_VERSION) || '1.0.0',
        last_sync_at: nowISO(),
        updated_at: nowISO(),
      }, { onConflict: 'business_id,device_id' });
      if (error) console.warn('[sync] no se pudo registrar el dispositivo', error.message||error);
    }catch(err){ console.warn('[sync] registerDevice falló', err.message||err); }
  }

  /* -------------------- ARRANQUE -------------------- */
  /* Bug real encontrado en Fase 8 (prueba de dos dispositivos físicos
     simultáneos): el diseño documentado arriba dice que el pull se
     dispara "al cargar la app, al recuperar conexión, y cada
     SYNC_INTERVAL_MS" — pero en el código, tanto el listener 'online'
     como el temporizador periódico solo llamaban a processQueue(), y
     pullAll() únicamente se ejecutaba DENTRO de processQueue() si hubo
     algo propio que subir con éxito (`if (okCount) await pullAll();`).
     Un dispositivo sin cambios locales pendientes (p. ej. la tablet,
     tras subir su propio producto de prueba) nunca vuelve a tener
     okCount>0, así que pullAll() deja de ejecutarse para siempre en ese
     dispositivo hasta que recargue la app — nunca baja cambios hechos
     en OTRO dispositivo.
     Reproducido con datos reales: tablet y teléfono con la cuenta de
     pruebas B, cada uno crea un producto nuevo (SYNC-TAB-01 en la
     tablet, SYNC-TEL-01 en el teléfono). El teléfono sí ve ambos
     (porque su propio push disparó un pullAll() que trajo el de la
     tablet), pero la tablet se queda atascada en 609 productos (608 +
     el suyo) y nunca baja el del teléfono (610), incluso esperando
     varios minutos con la app abierta y con conexión activa.
     Corrección: llamar a pullAll() de forma independiente en el
     listener 'online' y en cada tick del temporizador, no solo como
     efecto secundario de un push exitoso. */
  async function start(){
    window.addEventListener('online', () => {
      setStatus('Reconectado — sincronizando…','busy');
      processQueue();
      pullAll();
    });
    window.addEventListener('offline', () => setStatus('Sin conexión — trabajando en local', 'offline'));

    if (!window.SB || !window.SB.isConfigured) {
      setStatus('Solo local (Supabase no configurado)', 'offline');
      return;
    }
    await ensureAuth();
    setStatus(navigator.onLine ? 'Conectando…' : 'Sin conexión — trabajando en local', navigator.onLine ? 'busy':'offline');
    const businessId = await getBusinessId();
    if (businessId) await registerDevice(businessId);
    await pullAll();
    processQueue();
    const interval = (window.APP_CONFIG && window.APP_CONFIG.SYNC_INTERVAL_MS) || 60000;
    intervalHandle = setInterval(async () => {
      if (await readyToSync()) {
        processQueue();
        pullAll();
        getBusinessId().then(id => id && registerDevice(id));
      }
    }, interval);
  }

  window.SyncQueue = { enqueue, processQueue, pullAll, start, setStatus, signOut, ensureAuth };
})();
