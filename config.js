/**
 * CONFIGURACIÓN — Bitácora de Barra
 * ---------------------------------------------------------------
 * Copia este archivo como "config.js" (mismo nivel, junto a index.html)
 * y rellena los valores de tu proyecto de Supabase.
 *
 * Dónde conseguirlos: en tu proyecto de Supabase → Project Settings → API.
 *   SUPABASE_URL      -> "Project URL"
 *   SUPABASE_ANON_KEY -> "anon public" key
 *
 * La "anon key" está PENSADA para ser pública (se usa desde el navegador
 * del cliente); la seguridad real la da Row Level Security (RLS) en la
 * base de datos (ver supabase/schema.sql), no el secreto de esta clave.
 * NUNCA pongas aquí la "service_role key" — esa es privada y no debe
 * salir del servidor.
 *
 * Si dejas los valores vacíos, la app funciona igualmente: 100% local/
 * offline con IndexedDB, sin sincronizar con ningún servidor. En cuanto
 * rellenes estos valores y recargues, empezará a sincronizar sola.
 * ---------------------------------------------------------------
 */
window.APP_CONFIG = {
  // Configurado en Fase 8 con el proyecto Supabase REAL de desarrollo del
  // usuario. Es la "publishable key" (formato nuevo de Supabase, equivalente
  // a la "anon key" clásica): pensada para ir en el cliente, la seguridad
  // real la da RLS. NO es la "secret key" / service_role.
  SUPABASE_URL: 'https://gapwnrsxtkqmsrchzvnv.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_qHksBNYGcooxiOH4vP2KYg_nBPp7aMD',

  // Nombre del negocio por defecto si el perfil del usuario no trae uno.
  APP_NAME: 'Bitácora de Barra',

  // Intervalo (ms) de sincronización periódica en segundo plano mientras
  // hay conexión. 60000 = cada 60s. Súbelo si quieres ahorrar batería/datos.
  SYNC_INTERVAL_MS: 60000,
};
