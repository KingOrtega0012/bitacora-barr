/**
 * supabaseClient.js
 * ---------------------------------------------------------------
 * Envoltorio fino sobre el cliente oficial de Supabase (cargado desde
 * CDN en index.html como `window.supabase`, la librería). Expone
 * `window.SB` con:
 *   - SB.client       -> cliente real de supabase-js, o null si no
 *                        hay configuración (URL/anon key vacíos).
 *   - SB.isConfigured -> boolean.
 *   - SB.auth...      -> helpers de sesión (signIn/signOut/getSession).
 *
 * IMPORTANTE (regla del proyecto): la UI y app.js NO deben llamar a
 * Supabase directamente para operar el inventario. Todas las escrituras
 * de negocio pasan por IndexedDB (ver db.js) y es sync.js quien empuja
 * los cambios a Supabase en segundo plano. SB se usa solo para:
 *   1) Auth (login/logout/sesión).
 *   2) Que sync.js lo use como transporte hacia Postgres.
 * ---------------------------------------------------------------
 */
(function () {
  const cfg = window.APP_CONFIG || {};
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

  let client = null;
  if (configured && window.supabase && window.supabase.createClient) {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } else if (configured) {
    console.warn('[SB] APP_CONFIG tiene URL/clave pero la librería supabase-js no cargó (revisa el <script> del CDN en index.html o la conexión a internet la primera vez).');
  }

  window.SB = {
    client,
    isConfigured: configured,

    async getSession() {
      if (!client) return null;
      const { data } = await client.auth.getSession();
      return data.session;
    },
    async signInWithPassword(email, password) {
      if (!client) throw new Error('Supabase no está configurado (revisa config.js)');
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },
    async signOut() {
      if (!client) return;
      await client.auth.signOut();
    },
    onAuthStateChange(cb) {
      if (!client) return { unsubscribe(){} };
      const { data } = client.auth.onAuthStateChange((event, session) => cb(event, session));
      return data.subscription;
    },
  };
})();
