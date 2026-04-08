const { createClient } = require('@supabase/supabase-js');
const { supabase: config } = require('./env');

const supabase = createClient(config.url, config.key);

module.exports = supabase;
