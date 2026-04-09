const dotenv = require('dotenv');
dotenv.config();

// Fehlende Variablen als Warnung (kein harter Fehler, damit Deployment startet)
const required = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_USERNAME', 'ADMIN_PASSWORD'
];

required.forEach(name => {
  if (!process.env[name]) console.warn(`⚠️  Fehlende Umgebungsvariable: ${name}`);
});

module.exports = {
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
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
