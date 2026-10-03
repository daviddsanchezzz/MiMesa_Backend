const { createClient } = require('@supabase/supabase-js');

let client;

function getSupabaseClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    const error = new Error('Supabase Storage no esta configurado');
    error.code = 'SUPABASE_NOT_CONFIGURED';
    throw error;
  }
  client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}

function resetSupabaseClientForTests() {
  client = undefined;
}

module.exports = { getSupabaseClient, resetSupabaseClientForTests };
