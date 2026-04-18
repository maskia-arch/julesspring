/**
 * i18n.js  v1.4.26
 * Bot-Systemsprache: DE + Top-5 Weltsprachen
 * EN, ES, ZH, AR, FR
 * Alle Menütexte hartkodiert → kein API-Call nötig
 */

const SUPPORTED_LANGUAGES = {
  de: "🇩🇪 Deutsch",
  en: "🇬🇧 English",
  es: "🇪🇸 Español",
  zh: "🇨🇳 中文",
  ar: "🇸🇦 العربية",
  fr: "🇫🇷 Français",
};

const T = {
  // Settings menu header
  settings_header: {
    de: (title) => `⚙️ <b>Einstellungen für: ${title}</b>`,
    en: (title) => `⚙️ <b>Settings for: ${title}</b>`,
    es: (title) => `⚙️ <b>Ajustes para: ${title}</b>`,
    zh: (title) => `⚙️ <b>${title} 的设置</b>`,
    ar: (title) => `⚙️ <b>إعدادات: ${title}</b>`,
    fr: (title) => `⚙️ <b>Paramètres de: ${title}</b>`,
  },
  status_approved: {
    de: "🟢 Freigeschaltet", en: "🟢 Active", es: "🟢 Activo",
    zh: "🟢 已激活", ar: "🟢 مفعّل", fr: "🟢 Activé",
  },
  status_pending: {
    de: "🔴 Ausstehend", en: "🔴 Pending", es: "🔴 Pendiente",
    zh: "🔴 待审核", ar: "🔴 قيد الانتظار", fr: "🔴 En attente",
  },
  ai_active: {
    de: "✅ Aktiv", en: "✅ Active", es: "✅ Activo",
    zh: "✅ 已启用", ar: "✅ نشط", fr: "✅ Actif",
  },
  ai_inactive: {
    de: "❌ Inaktiv", en: "❌ Inactive", es: "❌ Inactivo",
    zh: "❌ 未启用", ar: "❌ غير نشط", fr: "❌ Inactif",
  },
  choose_action: {
    de: "Wähle was du verwalten möchtest:",
    en: "Choose what you want to manage:",
    es: "Elige qué quieres gestionar:",
    zh: "选择你要管理的内容：",
    ar: "اختر ما تريد إدارته:",
    fr: "Choisissez ce que vous voulez gérer :",
  },
  btn_welcome: {
    de: "👋 Willkommensnachricht", en: "👋 Welcome message",
    es: "👋 Mensaje de bienvenida", zh: "👋 欢迎消息",
    ar: "👋 رسالة الترحيب", fr: "👋 Message de bienvenue",
  },
  btn_goodbye: {
    de: "👋 Abschiedsnachricht", en: "👋 Goodbye message",
    es: "👋 Mensaje de despedida", zh: "👋 告别消息",
    ar: "👋 رسالة الوداع", fr: "👋 Message d'au revoir",
  },
  btn_schedule: {
    de: "⏰ Geplante Nachrichten", en: "⏰ Scheduled messages",
    es: "⏰ Mensajes programados", zh: "⏰ 定时消息",
    ar: "⏰ رسائل مجدولة", fr: "⏰ Messages planifiés",
  },
  btn_clean: {
    de: "🧹 Gelöschte bereinigen", en: "🧹 Clean deleted",
    es: "🧹 Limpiar eliminados", zh: "🧹 清理已删除",
    ar: "🧹 تنظيف المحذوفين", fr: "🧹 Nettoyer les supprimés",
  },
  btn_stats: {
    de: "📊 Statistiken", en: "📊 Statistics",
    es: "📊 Estadísticas", zh: "📊 统计",
    ar: "📊 الإحصاءات", fr: "📊 Statistiques",
  },
  btn_safelist: {
    de: "🛡 Safelist", en: "🛡 Safelist",
    es: "🛡 Lista segura", zh: "🛡 安全名单",
    ar: "🛡 قائمة آمنة", fr: "🛡 Liste sûre",
  },
  btn_ai: {
    de: "🤖 KI-Features", en: "🤖 AI Features",
    es: "🤖 Funciones IA", zh: "🤖 AI 功能",
    ar: "🤖 ميزات الذكاء", fr: "🤖 Fonctions IA",
  },
  btn_language: {
    de: "🌐 Sprache", en: "🌐 Language",
    es: "🌐 Idioma", zh: "🌐 语言",
    ar: "🌐 اللغة", fr: "🌐 Langue",
  },
  welcome_intro: {
    de: (username) =>
      `👋 Hallo${username ? " " + username : ""}!\n\nFüge mich als Admin zu deinem Channel/Gruppe hinzu und schreibe dann /start hier.\n\nBefehle: /menu · /settings · /dashboard · /help`,
    en: (username) =>
      `👋 Hi${username ? " " + username : ""}!\n\nAdd me as admin to your channel/group, then write /start here.\n\nCommands: /menu · /settings · /dashboard · /help`,
    es: (username) =>
      `👋 ¡Hola${username ? " " + username : ""}!\n\nAgrégame como admin a tu canal/grupo y luego escribe /start aquí.\n\nComandos: /menu · /settings · /dashboard`,
    zh: (username) =>
      `👋 你好${username ? username : ""}！\n\n将我添加为你的频道/群组管理员，然后在这里发送 /start。\n\n命令：/menu · /settings · /dashboard`,
    ar: (username) =>
      `👋 مرحباً${username ? " " + username : ""}!\n\nأضفني كمشرف في قناتك/مجموعتك ثم اكتب /start هنا.\n\nالأوامر: /menu · /settings`,
    fr: (username) =>
      `👋 Bonjour${username ? " " + username : ""}!\n\nAjoutez-moi comme admin à votre canal/groupe, puis écrivez /start ici.\n\nCommandes : /menu · /settings · /dashboard`,
  },
  summary_creating: {
    de: (est) => `⏳ Erstelle Tageszusammenfassung… (~${est} Token)`,
    en: (est) => `⏳ Creating daily summary… (~${est} tokens)`,
    es: (est) => `⏳ Creando resumen diario… (~${est} tokens)`,
    zh: (est) => `⏳ 正在生成每日摘要… (~${est} 代币)`,
    ar: (est) => `⏳ جارٍ إنشاء الملخص اليومي… (~${est} رمز)`,
    fr: (est) => `⏳ Création du résumé quotidien… (~${est} tokens)`,
  },
  summary_cooldown: {
    de: (nextAt) => `⏳ Tageszusammenfassung nur 1x pro 24h.\nNächste möglich um ${nextAt}.`,
    en: (nextAt) => `⏳ Daily summary only once per 24h.\nNext available at ${nextAt}.`,
    es: (nextAt) => `⏳ Resumen diario solo 1x cada 24h.\nPróximo disponible a las ${nextAt}.`,
    zh: (nextAt) => `⏳ 每日摘要每24小时仅限一次。\n下次可用时间：${nextAt}。`,
    ar: (nextAt) => `⏳ الملخص اليومي مرة واحدة كل 24 ساعة.\nمتاح التالي في ${nextAt}.`,
    fr: (nextAt) => `⏳ Résumé quotidien 1x par 24h seulement.\nProchain disponible à ${nextAt}.`,
  },
  language_menu: {
    de: "🌐 <b>Bot-Sprache wählen</b>\n\nWähle die Sprache für Menüs und Nachrichten in diesem Channel:",
    en: "🌐 <b>Select bot language</b>\n\nChoose the language for menus and messages in this channel:",
    es: "🌐 <b>Seleccionar idioma del bot</b>\n\nElige el idioma para menús y mensajes de este canal:",
    zh: "🌐 <b>选择机器人语言</b>\n\n为此频道的菜单和消息选择语言：",
    ar: "🌐 <b>اختر لغة البوت</b>\n\nاختر لغة القوائم والرسائل لهذه القناة:",
    fr: "🌐 <b>Choisir la langue du bot</b>\n\nChoisissez la langue des menus et messages de ce canal :",
  },
  language_set: {
    de: (lang) => `✅ Sprache auf ${lang} gesetzt.`,
    en: (lang) => `✅ Language set to ${lang}.`,
    es: (lang) => `✅ Idioma cambiado a ${lang}.`,
    zh: (lang) => `✅ 语言已设置为 ${lang}。`,
    ar: (lang) => `✅ تم تعيين اللغة إلى ${lang}.`,
    fr: (lang) => `✅ Langue définie sur ${lang}.`,
  },
};

/**
 * Get a translated string for the given key and language.
 * Falls back to German if language not found.
 */
function t(key, lang, ...args) {
  const entry = T[key];
  if (!entry) return key;
  const langCode = (lang || "de").split("-")[0].toLowerCase();
  const fn = entry[langCode] || entry["de"];
  if (typeof fn === "function") return fn(...args);
  return fn;
}

/**
 * Detect preferred language from Telegram user object.
 * Falls back to "de".
 */
function detectLang(telegramUser) {
  if (!telegramUser?.language_code) return "de";
  const code = telegramUser.language_code.split("-")[0].toLowerCase();
  return SUPPORTED_LANGUAGES[code] ? code : "de";
}

module.exports = { t, detectLang, SUPPORTED_LANGUAGES };
