const { createClient } = require('@supabase/supabase-js');
const { supabase: config } = require('./env');

const isSelfHosted = process.env.DB_SELF_HOSTED === 'true' || !!process.env.DATABASE_URL;

const options = {
  auth: {
    persistSession: false
  }
};

if (isSelfHosted) {
  // PostgREST hat standardmäßig keinen '/rest/v1/' Präfix, sondern horcht direkt auf der Root-URL.
  // Das Supabase-SDK fügt jedoch '/rest/v1/' immer an. Ein eigener Fetch-Wrapper biegt das wieder hin.
  options.global = {
    fetch: (url, opts) => {
      const targetUrl = url.replace('/rest/v1/', '/');
      return fetch(targetUrl, opts).catch(err => {
        console.error(`[Supabase/PostgREST Connection Error] Failed to connect to ${targetUrl}:`, err.message);
        throw err;
      });
    }
  };
}

const supabase = createClient(config.url, config.key, options);

module.exports = supabase;
