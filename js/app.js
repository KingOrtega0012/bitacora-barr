
/* =========================================================================
   BITÁCORA DE BARRA — App funcional de gestión de operaciones de bar
   Fase 1 MVP: Dashboard, Productos, Inventario, Entradas, Salidas, Mermas,
   Temperaturas, Historial. Persistencia 100% local vía IndexedDB.
   ========================================================================= */

/* ---------------------------------------------------------------------
   1. CAPA DE DATOS — IndexedDB
   Decisión: IndexedDB (no localStorage) porque necesitamos varias
   tablas relacionadas con índices y consultas, y volumen de datos que
   localStorage no soporta bien. Cada cambio de stock se registra SIEMPRE
   como fila en "movimientos" — nunca se sobreescribe stockActual sin
   dejar rastro (trazabilidad total, requisito fundamental).
   --------------------------------------------------------------------- */
const DB_NAME = 'bitacora_barra_db';
const DB_VERSION = 6;
let db;

/* Stores que se sincronizan con Supabase (mapean 1:1 a tablas de Postgres,
   ver supabase/schema.sql). 'config' y 'sync_queue' son puramente locales
   y nunca se sincronizan. */
/* 'usuarios' queda FUERA a propósito: hoy es una lista local de PIN por
   rol, con identidad propia (uid() local) que no coincide con auth.users
   de Supabase. Mezclarla con la tabla `profiles` (que exige id = usuario
   de Supabase Auth) daría usuarios fantasma. Migrar "usuarios" a Supabase
   Auth real es un paso deliberadamente separado — ver README.md. */
/* Fase 6: 'facturaLineas' (→ invoice_items), 'mermaRegistros'
   (→ waste_records) y 'adjuntos' (→ attachments) pasan a ser entidades
   propias y sincronizables, en vez de vivir solo embebidas dentro de
   'facturas'/'movimientos'. Ver registrarAdjunto() y js/sync.js. */
const SYNCABLE_STORES = new Set([
  'productos','movimientos','equipos','temperaturas','proveedores','facturas',
  'inventariosFisicos','checklists','checklistRegistros','tareasMantenimiento',
  'incidencias','facturaLineas','mermaRegistros','adjuntos'
]);

function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const d = e.target.result;
      if(!d.objectStoreNames.contains('productos')){
        const s = d.createObjectStore('productos',{keyPath:'id'});
        s.createIndex('nombre','nombre');
        s.createIndex('categoria','categoria');
        s.createIndex('codigoBarras','codigoBarras');
      }
      if(!d.objectStoreNames.contains('movimientos')){
        const s = d.createObjectStore('movimientos',{keyPath:'id'});
        s.createIndex('productoId','productoId');
        s.createIndex('fecha','fecha');
        s.createIndex('tipo','tipo');
      }
      if(!d.objectStoreNames.contains('equipos')){
        d.createObjectStore('equipos',{keyPath:'id'});
      }
      if(!d.objectStoreNames.contains('temperaturas')){
        const s = d.createObjectStore('temperaturas',{keyPath:'id'});
        s.createIndex('equipoId','equipoId');
        s.createIndex('fecha','fecha');
      }
      if(!d.objectStoreNames.contains('config')){
        d.createObjectStore('config',{keyPath:'key'});
      }
      /* Fase 2 */
      if(!d.objectStoreNames.contains('proveedores')){
        const s = d.createObjectStore('proveedores',{keyPath:'id'});
        s.createIndex('nombre','nombre');
      }
      if(!d.objectStoreNames.contains('facturas')){
        const s = d.createObjectStore('facturas',{keyPath:'id'});
        s.createIndex('proveedorId','proveedorId');
        s.createIndex('fecha','fecha');
      }
      if(!d.objectStoreNames.contains('inventariosFisicos')){
        const s = d.createObjectStore('inventariosFisicos',{keyPath:'id'});
        s.createIndex('fecha','fecha');
      }
      /* Fase 3 */
      if(!d.objectStoreNames.contains('checklists')){
        d.createObjectStore('checklists',{keyPath:'id'});
      }
      if(!d.objectStoreNames.contains('checklistRegistros')){
        const s = d.createObjectStore('checklistRegistros',{keyPath:'id'});
        s.createIndex('checklistId','checklistId');
        s.createIndex('fecha','fecha');
      }
      if(!d.objectStoreNames.contains('tareasMantenimiento')){
        d.createObjectStore('tareasMantenimiento',{keyPath:'id'});
      }
      if(!d.objectStoreNames.contains('incidencias')){
        const s = d.createObjectStore('incidencias',{keyPath:'id'});
        s.createIndex('estado','estado');
        s.createIndex('fecha','fecha');
      }
      /* Fase 4 */
      if(!d.objectStoreNames.contains('usuarios')){
        d.createObjectStore('usuarios',{keyPath:'id'});
      }
      /* Fase 5 — sincronización (ver js/sync.js) */
      if(!d.objectStoreNames.contains('sync_queue')){
        const s = d.createObjectStore('sync_queue',{keyPath:'id'});
        s.createIndex('estado','estado');
        s.createIndex('store','store');
      }
      /* Fase 6 — líneas de factura, mermas y adjuntos como entidades
         propias (auditoría 6G/6H/6I). No sustituyen a 'facturas'/
         'movimientos' (que se conservan tal cual para no romper nada
         existente); son un registro adicional para trazabilidad y
         sincronización fina factura→línea, merma→movimiento, foto→Storage. */
      if(!d.objectStoreNames.contains('facturaLineas')){
        const s = d.createObjectStore('facturaLineas',{keyPath:'id'});
        s.createIndex('facturaId','facturaId');
        s.createIndex('productoId','productoId');
      }
      if(!d.objectStoreNames.contains('mermaRegistros')){
        const s = d.createObjectStore('mermaRegistros',{keyPath:'id'});
        s.createIndex('productoId','productoId');
        s.createIndex('fecha','fecha');
      }
      if(!d.objectStoreNames.contains('adjuntos')){
        const s = d.createObjectStore('adjuntos',{keyPath:'id'});
        s.createIndex('entidadTipo','entidadTipo');
        s.createIndex('entidadId','entidadId');
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
function tx(store, mode='readonly'){ return db.transaction(store, mode).objectStore(store); }
function reqP(r){ return new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function getAll(store){ return reqP(tx(store).getAll()); }
function getOne(store, key){ return reqP(tx(store).get(key)); }
/* IDs: UUID v4 real (necesario para poder sincronizar sin cambiar de
   identidad al pasar de "creado offline" a "confirmado en Supabase").
   Fallback por si algún WebView muy antiguo no trae crypto.randomUUID. */
function uid(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}
function nowISO(){ return new Date().toISOString(); }

/* ---------------------------------------------------------------------
   1B. ESCRITURA LOCAL-PRIMERO + COLA DE SINCRONIZACIÓN
   put(store, val) es la única puerta de escritura que usa TODA la app
   (ningún otro archivo toca IndexedDB directamente). Aquí:
     1) se sella `updated_at` en el propio registro,
     2) se guarda YA en IndexedDB (la operación se considera "hecha" en
        cuanto esto resuelve — nunca se espera a una petición HTTP),
     3) si el store es sincronizable, se encola una entrada en
        `sync_queue` que js/sync.js drenará hacia Supabase cuando haya
        conexión (o inmediatamente si ya la hay).
   putFromRemote() es la usada exclusivamente por sync.js al aplicar
   cambios que llegan de Supabase: escribe en IndexedDB SIN re-encolar,
   para no generar un bucle infinito de sincronización.
   --------------------------------------------------------------------- */
function rawPut(store, val){ return reqP(tx(store,'readwrite').put(val)); }
function rawDelete(store, key){ return reqP(tx(store,'readwrite').delete(key)); }

async function put(store, val){
  if (SYNCABLE_STORES.has(store)) {
    val = { ...val, updated_at: nowISO(), device_id: (typeof STATE!=='undefined' && STATE.deviceId) || getDeviceIdSafe() };
  }
  const result = await rawPut(store, val);
  if (SYNCABLE_STORES.has(store) && window.SyncQueue) {
    await window.SyncQueue.enqueue(store, 'upsert', val);
  }
  return result;
}
/* Borrado: en local se elimina de verdad (la UI espera que desaparezca),
   pero si el store sincroniza, se encola como tombstone (deleted_at) para
   que otros dispositivos también lo retiren al sincronizar, en vez de
   mandar un DELETE físico que sería imposible de propagar de forma segura
   en un sistema offline-first. */
async function del(store, key){
  if (SYNCABLE_STORES.has(store) && window.SyncQueue) {
    const existing = await getOne(store, key).catch(()=>null);
    await window.SyncQueue.enqueue(store, 'delete', { id: key, updated_at: nowISO(), deleted_at: nowISO(), _prev: existing });
  }
  return rawDelete(store, key);
}
function putFromRemote(store, val){ return rawPut(store, val); }
function deleteFromRemote(store, key){ return rawDelete(store, key); }
function getDeviceIdSafe(){ try { return localStorage.getItem('bb_device_id') || ''; } catch(e){ return ''; } }

/* ---------------------------------------------------------------------
   2. ESTADO EN MEMORIA (caché de IndexedDB para renderizado rápido)
   --------------------------------------------------------------------- */
const STATE = { productos:[], movimientos:[], equipos:[], temperaturas:[], proveedores:[], facturas:[], inventariosFisicos:[],
  checklists:[], checklistRegistros:[], tareasMantenimiento:[], incidencias:[], usuarios:[],
  usuario:'Encargado', currentUserId:null, currentRol:'ENCARGADO', deviceId:null };

async function reloadAll(){
  [STATE.productos, STATE.movimientos, STATE.equipos, STATE.temperaturas, STATE.proveedores, STATE.facturas, STATE.inventariosFisicos,
   STATE.checklists, STATE.checklistRegistros, STATE.tareasMantenimiento, STATE.incidencias, STATE.usuarios] = await Promise.all([
    getAll('productos'), getAll('movimientos'), getAll('equipos'), getAll('temperaturas'), getAll('proveedores'), getAll('facturas'), getAll('inventariosFisicos'),
    getAll('checklists'), getAll('checklistRegistros'), getAll('tareasMantenimiento'), getAll('incidencias'), getAll('usuarios')
  ]);
  // Bug real encontrado en Fase 8: un solo registro con `fecha` vacía/ausente
  // (por ejemplo, sincronizado desde otro dispositivo o creado por una vía
  // que no pasa por el formulario normal) hacía que reloadAll() entero
  // lanzara una excepción sin capturar en el .sort() — y como reloadAll()
  // se llama justo después de put() en cada guardado, cualquier pantalla
  // (crear producto, registrar movimiento, etc.) se quedaba "colgada" sin
  // cerrar ni avisar, aunque el dato SÍ se hubiera guardado bien en
  // IndexedDB. Se compara con '' como valor de reserva (nunca se pierde ni
  // se reordena el resto del listado por un único registro incompleto).
  STATE.movimientos.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));
  STATE.temperaturas.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));
  STATE.facturas.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));
  STATE.inventariosFisicos.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));
  STATE.checklistRegistros.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));
  STATE.incidencias.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));
}
function provById(id){ return STATE.proveedores.find(x=>x.id===id); }
function refreshProvDatalist(){
  const dl = document.getElementById('provList');
  if(dl) dl.innerHTML = STATE.proveedores.map(p=>`<option value="${esc(p.nombre)}">`).join('');
}
/* Busca o crea (al vuelo) un proveedor por nombre a partir de texto libre. Devuelve el proveedor. */
async function ensureProveedor(nombre){
  nombre = (nombre||'').trim();
  if(!nombre) return null;
  const existing = STATE.proveedores.find(p=>normTxt(p.nombre)===normTxt(nombre));
  if(existing) return existing;
  const nuevo = {id:uid(), nombre, telefono:'', email:'', contacto:'', productosHabituales:'', observaciones:'Creado automáticamente'};
  await put('proveedores', nuevo);
  await reloadAll();
  refreshProvDatalist();
  return nuevo;
}
/* Normaliza texto para comparar nombres de producto de forma difusa (sin acentos, minúsculas, sin dobles espacios) */
function normTxt(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim(); }
/* Coincidencia difusa simple: exacta > una cadena contiene a la otra > comparten la mayoría de palabras */
function matchProducto(nombre){
  const n = normTxt(nombre);
  if(!n) return {producto:null, confianza:0};
  let best=null, bestScore=0;
  for(const p of STATE.productos){
    const pn = normTxt(p.nombre);
    let score=0;
    if(pn===n) score=1;
    else if(pn.includes(n)||n.includes(pn)) score=0.82;
    else{
      const a=new Set(n.split(' ')), b=new Set(pn.split(' '));
      const inter=[...a].filter(w=>b.has(w)).length;
      score = inter / Math.max(a.size,b.size);
    }
    if(score>bestScore){ bestScore=score; best=p; }
  }
  if(bestScore>=0.55) return {producto:best, confianza:bestScore};
  return {producto:null, confianza:bestScore};
}

const CATEGORIAS = ['Bebida','Cerveza','Vino/Licor','Refresco/Agua','Alimentación','Limpieza','Desechables','Otros'];
const MOTIVOS_SALIDA = ['Consumo/venta','Merma','Rotura','Caducidad','Invitación','Uso interno','Error de inventario','Otro'];
const MOTIVOS_MERMA = ['Rotura','Caducidad','Derrame','Producto defectuoso','Mala preparación','Devolución','Otro'];
const PRIORIDADES = ['Baja','Media','Alta'];
const ESTADOS_INCIDENCIA = ['ABIERTA','EN PROCESO','RESUELTA'];
const TIPOS_INCIDENCIA = ['Nevera fuera de temperatura','Máquina averiada','Producto defectuoso','Falta de stock','Problema con proveedor','Rotura','Problema de limpieza','Otro'];

/* ---------------------------------------------------------------------
   ROLES Y PERMISOS (módulo 15)
   Tres roles con permisos crecientes. Las operaciones diarias (entradas,
   salidas, mermas, temperaturas, ejecutar checklists, incidencias,
   marcar tareas realizadas) están abiertas a cualquier rol porque son
   el pan de cada día del personal de sala. La gestión del catálogo,
   informes/analítica y usuarios quedan restringidas.
   --------------------------------------------------------------------- */
const ROLES = ['ADMINISTRADOR','ENCARGADO','EMPLEADO'];
const PERMISOS_POR_ROL = {
  ADMINISTRADOR: ['catalogo','proveedores','equipos','checklist_config','mantenimiento_config','inventario_fisico','reportes','analitica','usuarios','seguridad'],
  ENCARGADO:     ['catalogo','proveedores','equipos','checklist_config','mantenimiento_config','inventario_fisico','reportes','analitica'],
  EMPLEADO:      [],
};
function can(perm){ return (PERMISOS_POR_ROL[STATE.currentRol]||[]).includes(perm); }
function requirePerm(perm, msg){
  if(can(perm)) return true;
  toast(msg || 'Acción restringida a Encargado/Administrador');
  return false;
}
function rolBadgeCls(rol){ return rol==='ADMINISTRADOR'?'crit':(rol==='ENCARGADO'?'info':'neutral'); }

/* ---------------------------------------------------------------------
   3. SEED — datos de ejemplo la primera vez que se abre la app
   (para que el primer vistazo muestre la app en uso real, no un
   formulario vacío). Solo se ejecuta si no hay productos guardados.
   --------------------------------------------------------------------- */
async function seedIfEmpty(){
  const existing = await getAll('productos');
  if(existing.length) return;
  const prods = [
    {nombre:'Cerveza Estrella 33cl', categoria:'Cerveza', marca:'Estrella', formato:'Botella 33cl', unidad:'ud', stockActual:86, stockMin:48, stockMax:200, precioCompra:0.55, proveedor:'Hijos de Rivera', ubicacion:'Cámara 1', caducidad:'', lote:'', codigoBarras:'', observaciones:''},
    {nombre:'Coca-Cola 33cl', categoria:'Refresco/Agua', marca:'Coca-Cola', formato:'Lata 33cl', unidad:'ud', stockActual:22, stockMin:30, stockMax:150, precioCompra:0.48, proveedor:'Coca-Cola European Partners', ubicacion:'Nevera bebidas', caducidad:'', lote:'', codigoBarras:'', observaciones:''},
    {nombre:'Agua mineral 50cl', categoria:'Refresco/Agua', marca:'Font Vella', formato:'Botella 50cl', unidad:'ud', stockActual:60, stockMin:24, stockMax:120, precioCompra:0.28, proveedor:'Danone Aguas', ubicacion:'Almacén', caducidad:'', lote:'', codigoBarras:'', observaciones:''},
    {nombre:'Vino tinto crianza', categoria:'Vino/Licor', marca:'Ramón Bilbao', formato:'Botella 75cl', unidad:'ud', stockActual:9, stockMin:6, stockMax:36, precioCompra:5.9, proveedor:'Distribuciones Canarias', ubicacion:'Bodega', caducidad:'', lote:'L2309', observaciones:''},
    {nombre:'Ron añejo', categoria:'Vino/Licor', marca:'Barceló', formato:'Botella 70cl', unidad:'ud', stockActual:4, stockMin:4, stockMax:15, precioCompra:9.4, proveedor:'Distribuciones Canarias', ubicacion:'Barra', caducidad:'', lote:'', observaciones:''},
    {nombre:'Patatas fritas 150g', categoria:'Alimentación', marca:'Lays', formato:'Bolsa 150g', unidad:'ud', stockActual:14, stockMin:10, stockMax:40, precioCompra:1.1, proveedor:'Makro', ubicacion:'Almacén', caducidad:addDays(28), lote:'', observaciones:''},
    {nombre:'Pan de hamburguesa', categoria:'Alimentación', marca:'Bimbo', formato:'Paquete 6ud', unidad:'paquete', stockActual:5, stockMin:6, stockMax:20, precioCompra:1.6, proveedor:'Makro', ubicacion:'Congelador 1', caducidad:addDays(2), lote:'', observaciones:''},
    {nombre:'Carne de hamburguesa 150g', categoria:'Alimentación', marca:'', formato:'Unidad', unidad:'ud', stockActual:18, stockMin:20, stockMax:80, precioCompra:1.3, proveedor:'Carnicería Domínguez', ubicacion:'Congelador 2', caducidad:addDays(6), lote:'L-914', observaciones:''},
    {nombre:'Tomate', categoria:'Alimentación', marca:'', formato:'kg', unidad:'kg', stockActual:3.2, stockMin:3, stockMax:12, precioCompra:1.8, proveedor:'Frutas El Sol', ubicacion:'Cámara 1', caducidad:addDays(1), lote:'', observaciones:''},
    {nombre:'Aceite de oliva 5L', categoria:'Alimentación', marca:'Carbonell', formato:'Garrafa 5L', unidad:'garrafa', stockActual:2, stockMin:2, stockMax:8, precioCompra:19.5, proveedor:'Makro', ubicacion:'Almacén', caducidad:addDays(180), observaciones:''},
    {nombre:'Servilletas', categoria:'Desechables', marca:'', formato:'Paquete 100ud', unidad:'paquete', stockActual:11, stockMin:5, stockMax:30, precioCompra:1.2, proveedor:'Makro', ubicacion:'Almacén', caducidad:'', observaciones:''},
    {nombre:'Detergente lavavajillas', categoria:'Limpieza', marca:'Fairy', formato:'Botella 1L', unidad:'ud', stockActual:1, stockMin:2, stockMax:6, precioCompra:3.4, proveedor:'Makro', ubicacion:'Almacén limpieza', caducidad:'', observaciones:''},
  ].map(p=>({id:uid(), ...p}));
  for(const p of prods) await put('productos', p);

  const equipos = [
    {nombre:'Nevera bebidas', tipo:'Nevera', ubicacion:'Barra', tempMin:2, tempMax:8, estado:'Operativo', observaciones:''},
    {nombre:'Cámara 1', tipo:'Cámara frigorífica', ubicacion:'Almacén', tempMin:1, tempMax:5, estado:'Operativo', observaciones:''},
    {nombre:'Congelador 1', tipo:'Congelador', ubicacion:'Cocina', tempMin:-22, tempMax:-16, estado:'Operativo', observaciones:''},
    {nombre:'Congelador 2', tipo:'Congelador', ubicacion:'Cocina', tempMin:-22, tempMax:-16, estado:'Operativo', observaciones:''},
  ].map(e=>({id:uid(), ...e}));
  for(const e of equipos) await put('equipos', e);

  const proveedores = [
    {nombre:'Hijos de Rivera', telefono:'981 289 000', email:'pedidos@hijosderivera.com', contacto:'Marta (comercial)', productosHabituales:'Cerveza Estrella', observaciones:'Reparto los lunes y jueves'},
    {nombre:'Coca-Cola European Partners', telefono:'900 100 200', email:'pedidos@ccep.com', contacto:'', productosHabituales:'Refrescos', observaciones:''},
    {nombre:'Danone Aguas', telefono:'900 300 400', email:'', contacto:'', productosHabituales:'Agua mineral', observaciones:''},
    {nombre:'Distribuciones Canarias', telefono:'928 123 456', email:'ventas@distcanarias.es', contacto:'Javier Pérez', productosHabituales:'Vino, licores', observaciones:'Pedido mínimo 100€'},
    {nombre:'Makro', telefono:'900 500 600', email:'', contacto:'', productosHabituales:'Alimentación, limpieza, desechables', observaciones:''},
    {nombre:'Carnicería Domínguez', telefono:'928 654 321', email:'', contacto:'Antonio Domínguez', productosHabituales:'Carnes', observaciones:'Entrega bajo pedido con 24h'},
    {nombre:'Frutas El Sol', telefono:'928 111 222', email:'', contacto:'', productosHabituales:'Fruta y verdura', observaciones:'Reparto diario de madrugada'},
  ].map(pr=>({id:uid(), ...pr}));
  for(const pr of proveedores) await put('proveedores', pr);

  // lecturas de ejemplo (últimos 6 días) para nevera bebidas y cámara 1
  const base = equipos[0], base2 = equipos[1];
  const temps = [9.2,7.8,7.5,7.9,8.6,6.9];
  for(let i=0;i<temps.length;i++){
    const t = temps[temps.length-1-i];
    const fuera = t < base.tempMin || t > base.tempMax;
    await put('temperaturas', {id:uid(), equipoId:base.id, temperatura:t, fecha:daysAgoISO(temps.length-1-i), usuario:'Encargado',
      observaciones:'', fueraDeRango:fuera, accionCorrectiva: fuera? 'Se revisó que la puerta estuviera correctamente cerrada y se volvió a comprobar la temperatura.':''});
  }
  const temps2 = [3.1,3.4,2.9,3.0,3.6,3.2];
  for(let i=0;i<temps2.length;i++){
    await put('temperaturas', {id:uid(), equipoId:base2.id, temperatura:temps2[temps2.length-1-i], fecha:daysAgoISO(temps2.length-1-i), usuario:'Encargado', observaciones:'', fueraDeRango:false, accionCorrectiva:''});
  }

  // movimientos de ejemplo
  const cocaId = prods.find(p=>p.nombre.startsWith('Coca')).id;
  const cervezaId = prods.find(p=>p.nombre.startsWith('Cerveza')).id;
  const panId = prods.find(p=>p.nombre.startsWith('Pan')).id;
  await put('movimientos', {id:uid(), productoId:cervezaId, tipo:'entrada', cantidad:48, stockAnterior:38, stockPosterior:86, motivo:'Entrada manual', usuario:'Encargado', fecha:daysAgoISO(1), observaciones:'Reposición semanal', proveedor:'Hijos de Rivera', precioCompra:0.55, lote:'', caducidadLote:''});
  await put('movimientos', {id:uid(), productoId:cocaId, tipo:'salida', cantidad:18, stockAnterior:40, stockPosterior:22, motivo:'Consumo/venta', usuario:'Encargado', fecha:daysAgoISO(0), observaciones:''});
  await put('movimientos', {id:uid(), productoId:panId, tipo:'merma', cantidad:2, stockAnterior:7, stockPosterior:5, motivo:'Caducidad', usuario:'Encargado', fecha:daysAgoISO(0), observaciones:'Bolsa abierta olvidada fuera del congelador'});

  const checklistApertura = {id:uid(), nombre:'Apertura', tipo:'apertura', items:[
    'Revisar temperaturas de neveras y congeladores','Revisar estado general de las neveras','Revisar stock crítico',
    'Encender equipos (cafetera, máquinas, luces)','Revisar limpieza de la barra y sala','Comprobar caja y cambio inicial',
  ].map(t=>({id:uid(), texto:t}))};
  const checklistCierre = {id:uid(), nombre:'Cierre', tipo:'cierre', items:[
    'Registrar temperaturas de cierre','Revisar cámaras y congeladores cerrados correctamente','Guardar productos perecederos',
    'Limpiar barra, máquina de café y superficies','Revisar y anotar stock','Cerrar equipos no esenciales','Sacar la basura',
  ].map(t=>({id:uid(), texto:t}))};
  await put('checklists', checklistApertura); await put('checklists', checklistCierre);

  const tareas = [
    {nombre:'Limpiar nevera bebidas', frecuenciaDias:7, ultimaRealizacion:addDays(-4), responsable:'Encargado', observaciones:''},
    {nombre:'Limpiar cafetera', frecuenciaDias:1, ultimaRealizacion:addDays(-1), responsable:'Barra', observaciones:'Ciclo de limpieza automático + repaso manual'},
    {nombre:'Limpiar campana extractora', frecuenciaDias:30, ultimaRealizacion:addDays(-35), responsable:'Cocina', observaciones:''},
    {nombre:'Cambiar aceite freidora', frecuenciaDias:14, ultimaRealizacion:addDays(-13), responsable:'Cocina', observaciones:''},
    {nombre:'Revisar filtros aire acondicionado', frecuenciaDias:60, ultimaRealizacion:addDays(-10), responsable:'Encargado', observaciones:''},
  ].map(t=>({id:uid(), ...t, proximaRealizacion: addDaysFrom(t.ultimaRealizacion, t.frecuenciaDias), foto:null}));
  for(const t of tareas) await put('tareasMantenimiento', t);

  await put('incidencias', {id:uid(), titulo:'Nevera bebidas fuera de temperatura', descripcion:'Detectada a 9.2°C durante el control matutino.',
    tipo:'Nevera fuera de temperatura', fecha:daysAgoISO(1), usuario:'Encargado', prioridad:'Alta', estado:'RESUELTA',
    accionRealizada:'Se revisó el cierre de la puerta y se volvió a comprobar la temperatura; volvió a rango.', foto:null, observaciones:''});

  const usuarios = [
    {nombre:'Administrador', rol:'ADMINISTRADOR', pin:''},
    {nombre:'Encargado', rol:'ENCARGADO', pin:''},
    {nombre:'Empleado', rol:'EMPLEADO', pin:''},
  ].map(u=>({id:uid(), ...u}));
  for(const u of usuarios) await put('usuarios', u);
}
function addDaysFrom(dateStr, n){ const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function addDays(n){ const d=new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function daysAgoISO(n){ const d=new Date(); d.setDate(d.getDate()-n); d.setHours(9,0,0,0); return d.toISOString(); }

/* ---------------------------------------------------------------------
   4. UTILIDADES
   --------------------------------------------------------------------- */
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'), 2200);
}
function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-ES',{day:'2-digit',month:'short'}) + ' · ' + d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
}
function fmtDateShort(iso){ if(!iso) return '—'; return new Date(iso).toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}); }
function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(dateStr+'T00:00:00');
  return Math.round((target-today)/86400000);
}
function money(n){ return (Math.round((n||0)*100)/100).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' €'; }
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function prodById(id){ return STATE.productos.find(p=>p.id===id); }
function equipoById(id){ return STATE.equipos.find(e=>e.id===id); }
function stockBadge(p){
  if(p.stockActual<=0) return {cls:'crit',txt:'SIN STOCK'};
  if(p.stockActual < p.stockMin) return {cls:'warn',txt:'STOCK BAJO'};
  if(p.stockMax && p.stockActual > p.stockMax) return {cls:'info',txt:'SOBRESTOCK'};
  return {cls:'ok',txt:'OK'};
}
function tareaEstado(t){
  const d = daysUntil(t.proximaRealizacion);
  if(t.ultimaRealizacion === new Date().toISOString().slice(0,10)) return {cls:'ok', txt:'COMPLETADA HOY'};
  if(d<0) return {cls:'crit', txt:'ATRASADA'};
  if(d===0) return {cls:'warn', txt:'PARA HOY'};
  return {cls:'neutral', txt:'PENDIENTE'};
}
function incPrioridadCls(p){ return p==='Alta'?'crit':(p==='Media'?'warn':'info'); }
function incEstadoCls(e){ return e==='ABIERTA'?'crit':(e==='EN PROCESO'?'warn':'ok'); }
function caducidadBadge(dateStr){
  const d = daysUntil(dateStr);
  if(d===null) return null;
  if(d<0) return {cls:'crit',txt:'CADUCADO'};
  if(d===0) return {cls:'crit',txt:'CADUCA HOY'};
  if(d<=3) return {cls:'warn',txt:`CADUCA EN ${d} DÍA${d===1?'':'S'}`};
  if(d<=7) return {cls:'info',txt:`CADUCA EN ${d} DÍAS`};
  return null;
}

/* ---------------------------------------------------------------------
   5. NÚCLEO DE TRAZABILIDAD DE STOCK
   Toda variación de stockActual pasa por aquí y SIEMPRE crea un
   movimiento. Nunca se toca producto.stockActual directamente en otro
   sitio del código.
   --------------------------------------------------------------------- */
async function registrarMovimiento({productoId, tipo, cantidad, motivo, observaciones, extra={}}){
  const p = prodById(productoId);
  if(!p) throw new Error('Producto no encontrado');
  const anterior = p.stockActual;
  let posterior;
  if(tipo==='ajuste' && extra.posteriorAbsoluto!==undefined) posterior = +extra.posteriorAbsoluto.toFixed(3);
  else if(tipo==='entrada') posterior = +(anterior + cantidad).toFixed(3);
  else posterior = +(anterior - cantidad).toFixed(3); // salida, merma
  p.stockActual = posterior;
  await put('productos', p);
  const mov = {
    id:uid(), productoId, tipo, cantidad, stockAnterior:anterior, stockPosterior:posterior,
    motivo, usuario:STATE.usuario, fecha:nowISO(), observaciones:observaciones||'', ...extra
  };
  await put('movimientos', mov);
  await reloadAll();
  return mov;
}

/* ---------------------------------------------------------------------
   5B. ADJUNTOS (fotos de facturas/mermas/incidencias/tareas) — Fase 6I
   La foto se sigue guardando embebida en su entidad (factura.imgDataUrl,
   incidencia.foto, tarea.foto…) para que la app siga funcionando y
   mostrando la imagen exactamente igual que antes, incluso sin Supabase.
   Además, se crea aquí un registro 'adjuntos' independiente: es lo que
   js/sync.js sube a Supabase Storage (bucket "attachments") cuando hay
   conexión, sin bloquear ni depender de esa subida para que la foto
   quede guardada localmente (si no hay red, el registro simplemente
   queda en sync_queue como cualquier otro cambio, y no se pierde).
   --------------------------------------------------------------------- */
async function registrarAdjunto({entidadTipo, entidadId, dataUrl}){
  if(!dataUrl) return null;
  const contentType = (dataUrl.match(/^data:([^;]+);/)||[])[1] || 'image/jpeg';
  const rec = {id:uid(), entidadTipo, entidadId, dataUrl, contentType, fecha: nowISO()};
  await put('adjuntos', rec);
  return rec;
}

/* ---------------------------------------------------------------------
   PIN local (bloqueo rápido de pantalla) — Fase 6K
   IMPORTANTE: esto NO es una contraseña de Supabase. Es un candado de
   4 dígitos puramente local para saber "quién de los que están delante
   del mostrador está actuando ahora" — mientras que Supabase Auth (ver
   js/sync.js) es la autenticación real que protege los datos en la nube.
   El PIN nunca se guarda en texto plano: se hashea (SHA-256) antes de
   escribirlo en IndexedDB, y como 'usuarios'/'config' están fuera de
   SYNCABLE_STORES, ni el PIN ni su hash salen nunca del dispositivo. */
async function hashPin(pin){
  const data = new TextEncoder().encode('bb_pin_v1:' + pin);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

/* =========================================================================
   6. ROUTER Y RENDER
   ========================================================================= */
let CURRENT_TAB = 'dashboard';
const tabbar = document.getElementById('tabbar');
tabbar.addEventListener('click', e=>{
  const btn = e.target.closest('button[data-tab]'); if(!btn) return;
  goTab(btn.dataset.tab);
});
function goTab(tab){
  CURRENT_TAB = tab;
  [...tabbar.children].forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  render();
  document.getElementById('main').scrollTop = 0;
}
function render(){
  const main = document.getElementById('main');
  const renderers = { dashboard:renderDashboard, inventario:renderInventario, historial:renderHistorial, temperaturas:renderTemperaturas, mas:renderMas };
  main.innerHTML = '';
  const view = document.createElement('div'); view.className='view';
  (renderers[CURRENT_TAB]||renderDashboard)(view);
  main.appendChild(view);
}
function clockTick(){
  document.getElementById('clockLine').textContent = new Date().toLocaleString('es-ES',{weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
}

/* ---------------------------------------------------------------------
   7. DASHBOARD
   --------------------------------------------------------------------- */
function renderDashboard(root){
  const bajo = STATE.productos.filter(p=>p.stockActual < p.stockMin);
  const sinStock = STATE.productos.filter(p=>p.stockActual<=0);
  const caducando = STATE.productos.filter(p=>{ const d=daysUntil(p.caducidad); return d!==null && d<=7; });
  const caducados = STATE.productos.filter(p=>{ const d=daysUntil(p.caducidad); return d!==null && d<0; });

  const equiposConEstado = STATE.equipos.map(eq=>{
    const last = STATE.temperaturas.find(t=>t.equipoId===eq.id);
    return {eq, last, fuera: last ? last.fueraDeRango : false};
  });
  const fueraRango = equiposConEstado.filter(x=>x.fuera);

  const movRecientes = STATE.movimientos.slice(0,5);
  const incAbiertas = STATE.incidencias.filter(i=>i.estado!=='RESUELTA');
  const tareasHoyOAtrasadas = STATE.tareasMantenimiento.filter(t=>{ const d=daysUntil(t.proximaRealizacion); return d<=0 && t.ultimaRealizacion!==new Date().toISOString().slice(0,10); });

  root.innerHTML = `
    <div class="stat-grid">
      <div class="stat ${fueraRango.length?'crit':'ok'}">
        <div class="top"><span class="label">Temperaturas</span><span class="pill-icon" style="background:var(--surface)">🌡️</span></div>
        <span class="value ${fueraRango.length?'c-crit':'c-ok'}">${fueraRango.length?fueraRango.length+' fuera':'✓ En rango'}</span>
        <span class="tiny">${STATE.equipos.length} equipos monitorizados</span>
      </div>
      <div class="stat ${bajo.length?'warn':'ok'}">
        <div class="top"><span class="label">Inventario</span><span class="pill-icon" style="background:var(--surface)">📦</span></div>
        <span class="value ${bajo.length?'c-warn':'c-ok'}">${bajo.length?bajo.length+' bajo mín.':'✓ Correcto'}</span>
        <span class="tiny">${STATE.productos.length} productos activos</span>
      </div>
      <div class="stat ${caducados.length?'crit':(caducando.length?'warn':'ok')}">
        <div class="top"><span class="label">Caducidades</span><span class="pill-icon" style="background:var(--surface)">⏳</span></div>
        <span class="value ${caducados.length?'c-crit':(caducando.length?'c-warn':'c-ok')}">${caducados.length? caducados.length+' caducados' : (caducando.length? caducando.length+' próximas' : '✓ Ninguna')}</span>
        <span class="tiny">próximos 7 días</span>
      </div>
      <div class="stat ${incAbiertas.length?'crit':'ok'}">
        <div class="top"><span class="label">Incidencias</span><span class="pill-icon" style="background:var(--surface)">🛠️</span></div>
        <span class="value ${incAbiertas.length?'c-crit':'c-ok'}">${incAbiertas.length? incAbiertas.length+' abiertas' : '✓ Ninguna'}</span>
        <span class="tiny">abiertas o en proceso</span>
      </div>
      <div class="stat ${tareasHoyOAtrasadas.length?'warn':'ok'}">
        <div class="top"><span class="label">Tareas</span><span class="pill-icon" style="background:var(--surface)">🧽</span></div>
        <span class="value ${tareasHoyOAtrasadas.length?'c-warn':'c-ok'}">${tareasHoyOAtrasadas.length? tareasHoyOAtrasadas.length+' pendientes' : '✓ Al día'}</span>
        <span class="tiny">limpieza / mantenimiento</span>
      </div>
      <div class="stat info">
        <div class="top"><span class="label">Movimientos</span><span class="pill-icon" style="background:var(--surface)">↕️</span></div>
        <span class="value c-info">${STATE.movimientos.filter(m=>(m.fecha||'').slice(0,10)===new Date().toISOString().slice(0,10)).length}</span>
        <span class="tiny">hoy</span>
      </div>
    </div>

    <div>
      <div class="section-head"><h2>Accesos rápidos</h2></div>
      <div class="quick-grid" style="margin-top:8px">
        ${qa('temp','🌡️','Temperatura')}
        ${qa('entrada','⬇️','Añadir stock')}
        ${qa('salida','⬆️','Retirar stock')}
        ${qa('factura','🧾','Escanear factura')}
        ${qa('merma','⚠️','Registrar merma')}
        ${qa('almacen','📷','Modo almacén')}
        ${qa('caducidades','⏳','Caducidades')}
        ${qa('checklist_apertura','☀️','Check. apertura')}
        ${qa('checklist_cierre','🌙','Check. cierre')}
        ${qa('nueva_incidencia','🛠️','Nueva incidencia')}
        ${qa('productos','🔎','Ver inventario')}
      </div>
    </div>

    ${(bajo.length||caducando.length||fueraRango.length||incAbiertas.length||tareasHoyOAtrasadas.length) ? `
    <div class="card">
      <div class="section-head"><h2>Necesita atención</h2></div>
      <div class="row-list" style="margin-top:10px">
        ${fueraRango.map(x=>alertRow('🌡️',x.eq.nombre, `${x.last.temperatura}°C · límite ${x.eq.tempMin}–${x.eq.tempMax}°C`,'crit','FUERA DE RANGO')).join('')}
        ${incAbiertas.slice(0,3).map(i=>alertRow('🛠️',i.titulo, i.tipo,'crit',i.estado)).join('')}
        ${caducados.slice(0,3).map(p=>alertRow('⏳',p.nombre, `Caducó el ${fmtDateShort(p.caducidad)}`,'crit','CADUCADO')).join('')}
        ${bajo.slice(0,4).map(p=>alertRow('📦',p.nombre, `${fmtNum(p.stockActual)} ${p.unidad} · mínimo ${fmtNum(p.stockMin)}`,'warn','STOCK BAJO')).join('')}
        ${tareasHoyOAtrasadas.slice(0,3).map(t=>alertRow('🧽',t.nombre, t.responsable||'Sin responsable','warn', tareaEstado(t).txt)).join('')}
        ${caducando.filter(p=>daysUntil(p.caducidad)>=0).slice(0,3).map(p=>alertRow('⏳',p.nombre, `Caduca en ${daysUntil(p.caducidad)} día(s)`,'warn','PRÓXIMO')).join('')}
      </div>
    </div>` : `<div class="card" style="text-align:center;color:var(--ok);font-weight:700">✓ Todo bajo control ahora mismo</div>`}

    <div class="card">
      <div class="section-head"><h2>Movimientos recientes</h2><button class="link-btn" onclick="goTab('historial')">Ver todo</button></div>
      <div class="row-list" style="margin-top:10px">
        ${movRecientes.length? movRecientes.map(movRowHtml).join('') : '<div class="muted" style="padding:8px 0">Sin movimientos todavía.</div>'}
      </div>
    </div>
  `;
  root.querySelectorAll('[data-qa]').forEach(b=> b.addEventListener('click', ()=>handleQuickAction(b.dataset.qa)));
}
function fmtNum(n){ return (Math.round((n||0)*100)/100).toString().replace(/\.00$/,''); }
function qa(key,emoji,label){
  return `<button class="quick-btn" data-qa="${key}"><span style="font-size:18px">${emoji}</span>${label}</button>`;
}
function alertRow(emoji,title,sub,cls,badge){
  return `<div class="item-row"><div class="ic">${emoji}</div><div class="body"><div class="name">${esc(title)}</div><div class="sub">${esc(sub)}</div></div><span class="badge ${cls}">${badge}</span></div>`;
}
function movRowHtml(m){
  const p = prodById(m.productoId);
  const cfg = {entrada:{ic:'⬇️',cls:'ok',sign:'+'}, salida:{ic:'⬆️',cls:'warn',sign:'−'}, merma:{ic:'⚠️',cls:'crit',sign:'−'}, ajuste:{ic:'🧮',cls:'info',sign:''}}[m.tipo]||{ic:'•',cls:'neutral',sign:''};
  return `<div class="item-row"><div class="ic">${cfg.ic}</div><div class="body"><div class="name">${esc(p?p.nombre:'Producto eliminado')}</div><div class="sub">${m.motivo||m.tipo} · ${fmtDate(m.fecha)}</div></div>
    <div class="right"><div class="n" style="color:var(--${cfg.cls==='neutral'?'ink':cfg.cls})">${cfg.sign}${fmtNum(m.cantidad)}</div></div></div>`;
}
function handleQuickAction(key){
  if(key==='temp') return openTempLogSheet();
  if(key==='entrada') return openEntradaSheet();
  if(key==='salida') return openSalidaSheet();
  if(key==='factura') return openFacturaSheet();
  if(key==='merma') return openMermaSheet();
  if(key==='almacen') return openModoAlmacenSheet();
  if(key==='caducidades') return openCaducidadesSheet();
  if(key==='checklist_apertura') return openChecklistRunByTipo('apertura');
  if(key==='checklist_cierre') return openChecklistRunByTipo('cierre');
  if(key==='nueva_incidencia') return openIncidenciaFormSheet(null);
  if(key==='productos') return goTab('inventario');
}

/* ---------------------------------------------------------------------
   8. INVENTARIO / PRODUCTOS
   --------------------------------------------------------------------- */
let invFilter = {q:'', cat:'Todas', onlyLow:false};
function renderInventario(root){
  root.innerHTML = `
    <div class="page-head"><h1 style="font-size:20px">Inventario</h1></div>
    <div class="fab-row">
      <button class="btn btn-outline" style="flex:1" id="goCaducidades">⏳ Caducidades</button>
      <button class="btn btn-outline" style="flex:1" id="goFisico">🧮 Inventario físico</button>
    </div>
    <div class="searchbar">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="invSearch" placeholder="Buscar producto, marca, proveedor…" value="${esc(invFilter.q)}">
    </div>
    <div class="chip-row" id="catChips">
      ${['Todas',...CATEGORIAS].map(c=>`<button class="chip ${invFilter.cat===c?'active':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <label class="item-row" style="cursor:pointer">
      <input type="checkbox" id="onlyLow" ${invFilter.onlyLow?'checked':''} style="width:18px;height:18px;accent-color:var(--accent)">
      <div class="body"><div class="name" style="font-weight:600">Solo stock bajo mínimo</div></div>
    </label>
    <div class="row-list" id="prodList"></div>
    <button class="btn btn-primary btn-block" id="addProdBtn">+ Nuevo producto</button>
  `;
  const list = root.querySelector('#prodList');
  function draw(){
    const q = invFilter.q.trim().toLowerCase();
    let items = STATE.productos.filter(p=>{
      if(invFilter.cat!=='Todas' && p.categoria!==invFilter.cat) return false;
      if(invFilter.onlyLow && !(p.stockActual < p.stockMin)) return false;
      if(!q) return true;
      return [p.nombre,p.marca,p.proveedor,p.ubicacion].some(v=> (v||'').toLowerCase().includes(q));
    }).sort((a,b)=>a.nombre.localeCompare(b.nombre));
    list.innerHTML = items.length ? items.map(prodRowHtml).join('') : `<div class="empty"><svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="14" rx="2"/></svg><div>No se encontraron productos</div></div>`;
    list.querySelectorAll('[data-open-prod]').forEach(el=> el.addEventListener('click', ()=>openProductSheet(el.dataset.openProd)));
  }
  draw();
  root.querySelector('#invSearch').addEventListener('input', e=>{invFilter.q=e.target.value; draw();});
  root.querySelector('#catChips').addEventListener('click', e=>{
    const c = e.target.closest('.chip'); if(!c) return;
    invFilter.cat = c.dataset.cat; renderInventario(root);
  });
  root.querySelector('#onlyLow').addEventListener('change', e=>{invFilter.onlyLow=e.target.checked; draw();});
  root.querySelector('#addProdBtn').addEventListener('click', ()=>openProductSheet(null));
  root.querySelector('#goCaducidades').addEventListener('click', openCaducidadesSheet);
  root.querySelector('#goFisico').addEventListener('click', openInventarioFisicoSheet);
}
function prodRowHtml(p){
  const b = stockBadge(p);
  const cad = caducidadBadge(p.caducidad);
  return `<div class="item-row" data-open-prod="${p.id}" style="cursor:pointer">
    <div class="ic">${catEmoji(p.categoria)}</div>
    <div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">${esc(p.ubicacion||'Sin ubicación')} · ${esc(p.marca||p.categoria)}</div></div>
    <div class="right">
      <div class="n">${fmtNum(p.stockActual)} <span class="tiny">${esc(p.unidad)}</span></div>
      <div style="margin-top:3px;display:flex;gap:4px;justify-content:flex-end">
        <span class="badge ${b.cls}">${b.txt}</span>${cad?`<span class="badge ${cad.cls}">${cad.txt}</span>`:''}
      </div>
    </div>
  </div>`;
}
function catEmoji(cat){
  return {Bebida:'🥤',Cerveza:'🍺','Vino/Licor':'🍷','Refresco/Agua':'🥤',Alimentación:'🍽️',Limpieza:'🧴',Desechables:'🧻',Otros:'📦'}[cat] || '📦';
}

/* Ficha de producto (crear / editar / eliminar / acciones rápidas) */
function openProductSheet(id){
  if(!requirePerm('catalogo', 'Solo Encargado/Administrador pueden crear o editar productos')) return;
  const editing = !!id;
  const p = editing ? prodById(id) : {id:uid(), nombre:'', categoria:CATEGORIAS[0], marca:'', formato:'', unidad:'ud', stockActual:0, stockMin:0, stockMax:0, precioCompra:0, proveedor:'', ubicacion:'', caducidad:'', lote:'', codigoBarras:'', observaciones:''};
  openSheet({
    title: editing? 'Editar producto' : 'Nuevo producto',
    bodyHtml: `
      <div class="form-stack">
        ${editing? `<div class="stat-grid">
            <div class="stat ok" style="grid-column:span 2"><div class="top"><span class="label">Stock actual</span></div><span class="value c-ok">${fmtNum(p.stockActual)} <span style="font-size:15px">${esc(p.unidad)}</span></span></div>
          </div>`:''}
        <div class="field"><label>Nombre del producto</label><input id="f_nombre" value="${esc(p.nombre)}" placeholder="Ej. Cerveza Estrella 33cl"></div>
        <div class="grid2">
          <div class="field"><label>Categoría</label><select id="f_categoria">${CATEGORIAS.map(c=>`<option ${c===p.categoria?'selected':''}>${c}</option>`).join('')}</select></div>
          <div class="field"><label>Marca</label><input id="f_marca" value="${esc(p.marca)}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Formato</label><input id="f_formato" value="${esc(p.formato)}" placeholder="Botella 33cl"></div>
          <div class="field"><label>Unidad de medida</label><input id="f_unidad" value="${esc(p.unidad)}" placeholder="ud / kg / L"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Stock mínimo</label><input id="f_min" type="number" step="any" value="${p.stockMin}"></div>
          <div class="field"><label>Stock máximo</label><input id="f_max" type="number" step="any" value="${p.stockMax}"></div>
        </div>
        ${!editing? `<div class="field"><label>Stock inicial</label><input id="f_stock" type="number" step="any" value="${p.stockActual}"></div>`:''}
        <div class="grid2">
          <div class="field"><label>Precio de compra</label><input id="f_precio" type="number" step="0.01" value="${p.precioCompra}"></div>
          <div class="field"><label>Proveedor</label><input id="f_proveedor" value="${esc(p.proveedor)}" list="provList"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Ubicación</label><input id="f_ubicacion" value="${esc(p.ubicacion)}" placeholder="Cámara 1, Barra…"></div>
          <div class="field"><label>Código de barras</label>
            <div style="display:flex;gap:6px">
              <input id="f_barras" value="${esc(p.codigoBarras)}" style="flex:1">
              ${('BarcodeDetector' in window) ? '<button type="button" class="btn btn-outline btn-sm" id="f_scanBarras">📷</button>' : ''}
            </div>
          </div>
        </div>
        <div class="grid2">
          <div class="field"><label>Caducidad</label><input id="f_caducidad" type="date" value="${p.caducidad||''}"></div>
          <div class="field"><label>Lote</label><input id="f_lote" value="${esc(p.lote)}"></div>
        </div>
        <div class="field"><label>Observaciones</label><textarea id="f_obs">${esc(p.observaciones)}</textarea></div>
      </div>
    `,
    footHtml: `
      ${editing?`<button class="btn btn-outline" id="delProdBtn">Eliminar</button>`:''}
      <button class="btn btn-primary btn-block" id="saveProdBtn">${editing?'Guardar cambios':'Crear producto'}</button>
    `,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#saveProdBtn').addEventListener('click', async ()=>{
        const nombre = sheetEl.querySelector('#f_nombre').value.trim();
        if(!nombre){ toast('El nombre es obligatorio'); return; }
        const updated = {
          ...p,
          nombre, categoria: sheetEl.querySelector('#f_categoria').value,
          marca: sheetEl.querySelector('#f_marca').value.trim(),
          formato: sheetEl.querySelector('#f_formato').value.trim(),
          unidad: sheetEl.querySelector('#f_unidad').value.trim()||'ud',
          stockMin: parseFloat(sheetEl.querySelector('#f_min').value)||0,
          stockMax: parseFloat(sheetEl.querySelector('#f_max').value)||0,
          precioCompra: parseFloat(sheetEl.querySelector('#f_precio').value)||0,
          proveedor: sheetEl.querySelector('#f_proveedor').value.trim(),
          ubicacion: sheetEl.querySelector('#f_ubicacion').value.trim(),
          codigoBarras: sheetEl.querySelector('#f_barras').value.trim(),
          caducidad: sheetEl.querySelector('#f_caducidad').value,
          lote: sheetEl.querySelector('#f_lote').value.trim(),
          observaciones: sheetEl.querySelector('#f_obs').value.trim(),
        };
        if(!editing) updated.stockActual = parseFloat(sheetEl.querySelector('#f_stock').value)||0;
        if(updated.proveedor) await ensureProveedor(updated.proveedor);
        await put('productos', updated);
        await reloadAll();
        closeSheet(); toast(editing?'Producto actualizado':'Producto creado'); render();
      });
      const del = sheetEl.querySelector('#delProdBtn');
      if(del) del.addEventListener('click', async ()=>{
        confirmDialog('¿Eliminar producto?', `Se eliminará "${p.nombre}" del catálogo. El historial de movimientos ya registrado se conserva.`, async ()=>{
          await del2('productos', p.id); await reloadAll(); closeSheet(); toast('Producto eliminado'); render();
        });
      });
      const scanBtn = sheetEl.querySelector('#f_scanBarras');
      if(scanBtn) scanBtn.addEventListener('click', ()=>{
        scanBarcodeOnce(code=>{ sheetEl.querySelector('#f_barras').value = code; toast('Código capturado: '+code); });
      });
    }
  });
}
async function del2(store,id){ return del(store,id); }

/* Escaneo de un único código de barras (usado para rellenar el campo "Código de barras"). */
function scanBarcodeOnce(onResult){
  let stream=null, loopActive=false;
  openSheet({
    title:'Escanear código',
    bodyHtml:`<div class="card-flat" style="padding:0;overflow:hidden;aspect-ratio:4/3;position:relative;background:#000;border-radius:12px">
        <video id="sc_video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover"></video>
      </div><div class="tiny" style="text-align:center">Apunta al código de barras…</div>`,
    onMount: async (sheetEl)=>{
      function stop(){ loopActive=false; if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } }
      try{
        const detector = new BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128','qr_code']});
        stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
        const video = sheetEl.querySelector('#sc_video'); video.srcObject = stream; loopActive = true;
        (async function loop(){
          while(loopActive){
            try{ const codes = await detector.detect(video); if(codes.length){ stop(); closeSheet(); onResult(codes[0].rawValue); return; } }catch(e){}
            await new Promise(r=>setTimeout(r,300));
          }
        })();
      }catch(err){ toast('No se pudo acceder a la cámara'); }
      const obs = new MutationObserver(()=>{ if(!document.body.contains(sheetEl)){ stop(); obs.disconnect(); } });
      obs.observe(document.getElementById('modalRoot'), {childList:true});
    }
  });
}

/* ---------------------------------------------------------------------
   9. ENTRADA DE STOCK — Método A (manual) y Método B (factura simulada)
   --------------------------------------------------------------------- */
function openEntradaSheet(preselectId){
  let selected = preselectId ? prodById(preselectId) : null;
  const bodyId = 'entradaBody';
  const render2 = ()=> `
    <div class="form-stack" id="${bodyId}">
      <div class="field"><label>Producto</label>
        <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input id="e_search" placeholder="Buscar producto…" value="${selected?esc(selected.nombre):''}"></div>
        <div id="e_results" class="row-list" style="max-height:160px;overflow:auto"></div>
      </div>
      ${selected? entradaFormFields(selected) : ''}
    </div>`;
  function entradaFormFields(p){
    return `
      <div class="card-flat"><div class="muted">Stock actual</div><div class="num" style="font-size:20px;font-weight:700">${fmtNum(p.stockActual)} ${esc(p.unidad)}</div></div>
      <div class="field"><label>Cantidad a añadir</label>
        <div class="stepper">
          <button type="button" id="e_minus">−</button>
          <input id="e_cant" type="number" step="any" value="1" style="flex:1">
          <button type="button" id="e_plus">+</button>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Precio de compra (ud)</label><input id="e_precio" type="number" step="0.01" value="${p.precioCompra||''}"></div>
        <div class="field"><label>Proveedor</label><input id="e_proveedor" value="${esc(p.proveedor||'')}" list="provList"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Fecha</label><input id="e_fecha" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="field"><label>Lote</label><input id="e_lote" value="${esc(p.lote||'')}"></div>
      </div>
      <div class="field"><label>Caducidad (si aplica)</label><input id="e_caducidad" type="date" value="${p.caducidad||''}"></div>
      <div class="field"><label>Observaciones</label><textarea id="e_obs" placeholder="Opcional"></textarea></div>
      <div class="card-flat" style="display:flex;justify-content:space-between;align-items:center">
        <span class="muted">Stock resultante</span>
        <span class="num" id="e_resultado" style="font-size:19px;font-weight:700;color:var(--ok)">${fmtNum(p.stockActual+1)} ${esc(p.unidad)}</span>
      </div>
    `;
  }
  openSheet({
    title:'Entrada de stock — manual',
    bodyHtml: render2(),
    footHtml: `<button class="btn btn-primary btn-block" id="confirmEntradaBtn" ${selected?'':'disabled'}>Confirmar entrada</button>`,
    onMount:(sheetEl)=>{
      function wireSelectedControls(){
        const p = selected;
        const cantInput = sheetEl.querySelector('#e_cant');
        const resEl = sheetEl.querySelector('#e_resultado');
        function updateResult(){ const c=parseFloat(cantInput.value)||0; resEl.textContent = fmtNum(p.stockActual + c)+' '+p.unidad; }
        sheetEl.querySelector('#e_minus').addEventListener('click', ()=>{ cantInput.value = Math.max(0,(parseFloat(cantInput.value)||0)-1); updateResult(); });
        sheetEl.querySelector('#e_plus').addEventListener('click', ()=>{ cantInput.value = (parseFloat(cantInput.value)||0)+1; updateResult(); });
        cantInput.addEventListener('input', updateResult);
        sheetEl.querySelector('#confirmEntradaBtn').disabled = false;
      }
      function doSearch(q){
        const results = sheetEl.querySelector('#e_results');
        q = q.trim().toLowerCase();
        if(!q){ results.innerHTML=''; return; }
        const items = STATE.productos.filter(p=>p.nombre.toLowerCase().includes(q)).slice(0,6);
        results.innerHTML = items.map(p=>`<div class="item-row" data-pick="${p.id}" style="cursor:pointer"><div class="ic">${catEmoji(p.categoria)}</div><div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">Stock: ${fmtNum(p.stockActual)} ${esc(p.unidad)}</div></div></div>`).join('') || '<div class="muted" style="padding:6px">Sin resultados. Puedes crearlo en Inventario.</div>';
        results.querySelectorAll('[data-pick]').forEach(el=> el.addEventListener('click', ()=>{
          selected = prodById(el.dataset.pick);
          document.getElementById(bodyId).outerHTML = render2();
          wireSelectedControls();
          sheetEl.querySelector('#e_search').value = selected.nombre;
          sheetEl.querySelector('#e_results').innerHTML='';
        }));
      }
      sheetEl.querySelector('#e_search').addEventListener('input', e=>doSearch(e.target.value));
      if(selected) wireSelectedControls();
      sheetEl.querySelector('#confirmEntradaBtn').addEventListener('click', async ()=>{
        if(!selected) return;
        const cant = parseFloat(sheetEl.querySelector('#e_cant').value);
        if(!cant || cant<=0){ toast('Introduce una cantidad válida'); return; }
        const precio = parseFloat(sheetEl.querySelector('#e_precio').value)||0;
        const proveedor = sheetEl.querySelector('#e_proveedor').value.trim();
        const fecha = sheetEl.querySelector('#e_fecha').value;
        const lote = sheetEl.querySelector('#e_lote').value.trim();
        const caducidad = sheetEl.querySelector('#e_caducidad').value;
        const obs = sheetEl.querySelector('#e_obs').value.trim();
        // actualizar datos de referencia del producto si cambian
        if(proveedor) { selected.proveedor = proveedor; await ensureProveedor(proveedor); }
        if(precio) selected.precioCompra = precio;
        if(lote) selected.lote = lote;
        if(caducidad) selected.caducidad = caducidad;
        await put('productos', selected);
        await registrarMovimiento({productoId:selected.id, tipo:'entrada', cantidad:cant, motivo:'Entrada manual', observaciones:obs,
          extra:{proveedor, precioCompra:precio, lote, caducidadLote:caducidad, fechaOperacion:fecha}});
        closeSheet(); toast(`+${fmtNum(cant)} ${selected.unidad} añadidos a ${selected.nombre}`); render();
      });
    }
  });
}

/* Método B — factura mediante imagen: FACTURA → OCR/IA → PROPUESTA → REVISIÓN → CONFIRMAR
   Nota de arquitectura: el reconocimiento real de texto en imágenes de facturas variadas
   requiere un modelo de visión (fuera del alcance de una app 100% local/offline sin
   servidor). Esta pantalla implementa el FLUJO completo y lo deja listo para conectar un
   motor OCR/IA real: la imagen se guarda y pasa por PROPUESTA → REVISIÓN → CONFIRMAR
   igual que en producción; ahora mismo la "propuesta" se genera a partir de líneas de
   texto simples que el usuario puede pegar (modo manual-asistido) mientras no haya un
   proveedor de OCR conectado. Ningún dato toca el inventario sin pasar por Confirmar. */
function openFacturaSheet(){
  let imgDataUrl = null;
  let lineas = [];
  openSheet({
    title:'Escanear factura',
    bodyHtml: `
      <div class="form-stack">
        <div class="card-flat" style="text-align:center">
          <div style="font-size:13px;color:var(--ink-muted);margin-bottom:10px">Sube una foto de la factura, o pega el texto de las líneas manualmente (proveedor, fecha y productos con cantidad y precio).</div>
          <input type="file" id="f_img" accept="image/*" capture="environment" style="width:100%">
          <div id="imgPreviewWrap" style="margin-top:10px"></div>
        </div>
        <div class="field"><label>Proveedor</label><input id="f_prov" placeholder="Nombre del proveedor" list="provList"></div>
        <div class="grid2">
          <div class="field"><label>Fecha de factura</label><input id="f_fecha" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
          <div class="field"><label>Nº factura</label><input id="f_num" placeholder="Opcional"></div>
        </div>
        <div class="field"><label>Líneas de producto (una por línea: <span style="font-family:var(--font-mono)">nombre; cantidad; precio</span>)</label>
          <textarea id="f_lines" placeholder="Cerveza Estrella 33cl; 24; 0.55&#10;Coca-Cola 33cl; 12; 0.48" style="min-height:100px"></textarea>
        </div>
        <button class="btn btn-outline btn-block" id="parseBtn">Generar propuesta de productos</button>
      </div>
    `,
    footHtml: `<div class="tiny" style="flex:1">El inventario no se modifica hasta que confirmes la revisión.</div>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#f_img').addEventListener('change', e=>{
        const file = e.target.files[0]; if(!file) return;
        const reader = new FileReader();
        reader.onload = ()=>{ imgDataUrl = reader.result;
          sheetEl.querySelector('#imgPreviewWrap').innerHTML = `<img src="${imgDataUrl}" style="max-height:160px;border-radius:10px;border:1px solid var(--border)">`;
          toast('Imagen adjuntada. Completa las líneas de producto para generar la propuesta.');
        };
        reader.readAsDataURL(file);
      });
      sheetEl.querySelector('#parseBtn').addEventListener('click', ()=>{
        const raw = sheetEl.querySelector('#f_lines').value.trim();
        if(!raw){ toast('Añade al menos una línea de producto'); return; }
        lineas = raw.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{
          const [nombre, cant, precio] = l.split(';').map(x=>(x||'').trim());
          const {producto, confianza} = matchProducto(nombre);
          return { nombre: nombre||'(sin nombre)', cantidad: parseFloat(cant)||0, precio: parseFloat(precio)||0,
            productoId: producto? producto.id : null, esNuevo: !producto, confianza: producto? confianza : 0 };
        });
        const proveedor = sheetEl.querySelector('#f_prov').value.trim();
        const fecha = sheetEl.querySelector('#f_fecha').value;
        const numFactura = sheetEl.querySelector('#f_num').value.trim();
        closeSheet();
        openFacturaRevisionSheet({lineas, proveedor, fecha, numFactura, imgDataUrl});
      });
    }
  });
}
function openFacturaRevisionSheet(factura){
  function confBadge(l){
    if(l.esNuevo) return {cls:'warn', txt:'PRODUCTO NUEVO'};
    if(l.confianza>=0.95) return {cls:'ok', txt:'COINCIDENCIA EXACTA'};
    if(l.confianza>=0.7) return {cls:'info', txt:'COINCIDENCIA PROBABLE'};
    return {cls:'warn', txt:'COINCIDENCIA DUDOSA — revisa'};
  }
  function bodyHtml(){
    return `
      <div class="card-flat">
        <div class="grid2">
          <div><div class="tiny">PROVEEDOR</div><div style="font-weight:700">${esc(factura.proveedor||'Sin especificar')}</div></div>
          <div><div class="tiny">FECHA</div><div style="font-weight:700">${fmtDateShort(factura.fecha)}</div></div>
        </div>
      </div>
      <div class="row-list" id="revLines">
        ${factura.lineas.map((l,i)=>{ const cb=confBadge(l); const linked = l.productoId ? prodById(l.productoId) : null;
          return `
          <div class="item-row" data-line="${i}" style="cursor:pointer">
            <div class="ic">${l.esNuevo?'🆕':'✅'}</div>
            <div class="body">
              <div class="name">${esc(linked? linked.nombre : l.nombre)}</div>
              <div class="sub">${l.esNuevo? 'Se creará como producto nuevo · toca para vincular a uno existente' : 'Detectado: "'+esc(l.nombre)+'" · toca para cambiar'}</div>
            </div>
            <div class="right"><div class="n">${fmtNum(l.cantidad)}</div><div class="tiny">${money(l.precio)}/ud</div></div>
          </div>
          <div style="margin:-6px 0 4px 46px"><span class="badge ${cb.cls}">${cb.txt}</span></div>
          `;}).join('')}
      </div>
      <div class="card-flat" style="display:flex;justify-content:space-between"><span class="muted">Total factura (estimado)</span><span class="num" style="font-weight:700">${money(factura.lineas.reduce((s,l)=>s+l.cantidad*l.precio,0))}</span></div>
      <div class="tiny">Toca cualquier línea para corregirla o vincularla a otro producto. Solo al pulsar "Confirmar entrada" se actualizará el inventario.</div>
    `;
  }
  openSheet({
    title:'Revisar factura detectada',
    bodyHtml: bodyHtml(),
    footHtml: `<button class="btn btn-primary btn-block" id="confirmFacturaBtn">Confirmar entrada (${factura.lineas.length} líneas)</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelectorAll('[data-line]').forEach(el=> el.addEventListener('click', ()=>{
          const i = +el.dataset.line;
          openLineEditSheet(factura.lineas[i], (updatedLine)=>{ factura.lineas[i]=updatedLine; sheetEl.querySelector('.sheet-body').innerHTML=bodyHtml(); wire(); });
        }));
      }
      wire();
      sheetEl.querySelector('#confirmFacturaBtn').addEventListener('click', async ()=>{
        const facturaId = uid();
        const proveedor = await ensureProveedor(factura.proveedor);
        /* Bug real encontrado en Fase 8: la factura se guardaba (put) DESPUÉS
           de sus líneas (facturaLineas → invoice_items). Localmente no pasa
           nada (IndexedDB no tiene FK), pero al sincronizar, la cola procesa
           en el orden en que se encoló cada cambio — así que las líneas
           intentaban subirse a Supabase antes de que la factura existiera
           ahí, y el servidor las rechazaba por la clave foránea
           invoice_items_invoice_id_fkey. Se autorrecuperaba en el siguiente
           reintento (cuando la factura ya hubiera subido), pero es un fallo
           real e innecesario. Se guarda la factura primero para que quede
           encolada (y por tanto sincronizada) antes que sus líneas. */
        await put('facturas', {id:facturaId, proveedorId:proveedor?proveedor.id:null, proveedor:factura.proveedor, fecha:factura.fecha, numFactura:factura.numFactura,
          imgDataUrl:factura.imgDataUrl, lineas:factura.lineas, total:factura.lineas.reduce((s,l)=>s+l.cantidad*l.precio,0), creadaEn:nowISO()});
        for(const l of factura.lineas){
          let productoId = l.productoId;
          if(!productoId){
            const nuevo = {id:uid(), nombre:l.nombre, categoria:CATEGORIAS[0], marca:'', formato:'', unidad:'ud',
              stockActual:0, stockMin:0, stockMax:0, precioCompra:l.precio, proveedor:factura.proveedor, ubicacion:'', caducidad:'', lote:'', codigoBarras:'', observaciones:'Creado desde factura escaneada'};
            await put('productos', nuevo);
            await reloadAll();
            productoId = nuevo.id;
          }
          const mov = await registrarMovimiento({productoId, tipo:'entrada', cantidad:l.cantidad, motivo:'Entrada por factura',
            observaciones:`Factura ${factura.numFactura||''} · ${factura.proveedor||''}`.trim(),
            extra:{proveedor:factura.proveedor, precioCompra:l.precio, facturaId}});
          /* Fase 6G: la línea de factura pasa a ser también su propia
             entidad sincronizable (invoice_items), con trazabilidad
             completa factura → línea → producto → movimiento. El id se
             genera una sola vez aquí, así que reintentar la sincronización
             nunca duplica la línea (upsert por id es idempotente). */
          await put('facturaLineas', {id:uid(), facturaId, productoId, nombre:l.nombre, cantidad:l.cantidad, precio:l.precio,
            movimientoId:mov.id, esNuevoProducto: !l.productoId});
        }
        if(factura.imgDataUrl) await registrarAdjunto({entidadTipo:'invoices', entidadId:facturaId, dataUrl:factura.imgDataUrl});
        await reloadAll();
        closeSheet(); toast('Factura confirmada: inventario actualizado'); goTab('dashboard');
      });
    }
  });
}
function openLineEditSheet(line, onSave){
  openSheet({
    title:'Corregir línea',
    bodyHtml:`
      <div class="form-stack">
        <div class="field"><label>Producto detectado (edítalo si hace falta)</label>
          <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="le_search" value="${esc(line.nombre)}" placeholder="Nombre del producto"></div>
          <div id="le_results" class="row-list" style="max-height:130px;overflow:auto"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Cantidad</label><input id="le_cant" type="number" step="any" value="${line.cantidad}"></div>
          <div class="field"><label>Precio/ud</label><input id="le_precio" type="number" step="0.01" value="${line.precio}"></div>
        </div>
        <div class="tiny" id="le_linkInfo">${line.productoId? 'Vinculado a: '+esc(prodById(line.productoId)?.nombre||'') : 'Se creará como producto nuevo'}</div>
      </div>
    `,
    footHtml:`<button class="btn btn-primary btn-block" id="le_save">Guardar línea</button>`,
    onMount:(sheetEl)=>{
      let productoId = line.productoId;
      sheetEl.querySelector('#le_search').addEventListener('input', e=>{
        const q = e.target.value.trim().toLowerCase(); const res = sheetEl.querySelector('#le_results');
        if(!q){ res.innerHTML=''; return; }
        const items = STATE.productos.filter(p=>p.nombre.toLowerCase().includes(q)).slice(0,6);
        res.innerHTML = items.map(p=>`<div class="item-row" data-pick="${p.id}" style="cursor:pointer"><div class="ic">${catEmoji(p.categoria)}</div><div class="body"><div class="name">${esc(p.nombre)}</div></div></div>`).join('') || '<div class="muted" style="padding:6px">Sin coincidencias — se creará como producto nuevo</div>';
        res.querySelectorAll('[data-pick]').forEach(el=> el.addEventListener('click', ()=>{
          productoId = el.dataset.pick; const p = prodById(productoId);
          sheetEl.querySelector('#le_search').value = p.nombre;
          sheetEl.querySelector('#le_linkInfo').textContent = 'Vinculado a: '+p.nombre;
          res.innerHTML='';
        }));
      });
      sheetEl.querySelector('#le_save').addEventListener('click', ()=>{
        const nombre = sheetEl.querySelector('#le_search').value.trim();
        const cantidad = parseFloat(sheetEl.querySelector('#le_cant').value)||0;
        const precio = parseFloat(sheetEl.querySelector('#le_precio').value)||0;
        closeSheet();
        onSave({ nombre, cantidad, precio, productoId, esNuevo: !productoId, confianza: productoId?1:0 });
      });
    }
  });
}

/* ---------------------------------------------------------------------
   10. SALIDA / RETIRADA DE STOCK (incl. retirada rápida multi-producto)
   --------------------------------------------------------------------- */
function openSalidaSheet(preselectId){
  let selected = preselectId ? prodById(preselectId) : null;
  let motivo = null;
  function bodyHtml(){
    return `
      <div class="field"><label>Producto</label>
        <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input id="s_search" placeholder="Buscar producto…" value="${selected?esc(selected.nombre):''}"></div>
        <div id="s_results" class="row-list" style="max-height:160px;overflow:auto"></div>
      </div>
      ${selected? `
      <div class="card-flat"><div class="muted">Stock actual</div><div class="num" style="font-size:20px;font-weight:700">${fmtNum(selected.stockActual)} ${esc(selected.unidad)}</div></div>
      <div class="field"><label>Retirar</label>
        <div class="stepper">
          <button type="button" id="s_minus">−</button>
          <input id="s_cant" type="number" step="any" value="1" style="flex:1">
          <button type="button" id="s_plus">+</button>
        </div>
      </div>
      <div class="field"><label>Motivo</label>
        <div class="reason-grid" id="s_reasons">
          ${MOTIVOS_SALIDA.map(m=>`<button type="button" class="reason-btn" data-m="${esc(m)}">${esc(m)}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>Observaciones</label><textarea id="s_obs" placeholder="Opcional"></textarea></div>
      <div class="card-flat" style="display:flex;justify-content:space-between;align-items:center">
        <span class="muted">Stock resultante</span>
        <span class="num" id="s_resultado" style="font-size:19px;font-weight:700;color:var(--warn)">${fmtNum(selected.stockActual-1)} ${esc(selected.unidad)}</span>
      </div>
      ` : ''}
    `;
  }
  openSheet({
    title:'Retirar stock',
    bodyHtml: bodyHtml(),
    footHtml: `<button class="btn btn-outline" id="quickModeBtn">Retirada rápida</button><button class="btn btn-crit btn-block" id="confirmSalidaBtn" disabled>Confirmar retirada</button>`,
    onMount:(sheetEl)=>{
      function refreshBody(){ sheetEl.querySelector('.sheet-body').innerHTML = bodyHtml(); wire(); }
      function wire(){
        const results = sheetEl.querySelector('#s_results');
        sheetEl.querySelector('#s_search').addEventListener('input', e=>{
          const q = e.target.value.trim().toLowerCase();
          if(!q){ results.innerHTML=''; return; }
          const items = STATE.productos.filter(p=>p.nombre.toLowerCase().includes(q)).slice(0,6);
          results.innerHTML = items.map(p=>`<div class="item-row" data-pick="${p.id}" style="cursor:pointer"><div class="ic">${catEmoji(p.categoria)}</div><div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">Stock: ${fmtNum(p.stockActual)} ${esc(p.unidad)}</div></div></div>`).join('') || '<div class="muted" style="padding:6px">Sin resultados</div>';
          results.querySelectorAll('[data-pick]').forEach(el=> el.addEventListener('click', ()=>{ selected = prodById(el.dataset.pick); motivo=null; refreshBody(); }));
        });
        if(!selected) return;
        const cantInput = sheetEl.querySelector('#s_cant');
        const resEl = sheetEl.querySelector('#s_resultado');
        function updateResult(){ const c=parseFloat(cantInput.value)||0; resEl.textContent = fmtNum(selected.stockActual - c)+' '+selected.unidad; resEl.style.color = (selected.stockActual-c)<0 ? 'var(--crit)':'var(--warn)'; }
        sheetEl.querySelector('#s_minus').addEventListener('click', ()=>{ cantInput.value = Math.max(0.01,(parseFloat(cantInput.value)||0)-1); updateResult(); });
        sheetEl.querySelector('#s_plus').addEventListener('click', ()=>{ cantInput.value = (parseFloat(cantInput.value)||0)+1; updateResult(); });
        cantInput.addEventListener('input', updateResult);
        sheetEl.querySelector('#s_reasons').addEventListener('click', e=>{
          const b = e.target.closest('.reason-btn'); if(!b) return;
          sheetEl.querySelectorAll('.reason-btn').forEach(x=>x.classList.remove('sel'));
          b.classList.add('sel'); motivo = b.dataset.m;
          sheetEl.querySelector('#confirmSalidaBtn').disabled = false;
        });
      }
      wire();
      sheetEl.querySelector('#quickModeBtn').addEventListener('click', ()=>{ closeSheet(); openRetiradaRapidaSheet(); });
      sheetEl.querySelector('#confirmSalidaBtn').addEventListener('click', async ()=>{
        if(!selected || !motivo) return;
        const cant = parseFloat(sheetEl.querySelector('#s_cant').value);
        if(!cant || cant<=0){ toast('Introduce una cantidad válida'); return; }
        if(cant>selected.stockActual){ toast('No puedes retirar más de lo disponible'); return; }
        const obs = sheetEl.querySelector('#s_obs').value.trim();
        await registrarMovimiento({productoId:selected.id, tipo:'salida', cantidad:cant, motivo, observaciones:obs});
        closeSheet(); toast(`−${fmtNum(cant)} ${selected.unidad} de ${selected.nombre}`); render();
      });
    }
  });
}
/* Retirada rápida: varios productos consecutivos en una sola pantalla */
function openRetiradaRapidaSheet(){
  const cart = []; // {productoId, cantidad, motivo}
  function renderCart(){ return cart.map((c,i)=>{ const p=prodById(c.productoId);
    return `<div class="item-row"><div class="ic">${catEmoji(p.categoria)}</div><div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">${esc(c.motivo)}</div></div><div class="right"><div class="n" style="color:var(--warn)">−${fmtNum(c.cantidad)}</div></div><button class="btn-ghost" data-rm="${i}">✕</button></div>`;
  }).join('') || '<div class="muted" style="padding:8px 0">Añade productos a la lista de retirada.</div>'; }
  openSheet({
    title:'Retirada rápida',
    bodyHtml: `
      <div class="field"><label>Buscar y añadir producto</label>
        <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="qr_search" placeholder="Nombre del producto…"></div>
        <div id="qr_results" class="row-list" style="max-height:140px;overflow:auto"></div>
      </div>
      <div class="section-head"><h2>Lista de retirada</h2></div>
      <div class="row-list" id="qr_cart">${renderCart()}</div>
    `,
    footHtml: `<button class="btn btn-crit btn-block" id="qr_confirm" disabled>Confirmar todas las retiradas</button>`,
    onMount:(sheetEl)=>{
      function refreshCart(){ sheetEl.querySelector('#qr_cart').innerHTML = renderCart();
        sheetEl.querySelectorAll('[data-rm]').forEach(b=> b.addEventListener('click', ()=>{ cart.splice(+b.dataset.rm,1); refreshCart(); }));
        sheetEl.querySelector('#qr_confirm').disabled = cart.length===0;
      }
      sheetEl.querySelector('#qr_search').addEventListener('input', e=>{
        const q=e.target.value.trim().toLowerCase(); const res=sheetEl.querySelector('#qr_results');
        if(!q){res.innerHTML='';return;}
        const items = STATE.productos.filter(p=>p.nombre.toLowerCase().includes(q)).slice(0,6);
        res.innerHTML = items.map(p=>`<div class="item-row" data-pick="${p.id}" style="cursor:pointer"><div class="ic">${catEmoji(p.categoria)}</div><div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">Stock: ${fmtNum(p.stockActual)}</div></div></div>`).join('');
        res.querySelectorAll('[data-pick]').forEach(el=> el.addEventListener('click', ()=>{
          openMiniQty(prodById(el.dataset.pick), (cant,mot)=>{ cart.push({productoId:el.dataset.pick, cantidad:cant, motivo:mot}); refreshCart(); });
          sheetEl.querySelector('#qr_search').value=''; res.innerHTML='';
        }));
      });
      refreshCart();
      sheetEl.querySelector('#qr_confirm').addEventListener('click', async ()=>{
        for(const c of cart){ await registrarMovimiento({productoId:c.productoId, tipo:'salida', cantidad:c.cantidad, motivo:c.motivo, observaciones:'Retirada rápida'}); }
        closeSheet(); toast(`${cart.length} retiradas registradas`); render();
      });
    }
  });
}
function openMiniQty(p, onDone){
  let motivo = MOTIVOS_SALIDA[0];
  openSheet({
    title: p.nombre,
    bodyHtml: `
      <div class="card-flat"><div class="muted">Stock actual</div><div class="num" style="font-weight:700;font-size:19px">${fmtNum(p.stockActual)} ${esc(p.unidad)}</div></div>
      <div class="field"><label>Cantidad</label><div class="stepper"><button type="button" id="m_minus">−</button><input id="m_cant" type="number" value="1" step="any"><button type="button" id="m_plus">+</button></div></div>
      <div class="field"><label>Motivo</label><div class="reason-grid" id="m_reasons">${MOTIVOS_SALIDA.map((m,i)=>`<button type="button" class="reason-btn ${i===0?'sel':''}" data-m="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" id="m_add">Añadir a la lista</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#m_minus').addEventListener('click', ()=>{ const i=sheetEl.querySelector('#m_cant'); i.value=Math.max(0.01,(parseFloat(i.value)||0)-1); });
      sheetEl.querySelector('#m_plus').addEventListener('click', ()=>{ const i=sheetEl.querySelector('#m_cant'); i.value=(parseFloat(i.value)||0)+1; });
      sheetEl.querySelector('#m_reasons').addEventListener('click', e=>{ const b=e.target.closest('.reason-btn'); if(!b) return; sheetEl.querySelectorAll('.reason-btn').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); motivo=b.dataset.m; });
      sheetEl.querySelector('#m_add').addEventListener('click', ()=>{
        const cant = parseFloat(sheetEl.querySelector('#m_cant').value)||0;
        if(cant<=0){toast('Cantidad inválida');return;}
        closeSheet(); onDone(cant, motivo);
      });
    }
  });
}

/* ---------------------------------------------------------------------
   11. MERMAS
   --------------------------------------------------------------------- */
function openMermaSheet(preselectId){
  let selected = preselectId ? prodById(preselectId) : null;
  let motivo = null; let fotoData = null;
  function bodyHtml(){
    return `
      <div class="field"><label>Producto</label>
        <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="me_search" placeholder="Buscar producto…" value="${selected?esc(selected.nombre):''}"></div>
        <div id="me_results" class="row-list" style="max-height:150px;overflow:auto"></div>
      </div>
      ${selected? `
      <div class="card-flat"><div class="muted">Stock actual</div><div class="num" style="font-size:19px;font-weight:700">${fmtNum(selected.stockActual)} ${esc(selected.unidad)}</div></div>
      <div class="field"><label>Cantidad perdida</label><div class="stepper"><button type="button" id="me_minus">−</button><input id="me_cant" type="number" value="1" step="any"><button type="button" id="me_plus">+</button></div></div>
      <div class="field"><label>Motivo</label><div class="reason-grid" id="me_reasons">${MOTIVOS_MERMA.map(m=>`<button type="button" class="reason-btn" data-m="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>
      <div class="field"><label>Fotografía (opcional)</label><input type="file" id="me_foto" accept="image/*" capture="environment"><div id="me_fotoPrev"></div></div>
      <div class="field"><label>Observaciones</label><textarea id="me_obs"></textarea></div>
      ` : ''}
    `;
  }
  openSheet({
    title:'Registrar merma',
    bodyHtml: bodyHtml(),
    footHtml: `<button class="btn btn-crit btn-block" id="me_confirm" disabled>Registrar merma</button>`,
    onMount:(sheetEl)=>{
      function refresh(){ sheetEl.querySelector('.sheet-body').innerHTML = bodyHtml(); wire(); }
      function wire(){
        sheetEl.querySelector('#me_search').addEventListener('input', e=>{
          const q=e.target.value.trim().toLowerCase(); const res=sheetEl.querySelector('#me_results');
          if(!q){res.innerHTML='';return;}
          const items = STATE.productos.filter(p=>p.nombre.toLowerCase().includes(q)).slice(0,6);
          res.innerHTML = items.map(p=>`<div class="item-row" data-pick="${p.id}" style="cursor:pointer"><div class="ic">${catEmoji(p.categoria)}</div><div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">Stock: ${fmtNum(p.stockActual)}</div></div></div>`).join('');
          res.querySelectorAll('[data-pick]').forEach(el=> el.addEventListener('click', ()=>{ selected=prodById(el.dataset.pick); motivo=null; fotoData=null; refresh(); }));
        });
        if(!selected) return;
        const cantInput = sheetEl.querySelector('#me_cant');
        sheetEl.querySelector('#me_minus').addEventListener('click', ()=>{ cantInput.value=Math.max(0.01,(parseFloat(cantInput.value)||0)-1); });
        sheetEl.querySelector('#me_plus').addEventListener('click', ()=>{ cantInput.value=(parseFloat(cantInput.value)||0)+1; });
        sheetEl.querySelector('#me_reasons').addEventListener('click', e=>{ const b=e.target.closest('.reason-btn'); if(!b) return; sheetEl.querySelectorAll('.reason-btn').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); motivo=b.dataset.m; sheetEl.querySelector('#me_confirm').disabled=false; });
        sheetEl.querySelector('#me_foto').addEventListener('change', e=>{
          const f=e.target.files[0]; if(!f) return; const r=new FileReader();
          r.onload=()=>{ fotoData=r.result; sheetEl.querySelector('#me_fotoPrev').innerHTML=`<img src="${fotoData}" style="max-height:120px;border-radius:9px;margin-top:8px">`; };
          r.readAsDataURL(f);
        });
      }
      wire();
      sheetEl.querySelector('#me_confirm').addEventListener('click', async ()=>{
        if(!selected||!motivo) return;
        const cant = parseFloat(sheetEl.querySelector('#me_cant').value);
        if(!cant||cant<=0){toast('Cantidad inválida');return;}
        if(cant>selected.stockActual){toast('La cantidad supera el stock disponible');return;}
        const obs = sheetEl.querySelector('#me_obs').value.trim();
        const mov = await registrarMovimiento({productoId:selected.id, tipo:'merma', cantidad:cant, motivo, observaciones:obs, extra:{foto:fotoData}});
        /* Fase 6H: la merma pasa a tener también su propio registro
           sincronizable (waste_records), enlazado al movimiento de stock
           que generó — no sustituye al movimiento (que sigue siendo la
           fuente de verdad del stock), es trazabilidad adicional. */
        const mermaId = uid();
        await put('mermaRegistros', {id:mermaId, productoId:selected.id, cantidad:cant, motivo, fecha:nowISO(), usuario:STATE.usuario, movimientoId:mov.id});
        if(fotoData) await registrarAdjunto({entidadTipo:'waste_records', entidadId:mermaId, dataUrl:fotoData});
        closeSheet(); toast(`Merma registrada: −${fmtNum(cant)} ${selected.unidad}`); render();
      });
    }
  });
}

/* ---------------------------------------------------------------------
   12. TEMPERATURAS
   --------------------------------------------------------------------- */
function renderTemperaturas(root){
  root.innerHTML = `
    <div class="page-head"><h1 style="font-size:20px">Temperaturas</h1></div>
    <div class="row-list" id="eqList"></div>
    <button class="btn btn-outline btn-block" id="addEquipoBtn">+ Añadir equipo</button>
    <div class="card">
      <div class="section-head"><h2>Mermas — resumen</h2></div>
      ${mermaStatsHtml()}
    </div>
  `;
  const eqList = root.querySelector('#eqList');
  eqList.innerHTML = STATE.equipos.length ? STATE.equipos.map(eq=>{
    const last = STATE.temperaturas.find(t=>t.equipoId===eq.id);
    const fuera = last && last.fueraDeRango;
    return `<div class="item-row" data-eq="${eq.id}" style="cursor:pointer">
      <div class="ic">${eq.tipo==='Congelador'?'❄️':'🌡️'}</div>
      <div class="body"><div class="name">${esc(eq.nombre)}</div><div class="sub">${esc(eq.ubicacion)} · límites ${eq.tempMin}–${eq.tempMax}°C</div></div>
      <div class="right"><div class="n" style="color:${fuera?'var(--crit)':'var(--ok)'}">${last?last.temperatura+'°C':'—'}</div>
      <span class="badge ${fuera?'crit':(last?'ok':'neutral')}">${fuera?'FUERA DE RANGO':(last?'EN RANGO':'SIN LECTURAS')}</span></div>
    </div>`;
  }).join('') : `<div class="empty"><svg viewBox="0 0 24 24"><path d="M10 13.5V4a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0Z"/></svg><div>Sin equipos configurados</div></div>`;
  eqList.querySelectorAll('[data-eq]').forEach(el=> el.addEventListener('click', ()=>openEquipoDetail(el.dataset.eq)));
  root.querySelector('#addEquipoBtn').addEventListener('click', openEquipoFormSheet);
}
function mermaStatsHtml(){
  const now = new Date();
  const weekAgo = new Date(now-7*86400000);
  const monthAgo = new Date(now-30*86400000);
  const mermas = STATE.movimientos.filter(m=>m.tipo==='merma');
  const wk = mermas.filter(m=>new Date(m.fecha)>=weekAgo);
  const mo = mermas.filter(m=>new Date(m.fecha)>=monthAgo);
  const valorSemana = wk.reduce((s,m)=>{ const p=prodById(m.productoId); return s+(p?p.precioCompra*m.cantidad:0); },0);
  const porProducto = {};
  mo.forEach(m=>{ porProducto[m.productoId]=(porProducto[m.productoId]||0)+m.cantidad; });
  const top = Object.entries(porProducto).sort((a,b)=>b[1]-a[1]).slice(0,3);
  return `
    <div class="grid2" style="margin-top:8px">
      <div class="card-flat"><div class="tiny">ESTA SEMANA</div><div class="num" style="font-weight:700;font-size:18px">${wk.length} <span style="font-size:12px;font-weight:500">mermas</span></div><div class="tiny">≈ ${money(valorSemana)}</div></div>
      <div class="card-flat"><div class="tiny">ESTE MES</div><div class="num" style="font-weight:700;font-size:18px">${mo.length} <span style="font-size:12px;font-weight:500">mermas</span></div></div>
    </div>
    ${top.length? `<div style="margin-top:10px"><div class="tiny" style="margin-bottom:6px">PRODUCTOS CON MÁS MERMA (30 días)</div>
      <div class="row-list">${top.map(([pid,c])=>{const p=prodById(pid); return `<div class="item-row"><div class="ic">${p?catEmoji(p.categoria):'📦'}</div><div class="body"><div class="name">${p?esc(p.nombre):'—'}</div></div><div class="right n">−${fmtNum(c)}</div></div>`;}).join('')}</div></div>` : ''}
  `;
}
function openEquipoFormSheet(){
  if(!requirePerm('equipos', 'Solo Encargado/Administrador pueden configurar equipos')) return;
  openSheet({
    title:'Nuevo equipo',
    bodyHtml:`
      <div class="form-stack">
        <div class="field"><label>Nombre</label><input id="eq_nombre" placeholder="Nevera bebidas"></div>
        <div class="grid2">
          <div class="field"><label>Tipo</label><select id="eq_tipo"><option>Nevera</option><option>Congelador</option><option>Cámara frigorífica</option><option>Otro</option></select></div>
          <div class="field"><label>Ubicación</label><input id="eq_ubi" placeholder="Barra, cocina…"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Temp. mínima (°C)</label><input id="eq_min" type="number" step="any" value="2"></div>
          <div class="field"><label>Temp. máxima (°C)</label><input id="eq_max" type="number" step="any" value="8"></div>
        </div>
        <div class="field"><label>Observaciones</label><textarea id="eq_obs"></textarea></div>
      </div>`,
    footHtml:`<button class="btn btn-primary btn-block" id="eq_save">Crear equipo</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#eq_save').addEventListener('click', async ()=>{
        const nombre = sheetEl.querySelector('#eq_nombre').value.trim();
        if(!nombre){toast('El nombre es obligatorio');return;}
        const eq = {id:uid(), nombre, tipo:sheetEl.querySelector('#eq_tipo').value, ubicacion:sheetEl.querySelector('#eq_ubi').value.trim(),
          tempMin:parseFloat(sheetEl.querySelector('#eq_min').value), tempMax:parseFloat(sheetEl.querySelector('#eq_max').value),
          estado:'Operativo', observaciones:sheetEl.querySelector('#eq_obs').value.trim()};
        await put('equipos', eq); await reloadAll(); closeSheet(); toast('Equipo creado'); render();
      });
    }
  });
}
function openEquipoDetail(id){
  const eq = equipoById(id);
  const logs = STATE.temperaturas.filter(t=>t.equipoId===id).slice(0,12);
  const sparkData = logs.slice(0,10).reverse();
  const maxT = Math.max(...sparkData.map(l=>l.temperatura), eq.tempMax, 1);
  const minT = Math.min(...sparkData.map(l=>l.temperatura), eq.tempMin, 0);
  const range = (maxT-minT)||1;
  openSheet({
    title: eq.nombre,
    bodyHtml:`
      <div class="card-flat"><div class="grid2">
        <div><div class="tiny">TIPO</div><div style="font-weight:700">${esc(eq.tipo)}</div></div>
        <div><div class="tiny">UBICACIÓN</div><div style="font-weight:700">${esc(eq.ubicacion||'—')}</div></div>
        <div><div class="tiny">LÍMITE MÍN.</div><div style="font-weight:700">${eq.tempMin}°C</div></div>
        <div><div class="tiny">LÍMITE MÁX.</div><div style="font-weight:700">${eq.tempMax}°C</div></div>
      </div></div>
      ${sparkData.length? `<div class="card-flat"><div class="tiny" style="margin-bottom:8px">ÚLTIMAS LECTURAS</div>
        <div class="spark">${sparkData.map(l=>{ const h=6+((l.temperatura-minT)/range)*40; return `<div style="height:${h}px;background:${l.fueraDeRango?'var(--crit)':'var(--ok)'}"></div>`; }).join('')}</div></div>`:''}
      <div class="section-head"><h2>Historial de lecturas</h2></div>
      <div class="row-list">${logs.length? logs.map(l=>`
        <div class="item-row"><div class="ic">${l.fueraDeRango?'⚠️':'✓'}</div>
          <div class="body"><div class="name">${l.temperatura}°C</div><div class="sub">${fmtDate(l.fecha)} · ${esc(l.usuario)}${l.accionCorrectiva?' · Acción: '+esc(l.accionCorrectiva):''}</div></div>
          <span class="badge ${l.fueraDeRango?'crit':'ok'}">${l.fueraDeRango?'FUERA':'OK'}</span>
        </div>`).join('') : '<div class="muted" style="padding:8px 0">Sin lecturas todavía.</div>'}
      </div>
    `,
    footHtml:`<button class="btn btn-primary btn-block" id="logTempBtn">Registrar temperatura</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#logTempBtn').addEventListener('click', ()=>{ closeSheet(); openTempLogSheet(id); });
    }
  });
}
function openTempLogSheet(preselectEquipoId){
  let equipoId = preselectEquipoId || (STATE.equipos[0] && STATE.equipos[0].id);
  if(!equipoId){ toast('Primero crea un equipo en la sección Temperaturas'); return; }
  openSheet({
    title:'Registrar temperatura',
    bodyHtml:`
      <div class="form-stack">
        <div class="field"><label>Equipo</label><select id="t_equipo">${STATE.equipos.map(e=>`<option value="${e.id}" ${e.id===equipoId?'selected':''}>${esc(e.nombre)}</option>`).join('')}</select></div>
        <div class="field"><label>Temperatura (°C)</label><input id="t_valor" type="number" step="0.1" placeholder="Ej. 6.5"></div>
        <div id="t_alertZone"></div>
        <div class="field"><label>Observaciones</label><textarea id="t_obs" placeholder="Opcional"></textarea></div>
      </div>`,
    footHtml:`<button class="btn btn-primary btn-block" id="t_save">Guardar lectura</button>`,
    onMount:(sheetEl)=>{
      function checkRange(){
        const eq = equipoById(sheetEl.querySelector('#t_equipo').value);
        const v = parseFloat(sheetEl.querySelector('#t_valor').value);
        const zone = sheetEl.querySelector('#t_alertZone');
        if(isNaN(v)){ zone.innerHTML=''; return; }
        const fuera = v < eq.tempMin || v > eq.tempMax;
        zone.innerHTML = fuera ? `
          <div class="card-flat" style="border:1.5px solid var(--crit);background:var(--crit-soft)">
            <div style="font-weight:700;color:var(--crit);margin-bottom:6px">⚠ FUERA DE RANGO (límite ${eq.tempMin}–${eq.tempMax}°C)</div>
            <div class="field"><label>Acción correctiva realizada</label><textarea id="t_accion" placeholder="Ej. Se revisó que la puerta estuviera correctamente cerrada y se volvió a comprobar la temperatura."></textarea></div>
          </div>` : `<div class="card-flat" style="border:1.5px solid var(--ok);background:var(--ok-soft);color:var(--ok);font-weight:700">✓ Dentro de rango</div>`;
      }
      sheetEl.querySelector('#t_equipo').addEventListener('change', checkRange);
      sheetEl.querySelector('#t_valor').addEventListener('input', checkRange);
      sheetEl.querySelector('#t_save').addEventListener('click', async ()=>{
        const eqId = sheetEl.querySelector('#t_equipo').value;
        const eq = equipoById(eqId);
        const v = parseFloat(sheetEl.querySelector('#t_valor').value);
        if(isNaN(v)){ toast('Introduce una temperatura válida'); return; }
        const fuera = v<eq.tempMin || v>eq.tempMax;
        const accionEl = sheetEl.querySelector('#t_accion');
        if(fuera && (!accionEl || !accionEl.value.trim())){ toast('Describe la acción correctiva antes de guardar'); return; }
        const log = {id:uid(), equipoId:eqId, temperatura:v, fecha:nowISO(), usuario:STATE.usuario,
          observaciones: sheetEl.querySelector('#t_obs').value.trim(), fueraDeRango:fuera, accionCorrectiva: fuera? accionEl.value.trim() : ''};
        await put('temperaturas', log); await reloadAll();
        closeSheet(); toast(fuera? 'Incidencia de temperatura registrada' : 'Temperatura guardada'); render();
      });
      checkRange();
    }
  });
}

/* ---------------------------------------------------------------------
   13. HISTORIAL (trazabilidad completa)
   --------------------------------------------------------------------- */
let histFilter = 'todos';
function renderHistorial(root){
  const types = [['todos','Todos'],['entrada','Entradas'],['salida','Salidas'],['merma','Mermas'],['ajuste','Ajustes'],['temp','Temperaturas']];
  root.innerHTML = `
    <div class="page-head"><h1 style="font-size:20px">Historial</h1></div>
    <div class="chip-row">${types.map(([k,l])=>`<button class="chip ${histFilter===k?'active':''}" data-h="${k}">${l}</button>`).join('')}</div>
    <div class="card" id="histCard"></div>
  `;
  function draw(){
    let entries = [];
    if(histFilter==='todos' || histFilter!=='temp'){
      STATE.movimientos.filter(m=>histFilter==='todos'||m.tipo===histFilter).forEach(m=>entries.push({kind:'mov',data:m,fecha:m.fecha}));
    }
    if(histFilter==='todos' || histFilter==='temp'){
      STATE.temperaturas.forEach(t=>entries.push({kind:'temp',data:t,fecha:t.fecha}));
    }
    entries.sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''));
    entries = entries.slice(0,80);
    const card = root.querySelector('#histCard');
    card.innerHTML = entries.length ? entries.map(e=>{
      if(e.kind==='temp'){ const t=e.data; const eq=equipoById(t.equipoId);
        return `<div class="hist-row"><div class="hist-dot" style="background:${t.fueraDeRango?'var(--crit)':'var(--ok)'}"></div>
          <div class="hist-body"><div class="hist-top"><span class="hist-title">🌡️ ${esc(eq?eq.nombre:'Equipo')}</span><span class="hist-delta">${t.temperatura}°C</span></div>
          <div class="hist-meta">${fmtDate(t.fecha)} · ${esc(t.usuario)}${t.fueraDeRango?' · Incidencia registrada':''}</div></div></div>`;
      }
      const m=e.data; const p=prodById(m.productoId);
      const cfg = {entrada:{c:'var(--ok)',sign:'+',ic:'⬇️'},salida:{c:'var(--warn)',sign:'−',ic:'⬆️'},merma:{c:'var(--crit)',sign:'−',ic:'⚠️'},ajuste:{c:'var(--info)',sign:'',ic:'🧮'}}[m.tipo];
      return `<div class="hist-row"><div class="hist-dot" style="background:${cfg.c}"></div>
        <div class="hist-body"><div class="hist-top"><span class="hist-title">${cfg.ic} ${esc(p?p.nombre:'Producto eliminado')}</span><span class="hist-delta" style="color:${cfg.c}">${cfg.sign}${fmtNum(m.cantidad)}</span></div>
        <div class="hist-meta">${fmtDate(m.fecha)} · ${esc(m.motivo)} · ${esc(m.usuario)} · stock ${fmtNum(m.stockAnterior)}→${fmtNum(m.stockPosterior)}</div></div></div>`;
    }).join('') : `<div class="empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg><div>Sin registros en este filtro</div></div>`;
  }
  draw();
  root.querySelectorAll('[data-h]').forEach(b=> b.addEventListener('click', ()=>{ histFilter=b.dataset.h; renderHistorial(root); }));
}

/* ---------------------------------------------------------------------
   14. "MÁS" — usuario, backup/restore, roadmap de fases siguientes
   --------------------------------------------------------------------- */
function renderMas(root){
  root.innerHTML = `
    <div class="page-head"><h1 style="font-size:20px">Más</h1></div>
    <div class="card">
      <div class="section-head"><h2>Usuario activo</h2><button class="link-btn" id="switchUserBtn">Cambiar</button></div>
      <div class="item-row" style="margin-top:8px"><div class="ic">${STATE.usuario[0].toUpperCase()}</div><div class="body"><div class="name">${esc(STATE.usuario)}</div><div class="sub">Cada movimiento registrado queda asociado a este usuario</div></div><span class="badge ${rolBadgeCls(STATE.currentRol)}">${STATE.currentRol}</span></div>
    </div>
    <div class="card">
      <div class="section-head"><h2>Operaciones diarias</h2></div>
      <div class="row-list" style="margin-top:8px">
        <div class="item-row" id="goChecklists" style="cursor:pointer"><div class="ic">✅</div><div class="body"><div class="name">Checklists de apertura y cierre</div><div class="sub">${STATE.checklists.length} plantillas configuradas</div></div></div>
        <div class="item-row" id="goMantenimiento" style="cursor:pointer"><div class="ic">🧽</div><div class="body"><div class="name">Limpieza y mantenimiento</div><div class="sub">${STATE.tareasMantenimiento.filter(t=>daysUntil(t.proximaRealizacion)<=0 && t.ultimaRealizacion!==new Date().toISOString().slice(0,10)).length} tarea(s) pendientes</div></div></div>
        <div class="item-row" id="goIncidencias" style="cursor:pointer"><div class="ic">🛠️</div><div class="body"><div class="name">Incidencias</div><div class="sub">${STATE.incidencias.filter(i=>i.estado!=='RESUELTA').length} abierta(s) / ${STATE.incidencias.length} total</div></div></div>
      </div>
    </div>
    ${can('reportes')||can('analitica') ? `
    <div class="card">
      <div class="section-head"><h2>Informes</h2></div>
      <div class="row-list" style="margin-top:8px">
        ${can('reportes')?`<div class="item-row" id="goReportes" style="cursor:pointer"><div class="ic">📊</div><div class="body"><div class="name">Reportes semanales</div><div class="sub">Genera y exporta el informe de la semana</div></div></div>`:''}
        ${can('analitica')?`<div class="item-row" id="goAnalitica" style="cursor:pointer"><div class="ic">📈</div><div class="body"><div class="name">Analítica</div><div class="sub">Valor de inventario, tendencias y rotación</div></div></div>`:''}
      </div>
    </div>` : ''}
    ${can('proveedores') ? `
    <div class="card">
      <div class="section-head"><h2>Proveedores</h2><button class="link-btn" id="goProveedores">Gestionar</button></div>
      <div class="muted" style="margin-top:4px">${STATE.proveedores.length} proveedores guardados. Se vinculan a entradas de stock y facturas.</div>
    </div>` : ''}
    ${can('usuarios')||can('seguridad') ? `
    <div class="card">
      <div class="section-head"><h2>Usuarios y seguridad</h2></div>
      <div class="row-list" style="margin-top:8px">
        ${can('usuarios')?`<div class="item-row" id="goUsuarios" style="cursor:pointer"><div class="ic">👥</div><div class="body"><div class="name">Gestionar usuarios</div><div class="sub">${STATE.usuarios.length} usuario(s) · roles y PIN</div></div></div>`:''}
      </div>
      ${can('seguridad')? securityCardHtml() : ''}
    </div>` : ''}
    ${window.SB && window.SB.isConfigured ? `
    <!-- Bug real encontrado en Fase 8: la cuenta de Supabase (y "Cerrar
         sesión") vivía SOLO dentro de la tarjeta "Usuarios y seguridad",
         que se oculta por completo salvo para el rol ADMINISTRADOR (ver
         PERMISOS_POR_ROL). Un usuario con rol Encargado o Empleado —
         perfiles habituales del día a día — nunca podía ver esa tarjeta,
         así que no había forma de cerrar sesión de la cuenta Supabase (por
         ejemplo, para cambiar entre dos negocios) sin ser Administrador.
         Cerrar sesión es una acción de dispositivo/sesión, no un permiso
         de gestión del catálogo, así que se separa en su propia tarjeta
         siempre visible, sin depender del rol local. */ -->
    <div class="card">
      <div class="section-head"><h2>Cuenta Supabase</h2></div>
      ${supabaseAccountHtml()}
    </div>` : ''}
    <div class="card">
      <div class="section-head"><h2>Copia de seguridad</h2></div>
      <div class="muted" style="margin-top:4px">Exporta todos los datos como JSON para guardarlos fuera de este dispositivo, o restaura una copia anterior.</div>
      <div class="fab-row" style="margin-top:10px">
        <button class="btn btn-outline" style="flex:1" id="exportBtn">Exportar copia</button>
        <button class="btn btn-outline" style="flex:1" id="importBtn">Importar copia</button>
      </div>
      <input type="file" id="importFile" accept="application/json" style="display:none">
    </div>
    <div class="card">
      <div class="section-head"><h2>Datos guardados</h2></div>
      <div class="grid2" style="margin-top:8px">
        <div class="card-flat"><div class="tiny">PRODUCTOS</div><div class="num" style="font-weight:700;font-size:18px">${STATE.productos.length}</div></div>
        <div class="card-flat"><div class="tiny">MOVIMIENTOS</div><div class="num" style="font-weight:700;font-size:18px">${STATE.movimientos.length}</div></div>
        <div class="card-flat"><div class="tiny">EQUIPOS</div><div class="num" style="font-weight:700;font-size:18px">${STATE.equipos.length}</div></div>
        <div class="card-flat"><div class="tiny">LECTURAS TEMP.</div><div class="num" style="font-weight:700;font-size:18px">${STATE.temperaturas.length}</div></div>
        <div class="card-flat"><div class="tiny">CHECKLISTS COMPLETADOS</div><div class="num" style="font-weight:700;font-size:18px">${STATE.checklistRegistros.length}</div></div>
        <div class="card-flat"><div class="tiny">INCIDENCIAS</div><div class="num" style="font-weight:700;font-size:18px">${STATE.incidencias.length}</div></div>
      </div>
      <div class="tiny" style="margin-top:10px">Todo se guarda en la memoria local de este dispositivo (IndexedDB) y persiste al cerrar la app o reiniciar el teléfono. No requiere conexión a Internet.</div>
    </div>
    <div class="card">
      <!-- Bug real encontrado en Fase 8: este texto databa de antes de que
           la sincronización real con Supabase existiera (Fase 6+) y se
           quedó diciendo "no activo" / "no hay sincronización en tiempo
           real" incluso con Supabase configurado y funcionando — texto
           falso en producción que puede confundir a quien lo lea. Ahora
           el título y el texto reflejan si hay sincronización real activa
           o no, sin tocar nada del comportamiento real de sincronización. -->
      <div class="section-head"><h2>Sincronización${window.SB && window.SB.isConfigured ? '' : ' (preparado, no activo)'}</h2></div>
      <div class="muted" style="margin-top:4px">${window.SB && window.SB.isConfigured
        ? 'Sincronización en tiempo real activa con Supabase: los cambios se suben y bajan automáticamente entre dispositivos en cuanto hay conexión. Cada dato tiene un identificador único y fecha para resolver conflictos.'
        : 'Cada dato tiene un identificador único y fecha, listo para una futura sincronización con un servidor. Ahora mismo no hay sincronización en tiempo real entre dispositivos: usa "Exportar copia" / "Importar copia" para trasladar los datos a otro teléfono.'}</div>
      <div class="card-flat" style="margin-top:8px"><div class="tiny">ID DE ESTE DISPOSITIVO</div><div class="num" style="font-size:12px;word-break:break-all">${esc(STATE.deviceId||'—')}</div></div>
    </div>
    <div class="card">
      <div class="section-head"><h2>Estado de fases</h2></div>
      <div class="row-list" style="margin-top:8px">
        ${roadmapRow('✅ Fase 1', 'Dashboard, productos, inventario, entradas, salidas, mermas, temperaturas, historial')}
        ${roadmapRow('✅ Fase 2', 'Proveedores, caducidades, inventario físico, código de barras y revisión de facturas mejorada')}
        ${roadmapRow('✅ Fase 3', 'Checklists de apertura/cierre, limpieza y mantenimiento, incidencias, reportes semanales')}
        ${roadmapRow('🟡 Fase 4', 'Usuarios con roles, PIN local y analítica ya activos. Sincronización en la nube y multi-dispositivo en vivo requieren un servidor — no son posibles dentro de este artifact; el modelo de datos ya está preparado para ello')}
      </div>
    </div>
  `;
  root.querySelector('#switchUserBtn').addEventListener('click', openUserSwitchSheet);
  root.querySelector('#exportBtn').addEventListener('click', openExportSheet);
  root.querySelector('#importBtn').addEventListener('click', ()=> root.querySelector('#importFile').click());
  root.querySelector('#importFile').addEventListener('change', handleImportFile);
  root.querySelector('#goChecklists').addEventListener('click', openChecklistsListSheet);
  root.querySelector('#goMantenimiento').addEventListener('click', openMantenimientoListSheet);
  root.querySelector('#goIncidencias').addEventListener('click', openIncidenciasListSheet);
  const goReportesBtn = root.querySelector('#goReportes'); if(goReportesBtn) goReportesBtn.addEventListener('click', openReporteSemanalSheet);
  const goAnaliticaBtn = root.querySelector('#goAnalitica'); if(goAnaliticaBtn) goAnaliticaBtn.addEventListener('click', openAnaliticaSheet);
  const goProveedoresBtn = root.querySelector('#goProveedores'); if(goProveedoresBtn) goProveedoresBtn.addEventListener('click', openProveedoresListSheet);
  const goUsuariosBtn = root.querySelector('#goUsuarios'); if(goUsuariosBtn) goUsuariosBtn.addEventListener('click', openUsuariosListSheet);
  wireSecurityCard(root);
  wireAccountCard(root);
}
function securityCardHtml(){
  return `
    <div class="divider" style="margin:12px 0"></div>
    <div class="tiny" style="margin-bottom:6px">BLOQUEO DE LA APP</div>
    <label class="item-row" style="cursor:pointer">
      <input type="checkbox" id="sec_pinToggle" style="width:18px;height:18px;accent-color:var(--accent)">
      <div class="body"><div class="name" style="font-weight:600">Pedir PIN al abrir la app</div><div class="sub" id="sec_pinStatus">Comprobando…</div></div>
    </label>
    <div id="sec_pinSetZone" style="display:none;margin-top:8px" class="field"><label>Nuevo PIN (4 dígitos)</label><div class="fab-row"><input id="sec_pinValue" inputmode="numeric" maxlength="4" style="flex:1"><button type="button" class="btn btn-outline" id="sec_pinSave">Guardar</button></div></div>
    ${!(window.SB && window.SB.isConfigured) ? `
    <div class="divider" style="margin:12px 0"></div>
    <div class="tiny">SINCRONIZACIÓN</div>
    <div class="muted" style="margin-top:2px">Supabase no está configurado (config.js vacío) — la app funciona 100% local.</div>
    ` : ''}
  `;
}
/* Cuenta Supabase + "Cerrar sesión" — separada de securityCardHtml() para
   que sea visible con cualquier rol local (ver comentario en renderMas()). */
function supabaseAccountHtml(){
  return `
    <div id="sec_authInfo" class="muted">Comprobando sesión…</div>
    <button class="btn btn-outline btn-block" style="margin-top:8px" id="sec_signOut">Cerrar sesión</button>
  `;
}
function wireSecurityCard(root){
  const toggle = root.querySelector('#sec_pinToggle'); if(!toggle) return;
  const statusEl = root.querySelector('#sec_pinStatus');
  const setZone = root.querySelector('#sec_pinSetZone');
  getConfig('appPin').then(pin=>{
    toggle.checked = !!pin;
    statusEl.textContent = pin ? 'Activado — se pedirá PIN al abrir la app' : 'Desactivado';
  });
  toggle.addEventListener('change', async ()=>{
    if(toggle.checked){ setZone.style.display='block'; }
    else{ await setConfig('appPin', ''); statusEl.textContent='Desactivado'; setZone.style.display='none'; toast('Bloqueo por PIN desactivado'); }
  });
  root.querySelector('#sec_pinSave').addEventListener('click', async ()=>{
    const v = root.querySelector('#sec_pinValue').value.trim();
    if(!/^\d{4}$/.test(v)){ toast('El PIN debe tener 4 dígitos'); return; }
    await setConfig('appPin', await hashPin(v)); statusEl.textContent='Activado — se pedirá PIN al abrir la app'; setZone.style.display='none';
    toast('PIN de la app guardado');
  });
}
function wireAccountCard(root){
  const authInfo = root.querySelector('#sec_authInfo');
  if(authInfo && window.SB && window.SB.isConfigured){
    getConfig('authProfile').then(profile=>{
      authInfo.textContent = profile ? `Conectado como ${profile.email} (${profile.role})` : 'Sin sesión — trabajando en local';
    });
    const signOutBtn = root.querySelector('#sec_signOut');
    if(signOutBtn) signOutBtn.addEventListener('click', ()=> window.SyncQueue && window.SyncQueue.signOut());
  }
}
function roadmapRow(fase,desc){
  return `<div class="item-row"><div class="ic">🗺️</div><div class="body"><div class="name">${fase}</div><div class="sub">${esc(desc)}</div></div></div>`;
}
async function openExportSheet(){
  if(!requirePerm('reportes', 'La copia de seguridad está reservada a Encargado/Administrador')) return;
  /* Fase 7.21: el backup debe incluir TODO lo que puede haberse creado en
     este dispositivo, incluidas las entidades añadidas en la Fase 6
     (facturaLineas/invoice_items, mermaRegistros/waste_records, adjuntos)
     — antes se quedaban fuera del export/import y un backup no las
     recuperaba. getAll() se llama aparte porque no forman parte de STATE
     (no se usan para pintar ninguna pantalla, solo para sincronización). */
  const [facturaLineas, mermaRegistros, adjuntos] = await Promise.all([
    getAll('facturaLineas'), getAll('mermaRegistros'), getAll('adjuntos')
  ]);
  const data = { version:5, exportedAt:nowISO(), deviceId:STATE.deviceId, productos:STATE.productos, movimientos:STATE.movimientos, equipos:STATE.equipos, temperaturas:STATE.temperaturas,
    proveedores:STATE.proveedores, facturas:STATE.facturas, inventariosFisicos:STATE.inventariosFisicos,
    checklists:STATE.checklists, checklistRegistros:STATE.checklistRegistros, tareasMantenimiento:STATE.tareasMantenimiento, incidencias:STATE.incidencias,
    usuarios:STATE.usuarios, facturaLineas, mermaRegistros, adjuntos };
  const json = JSON.stringify(data, null, 2);
  openSheet({
    title:'Copia de seguridad (JSON)',
    bodyHtml:`<div class="tiny">Selecciona todo el texto y cópialo para guardarlo fuera de este dispositivo. Podrás pegarlo de vuelta con "Importar copia".</div>
      <textarea id="exportArea" style="min-height:260px;font-family:var(--font-mono);font-size:11.5px" readonly>${esc(json)}</textarea>`,
    footHtml:`<button class="btn btn-primary btn-block" id="selAllBtn">Seleccionar todo</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#selAllBtn').addEventListener('click', ()=>{
        const ta = sheetEl.querySelector('#exportArea'); ta.focus(); ta.select();
        toast('Texto seleccionado — cópialo con el menú del teléfono');
      });
    }
  });
}
async function handleImportFile(e){
  if(!requirePerm('reportes', 'Importar una copia está reservado a Encargado/Administrador')){ e.target.value=''; return; }
  const file = e.target.files[0]; if(!file) return;
  const text = await file.text();
  try{
    const data = JSON.parse(text);
    confirmDialog('¿Importar copia de seguridad?', 'Esto añadirá/actualizará los registros del archivo en tu base de datos local. No se eliminan los datos actuales.', async ()=>{
      for(const p of data.productos||[]) await put('productos', p);
      for(const m of data.movimientos||[]) await put('movimientos', m);
      for(const eq of data.equipos||[]) await put('equipos', eq);
      for(const t of data.temperaturas||[]) await put('temperaturas', t);
      for(const pv of data.proveedores||[]) await put('proveedores', pv);
      for(const f of data.facturas||[]) await put('facturas', f);
      for(const inv of data.inventariosFisicos||[]) await put('inventariosFisicos', inv);
      for(const c of data.checklists||[]) await put('checklists', c);
      for(const cr of data.checklistRegistros||[]) await put('checklistRegistros', cr);
      for(const tm of data.tareasMantenimiento||[]) await put('tareasMantenimiento', tm);
      for(const inc of data.incidencias||[]) await put('incidencias', inc);
      for(const u of data.usuarios||[]) await put('usuarios', u);
      // Fase 7.21: restaurar también las entidades de la Fase 6 (backups antiguos, versión<5, simplemente no las traerán — el resto se importa igual).
      for(const fl of data.facturaLineas||[]) await put('facturaLineas', fl);
      for(const mr of data.mermaRegistros||[]) await put('mermaRegistros', mr);
      for(const ad of data.adjuntos||[]) await put('adjuntos', ad);
      await reloadAll(); refreshProvDatalist();
      const stillExists = STATE.usuarios.find(x=>x.id===STATE.currentUserId);
      if(!stillExists && STATE.usuarios[0]) applyCurrentUser(STATE.usuarios[0]);
      /* Fase 7: el diálogo de confirmación se quedaba abierto tras
         importar (bloqueando el resto de la interfaz hasta que el
         usuario lo cerraba a mano con la ✕) — closeSheet() faltaba aquí,
         a diferencia de los demás confirmDialog() de la app. Encontrado
         al ejecutar el flujo real de importación, no por lectura de
         código. */
      closeSheet();
      toast('Copia importada correctamente'); render();
    });
  }catch(err){ toast('Archivo no válido'); }
  e.target.value='';
}

/* ---------------------------------------------------------------------
   14B. CADUCIDADES (módulo 6) — vista dedicada con filtros y orden
   --------------------------------------------------------------------- */
function openCaducidadesSheet(){
  let filtro = 'todos';
  function groupsHtml(){
    const conFecha = STATE.productos.filter(p=>p.caducidad).map(p=>({p, d:daysUntil(p.caducidad)})).sort((a,b)=>a.d-b.d);
    const buckets = {
      caducado: conFecha.filter(x=>x.d<0),
      hoy: conFecha.filter(x=>x.d===0),
      d3: conFecha.filter(x=>x.d>0 && x.d<=3),
      d7: conFecha.filter(x=>x.d>3 && x.d<=7),
      resto: conFecha.filter(x=>x.d>7),
    };
    let list = conFecha;
    if(filtro==='caducado') list=buckets.caducado;
    else if(filtro==='hoy') list=buckets.hoy;
    else if(filtro==='3') list=buckets.d3;
    else if(filtro==='7') list=buckets.d7;
    return {buckets, list};
  }
  function bodyHtml(){
    const {buckets, list} = groupsHtml();
    return `
      <div class="grid2">
        <div class="stat crit" style="padding:11px"><span class="label">Caducados</span><span class="value c-crit" style="font-size:20px">${buckets.caducado.length}</span></div>
        <div class="stat crit" style="padding:11px"><span class="label">Caducan hoy</span><span class="value c-crit" style="font-size:20px">${buckets.hoy.length}</span></div>
        <div class="stat warn" style="padding:11px"><span class="label">En 3 días</span><span class="value c-warn" style="font-size:20px">${buckets.d3.length}</span></div>
        <div class="stat info" style="padding:11px"><span class="label">En 7 días</span><span class="value c-info" style="font-size:20px">${buckets.d7.length}</span></div>
      </div>
      <div class="chip-row" id="cad_chips">
        ${[['todos','Todos'],['caducado','Caducados'],['hoy','Hoy'],['3','≤3 días'],['7','≤7 días']].map(([k,l])=>`<button class="chip ${filtro===k?'active':''}" data-f="${k}">${l}</button>`).join('')}
      </div>
      <div class="row-list" id="cad_list">
        ${list.length ? list.map(x=>{
          const b = caducidadBadge(x.p.caducidad) || {cls:'neutral',txt:'—'};
          return `<div class="item-row" data-open-prod2="${x.p.id}" style="cursor:pointer"><div class="ic">${catEmoji(x.p.categoria)}</div>
            <div class="body"><div class="name">${esc(x.p.nombre)}</div><div class="sub">${fmtDateShort(x.p.caducidad)} · ${fmtNum(x.p.stockActual)} ${esc(x.p.unidad)} en stock</div></div>
            <span class="badge ${b.cls}">${b.txt}</span></div>`;
        }).join('') : `<div class="empty"><svg viewBox="0 0 24 24"><path d="M10 13.5V4a2 2 0 1 1 4 0v9.5"/></svg><div>Sin productos en este filtro</div></div>`}
      </div>
    `;
  }
  openSheet({
    title:'Caducidades',
    bodyHtml: bodyHtml(),
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelector('#cad_chips').addEventListener('click', e=>{
          const c = e.target.closest('.chip'); if(!c) return; filtro=c.dataset.f;
          sheetEl.querySelector('.sheet-body').innerHTML = bodyHtml(); wire();
        });
        sheetEl.querySelectorAll('[data-open-prod2]').forEach(el=> el.addEventListener('click', ()=>{ closeSheet(); openProductSheet(el.dataset.openProd2); }));
      }
      wire();
    }
  });
}

/* ---------------------------------------------------------------------
   14C. INVENTARIO FÍSICO (módulo 13) — conteo real vs. teórico y ajuste
   --------------------------------------------------------------------- */
function openInventarioFisicoSheet(){
  if(!requirePerm('inventario_fisico', 'Solo Encargado/Administrador pueden hacer inventario físico')) return;
  const counted = {}; // productoId -> stock contado
  let q = '';
  function bodyHtml(){
    const items = STATE.productos.filter(p=> !q || p.nombre.toLowerCase().includes(q.toLowerCase())).sort((a,b)=>a.nombre.localeCompare(b.nombre));
    return `
      <div class="tiny">Introduce el stock contado físicamente para cada producto. Los productos sin conteo no se modifican.</div>
      <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="if_search" placeholder="Buscar producto…" value="${esc(q)}"></div>
      <div class="row-list">
        ${items.map(p=>`
          <div class="item-row">
            <div class="ic">${catEmoji(p.categoria)}</div>
            <div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">Registrado: ${fmtNum(p.stockActual)} ${esc(p.unidad)}</div></div>
            <input data-count="${p.id}" type="number" step="any" placeholder="—" value="${counted[p.id]!==undefined?counted[p.id]:''}" style="width:78px;background:var(--surface-2);border:1px solid var(--border);border-radius:9px;padding:8px;text-align:center;font-family:var(--font-mono);font-weight:700">
          </div>`).join('') || '<div class="muted" style="padding:8px 0">Sin productos.</div>'}
      </div>
    `;
  }
  openSheet({
    title:'Inventario físico',
    bodyHtml: bodyHtml(),
    footHtml:`<button class="btn btn-primary btn-block" id="if_review">Revisar diferencias</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelectorAll('[data-count]').forEach(inp=> inp.addEventListener('input', e=>{
          const v = e.target.value; const id = e.target.dataset.count;
          if(v==='') delete counted[id]; else counted[id] = parseFloat(v);
        }));
        sheetEl.querySelector('#if_search').addEventListener('input', e=>{ q=e.target.value;
          const scroll = sheetEl.querySelector('.sheet-body').scrollTop;
          sheetEl.querySelector('.sheet-body').innerHTML = bodyHtml(); wire();
          sheetEl.querySelector('.sheet-body').scrollTop = scroll;
          sheetEl.querySelector('#if_search').focus();
        });
      }
      wire();
      sheetEl.querySelector('#if_review').addEventListener('click', ()=>{
        const diffs = Object.entries(counted).map(([id,contado])=>{
          const p = prodById(id); return {p, contado, anterior:p.stockActual, diff:+(contado-p.stockActual).toFixed(3)};
        }).filter(d=>d.diff!==0);
        if(!Object.keys(counted).length){ toast('Introduce al menos un conteo'); return; }
        closeSheet(); openInventarioFisicoRevision(diffs, Object.keys(counted).length);
      });
    }
  });
}
function openInventarioFisicoRevision(diffs, totalContados){
  openSheet({
    title:'Confirmar ajustes',
    bodyHtml: diffs.length ? `
      <div class="tiny">${totalContados} producto(s) contados · ${diffs.length} con diferencia respecto al stock registrado.</div>
      <div class="row-list">${diffs.map(d=>`
        <div class="item-row"><div class="ic">${catEmoji(d.p.categoria)}</div>
          <div class="body"><div class="name">${esc(d.p.nombre)}</div><div class="sub">Registrado ${fmtNum(d.anterior)} → Contado ${fmtNum(d.contado)}</div></div>
          <div class="right n" style="color:${d.diff<0?'var(--crit)':'var(--ok)'}">${d.diff>0?'+':''}${fmtNum(d.diff)}</div>
        </div>`).join('')}</div>
      <div class="field"><label>Motivo del ajuste</label><input id="if_motivo" value="Inventario físico"></div>
    ` : `<div class="empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg><div>Sin diferencias — el stock contado coincide con el registrado.</div></div>`,
    footHtml: diffs.length ? `<button class="btn btn-primary btn-block" id="if_confirm">Confirmar ${diffs.length} ajuste(s)</button>` : '',
    onMount:(sheetEl)=>{
      const btn = sheetEl.querySelector('#if_confirm'); if(!btn) return;
      btn.addEventListener('click', async ()=>{
        const motivo = sheetEl.querySelector('#if_motivo').value.trim() || 'Inventario físico';
        const registro = {id:uid(), fecha:nowISO(), usuario:STATE.usuario, motivo, items:diffs.map(d=>({productoId:d.p.id, anterior:d.anterior, contado:d.contado, diferencia:d.diff}))};
        for(const d of diffs){
          await registrarMovimiento({productoId:d.p.id, tipo:'ajuste', cantidad:Math.abs(d.diff), motivo, observaciones:`Ajuste por inventario físico: ${fmtNum(d.anterior)} → ${fmtNum(d.contado)}`, extra:{posteriorAbsoluto:d.contado}});
        }
        await put('inventariosFisicos', registro); await reloadAll();
        closeSheet(); toast(`Inventario físico aplicado: ${diffs.length} ajuste(s)`); render();
      });
    }
  });
}

/* ---------------------------------------------------------------------
   14D. PROVEEDORES (módulo 10)
   --------------------------------------------------------------------- */
function openProveedoresListSheet(){
  let q='';
  function bodyHtml(){
    const items = STATE.proveedores.filter(p=>!q || p.nombre.toLowerCase().includes(q.toLowerCase())).sort((a,b)=>a.nombre.localeCompare(b.nombre));
    return `
      <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="pv_search" placeholder="Buscar proveedor…" value="${esc(q)}"></div>
      <div class="row-list">${items.length? items.map(p=>{
        const nEntradas = STATE.movimientos.filter(m=>m.tipo==='entrada' && normTxt(m.proveedor||'')===normTxt(p.nombre)).length;
        return `<div class="item-row" data-open-prov="${p.id}" style="cursor:pointer"><div class="ic">🚚</div>
          <div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">${esc(p.productosHabituales||p.telefono||'Sin datos adicionales')}</div></div>
          <div class="right"><div class="tiny">${nEntradas} entrada(s)</div></div></div>`;
      }).join('') : '<div class="muted" style="padding:8px 0">Sin proveedores todavía.</div>'}</div>
    `;
  }
  openSheet({
    title:'Proveedores',
    bodyHtml: bodyHtml(),
    footHtml:`<button class="btn btn-primary btn-block" id="pv_add">+ Nuevo proveedor</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelector('#pv_search').addEventListener('input', e=>{ q=e.target.value; sheetEl.querySelector('.sheet-body').innerHTML=bodyHtml(); wire(); });
        sheetEl.querySelectorAll('[data-open-prov]').forEach(el=> el.addEventListener('click', ()=>openProveedorFormSheet(el.dataset.openProv)));
      }
      wire();
      sheetEl.querySelector('#pv_add').addEventListener('click', ()=>openProveedorFormSheet(null));
    }
  });
}
function openProveedorFormSheet(id){
  if(!requirePerm('proveedores', 'Solo Encargado/Administrador pueden gestionar proveedores')) return;
  const editing = !!id;
  const pv = editing? provById(id) : {id:uid(), nombre:'', telefono:'', email:'', contacto:'', productosHabituales:'', observaciones:''};
  openSheet({
    title: editing? 'Editar proveedor' : 'Nuevo proveedor',
    bodyHtml:`
      <div class="form-stack">
        <div class="field"><label>Nombre</label><input id="pv_nombre" value="${esc(pv.nombre)}"></div>
        <div class="grid2">
          <div class="field"><label>Teléfono</label><input id="pv_tel" value="${esc(pv.telefono)}"></div>
          <div class="field"><label>Email</label><input id="pv_email" value="${esc(pv.email)}"></div>
        </div>
        <div class="field"><label>Persona de contacto</label><input id="pv_contacto" value="${esc(pv.contacto)}"></div>
        <div class="field"><label>Productos habituales</label><input id="pv_prods" value="${esc(pv.productosHabituales)}"></div>
        <div class="field"><label>Observaciones</label><textarea id="pv_obs">${esc(pv.observaciones)}</textarea></div>
      </div>`,
    footHtml:`${editing?'<button class="btn btn-outline" id="pv_del">Eliminar</button>':''}<button class="btn btn-primary btn-block" id="pv_save">${editing?'Guardar cambios':'Crear proveedor'}</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#pv_save').addEventListener('click', async ()=>{
        const nombre = sheetEl.querySelector('#pv_nombre').value.trim();
        if(!nombre){ toast('El nombre es obligatorio'); return; }
        const updated = {...pv, nombre, telefono:sheetEl.querySelector('#pv_tel').value.trim(), email:sheetEl.querySelector('#pv_email').value.trim(),
          contacto:sheetEl.querySelector('#pv_contacto').value.trim(), productosHabituales:sheetEl.querySelector('#pv_prods').value.trim(), observaciones:sheetEl.querySelector('#pv_obs').value.trim()};
        await put('proveedores', updated); await reloadAll(); refreshProvDatalist();
        closeSheet(); toast(editing?'Proveedor actualizado':'Proveedor creado'); openProveedoresListSheet();
      });
      const delBtn = sheetEl.querySelector('#pv_del');
      if(delBtn) delBtn.addEventListener('click', ()=>{
        confirmDialog('¿Eliminar proveedor?', `Se eliminará "${pv.nombre}". Las entradas y facturas ya registradas conservan el nombre del proveedor.`, async ()=>{
          await del('proveedores', pv.id); await reloadAll(); refreshProvDatalist();
          closeSheet(); toast('Proveedor eliminado'); openProveedoresListSheet();
        });
      });
    }
  });
}

/* ---------------------------------------------------------------------
   14E. MODO ALMACÉN — escaneo de código de barras (módulo 14)
   Decisión: se usa la BarcodeDetector API nativa del navegador (sin
   librerías externas, funciona offline) cuando está disponible. Si el
   navegador no la soporta, se ofrece introducción manual del código.
   --------------------------------------------------------------------- */
function openModoAlmacenSheet(){
  let stream = null, detector = null, loopActive = false, lastCode = '';
  const supported = 'BarcodeDetector' in window;
  openSheet({
    title:'Modo almacén',
    bodyHtml:`
      <div class="form-stack">
        ${supported ? `
          <div class="card-flat" style="padding:0;overflow:hidden;aspect-ratio:4/3;position:relative;background:#000;border-radius:12px">
            <video id="ma_video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover"></video>
          </div>
          <div class="tiny" id="ma_status" style="text-align:center">Apunta al código de barras del producto…</div>
        ` : `<div class="card-flat" style="color:var(--warn)">Este navegador no permite escaneo de códigos por cámara. Introduce el código manualmente.</div>`}
        <div class="field"><label>Código de barras (manual)</label>
          <div class="searchbar"><input id="ma_manual" placeholder="Escribe o pega el código" inputmode="numeric"></div>
        </div>
        <div id="ma_result"></div>
      </div>
    `,
    onMount:async (sheetEl)=>{
      function lookup(code){
        code = (code||'').trim(); if(!code) return;
        const p = STATE.productos.find(pr=>pr.codigoBarras && pr.codigoBarras===code);
        const zone = sheetEl.querySelector('#ma_result');
        if(!p){
          zone.innerHTML = `<div class="card-flat" style="border:1.5px solid var(--warn)"><div style="font-weight:700;color:var(--warn)">Código ${esc(code)} no encontrado</div><div class="tiny" style="margin-top:4px">No coincide con ningún producto. Puedes crearlo desde Inventario y guardar este código.</div></div>`;
          return;
        }
        const b = stockBadge(p);
        zone.innerHTML = `<div class="item-row"><div class="ic">${catEmoji(p.categoria)}</div>
          <div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">${fmtNum(p.stockActual)} ${esc(p.unidad)} en stock</div></div>
          <span class="badge ${b.cls}">${b.txt}</span></div>
          <div class="fab-row" style="margin-top:10px">
            <button class="btn btn-primary" style="flex:1" id="ma_entrada">Entrada</button>
            <button class="btn btn-crit" style="flex:1" id="ma_salida">Salida</button>
          </div>`;
        zone.querySelector('#ma_entrada').addEventListener('click', ()=>{ stopCamera(); closeSheet(); openEntradaSheet(p.id); });
        zone.querySelector('#ma_salida').addEventListener('click', ()=>{ stopCamera(); closeSheet(); openSalidaSheet(p.id); });
      }
      sheetEl.querySelector('#ma_manual').addEventListener('keydown', e=>{ if(e.key==='Enter') lookup(e.target.value); });
      sheetEl.querySelector('#ma_manual').addEventListener('change', e=> lookup(e.target.value));

      function stopCamera(){ loopActive=false; if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } }
      if(supported){
        try{
          detector = new BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128','qr_code']});
          stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
          const video = sheetEl.querySelector('#ma_video');
          video.srcObject = stream;
          loopActive = true;
          const statusEl = sheetEl.querySelector('#ma_status');
          (async function loop(){
            while(loopActive){
              try{
                const codes = await detector.detect(video);
                if(codes.length){
                  const val = codes[0].rawValue;
                  if(val && val!==lastCode){ lastCode=val; sheetEl.querySelector('#ma_manual').value=val; statusEl.textContent='Código detectado: '+val; lookup(val); }
                }
              }catch(err){ /* frame sin código, seguir */ }
              await new Promise(r=>setTimeout(r,350));
            }
          })();
        }catch(err){
          sheetEl.querySelector('#ma_status') && (sheetEl.querySelector('#ma_status').textContent = 'No se pudo acceder a la cámara. Usa el código manual.');
        }
      }
      // limpiar cámara si se cierra la hoja
      const obs = new MutationObserver(()=>{ if(!document.body.contains(sheetEl)){ stopCamera(); obs.disconnect(); } });
      obs.observe(document.getElementById('modalRoot'), {childList:true});
    }
  });
}

/* ---------------------------------------------------------------------
   14F. CHECKLISTS DE APERTURA Y CIERRE (módulo 7)
   --------------------------------------------------------------------- */
function openChecklistsListSheet(){
  openSheet({
    title:'Checklists',
    bodyHtml:`
      <div class="row-list">${STATE.checklists.length? STATE.checklists.map(c=>{
        const ultimaEjec = STATE.checklistRegistros.find(r=>r.checklistId===c.id);
        return `<div class="item-row" data-run="${c.id}" style="cursor:pointer"><div class="ic">${c.tipo==='apertura'?'☀️':(c.tipo==='cierre'?'🌙':'✅')}</div>
          <div class="body"><div class="name">${esc(c.nombre)}</div><div class="sub">${c.items.length} tareas${ultimaEjec?' · última vez '+fmtDate(ultimaEjec.fecha):''}</div></div>
          <button class="btn-ghost" data-edit="${c.id}">Editar</button></div>`;
      }).join('') : '<div class="muted" style="padding:8px 0">Sin checklists todavía.</div>'}</div>
    `,
    footHtml:`<button class="btn btn-outline btn-block" id="cl_new">+ Nueva plantilla de checklist</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelectorAll('[data-run]').forEach(el=> el.addEventListener('click', e=>{
        if(e.target.closest('[data-edit]')) return;
        closeSheet(); openChecklistRunSheet(el.dataset.run);
      }));
      sheetEl.querySelectorAll('[data-edit]').forEach(el=> el.addEventListener('click', e=>{
        e.stopPropagation(); closeSheet(); openChecklistTemplateFormSheet(el.dataset.edit);
      }));
      sheetEl.querySelector('#cl_new').addEventListener('click', ()=>{ closeSheet(); openChecklistTemplateFormSheet(null); });
    }
  });
}
function openChecklistRunByTipo(tipo){
  const c = STATE.checklists.find(x=>x.tipo===tipo);
  if(!c){ toast('No hay checklist de '+tipo+' configurado. Créalo en Más → Checklists.'); return; }
  openChecklistRunSheet(c.id);
}
function openChecklistRunSheet(checklistId){
  const c = STATE.checklists.find(x=>x.id===checklistId);
  if(!c) return;
  const checked = {};
  const horaInicio = nowISO();
  function bodyHtml(){
    const done = Object.values(checked).filter(Boolean).length;
    return `
      <div class="card-flat" style="display:flex;justify-content:space-between;align-items:center">
        <span class="muted">Progreso</span><span class="num" style="font-weight:700">${done} / ${c.items.length}</span>
      </div>
      <div class="row-list">${c.items.map(it=>`
        <label class="item-row" style="cursor:pointer">
          <input type="checkbox" data-item="${it.id}" ${checked[it.id]?'checked':''} style="width:20px;height:20px;accent-color:var(--accent)">
          <div class="body"><div class="name" style="${checked[it.id]?'text-decoration:line-through;color:var(--ink-muted)':''}">${esc(it.texto)}</div></div>
        </label>`).join('')}</div>
    `;
  }
  openSheet({
    title: 'Checklist — ' + c.nombre,
    bodyHtml: bodyHtml(),
    footHtml:`<button class="btn btn-primary btn-block" id="cl_finish">Finalizar checklist</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelectorAll('[data-item]').forEach(cb=> cb.addEventListener('change', e=>{
          checked[e.target.dataset.item] = e.target.checked;
          sheetEl.querySelector('.sheet-body').innerHTML = bodyHtml(); wire();
        }));
      }
      wire();
      sheetEl.querySelector('#cl_finish').addEventListener('click', async ()=>{
        const completados = Object.entries(checked).filter(([,v])=>v).map(([k])=>k);
        if(completados.length < c.items.length){
          confirmDialog('¿Finalizar incompleto?', `Has completado ${completados.length} de ${c.items.length} tareas. ¿Guardar igualmente?`, async ()=>{
            await saveChecklistRun(); closeSheet();
          });
        } else { await saveChecklistRun(); closeSheet(); }
        async function saveChecklistRun(){
          await put('checklistRegistros', {id:uid(), checklistId:c.id, nombre:c.nombre, tipo:c.tipo, fecha:nowISO(), horaInicio,
            usuario:STATE.usuario, completados, totalItems:c.items.length});
          await reloadAll(); toast('Checklist de '+c.nombre.toLowerCase()+' guardado'); render();
        }
      });
    }
  });
}
function openChecklistTemplateFormSheet(id){
  if(!requirePerm('checklist_config', 'Solo Encargado/Administrador pueden editar plantillas de checklist')) return;
  const editing = !!id;
  const c = editing? STATE.checklists.find(x=>x.id===id) : {id:uid(), nombre:'', tipo:'otro', items:[]};
  let items = c.items.map(i=>({...i}));
  function bodyHtml(){
    return `
      <div class="form-stack">
        <div class="field"><label>Nombre</label><input id="cf_nombre" value="${esc(c.nombre)}"></div>
        <div class="field"><label>Tipo</label><select id="cf_tipo"><option value="apertura" ${c.tipo==='apertura'?'selected':''}>Apertura</option><option value="cierre" ${c.tipo==='cierre'?'selected':''}>Cierre</option><option value="otro" ${c.tipo==='otro'?'selected':''}>Otro</option></select></div>
        <div class="field"><label>Tareas</label>
          <div class="row-list" id="cf_items">${items.map((it,i)=>`<div class="item-row"><div class="body"><input data-idx="${i}" value="${esc(it.texto)}" style="width:100%;border:none;background:none;font-weight:600"></div><button class="btn-ghost" data-rmitem="${i}">✕</button></div>`).join('')}</div>
          <div class="searchbar" style="margin-top:8px"><input id="cf_newitem" placeholder="Nueva tarea…"></div>
          <button type="button" class="btn btn-outline btn-sm" id="cf_additem" style="margin-top:6px">+ Añadir tarea</button>
        </div>
      </div>
    `;
  }
  openSheet({
    title: editing? 'Editar checklist' : 'Nueva plantilla',
    bodyHtml: bodyHtml(),
    footHtml:`${editing?'<button class="btn btn-outline" id="cf_del">Eliminar</button>':''}<button class="btn btn-primary btn-block" id="cf_save">${editing?'Guardar cambios':'Crear checklist'}</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelectorAll('[data-idx]').forEach(inp=> inp.addEventListener('input', e=>{ items[+e.target.dataset.idx].texto = e.target.value; }));
        sheetEl.querySelectorAll('[data-rmitem]').forEach(b=> b.addEventListener('click', ()=>{ items.splice(+b.dataset.rmitem,1); refreshItemsBlock(); }));
      }
      function refreshItemsBlock(){
        sheetEl.querySelector('#cf_items').innerHTML = items.map((it,i)=>`<div class="item-row"><div class="body"><input data-idx="${i}" value="${esc(it.texto)}" style="width:100%;border:none;background:none;font-weight:600"></div><button class="btn-ghost" data-rmitem="${i}">✕</button></div>`).join('');
        wire();
      }
      wire();
      sheetEl.querySelector('#cf_additem').addEventListener('click', ()=>{
        const inp = sheetEl.querySelector('#cf_newitem');
        const v = inp.value.trim(); if(!v) return;
        items.push({id:uid(), texto:v}); inp.value=''; refreshItemsBlock();
      });
      sheetEl.querySelector('#cf_save').addEventListener('click', async ()=>{
        const nombre = sheetEl.querySelector('#cf_nombre').value.trim();
        if(!nombre){ toast('El nombre es obligatorio'); return; }
        if(!items.length){ toast('Añade al menos una tarea'); return; }
        const updated = {...c, nombre, tipo:sheetEl.querySelector('#cf_tipo').value, items};
        await put('checklists', updated); await reloadAll();
        closeSheet(); toast(editing?'Checklist actualizado':'Checklist creado'); openChecklistsListSheet();
      });
      const delBtn = sheetEl.querySelector('#cf_del');
      if(delBtn) delBtn.addEventListener('click', ()=>{
        confirmDialog('¿Eliminar checklist?', `Se eliminará la plantilla "${c.nombre}". Los registros ya completados se conservan.`, async ()=>{
          await del('checklists', c.id); await reloadAll(); closeSheet(); toast('Checklist eliminado'); openChecklistsListSheet();
        });
      });
    }
  });
}

/* ---------------------------------------------------------------------
   14G. LIMPIEZA Y MANTENIMIENTO (módulo 8) — tareas recurrentes
   --------------------------------------------------------------------- */
function openMantenimientoListSheet(){
  let filtro = 'todas';
  function bodyHtml(){
    const hoyStr = new Date().toISOString().slice(0,10);
    let items = [...STATE.tareasMantenimiento].sort((a,b)=> (a.proximaRealizacion||'').localeCompare(b.proximaRealizacion||''));
    if(filtro!=='todas') items = items.filter(t=>{
      const est = tareaEstado(t).txt;
      return (filtro==='atrasada'&&est==='ATRASADA') || (filtro==='hoy'&&est==='PARA HOY') || (filtro==='pendiente'&&est==='PENDIENTE') || (filtro==='completada'&&est.includes('COMPLETADA'));
    });
    return `
      <div class="chip-row" id="tm_chips">${[['todas','Todas'],['atrasada','Atrasadas'],['hoy','Para hoy'],['pendiente','Pendientes'],['completada','Completadas hoy']].map(([k,l])=>`<button class="chip ${filtro===k?'active':''}" data-f="${k}">${l}</button>`).join('')}</div>
      <div class="row-list" id="tm_list">${items.length? items.map(t=>{ const e=tareaEstado(t);
        return `<div class="item-row" data-tarea="${t.id}" style="cursor:pointer"><div class="ic">🧽</div>
          <div class="body"><div class="name">${esc(t.nombre)}</div><div class="sub">${esc(t.responsable||'Sin responsable')} · cada ${t.frecuenciaDias} día(s) · próxima ${fmtDateShort(t.proximaRealizacion)}</div></div>
          <span class="badge ${e.cls}">${e.txt}</span></div>`;
      }).join('') : '<div class="muted" style="padding:8px 0">Sin tareas en este filtro.</div>'}</div>
    `;
  }
  openSheet({
    title:'Limpieza y mantenimiento',
    bodyHtml: bodyHtml(),
    footHtml:`<button class="btn btn-primary btn-block" id="tm_new">+ Nueva tarea recurrente</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelector('#tm_chips').addEventListener('click', e=>{ const c=e.target.closest('.chip'); if(!c) return; filtro=c.dataset.f; sheetEl.querySelector('.sheet-body').innerHTML=bodyHtml(); wire(); });
        sheetEl.querySelectorAll('[data-tarea]').forEach(el=> el.addEventListener('click', ()=>{ closeSheet(); openTareaDetailSheet(el.dataset.tarea); }));
      }
      wire();
      sheetEl.querySelector('#tm_new').addEventListener('click', ()=>{ closeSheet(); openTareaFormSheet(null); });
    }
  });
}
function openTareaDetailSheet(id){
  const t = STATE.tareasMantenimiento.find(x=>x.id===id);
  const e = tareaEstado(t);
  openSheet({
    title: t.nombre,
    bodyHtml:`
      <div class="card-flat"><div class="grid2">
        <div><div class="tiny">RESPONSABLE</div><div style="font-weight:700">${esc(t.responsable||'—')}</div></div>
        <div><div class="tiny">FRECUENCIA</div><div style="font-weight:700">Cada ${t.frecuenciaDias} día(s)</div></div>
        <div><div class="tiny">ÚLTIMA VEZ</div><div style="font-weight:700">${fmtDateShort(t.ultimaRealizacion)}</div></div>
        <div><div class="tiny">PRÓXIMA</div><div style="font-weight:700">${fmtDateShort(t.proximaRealizacion)}</div></div>
      </div></div>
      <span class="badge ${e.cls}">${e.txt}</span>
      ${t.observaciones? `<div class="tiny" style="margin-top:8px">${esc(t.observaciones)}</div>`:''}
      ${t.foto? `<img src="${t.foto}" style="max-height:150px;border-radius:10px;margin-top:8px">`:''}
    `,
    footHtml:`<button class="btn btn-outline" id="tm_edit">Editar</button><button class="btn btn-primary btn-block" id="tm_done">Marcar realizada hoy</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#tm_edit').addEventListener('click', ()=>{ closeSheet(); openTareaFormSheet(t.id); });
      sheetEl.querySelector('#tm_done').addEventListener('click', async ()=>{
        const hoy = new Date().toISOString().slice(0,10);
        const updated = {...t, ultimaRealizacion:hoy, proximaRealizacion:addDaysFrom(hoy, t.frecuenciaDias)};
        await put('tareasMantenimiento', updated); await reloadAll();
        closeSheet(); toast('Tarea marcada como realizada'); render();
      });
    }
  });
}
function openTareaFormSheet(id){
  if(!requirePerm('mantenimiento_config', 'Solo Encargado/Administrador pueden crear o editar tareas recurrentes')) return;
  const editing = !!id;
  const t = editing? STATE.tareasMantenimiento.find(x=>x.id===id) : {id:uid(), nombre:'', frecuenciaDias:7, ultimaRealizacion:new Date().toISOString().slice(0,10), responsable:'', observaciones:'', foto:null};
  let fotoData = t.foto;
  let fotoChanged = false;
  openSheet({
    title: editing? 'Editar tarea' : 'Nueva tarea recurrente',
    bodyHtml:`
      <div class="form-stack">
        <div class="field"><label>Nombre</label><input id="tf_nombre" value="${esc(t.nombre)}" placeholder="Limpiar nevera, cambiar aceite…"></div>
        <div class="grid2">
          <div class="field"><label>Frecuencia (días)</label><input id="tf_frec" type="number" min="1" value="${t.frecuenciaDias}"></div>
          <div class="field"><label>Responsable</label><input id="tf_resp" value="${esc(t.responsable)}"></div>
        </div>
        <div class="field"><label>Última realización</label><input id="tf_ultima" type="date" value="${t.ultimaRealizacion}"></div>
        <div class="field"><label>Observaciones</label><textarea id="tf_obs">${esc(t.observaciones)}</textarea></div>
        <div class="field"><label>Fotografía (opcional)</label><input type="file" id="tf_foto" accept="image/*" capture="environment"><div id="tf_fotoPrev">${fotoData?`<img src="${fotoData}" style="max-height:120px;border-radius:9px;margin-top:8px">`:''}</div></div>
      </div>`,
    footHtml:`${editing?'<button class="btn btn-outline" id="tf_del">Eliminar</button>':''}<button class="btn btn-primary btn-block" id="tf_save">${editing?'Guardar cambios':'Crear tarea'}</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#tf_foto').addEventListener('change', e=>{
        const f=e.target.files[0]; if(!f) return; const r=new FileReader();
        r.onload=()=>{ fotoData=r.result; fotoChanged=true; sheetEl.querySelector('#tf_fotoPrev').innerHTML=`<img src="${fotoData}" style="max-height:120px;border-radius:9px;margin-top:8px">`; };
        r.readAsDataURL(f);
      });
      sheetEl.querySelector('#tf_save').addEventListener('click', async ()=>{
        const nombre = sheetEl.querySelector('#tf_nombre').value.trim();
        if(!nombre){ toast('El nombre es obligatorio'); return; }
        const frecuenciaDias = parseInt(sheetEl.querySelector('#tf_frec').value)||1;
        const ultimaRealizacion = sheetEl.querySelector('#tf_ultima').value || new Date().toISOString().slice(0,10);
        const updated = {...t, nombre, frecuenciaDias, ultimaRealizacion, responsable:sheetEl.querySelector('#tf_resp').value.trim(),
          observaciones:sheetEl.querySelector('#tf_obs').value.trim(), foto:fotoData, proximaRealizacion: addDaysFrom(ultimaRealizacion, frecuenciaDias)};
        await put('tareasMantenimiento', updated); await reloadAll();
        if(fotoChanged && fotoData) await registrarAdjunto({entidadTipo:'tasks', entidadId:updated.id, dataUrl:fotoData});
        closeSheet(); toast(editing?'Tarea actualizada':'Tarea creada'); openMantenimientoListSheet();
      });
      const delBtn = sheetEl.querySelector('#tf_del');
      if(delBtn) delBtn.addEventListener('click', ()=>{
        confirmDialog('¿Eliminar tarea?', `Se eliminará "${t.nombre}".`, async ()=>{
          await del('tareasMantenimiento', t.id); await reloadAll(); closeSheet(); toast('Tarea eliminada'); openMantenimientoListSheet();
        });
      });
    }
  });
}

/* ---------------------------------------------------------------------
   14H. INCIDENCIAS (módulo 9)
   --------------------------------------------------------------------- */
function openIncidenciasListSheet(){
  let filtro = 'todas';
  function bodyHtml(){
    let items = [...STATE.incidencias];
    if(filtro!=='todas') items = items.filter(i=>i.estado===filtro);
    return `
      <div class="chip-row" id="ic_chips">${[['todas','Todas'],['ABIERTA','Abiertas'],['EN PROCESO','En proceso'],['RESUELTA','Resueltas']].map(([k,l])=>`<button class="chip ${filtro===k?'active':''}" data-f="${k}">${l}</button>`).join('')}</div>
      <div class="row-list" id="ic_list">${items.length? items.map(i=>`
        <div class="item-row" data-inc="${i.id}" style="cursor:pointer"><div class="ic">🛠️</div>
          <div class="body"><div class="name">${esc(i.titulo)}</div><div class="sub">${esc(i.tipo)} · ${fmtDate(i.fecha)}</div></div>
          <div class="right"><span class="badge ${incEstadoCls(i.estado)}">${i.estado}</span><div class="tiny" style="margin-top:3px">${i.prioridad}</div></div>
        </div>`).join('') : '<div class="muted" style="padding:8px 0">Sin incidencias en este filtro.</div>'}</div>
    `;
  }
  openSheet({
    title:'Incidencias',
    bodyHtml: bodyHtml(),
    footHtml:`<button class="btn btn-primary btn-block" id="ic_new">+ Nueva incidencia</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelector('#ic_chips').addEventListener('click', e=>{ const c=e.target.closest('.chip'); if(!c) return; filtro=c.dataset.f; sheetEl.querySelector('.sheet-body').innerHTML=bodyHtml(); wire(); });
        sheetEl.querySelectorAll('[data-inc]').forEach(el=> el.addEventListener('click', ()=>{ closeSheet(); openIncidenciaFormSheet(el.dataset.inc); }));
      }
      wire();
      sheetEl.querySelector('#ic_new').addEventListener('click', ()=>{ closeSheet(); openIncidenciaFormSheet(null); });
    }
  });
}
function openIncidenciaFormSheet(id){
  const editing = !!id;
  const i = editing? STATE.incidencias.find(x=>x.id===id) : {id:uid(), titulo:'', descripcion:'', tipo:TIPOS_INCIDENCIA[0], fecha:nowISO(), usuario:STATE.usuario, prioridad:'Media', estado:'ABIERTA', accionRealizada:'', foto:null, observaciones:''};
  let fotoData = i.foto;
  let fotoChanged = false;
  openSheet({
    title: editing? 'Editar incidencia' : 'Nueva incidencia',
    bodyHtml:`
      <div class="form-stack">
        <div class="field"><label>Tipo</label><select id="if_tipo">${TIPOS_INCIDENCIA.map(t=>`<option ${t===i.tipo?'selected':''}>${esc(t)}</option>`).join('')}</select></div>
        <div class="field"><label>Título</label><input id="if_titulo" value="${esc(i.titulo)}" placeholder="Resumen breve"></div>
        <div class="field"><label>Descripción</label><textarea id="if_desc">${esc(i.descripcion)}</textarea></div>
        <div class="grid2">
          <div class="field"><label>Prioridad</label><select id="if_prioridad">${PRIORIDADES.map(p=>`<option ${p===i.prioridad?'selected':''}>${p}</option>`).join('')}</select></div>
          <div class="field"><label>Estado</label><select id="if_estado">${ESTADOS_INCIDENCIA.map(e=>`<option ${e===i.estado?'selected':''}>${e}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Acción realizada</label><textarea id="if_accion" placeholder="Opcional">${esc(i.accionRealizada)}</textarea></div>
        <div class="field"><label>Fotografía (opcional)</label><input type="file" id="if_foto" accept="image/*" capture="environment"><div id="if_fotoPrev">${fotoData?`<img src="${fotoData}" style="max-height:120px;border-radius:9px;margin-top:8px">`:''}</div></div>
        <div class="field"><label>Observaciones</label><textarea id="if_obs">${esc(i.observaciones)}</textarea></div>
      </div>`,
    footHtml:`${editing?'<button class="btn btn-outline" id="if_del">Eliminar</button>':''}<button class="btn btn-primary btn-block" id="if_save">${editing?'Guardar cambios':'Crear incidencia'}</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#if_foto').addEventListener('change', e=>{
        const f=e.target.files[0]; if(!f) return; const r=new FileReader();
        r.onload=()=>{ fotoData=r.result; fotoChanged=true; sheetEl.querySelector('#if_fotoPrev').innerHTML=`<img src="${fotoData}" style="max-height:120px;border-radius:9px;margin-top:8px">`; };
        r.readAsDataURL(f);
      });
      sheetEl.querySelector('#if_save').addEventListener('click', async ()=>{
        const titulo = sheetEl.querySelector('#if_titulo').value.trim();
        if(!titulo){ toast('El título es obligatorio'); return; }
        const updated = {...i, titulo, tipo:sheetEl.querySelector('#if_tipo').value, descripcion:sheetEl.querySelector('#if_desc').value.trim(),
          prioridad:sheetEl.querySelector('#if_prioridad').value, estado:sheetEl.querySelector('#if_estado').value,
          accionRealizada:sheetEl.querySelector('#if_accion').value.trim(), foto:fotoData, observaciones:sheetEl.querySelector('#if_obs').value.trim(),
          usuario: editing? i.usuario : STATE.usuario};
        await put('incidencias', updated); await reloadAll();
        /* Fase 6I: solo se genera un adjunto sincronizable si la foto
           cambió en esta edición — evita volver a subir a Supabase
           Storage la misma imagen cada vez que se guarda la incidencia. */
        if(fotoChanged && fotoData) await registrarAdjunto({entidadTipo:'incidents', entidadId:updated.id, dataUrl:fotoData});
        closeSheet(); toast(editing?'Incidencia actualizada':'Incidencia registrada'); openIncidenciasListSheet();
      });
      const delBtn = sheetEl.querySelector('#if_del');
      if(delBtn) delBtn.addEventListener('click', ()=>{
        confirmDialog('¿Eliminar incidencia?', `Se eliminará "${i.titulo}".`, async ()=>{
          await del('incidencias', i.id); await reloadAll(); closeSheet(); toast('Incidencia eliminada'); openIncidenciasListSheet();
        });
      });
    }
  });
}

/* ---------------------------------------------------------------------
   14I. REPORTES SEMANALES (módulo 12)
   Nota: al ejecutarse dentro de una página de artifact, la descarga de
   archivos (PDF/Excel) está bloqueada por el sandbox. El informe se
   genera íntegro en pantalla y se ofrece también como texto/JSON para
   copiar y pegar donde se necesite (mismo mecanismo que la copia de
   seguridad). Cuando esta app se despliegue como PWA/instalada, esas
   mismas funciones de exportación pueden generar el PDF/Excel real.
   --------------------------------------------------------------------- */
function startOfWeek(d){ const dt=new Date(d); const day=(dt.getDay()+6)%7; dt.setDate(dt.getDate()-day); dt.setHours(0,0,0,0); return dt; }
function openReporteSemanalSheet(){
  if(!requirePerm('reportes', 'Los reportes están reservados a Encargado/Administrador')) return;
  let ini = startOfWeek(new Date());
  let fin = new Date(ini); fin.setDate(fin.getDate()+6);
  function toInput(d){ return d.toISOString().slice(0,10); }
  function buildReport(iniD, finD){
    const iniISO = iniD.toISOString(); const finISO = new Date(finD.getFullYear(),finD.getMonth(),finD.getDate(),23,59,59).toISOString();
    const inRange = (f)=> f>=iniISO && f<=finISO;
    const movs = STATE.movimientos.filter(m=>inRange(m.fecha));
    const temps = STATE.temperaturas.filter(t=>inRange(t.fecha));
    const entradas = movs.filter(m=>m.tipo==='entrada');
    const salidas = movs.filter(m=>m.tipo==='salida');
    const mermas = movs.filter(m=>m.tipo==='merma');
    const ajustes = movs.filter(m=>m.tipo==='ajuste');
    const incTemp = temps.filter(t=>t.fueraDeRango);
    const compras = entradas.reduce((s,m)=> s + (m.cantidad*(m.precioCompra||prodById(m.productoId)?.precioCompra||0)),0);
    const valorMermas = mermas.reduce((s,m)=> s + (m.cantidad*(prodById(m.productoId)?.precioCompra||0)),0);
    const bajoMin = STATE.productos.filter(p=>p.stockActual<p.stockMin);
    const caducan = STATE.productos.filter(p=>{ const d=daysUntil(p.caducidad); return d!==null && d<=7; });
    const checklistRuns = STATE.checklistRegistros.filter(r=>inRange(r.fecha));
    const tareasRealizadas = STATE.tareasMantenimiento.filter(t=> t.ultimaRealizacion && t.ultimaRealizacion>=toInput(iniD) && t.ultimaRealizacion<=toInput(finD));
    const tareasPendientes = STATE.tareasMantenimiento.filter(t=> daysUntil(t.proximaRealizacion)<=0 && !tareasRealizadas.includes(t));
    const incidencias = STATE.incidencias.filter(i=>inRange(i.fecha));
    return {iniD, finD, movs, temps, entradas, salidas, mermas, ajustes, incTemp, compras, valorMermas, bajoMin, caducan, checklistRuns, tareasRealizadas, tareasPendientes, incidencias};
  }
  function bodyHtml(){
    const r = buildReport(ini, fin);
    const porDia = {};
    for(let i=0;i<7;i++){ const d=new Date(ini); d.setDate(d.getDate()+i); const key=d.toISOString().slice(0,10); porDia[key]={entradas:0,salidas:0,mermas:0}; }
    r.movs.forEach(m=>{ const key=(m.fecha||'').slice(0,10); if(porDia[key]){ if(m.tipo==='entrada')porDia[key].entradas+=m.cantidad; if(m.tipo==='salida')porDia[key].salidas+=m.cantidad; if(m.tipo==='merma')porDia[key].mermas+=m.cantidad; } });
    const maxDia = Math.max(1, ...Object.values(porDia).flatMap(v=>[v.entradas,v.salidas,v.mermas]));
    return `
      <div class="grid2">
        <div class="field"><label>Desde</label><input type="date" id="rp_ini" value="${toInput(ini)}"></div>
        <div class="field"><label>Hasta</label><input type="date" id="rp_fin" value="${toInput(fin)}"></div>
      </div>
      <div class="card-flat" style="text-align:center"><div class="tiny">SEMANA</div><div style="font-weight:700">${fmtDateShort(toInput(ini))} — ${fmtDateShort(toInput(fin))}</div></div>

      <div class="section-head"><h2>1. Resumen general</h2></div>
      <div class="stat-grid">
        <div class="stat info" style="padding:11px"><span class="label">Movimientos</span><span class="value c-info" style="font-size:19px">${r.movs.length}</span></div>
        <div class="stat ${r.incTemp.length?'crit':'ok'}" style="padding:11px"><span class="label">Incid. temp.</span><span class="value ${r.incTemp.length?'c-crit':'c-ok'}" style="font-size:19px">${r.incTemp.length}</span></div>
        <div class="stat ${r.incidencias.filter(i=>i.estado!=='RESUELTA').length?'warn':'ok'}" style="padding:11px"><span class="label">Incidencias</span><span class="value" style="font-size:19px">${r.incidencias.length}</span></div>
        <div class="stat ${r.bajoMin.length?'warn':'ok'}" style="padding:11px"><span class="label">Bajo mínimo</span><span class="value" style="font-size:19px">${r.bajoMin.length}</span></div>
      </div>

      <div class="section-head"><h2>2–3. Temperaturas e incidencias térmicas</h2></div>
      <div class="card-flat">${r.temps.length} lectura(s) registradas · ${r.incTemp.length} fuera de rango
        ${r.incTemp.length? `<div class="row-list" style="margin-top:8px">${r.incTemp.slice(0,5).map(t=>{const eq=equipoById(t.equipoId); return `<div class="item-row"><div class="ic">🌡️</div><div class="body"><div class="name">${esc(eq?eq.nombre:'')}</div><div class="sub">${t.temperatura}°C · ${fmtDate(t.fecha)}</div></div></div>`;}).join('')}</div>`:''}
      </div>

      <div class="section-head"><h2>4–6. Entradas, salidas y mermas</h2></div>
      <div class="card-flat">
        <div class="spark" style="height:56px">${Object.values(porDia).map(v=>`<div style="height:${6+(v.entradas/maxDia)*44}px;background:var(--ok)"></div>`).join('')}</div>
        <div class="tiny" style="margin-top:4px">Entradas por día (lun–dom)</div>
        <div class="grid2" style="margin-top:10px">
          <div><div class="tiny">ENTRADAS</div><div class="num" style="font-weight:700">${r.entradas.reduce((s,m)=>s+m.cantidad,0)} ud</div></div>
          <div><div class="tiny">SALIDAS</div><div class="num" style="font-weight:700">${r.salidas.reduce((s,m)=>s+m.cantidad,0)} ud</div></div>
          <div><div class="tiny">MERMAS</div><div class="num" style="font-weight:700;color:var(--crit)">${r.mermas.reduce((s,m)=>s+m.cantidad,0)} ud</div></div>
          <div><div class="tiny">VALOR MERMA</div><div class="num" style="font-weight:700;color:var(--crit)">${money(r.valorMermas)}</div></div>
        </div>
      </div>

      <div class="section-head"><h2>7–8. Stock bajo mínimo y próximos a caducar</h2></div>
      <div class="row-list">
        ${r.bajoMin.slice(0,5).map(p=>`<div class="item-row"><div class="ic">📦</div><div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">${fmtNum(p.stockActual)}/${fmtNum(p.stockMin)} ${esc(p.unidad)}</div></div></div>`).join('') || '<div class="muted" style="padding:6px 0">Ninguno bajo mínimo.</div>'}
        ${r.caducan.slice(0,5).map(p=>`<div class="item-row"><div class="ic">⏳</div><div class="body"><div class="name">${esc(p.nombre)}</div><div class="sub">Caduca ${fmtDateShort(p.caducidad)}</div></div></div>`).join('')}
      </div>

      <div class="section-head"><h2>9. Compras</h2></div>
      <div class="card-flat">${r.entradas.length} entrada(s) · valor estimado <b>${money(r.compras)}</b></div>

      <div class="section-head"><h2>10–11. Tareas de limpieza/mantenimiento</h2></div>
      <div class="card-flat">✓ ${r.tareasRealizadas.length} realizada(s) · ⚠ ${r.tareasPendientes.length} pendiente(s)/atrasada(s)</div>
      <div class="tiny">Checklists completados en la semana: ${r.checklistRuns.length}</div>

      <div class="section-head"><h2>12. Incidencias</h2></div>
      <div class="row-list">${r.incidencias.length? r.incidencias.map(i=>`<div class="item-row"><div class="ic">🛠️</div><div class="body"><div class="name">${esc(i.titulo)}</div><div class="sub">${esc(i.tipo)} · ${i.prioridad}</div></div><span class="badge ${incEstadoCls(i.estado)}">${i.estado}</span></div>`).join('') : '<div class="muted" style="padding:6px 0">Sin incidencias esta semana.</div>'}</div>

      <div class="section-head"><h2>13. Diferencias de inventario</h2></div>
      <div class="card-flat">${r.ajustes.length} ajuste(s) por inventario físico esta semana${r.ajustes.length?': '+r.ajustes.map(a=>fmtNum(a.stockPosterior-a.stockAnterior)).join(', '):''}</div>

      <div class="section-head"><h2>14. Resumen económico</h2></div>
      <div class="grid2">
        <div class="card-flat"><div class="tiny">COMPRAS</div><div class="num" style="font-weight:700">${money(r.compras)}</div></div>
        <div class="card-flat"><div class="tiny">PÉRDIDA POR MERMA</div><div class="num" style="font-weight:700;color:var(--crit)">${money(r.valorMermas)}</div></div>
      </div>
    `;
  }
  openSheet({
    title:'Reporte semanal',
    bodyHtml: bodyHtml(),
    footHtml:`<button class="btn btn-outline" id="rp_copy">Copiar informe (texto)</button><button class="btn btn-primary btn-block" id="rp_regen">Actualizar</button>`,
    onMount:(sheetEl)=>{
      function wire(){
        sheetEl.querySelector('#rp_regen').addEventListener('click', ()=>{
          ini = new Date(sheetEl.querySelector('#rp_ini').value+'T00:00:00');
          fin = new Date(sheetEl.querySelector('#rp_fin').value+'T00:00:00');
          sheetEl.querySelector('.sheet-body').innerHTML = bodyHtml(); wire();
        });
        sheetEl.querySelector('#rp_copy').addEventListener('click', ()=> openReporteTextoSheet(buildReport(ini,fin)));
      }
      wire();
    }
  });
}
function openReporteTextoSheet(r){
  const lines = [];
  lines.push(`INFORME SEMANAL — ${fmtDateShort(r.iniD.toISOString())} a ${fmtDateShort(r.finD.toISOString())}`);
  lines.push('');
  lines.push(`1. RESUMEN GENERAL: ${r.movs.length} movimientos, ${r.incidencias.length} incidencias, ${r.bajoMin.length} productos bajo mínimo`);
  lines.push(`2-3. TEMPERATURAS: ${r.temps.length} lecturas, ${r.incTemp.length} fuera de rango`);
  lines.push(`4. ENTRADAS: ${r.entradas.reduce((s,m)=>s+m.cantidad,0)} ud (${r.entradas.length} operaciones)`);
  lines.push(`5. SALIDAS: ${r.salidas.reduce((s,m)=>s+m.cantidad,0)} ud (${r.salidas.length} operaciones)`);
  lines.push(`6. MERMAS: ${r.mermas.reduce((s,m)=>s+m.cantidad,0)} ud · valor ${money(r.valorMermas)}`);
  lines.push(`7. BAJO MÍNIMO: ${r.bajoMin.map(p=>p.nombre).join(', ')||'ninguno'}`);
  lines.push(`8. PRÓXIMOS A CADUCAR: ${r.caducan.map(p=>p.nombre).join(', ')||'ninguno'}`);
  lines.push(`9. COMPRAS: ${money(r.compras)}`);
  lines.push(`10-11. TAREAS: ${r.tareasRealizadas.length} realizadas, ${r.tareasPendientes.length} pendientes/atrasadas`);
  lines.push(`12. INCIDENCIAS: ${r.incidencias.map(i=>`${i.titulo} (${i.estado})`).join('; ')||'ninguna'}`);
  lines.push(`13. AJUSTES DE INVENTARIO: ${r.ajustes.length}`);
  lines.push(`14. RESUMEN ECONÓMICO: compras ${money(r.compras)}, pérdida por merma ${money(r.valorMermas)}`);
  const text = lines.join('\n');
  openSheet({
    title:'Informe en texto',
    bodyHtml:`<div class="tiny">Selecciona todo y cópialo para pegarlo en un email, documento o donde lo necesites.</div>
      <textarea id="rp_text" style="min-height:280px;font-family:var(--font-mono);font-size:12px" readonly>${esc(text)}</textarea>`,
    footHtml:`<button class="btn btn-primary btn-block" id="rp_selall">Seleccionar todo</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#rp_selall').addEventListener('click', ()=>{ const ta=sheetEl.querySelector('#rp_text'); ta.focus(); ta.select(); toast('Texto seleccionado — cópialo con el menú del teléfono'); });
    }
  });
}

/* ---------------------------------------------------------------------
   14J. USUARIOS Y SEGURIDAD (módulo 15 + sección Seguridad)
   --------------------------------------------------------------------- */
function openUsuariosListSheet(){
  if(!requirePerm('usuarios', 'Solo el Administrador puede gestionar usuarios')) return;
  openSheet({
    title:'Usuarios',
    bodyHtml:`
      <div class="tiny">Cada operación queda registrada con el usuario activo. Los roles determinan qué se puede hacer en la app.</div>
      <div class="row-list">${STATE.usuarios.map(u=>`
        <div class="item-row" data-edit="${u.id}" style="cursor:pointer">
          <div class="ic">${u.nombre[0].toUpperCase()}</div>
          <div class="body"><div class="name">${esc(u.nombre)}</div><div class="sub">${u.pin?'PIN activado':'Sin PIN'}</div></div>
          <span class="badge ${rolBadgeCls(u.rol)}">${u.rol}</span>
        </div>`).join('')}</div>
    `,
    footHtml:`<button class="btn btn-primary btn-block" id="us_new">+ Nuevo usuario</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelectorAll('[data-edit]').forEach(el=> el.addEventListener('click', ()=>{ closeSheet(); openUsuarioFormSheet(el.dataset.edit); }));
      sheetEl.querySelector('#us_new').addEventListener('click', ()=>{ closeSheet(); openUsuarioFormSheet(null); });
    }
  });
}
function openUsuarioFormSheet(id){
  const editing = !!id;
  const u = editing? STATE.usuarios.find(x=>x.id===id) : {id:uid(), nombre:'', rol:'EMPLEADO', pin:''};
  openSheet({
    title: editing? 'Editar usuario' : 'Nuevo usuario',
    bodyHtml:`
      <div class="form-stack">
        <div class="field"><label>Nombre</label><input id="uf_nombre" value="${esc(u.nombre)}"></div>
        <div class="field"><label>Rol</label><select id="uf_rol">${ROLES.map(r=>`<option ${r===u.rol?'selected':''}>${r}</option>`).join('')}</select></div>
        <div class="field"><label>PIN de 4 dígitos (opcional)</label><input id="uf_pin" inputmode="numeric" maxlength="4" placeholder="${u.pin? 'PIN ya configurado — déjalo vacío para no cambiarlo' : 'Déjalo vacío para no usar PIN'}"></div>
        ${u.pin? `<div class="tiny">Por seguridad el PIN no se muestra aquí (se guarda como hash, nunca en texto plano). Escribe uno nuevo solo si quieres cambiarlo.</div>`:''}
        <div class="tiny">Administrador: acceso total. Encargado: gestión de catálogo, proveedores, equipos, informes y analítica. Empleado: solo operaciones diarias (entradas, salidas, mermas, temperaturas, checklists, incidencias).</div>
      </div>`,
    footHtml:`${editing?'<button class="btn btn-outline" id="uf_del">Eliminar</button>':''}<button class="btn btn-primary btn-block" id="uf_save">${editing?'Guardar cambios':'Crear usuario'}</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#uf_save').addEventListener('click', async ()=>{
        const nombre = sheetEl.querySelector('#uf_nombre').value.trim();
        if(!nombre){ toast('El nombre es obligatorio'); return; }
        const pinInput = sheetEl.querySelector('#uf_pin').value.trim();
        if(pinInput && !/^\d{4}$/.test(pinInput)){ toast('El PIN debe tener 4 dígitos'); return; }
        // Campo vacío + edición = se conserva el PIN (hash) que ya tenía.
        // Campo vacío + usuario nuevo = sin PIN. Campo relleno = se hashea y sustituye.
        const pin = pinInput ? await hashPin(pinInput) : (editing ? u.pin : '');
        const updated = {...u, nombre, rol:sheetEl.querySelector('#uf_rol').value, pin};
        await put('usuarios', updated); await reloadAll();
        if(STATE.currentUserId===updated.id) applyCurrentUser(updated);
        closeSheet(); toast(editing?'Usuario actualizado':'Usuario creado'); openUsuariosListSheet();
      });
      const delBtn = sheetEl.querySelector('#uf_del');
      if(delBtn) delBtn.addEventListener('click', ()=>{
        if(STATE.usuarios.length<=1){ toast('Debe existir al menos un usuario'); return; }
        confirmDialog('¿Eliminar usuario?', `Se eliminará "${u.nombre}". Los movimientos ya registrados conservan su nombre.`, async ()=>{
          await del('usuarios', u.id); await reloadAll();
          if(STATE.currentUserId===u.id) applyCurrentUser(STATE.usuarios[0]);
          closeSheet(); toast('Usuario eliminado'); openUsuariosListSheet();
        });
      });
    }
  });
}

/* ---------------------------------------------------------------------
   14K. ANALÍTICA (módulo 15 / preparación Fase 4)
   --------------------------------------------------------------------- */
function barRow(label, value, max, color, fmt){
  const pct = max>0 ? Math.max(2, (value/max)*100) : 2;
  return `<div style="display:flex;align-items:center;gap:8px">
    <div class="tiny" style="width:64px;flex-shrink:0;text-align:right">${esc(label)}</div>
    <div style="flex:1;background:var(--surface-3);border-radius:6px;height:14px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};border-radius:6px"></div></div>
    <div class="num tiny" style="width:56px;flex-shrink:0">${fmt?fmt(value):fmtNum(value)}</div>
  </div>`;
}
function openAnaliticaSheet(){
  if(!requirePerm('analitica', 'La analítica está reservada a Encargado/Administrador')) return;
  const valorInventario = STATE.productos.reduce((s,p)=>s+p.stockActual*(p.precioCompra||0),0);
  const hoy = new Date();
  // movimientos últimos 14 días
  const dias14 = [...Array(14)].map((_,i)=>{ const d=new Date(hoy); d.setDate(d.getDate()-(13-i)); return d.toISOString().slice(0,10); });
  const porDia = Object.fromEntries(dias14.map(d=>[d,{entradas:0,salidas:0,mermas:0}]));
  STATE.movimientos.forEach(m=>{ const k=(m.fecha||'').slice(0,10); if(porDia[k]){ if(m.tipo==='entrada')porDia[k].entradas+=m.cantidad; if(m.tipo==='salida')porDia[k].salidas+=m.cantidad; if(m.tipo==='merma')porDia[k].mermas+=m.cantidad; } });
  const maxMov = Math.max(1, ...Object.values(porDia).flatMap(v=>[v.entradas,v.salidas,v.mermas]));
  // mermas por semana (últimas 6)
  const semanas = [...Array(6)].map((_,i)=>{ const ini=startOfWeek(hoy); ini.setDate(ini.getDate()-7*(5-i)); const fin=new Date(ini); fin.setDate(fin.getDate()+6); return {ini,fin}; });
  const mermaSemana = semanas.map(s=>{
    const val = STATE.movimientos.filter(m=>m.tipo==='merma' && m.fecha>=s.ini.toISOString() && m.fecha<=new Date(s.fin.getFullYear(),s.fin.getMonth(),s.fin.getDate(),23,59,59).toISOString())
      .reduce((sum,m)=> sum + m.cantidad*(prodById(m.productoId)?.precioCompra||0), 0);
    return {label: s.ini.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit'}), val};
  });
  const maxMerma = Math.max(1, ...mermaSemana.map(m=>m.val));
  // top rotación 30 días
  const hace30 = new Date(hoy-30*86400000).toISOString();
  const salidasPorProd = {};
  STATE.movimientos.filter(m=>m.tipo==='salida' && m.fecha>=hace30).forEach(m=>{ salidasPorProd[m.productoId]=(salidasPorProd[m.productoId]||0)+m.cantidad; });
  const topRotacion = Object.entries(salidasPorProd).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxRot = Math.max(1, ...topRotacion.map(([,v])=>v));
  // incidencias de temperatura por equipo (30 días)
  const incPorEquipo = {};
  STATE.temperaturas.filter(t=>t.fueraDeRango && t.fecha>=hace30).forEach(t=>{ incPorEquipo[t.equipoId]=(incPorEquipo[t.equipoId]||0)+1; });
  const maxIncEq = Math.max(1, ...Object.values(incPorEquipo), 1);
  // top proveedores por valor de compra (todo el histórico disponible)
  const comprasPorProveedor = {};
  STATE.movimientos.filter(m=>m.tipo==='entrada' && m.proveedor).forEach(m=>{ comprasPorProveedor[m.proveedor] = (comprasPorProveedor[m.proveedor]||0) + m.cantidad*(m.precioCompra||0); });
  const topProveedores = Object.entries(comprasPorProveedor).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxProv = Math.max(1, ...topProveedores.map(([,v])=>v));

  openSheet({
    title:'Analítica',
    bodyHtml:`
      <div class="stat-grid">
        <div class="stat ok" style="grid-column:span 2"><span class="label">Valor actual del inventario</span><span class="value c-ok" style="font-size:24px">${money(valorInventario)}</span><span class="tiny">${STATE.productos.length} productos · a precio de compra</span></div>
      </div>

      <div class="section-head"><h2>Movimientos — últimos 14 días</h2></div>
      <div class="card-flat">
        <div class="spark" style="height:50px">${dias14.map(d=>`<div style="height:${6+(porDia[d].entradas/maxMov)*44}px;background:var(--ok)"></div>`).join('')}</div>
        <div class="tiny" style="margin-top:4px">Entradas por día</div>
        <div class="spark" style="height:50px;margin-top:8px">${dias14.map(d=>`<div style="height:${6+(porDia[d].salidas/maxMov)*44}px;background:var(--warn)"></div>`).join('')}</div>
        <div class="tiny" style="margin-top:4px">Salidas por día</div>
      </div>

      <div class="section-head"><h2>Mermas por semana (valor)</h2></div>
      <div class="card-flat" style="display:flex;flex-direction:column;gap:6px">${mermaSemana.map(m=>barRow(m.label, m.val, maxMerma, 'var(--crit)', money)).join('')}</div>

      <div class="section-head"><h2>Productos con más rotación (30 días)</h2></div>
      <div class="card-flat" style="display:flex;flex-direction:column;gap:6px">${topRotacion.length? topRotacion.map(([id,v])=>barRow((prodById(id)?.nombre||'—').slice(0,14), v, maxRot, 'var(--info)')).join('') : '<div class="muted">Sin salidas en 30 días.</div>'}</div>

      <div class="section-head"><h2>Incidencias de temperatura por equipo (30 días)</h2></div>
      <div class="card-flat" style="display:flex;flex-direction:column;gap:6px">${Object.keys(incPorEquipo).length? Object.entries(incPorEquipo).map(([id,v])=>barRow((equipoById(id)?.nombre||'—').slice(0,14), v, maxIncEq, 'var(--crit)')).join('') : '<div class="muted">Sin incidencias de temperatura en 30 días.</div>'}</div>

      <div class="section-head"><h2>Proveedores por volumen de compra</h2></div>
      <div class="card-flat" style="display:flex;flex-direction:column;gap:6px">${topProveedores.length? topProveedores.map(([n,v])=>barRow(n.slice(0,14), v, maxProv, 'var(--accent)', money)).join('') : '<div class="muted">Sin entradas con proveedor registrado.</div>'}</div>
    `,
  });
}

/* ---------------------------------------------------------------------
   15. SHEET / MODAL / CONFIRM genéricos
   --------------------------------------------------------------------- */
function openSheet({title, bodyHtml, footHtml, onMount}){
  closeSheet();
  const root = document.getElementById('modalRoot');
  const overlay = document.createElement('div'); overlay.className='overlay'; overlay.id='activeOverlay';
  overlay.innerHTML = `<div class="sheet">
    <div class="sheet-head"><h3>${esc(title)}</h3><button class="sheet-close" id="sheetCloseBtn">✕</button></div>
    <div class="sheet-body">${bodyHtml}</div>
    ${footHtml?`<div class="sheet-foot">${footHtml}</div>`:''}
  </div>`;
  root.appendChild(overlay);
  overlay.addEventListener('click', e=>{ if(e.target===overlay) closeSheet(); });
  overlay.querySelector('#sheetCloseBtn').addEventListener('click', closeSheet);
  if(onMount) onMount(overlay.querySelector('.sheet'));
}
function closeSheet(){ const o=document.getElementById('activeOverlay'); if(o) o.remove(); }
function confirmDialog(title, msg, onConfirm){
  openSheet({
    title,
    bodyHtml:`<div class="muted">${esc(msg)}</div>`,
    footHtml:`<button class="btn btn-outline" id="cd_cancel">Cancelar</button><button class="btn btn-crit btn-block" id="cd_ok">Confirmar</button>`,
    onMount:(sheetEl)=>{
      sheetEl.querySelector('#cd_cancel').addEventListener('click', closeSheet);
      sheetEl.querySelector('#cd_ok').addEventListener('click', onConfirm);
    }
  });
}

/* ---------------------------------------------------------------------
   16. ARRANQUE
   --------------------------------------------------------------------- */
document.getElementById('userChipBtn').addEventListener('click', openUserSwitchSheet);

function applyCurrentUser(u){
  STATE.currentUserId = u.id; STATE.currentRol = u.rol; STATE.usuario = u.nombre;
  localStorage.setItem('bb_current_user_id', u.id);
  document.getElementById('userNameLbl').textContent = u.nombre;
  document.getElementById('userInitial').textContent = u.nombre[0].toUpperCase();
}
function pickInitialUser(){
  const savedId = localStorage.getItem('bb_current_user_id');
  let u = savedId && STATE.usuarios.find(x=>x.id===savedId);
  if(!u) u = STATE.usuarios.find(x=>x.rol==='ENCARGADO') || STATE.usuarios[0];
  return u;
}
function getDeviceId(){
  let id = localStorage.getItem('bb_device_id');
  if(!id){ id = (crypto.randomUUID ? crypto.randomUUID() : uid()+uid()); localStorage.setItem('bb_device_id', id); }
  return id;
}
async function getConfig(key){ const row = await getOne('config', key); return row ? row.value : null; }
async function setConfig(key, value){ await put('config', {key, value}); }

(async function init(){
  try{
    db = await openDB();
    // Bug real encontrado en Fase 8 al probar un "dispositivo nuevo" (IndexedDB
    // vacía) contra un Supabase real ya configurado: seedIfEmpty() se disparaba
    // ANTES de que SyncQueue.start() pudiera hacer el pull inicial, así que un
    // negocio con datos reales en la nube recibía un catálogo de demostración
    // recién generado (con IDs nuevos) que además se subía como si fueran
    // productos reales, duplicando el inventario en cada instalación nueva.
    // Con Supabase configurado, el pull es la fuente de verdad — el catálogo
    // de ejemplo solo tiene sentido en modo 100% local (sin Supabase), que es
    // el caso para el que se diseñó originalmente. No cambia nada del modo
    // local: si config.js está vacío, el comportamiento es idéntico a antes.
    const supabaseConfigured = !!(window.SB && window.SB.isConfigured);
    if (!supabaseConfigured) await seedIfEmpty();
    await reloadAll();
    refreshProvDatalist();
    STATE.deviceId = getDeviceId();
    const initialUser = pickInitialUser();
    if(initialUser) applyCurrentUser(initialUser);
    clockTick(); setInterval(clockTick, 30000);

    const pinHash = await getConfig('appPin');
    if(pinHash){ showPinLock(pinHash, ()=> render()); }
    else render();

    // Arranca la sincronización con Supabase (no-op si config.js está vacío:
    // la app ya ha renderizado y es 100% usable solo con IndexedDB).
    if (window.SyncQueue) window.SyncQueue.start();
  }catch(err){
    document.getElementById('main').innerHTML = `<div class="card" style="text-align:center;color:var(--crit)">No se pudo iniciar la base de datos local en este navegador.<br><span class="tiny">${esc(err.message||err)}</span></div>`;
  }
})();

/* Pantalla de bloqueo por PIN (opcional, configurable en Más → Seguridad).
   correctPinHash es el hash SHA-256 guardado (ver hashPin()), nunca el
   PIN en claro. */
function showPinLock(correctPinHash, onUnlock){
  const root = document.getElementById('modalRoot');
  const overlay = document.createElement('div'); overlay.className='overlay'; overlay.id='pinLockOverlay';
  overlay.style.alignItems='center';
  let entered = '';
  function draw(){
    overlay.innerHTML = `<div class="sheet" style="border-radius:20px;max-width:340px;padding:28px 22px;align-items:center;text-align:center">
      <div class="mark" style="width:44px;height:44px;border-radius:12px;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-weight:700;font-size:20px;margin:0 auto 10px">B</div>
      <h3 style="font-size:18px">Bitácora de Barra</h3>
      <div class="tiny" style="margin:6px 0 16px">Introduce el PIN para continuar</div>
      <div style="display:flex;justify-content:center;gap:10px;margin-bottom:18px">${[0,1,2,3].map(i=>`<div style="width:14px;height:14px;border-radius:50%;background:${i<entered.length?'var(--accent)':'var(--surface-3)'};border:1px solid var(--border)"></div>`).join('')}</div>
      <div id="pinErr" class="tiny" style="color:var(--crit);min-height:16px"></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:260px;margin:10px auto 0">
        ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(k=>`<button type="button" data-k="${k}" class="btn btn-outline" style="font-size:18px;padding:14px 0">${k}</button>`).join('')}
      </div>
    </div>`;
    overlay.querySelectorAll('[data-k]').forEach(b=> b.addEventListener('click', async ()=>{
      const k = b.dataset.k;
      if(k==='⌫'){ entered = entered.slice(0,-1); }
      else if(k!==''){ if(entered.length<4) entered += k; }
      if(entered.length===4){
        const h = await hashPin(entered);
        if(h===correctPinHash){ overlay.remove(); onUnlock(); }
        else{ overlay.querySelector('#pinErr').textContent='PIN incorrecto'; entered=''; setTimeout(draw,250); }
        return;
      }
      draw();
    }));
  }
  draw();
  root.appendChild(overlay);
}

/* Cambio de usuario activo (desde el chip superior) */
function openUserSwitchSheet(){
  openSheet({
    title:'Cambiar de usuario',
    bodyHtml:`
      <div class="row-list">${STATE.usuarios.map(u=>`
        <div class="item-row" data-user="${u.id}" style="cursor:pointer">
          <div class="ic">${u.nombre[0].toUpperCase()}</div>
          <div class="body"><div class="name">${esc(u.nombre)}</div><div class="sub">${u.id===STATE.currentUserId?'Usuario activo':'Toca para cambiar'}</div></div>
          <span class="badge ${rolBadgeCls(u.rol)}">${u.rol}</span>
        </div>`).join('')}</div>
    `,
    footHtml: can('usuarios') ? `<button class="btn btn-outline btn-block" id="us_manage">Gestionar usuarios</button>` : '',
    onMount:(sheetEl)=>{
      sheetEl.querySelectorAll('[data-user]').forEach(el=> el.addEventListener('click', ()=>{
        const u = STATE.usuarios.find(x=>x.id===el.dataset.user);
        if(u.pin){
          closeSheet();
          askPinThen(u.pin, ()=>{ applyCurrentUser(u); toast('Ahora eres '+u.nombre); render(); }); // u.pin es un hash, ver hashPin()
        } else {
          applyCurrentUser(u); closeSheet(); toast('Ahora eres '+u.nombre); render();
        }
      }));
      const mBtn = sheetEl.querySelector('#us_manage');
      if(mBtn) mBtn.addEventListener('click', ()=>{ closeSheet(); openUsuariosListSheet(); });
    }
  });
}
/* Pide un PIN de 4 dígitos puntual (para cambiar a un usuario protegido o
   confirmar una acción crítica). correctPinHash es un hash SHA-256 (ver
   hashPin()), nunca el PIN en claro. */
function askPinThen(correctPinHash, onOk){
  let entered='';
  openSheet({
    title:'Introduce el PIN',
    bodyHtml:`<div style="display:flex;justify-content:center;gap:10px;margin:6px 0 10px" id="pp_dots">${[0,1,2,3].map(()=>`<div style="width:14px;height:14px;border-radius:50%;background:var(--surface-3);border:1px solid var(--border)"></div>`).join('')}</div>
      <div id="pp_err" class="tiny" style="color:var(--crit);text-align:center;min-height:16px"></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:260px;margin:0 auto">
        ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(k=>`<button type="button" data-k="${k}" class="btn btn-outline" style="font-size:18px;padding:14px 0">${k}</button>`).join('')}
      </div>`,
    onMount:(sheetEl)=>{
      function redraw(){ sheetEl.querySelector('#pp_dots').innerHTML = [0,1,2,3].map(i=>`<div style="width:14px;height:14px;border-radius:50%;background:${i<entered.length?'var(--accent)':'var(--surface-3)'};border:1px solid var(--border)"></div>`).join(''); }
      sheetEl.querySelectorAll('[data-k]').forEach(b=> b.addEventListener('click', async ()=>{
        const k=b.dataset.k;
        if(k==='⌫') entered=entered.slice(0,-1); else if(k!=='' && entered.length<4) entered+=k;
        redraw();
        if(entered.length===4){
          const h = await hashPin(entered);
          if(h===correctPinHash){ closeSheet(); onOk(); }
          else{ sheetEl.querySelector('#pp_err').textContent='PIN incorrecto'; entered=''; setTimeout(redraw,200); }
        }
      }));
    }
  });
}
