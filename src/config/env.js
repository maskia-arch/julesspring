const dotenv = require('dotenv');
dotenv.config();

const requiredEnvs = [
  'SUPABASE_URL', 
  'SUPABASE_SERVICE_ROLE_KEY', 
  'DEEPSEEK_API_KEY', 
  'OPENAI_API_KEY', // Neu für Vektorsuche/Embeddings
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'VAPID_PUBLIC_KEY', // Neu für Push
  'VAPID_PRIVATE_KEY' // Neu für Push
];

requiredEnvs.forEach(name => {
  if (!process.env[name]) {
    console.warn(`Warning: Missing environment variable: ${name}`);
    // Wir werfen hier keinen Error, falls SELLAUTH optional bleiben soll
  }
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
    apiKey: process.env.OPENAI_API_KEY, // Benötigt für text-embedding-3-small
  },
  admin: {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET || 'esim-secure-secret'
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  sellauth: {
    apiKey: process.env.SELLAUTH_API_KEY,
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  },
  port: process.env.PORT || 3000
};
