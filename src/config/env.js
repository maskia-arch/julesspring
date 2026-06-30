const dotenv = require('dotenv');
dotenv.config();

const isSelfHosted = process.env.DB_SELF_HOSTED === 'true' || !!process.env.DATABASE_URL;

// Fehlende Variablen als Warnung (kein harter Fehler, damit Deployment startet)
const required = [
  ...(isSelfHosted ? ['DATABASE_URL', 'JWT_SECRET'] : ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']),
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_USERNAME', 'ADMIN_PASSWORD'
];

required.forEach(name => {
  if (!process.env[name]) console.warn(`⚠️  Fehlende Umgebungsvariable: ${name}`);
});

// Dynamische Datenbank-Konfiguration
let supabaseUrl = process.env.SUPABASE_URL;
let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (isSelfHosted) {
  // Wenn self-hosted, nutzen wir die PostgREST-Adresse (im Docker-Netzwerk standardmäßig 'http://postgrest:3000')
  supabaseUrl = process.env.SUPABASE_URL || 'http://postgrest:3000';
  
  // Wir signieren einen JWT-Token für PostgREST, um Abfragen mit der Rolle 'postgres' (Superuser) zu autorisieren
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'ai-adminhelper-secret-change-me-32-chars-long';
  
  try {
    supabaseKey = jwt.sign({ role: 'postgres' }, secret, { algorithm: 'HS256' });
  } catch (err) {
    console.error('⚠️ Fehler beim Signieren des PostgREST-Tokens:', err.message);
  }
}

module.exports = {
  supabase: {
    url: supabaseUrl,
    key: supabaseKey,
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: 'https://api.deepseek.com',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  admin: {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET || 'ai-assistant-secret-change-me'
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  sellauth: {
    apiKey:   process.env.SELLAUTH_API_KEY   || '',
    shopId:   process.env.SELLAUTH_SHOP_ID   || '',
    shopUrl:  process.env.SELLAUTH_SHOP_URL  || '',
  },
  vapid: {
    publicKey:  process.env.VAPID_PUBLIC_KEY  || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
  },
  port: process.env.PORT || 3000
};
