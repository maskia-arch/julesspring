const SUPPORTED_LANGUAGES = {
  de: "🇩🇪 Deutsch",
  en: "🇬🇧 English",
  es: "🇪🇸 Español",
  zh: "🇨🇳 中文",
  ar: "🇸🇦 العربية",
  fr: "🇫🇷 Français",
  ru: "🇷🇺 Русский",
  tr: "🇹🇷 Türkçe",
};

const T = {
  settings_header: {
    de: (title) => `⚙️ <b>Einstellungen für: ${title}</b>`,
    en: (title) => `⚙️ <b>Settings for: ${title}</b>`,
    es: (title) => `⚙️ <b>Ajustes para: ${title}</b>`,
    zh: (title) => `⚙️ <b>${title} 的设置</b>`,
    ar: (title) => `⚙️ <b>إعدادات: ${title}</b>`,
    fr: (title) => `⚙️ <b>Paramètres de: ${title}</b>`,
    ru: (title) => `⚙️ <b>Настройки для: ${title}</b>`,
    tr: (title) => `⚙️ <b>${title} için ayarlar</b>`,
  },
  status_approved: {
    de: "🟢 Freigeschaltet", en: "🟢 Active", es: "🟢 Activo",
    zh: "🟢 已激活", ar: "🟢 مفعّل", fr: "🟢 Activé",
    ru: "🟢 Одобрено", tr: "🟢 Onaylandı",
  },
  status_pending: {
    de: "🔴 Ausstehend", en: "🔴 Pending", es: "🔴 Pendiente",
    zh: "🔴 待审核", ar: "🔴 قيد الانتظار", fr: "🔴 En attente",
    ru: "🔴 В ожидании", tr: "🔴 Bekliyor",
  },
  ai_active: {
    de: "✅ Aktiv", en: "✅ Active", es: "✅ Activo",
    zh: "✅ 已启用", ar: "✅ نشط", fr: "✅ Actif",
    ru: "✅ Активен", tr: "✅ Aktif",
  },
  ai_inactive: {
    de: "❌ Inaktiv", en: "❌ Inactive", es: "❌ Inactivo",
    zh: "❌ 未启用", ar: "❌ غير نشط", fr: "❌ Inactif",
    ru: "❌ Неактивен", tr: "❌ Pasif",
  },
  choose_action: {
    de: "Wähle was du verwalten möchtest:",
    en: "Choose what you want to manage:",
    es: "Elige qué quieres gestionar:",
    zh: "选择你要管理的内容：",
    ar: "اختر ما تريد إدارته:",
    fr: "Choisissez ce que vous voulez gérer :",
    ru: "Выберите, что вы хотите настроить:",
    tr: "Neyi yönetmek istediğinizi seçin:",
  },
  btn_welcome: {
    de: "👋 Willkommensnachricht", en: "👋 Welcome message",
    es: "👋 Mensaje de bienvenida", zh: "👋 欢迎消息",
    ar: "👋 رسالة الترحيب", fr: "👋 Message de bienvenue",
    ru: "👋 Сообщение приветствия", tr: "👋 Karşılama mesajı",
  },
  btn_goodbye: {
    de: "👋 Abschiedsnachricht", en: "👋 Goodbye message",
    es: "👋 Mensaje de despedida", zh: "👋 告别消息",
    ar: "👋 رسالة الوداع", fr: "👋 Message d'au revoir",
    ru: "👋 Сообщение прощания", tr: "👋 Veda mesajı",
  },
  btn_schedule: {
    de: "⏰ Geplante Nachrichten", en: "⏰ Scheduled messages",
    es: "⏰ Mensajes programados", zh: "⏰ 定时消息",
    ar: "⏰ رسائل مجدولة", fr: "⏰ Messages planifiés",
    ru: "⏰ Запланированные сообщения", tr: "⏰ Planlanmış mesajlar",
  },
  btn_clean: {
    de: "🧹 Gelöschte bereinigen", en: "🧹 Clean deleted",
    es: "🧹 Limpiar eliminados", zh: "🧹 清理已删除",
    ar: "🧹 تنظيف المحذوفين", fr: "🧹 Nettoyer les supprimés",
    ru: "🧹 Очистить удаленные", tr: "🧹 Silinenleri temizle",
  },
  btn_stats: {
    de: "📊 Statistiken", en: "📊 Statistics",
    es: "📊 Estadísticas", zh: "📊 统计",
    ar: "📊 الإحصاءات", fr: "📊 Statistiques",
    ru: "📊 Статистика", tr: "📊 İstatistikler",
  },
  btn_safelist: {
    de: "🛡 Safelist", en: "🛡 Safelist",
    es: "🛡 Lista segura", zh: "🛡 安全名单",
    ar: "🛡 قائمة آمنة", fr: "🛡 Liste sûre",
    ru: "🛡 Сейфлист", tr: "🛡 Güvenli Liste",
  },
  btn_ai: {
    de: "🤖 KI-Features", en: "🤖 AI Features",
    es: "🤖 Funciones IA", zh: "🤖 AI 功能",
    ar: "🤖 ميزات الذكاء", fr: "🤖 Fonctions IA",
    ru: "🤖 Функции ИИ", tr: "🤖 YZ Özellikleri",
  },
  btn_language: {
    de: "🌐 Sprache", en: "🌐 Language",
    es: "🌐 Idioma", zh: "🌐 语言",
    ar: "🌐 اللغة", fr: "🌐 Langue",
    ru: "🌐 Язык", tr: "🌐 Dil",
  },
  welcome_intro: {
    de: (username) => `👋 Hallo${username ? " " + username : ""}!\n\nFüge mich als Admin zu deinem Channel/Gruppe hinzu und schreibe dann /start hier.\n\nBefehle: /menu · /settings · /dashboard · /help`,
    en: (username) => `👋 Hi${username ? " " + username : ""}!\n\nAdd me as admin to your channel/group, then write /start here.\n\nCommands: /menu · /settings · /dashboard · /help`,
    es: (username) => `👋 ¡Hola${username ? " " + username : ""}!\n\nAgrégame como admin a tu canal/grupo y luego escribe /start aquí.\n\nComandos: /menu · /settings · /dashboard`,
    zh: (username) => `👋 你好${username ? username : ""}！\n\n将我添加为你的频道/群组管理员，然后在这里发送 /start。\n\n命令：/menu · /settings · /dashboard`,
    ar: (username) => `👋 مرحباً${username ? " " + username : ""}!\n\nأضفني كمشرف في قناتك/مجموعتك ثم اكتب /start هنا.\n\nالأوامر: /menu · /settings`,
    fr: (username) => `👋 Bonjour${username ? " " + username : ""}!\n\nAjoutez-moi comme admin à votre canal/groupe, puis écrivez /start ici.\n\nCommandes : /menu · /settings · /dashboard`,
    ru: (username) => `👋 Привет${username ? " " + username : ""}!\n\nДобавьте меня как администратора в ваш канал/группу, затем напишите /start здесь.\n\nКоманды: /menu · /settings · /dashboard · /help`,
    tr: (username) => `👋 Merhaba${username ? " " + username : ""}!\n\nBeni kanalınıza/grubunuza yönetici olarak ekleyin ve buraya /start yazın.\n\nKomutlar: /menu · /settings · /dashboard · /help`,
  },
  summary_creating: {
    de: (est) => `⏳ Erstelle Tageszusammenfassung… (~${est} Token)`,
    en: (est) => `⏳ Creating daily summary… (~${est} tokens)`,
    es: (est) => `⏳ Creando resumen diario… (~${est} tokens)`,
    zh: (est) => `⏳ 正在生成每日摘要… (~${est} 代币)`,
    ar: (est) => `⏳ جارٍ إنشاء الملخص اليومي… (~${est} رمز)`,
    fr: (est) => `⏳ Création du résumé quotidien… (~${est} tokens)`,
    ru: (est) => `⏳ Создание дневного отчета… (~${est} токенов)`,
    tr: (est) => `⏳ Günlük özet oluşturuluyor… (~${est} token)`,
  },
  summary_cooldown: {
    de: (nextAt) => `⏳ Tageszusammenfassung nur 1x pro 24h.\nNächste möglich um ${nextAt}.`,
    en: (nextAt) => `⏳ Daily summary only once per 24h.\nNext available at ${nextAt}.`,
    es: (nextAt) => `⏳ Resumen diario solo 1x cada 24h.\nPróximo disponible a las ${nextAt}.`,
    zh: (nextAt) => `⏳ 每日摘要每24小时仅限一次。\n下次可用时间：${nextAt}。`,
    ar: (nextAt) => `⏳ الملخص اليومي مرة واحدة كل 24 ساعة.\nمتاح التالي في ${nextAt}.`,
    fr: (nextAt) => `⏳ Résumé quotidien 1x par 24h seulement.\nProchain disponible à ${nextAt}.`,
    ru: (nextAt) => `⏳ Дневной отчет доступен только 1x в 24 часа.\nСледующий доступен в ${nextAt}.`,
    tr: (nextAt) => `⏳ Günlük özet 24 saatte sadece 1 kez alınabilir.\nBir sonraki uygun zaman: ${nextAt}.`,
  },
  language_menu: {
    de: "🌐 <b>Bot-Sprache wählen</b>\n\nWähle die Sprache für Menüs und Nachrichten in diesem Channel:",
    en: "🌐 <b>Select bot language</b>\n\nChoose the language for menus and messages in this channel:",
    es: "🌐 <b>Seleccionar idioma del bot</b>\n\nElige el idioma para menús y mensajes de este canal:",
    zh: "🌐 <b>选择机器人语言</b>\n\n为此频道的菜单和消息选择语言：",
    ar: "🌐 <b>اختر لغة البوت</b>\n\nاختر لغة القوائم والرسائل لهذه القناة:",
    fr: "🌐 <b>Choisir la langue du bot</b>\n\nChoisissez la langue des menus et messages de ce canal :",
    ru: "🌐 <b>Выберите язык бота</b>\n\nВыберите язык для меню и сообщений в этом канале:",
    tr: "🌐 <b>Bot dilini seçin</b>\n\nBu kanaldaki menüler ve mesajlar için dili seçin:",
  },
  language_set: {
    de: (lang) => `✅ Sprache auf ${lang} gesetzt.`,
    en: (lang) => `✅ Language set to ${lang}.`,
    es: (lang) => `✅ Idioma cambiado a ${lang}.`,
    zh: (lang) => `✅ 语言已设置为 ${lang}。`,
    ar: (lang) => `✅ تم تعيين اللغة إلى ${lang}.`,
    fr: (lang) => `✅ Langue définie sur ${lang}.`,
    ru: (lang) => `✅ Язык изменен на ${lang}.`,
    tr: (lang) => `✅ Dil ${lang} olarak ayarlandı.`,
  },
};

function t(key, lang, ...args) {
  const entry = T[key];
  if (!entry) return key;
  const langCode = (lang || "de").split("-")[0].toLowerCase();
  const fn = entry[langCode] || entry["de"];
  if (typeof fn === "function") return fn(...args);
  return fn;
}

function detectLang(telegramUser) {
  if (!telegramUser?.language_code) return "de";
  const code = telegramUser.language_code.split("-")[0].toLowerCase();
  return SUPPORTED_LANGUAGES[code] ? code : "de";
}

module.exports = { t, detectLang, SUPPORTED_LANGUAGES };
