/**
 * i18n.js — Vollständige Internationalisierung für AdminHelper & Support AI
 * 8 Sprachen: de / en / es / zh / ar / fr / ru / tr
 */

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
  // ── Bot-Einleitung ────────────────────────────────────────────────────────
  welcome_intro: {
    de: (u) => `👋 Hallo${u}!\n\nFüge mich als Admin zu deinem Channel/Gruppe hinzu und schreibe dann /start hier.\n\nBefehle: /menu · /settings · /dashboard · /help`,
    en: (u) => `👋 Hi${u}!\n\nAdd me as admin to your channel/group, then write /start here.\n\nCommands: /menu · /settings · /dashboard · /help`,
    es: (u) => `👋 ¡Hola${u}!\n\nAgrégame como admin a tu canal/grupo y luego escribe /start aquí.\n\nComandos: /menu · /settings · /dashboard`,
    zh: (u) => `👋 你好${u}！\n\n将我添加为频道/群组管理员，然后发送 /start。\n\n命令：/menu · /settings · /dashboard`,
    ar: (u) => `👋 مرحباً${u}!\n\nأضفني كمشرف في قناتك/مجموعتك ثم اكتب /start هنا.\n\nالأوامر: /menu · /settings`,
    fr: (u) => `👋 Bonjour${u}!\n\nAjoutez-moi comme admin à votre canal/groupe, puis écrivez /start ici.\n\nCommandes : /menu · /settings · /dashboard`,
    ru: (u) => `👋 Привет${u}!\n\nДобавьте меня как администратора в канал/группу, затем напишите /start.\n\nКоманды: /menu · /settings · /dashboard · /help`,
    tr: (u) => `👋 Merhaba${u}!\n\nBeni kanalınıza/grubunuza yönetici olarak ekleyin ve /start yazın.\n\nKomutlar: /menu · /settings · /dashboard · /help`,
  },

  // ── Hauptmenü ─────────────────────────────────────────────────────────────
  title: {
    de: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nKI: ${a} | Safelist: ${s} | Feedback: ${f}\n\nWähle eine Kategorie:`,
    en: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nAI: ${a} | Safelist: ${s} | Feedback: ${f}\n\nSelect a category:`,
    es: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nIA: ${a} | Safelist: ${s} | Feedback: ${f}\n\nElige una categoría:`,
    zh: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nAI: ${a} | 安全名单: ${s} | 反馈: ${f}\n\n选择类别：`,
    ar: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nذكاء: ${a} | آمن: ${s} | تقييم: ${f}\n\nاختر فئة:`,
    fr: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nIA: ${a} | Safelist: ${s} | Avis: ${f}\n\nChoisissez une catégorie :`,
    ru: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nИИ: ${a} | Сейфлист: ${s} | Отзывы: ${f}\n\nВыберите категорию:`,
    tr: (n,a,s,f) => `⚙️ <b>${n}</b>\n\nYZ: ${a} | Güvenli: ${s} | Geri Bildirim: ${f}\n\nKategori seçin:`,
  },

  // ── Status ────────────────────────────────────────────────────────────────
  ai_active:   { de:"✅ Aktiv",   en:"✅ Active",   es:"✅ Activo",  zh:"✅ 已启用", ar:"✅ نشط",       fr:"✅ Actif",    ru:"✅ Активен",  tr:"✅ Aktif"  },
  ai_inactive: { de:"❌ Inaktiv", en:"❌ Inactive", es:"❌ Inactivo",zh:"❌ 未启用", ar:"❌ غير نشط",   fr:"❌ Inactif",  ru:"❌ Неактивен",tr:"❌ Pasif"  },

  // ── Navigation ────────────────────────────────────────────────────────────
  back:      { de:"◀️ Zurück",    en:"◀️ Back",      es:"◀️ Volver",   zh:"◀️ 返回",  ar:"◀️ رجوع",     fr:"◀️ Retour",   ru:"◀️ Назад",      tr:"◀️ Geri"    },
  main:      { de:"◀️ Hauptmenü", en:"◀️ Main Menu", es:"◀️ Menú",     zh:"◀️ 主菜单", ar:"◀️ الرئيسية", fr:"◀️ Menu principal", ru:"◀️ Главное меню", tr:"◀️ Ana Menü" },
  cancel:    { de:"❌ Abbrechen", en:"❌ Cancel",     es:"❌ Cancelar", zh:"❌ 取消",   ar:"❌ إلغاء",     fr:"❌ Annuler",   ru:"❌ Отмена",      tr:"❌ İptal"    },
  skip_btn:  { de:"⏭ Überspringen", en:"⏭ Skip",    es:"⏭ Omitir",   zh:"⏭ 跳过",   ar:"⏭ تخطي",      fr:"⏭ Passer",    ru:"⏭ Пропустить",  tr:"⏭ Atla"     },

  // ── Haupt-Menü Buttons ────────────────────────────────────────────────────
  ch_settings: { de:"📋 Channel-Einstellungen", en:"📋 Channel Settings", es:"📋 Ajustes del canal", zh:"📋 频道设置", ar:"📋 إعدادات القناة", fr:"📋 Paramètres canal", ru:"📋 Настройки канала", tr:"📋 Kanal Ayarları" },
  mod:         { de:"🔒 Moderation",     en:"🔒 Moderation",   es:"🔒 Moderación",    zh:"🔒 管理",     ar:"🔒 الإشراف",      fr:"🔒 Modération",    ru:"🔒 Модерация",     tr:"🔒 Moderasyon"    },
  ai_feat:     { de:"🤖 AI Features",    en:"🤖 AI Features",  es:"🤖 Funciones IA",  zh:"🤖 AI功能",   ar:"🤖 ميزات الذكاء", fr:"🤖 Fonctions IA",  ru:"🤖 Функции ИИ",    tr:"🤖 YZ Özellikleri"},
  sl_btn:      { de:"🛡 Safelist {sl}",  en:"🛡 Safelist {sl}",es:"🛡 Lista segura {sl}",zh:"🛡 安全名单 {sl}",ar:"🛡 آمن {sl}", fr:"🛡 Liste sûre {sl}",ru:"🛡 Сейфлист {sl}", tr:"🛡 Güvenli {sl}"  },
  fb_btn:      { de:"💬 Feedback {fb}",  en:"💬 Feedback {fb}",es:"💬 Comentarios {fb}",zh:"💬 反馈 {fb}",ar:"💬 تقييمات {fb}",fr:"💬 Avis {fb}",    ru:"💬 Отзывы {fb}",   tr:"💬 Geri Bildirim {fb}" },

  // ── Channel-Einstellungen Buttons ─────────────────────────────────────────
  welcome:   { de:"👋 Willkommen",     en:"👋 Welcome",       es:"👋 Bienvenida",   zh:"👋 欢迎",   ar:"👋 ترحيب",    fr:"👋 Bienvenue",     ru:"👋 Приветствие",  tr:"👋 Karşılama"   },
  goodbye:   { de:"👋 Abschied",       en:"👋 Goodbye",       es:"👋 Despedida",    zh:"👋 告别",   ar:"👋 وداع",     fr:"👋 Au revoir",     ru:"👋 Прощание",     tr:"👋 Veda"        },
  sched:     { de:"📅 Zeitplan",       en:"📅 Schedule",      es:"📅 Horario",      zh:"📅 计划",   ar:"📅 جدول",     fr:"📅 Planification", ru:"📅 Расписание",   tr:"📅 Takvim"      },
  rep:       { de:"🔁 Wiederholungen", en:"🔁 Repeats",       es:"🔁 Repeticiones", zh:"🔁 重复",   ar:"🔁 تكرارات",  fr:"🔁 Répétitions",   ru:"🔁 Повторы",      tr:"🔁 Tekrarlar"   },
  lang:      { de:"🌐 Sprache",        en:"🌐 Language",      es:"🌐 Idioma",       zh:"🌐 语言",   ar:"🌐 اللغة",    fr:"🌐 Langue",        ru:"🌐 Язык",         tr:"🌐 Dil"         },
  stats:     { de:"📊 Statistik",      en:"📊 Statistics",    es:"📊 Estadísticas", zh:"📊 统计",   ar:"📊 إحصاءات",  fr:"📊 Statistiques",  ru:"📊 Статистика",   tr:"📊 İstatistik"  },
  admins:    { de:"👥 Admins verwalten",en:"👥 Manage Admins",es:"👥 Gestionar Admins",zh:"👥 管理管理员",ar:"👥 إدارة المشرفين",fr:"👥 Gérer les admins",ru:"👥 Управление админами",tr:"👥 Admin Yönet" },
  clean:     { de:"🧹 Bereinigen",     en:"🧹 Clean up",      es:"🧹 Limpiar",      zh:"🧹 清理",   ar:"🧹 تنظيف",    fr:"🧹 Nettoyer",      ru:"🧹 Очистка",      tr:"🧹 Temizlik"    },

  // ── Moderation Buttons ────────────────────────────────────────────────────
  bl:        { de:"🚫 Blacklist",      en:"🚫 Blacklist",     es:"🚫 Lista negra",  zh:"🚫 黑名单",  ar:"🚫 القائمة السوداء",fr:"🚫 Liste noire",  ru:"🚫 Черный список", tr:"🚫 Karaliste"   },
  ui:        { de:"🔍 UserInfo",       en:"🔍 User Info",     es:"🔍 Info usuario", zh:"🔍 用户信息", ar:"🔍 معلومات",  fr:"🔍 Infos user",    ru:"🔍 Инфо",         tr:"🔍 Kullanıcı"   },
  fb_mgr:    { de:"👤 User-Feedbacks verwalten",en:"👤 Manage User Feedbacks",es:"👤 Gestionar comentarios",zh:"👤 管理反馈",ar:"👤 إدارة التقييمات",fr:"👤 Gérer les avis",ru:"👤 Управление отзывами",tr:"👤 Geri Bildirimleri Yönet" },
  banned:    { de:"🚫 Gebannte User",  en:"🚫 Banned Users",  es:"🚫 Usuarios ban", zh:"🚫 封禁用户", ar:"🚫 محظورون",  fr:"🚫 Bannis",        ru:"🚫 Забаненные",   tr:"🚫 Yasaklılar"  },

  // ── AI Features Buttons ───────────────────────────────────────────────────
  daily:     { de:"📰 Tagesbericht",    en:"📰 Daily Report",  es:"📰 Informe diario",zh:"📰 日报",   ar:"📰 التقرير اليومي",fr:"📰 Rapport journalier",ru:"📰 Дневной отчет",tr:"📰 Günlük Rapor" },
  st:        { de:"💬 Smalltalk AI",    en:"💬 Smalltalk AI",  es:"💬 Charla IA",    zh:"💬 闲聊AI",  ar:"💬 محادثة ذكاء", fr:"💬 Discussion IA", ru:"💬 Болтовня ИИ",  tr:"💬 Sohbet YZ"   },
  kb:        { de:"📚 Wissensdatenbank", en:"📚 Knowledge Base",es:"📚 Base de datos",zh:"📚 知识库",  ar:"📚 قاعدة معرفة",fr:"📚 Base de connaissance",ru:"📚 База знаний",tr:"📚 Bilgi Bankası"},
  aw:        { de:"✍️ WerbeTexter",     en:"✍️ Ad Writer",     es:"✍️ Redactor",     zh:"✍️ 广告撰写", ar:"✍️ كاتب إعلانات",fr:"✍️ Rédacteur pub", ru:"✍️ Копирайтер",   tr:"✍️ Reklam Yazarı"},
  bl_ai:     { de:"✨ Blacklist Enhancer",en:"✨ Blacklist Enhancer",es:"✨ Mejora Blacklist",zh:"✨ 黑名单增强",ar:"✨ محسّن القائمة",fr:"✨ Améliorateur BL",ru:"✨ AI Blacklist", tr:"✨ AI Karaliste" },
  credits:   { de:"💳 Credits verwalten",en:"💳 Manage Credits",es:"💳 Gestionar créditos",zh:"💳 管理积分",ar:"💳 إدارة الاعتمادات",fr:"💳 Gérer les crédits",ru:"💳 Кредиты",    tr:"💳 Kredi Yönet"  },
  group_games:{ de:"🔒 Gruppenspiele", en:"🔒 Group Games",    es:"🔒 Juegos de grupo",zh:"🔒 群组游戏",ar:"🔒 ألعاب المجموعة",fr:"🔒 Jeux de groupe",ru:"🔒 Групповые игры",tr:"🔒 Grup Oyunları"},

  // ── Sperr-Meldungen ───────────────────────────────────────────────────────
  ai_locked: {
    de:"🤖 <b>AI Features</b> — Gesperrt\n\nNutze <b>/buy</b> um ein Paket zu kaufen.",
    en:"🤖 <b>AI Features</b> — Locked\n\nUse <b>/buy</b> to get a package.",
    es:"🤖 <b>AI Features</b> — Bloqueado\n\nUsa <b>/buy</b> para obtener un paquete.",
    zh:"🤖 <b>AI功能</b> — 已锁定\n\n使用 <b>/buy</b> 购买套餐。",
    ar:"🤖 <b>AI Features</b> — مقفل\n\nاستخدم <b>/buy</b> للحصول على حزمة.",
    fr:"🤖 <b>AI Features</b> — Verrouillé\n\nUtilisez <b>/buy</b> pour acheter un forfait.",
    ru:"🤖 <b>AI Features</b> — Заблокировано\n\nИспользуйте <b>/buy</b>.",
    tr:"🤖 <b>AI Features</b> — Kilitli\n\n<b>/buy</b> komutunu kullanın.",
  },
  mod_locked: {
    de:"🔒 <b>Moderation</b> — Gesperrt\n\nDein Kanal ist noch nicht verifiziert.\nBitte melde dich bei @autoacts.",
    en:"🔒 <b>Moderation</b> — Locked\n\nYour channel is not yet verified.\nPlease contact @autoacts.",
    es:"🔒 <b>Moderación</b> — Bloqueado\n\nTu canal no está verificado. Contacta @autoacts.",
    zh:"🔒 <b>管理</b> — 已锁定\n\n您的频道尚未验证。请联系 @autoacts。",
    ar:"🔒 <b>الإشراف</b> — مقفل\n\nقناتك غير مُحققة. يرجى التواصل مع @autoacts.",
    fr:"🔒 <b>Modération</b> — Verrouillé\n\nVotre canal n'est pas encore vérifié. Contactez @autoacts.",
    ru:"🔒 <b>Moderation</b> — Заблокировано\n\nКанал не верифицирован. Обратитесь к @autoacts.",
    tr:"🔒 <b>Moderasyon</b> — Kilitli\n\nKanalınız doğrulanmadı. @autoacts ile iletişime geçin.",
  },

  // ── Sprach-Menü ───────────────────────────────────────────────────────────
  language_menu: {
    de:"🌐 <b>Bot-Sprache wählen</b>\n\nWähle die Sprache für Menüs und Nachrichten:",
    en:"🌐 <b>Select bot language</b>\n\nChoose the language for menus and messages:",
    es:"🌐 <b>Seleccionar idioma</b>\n\nElige el idioma para menús y mensajes:",
    zh:"🌐 <b>选择语言</b>\n\n为菜单和消息选择语言：",
    ar:"🌐 <b>اختر اللغة</b>\n\nاختر لغة القوائم والرسائل:",
    fr:"🌐 <b>Choisir la langue</b>\n\nChoisissez la langue des menus et messages :",
    ru:"🌐 <b>Выбрать язык</b>\n\nВыберите язык для меню и сообщений:",
    tr:"🌐 <b>Dil seçin</b>\n\nMenüler ve mesajlar için dili seçin:",
  },
  language_set: {
    de: (l) => `✅ Sprache auf ${l} gesetzt.`,
    en: (l) => `✅ Language set to ${l}.`,
    es: (l) => `✅ Idioma cambiado a ${l}.`,
    zh: (l) => `✅ 语言已设置为 ${l}。`,
    ar: (l) => `✅ تم تعيين اللغة إلى ${l}.`,
    fr: (l) => `✅ Langue définie sur ${l}.`,
    ru: (l) => `✅ Язык изменен на ${l}.`,
    tr: (l) => `✅ Dil ${l} olarak ayarlandı.`,
  },

  // ── Tagesbericht ──────────────────────────────────────────────────────────
  summary_creating: {
    de: (e) => `⏳ Erstelle Tageszusammenfassung… (~${e} Token)`,
    en: (e) => `⏳ Creating daily summary… (~${e} tokens)`,
    es: (e) => `⏳ Creando resumen diario… (~${e} tokens)`,
    zh: (e) => `⏳ 正在生成每日摘要… (~${e} 代币)`,
    ar: (e) => `⏳ جارٍ إنشاء الملخص… (~${e} رمز)`,
    fr: (e) => `⏳ Création du résumé quotidien… (~${e} tokens)`,
    ru: (e) => `⏳ Создание отчета… (~${e} токенов)`,
    tr: (e) => `⏳ Günlük özet oluşturuluyor… (~${e} token)`,
  },
  summary_cooldown: {
    de: (n) => `⏳ Tageszusammenfassung nur 1x/24h.\nNächste möglich um ${n}.`,
    en: (n) => `⏳ Daily summary once per 24h.\nNext available at ${n}.`,
    es: (n) => `⏳ Resumen solo 1x/24h.\nPróximo a las ${n}.`,
    zh: (n) => `⏳ 每日摘要每24小时一次。\n下次：${n}。`,
    ar: (n) => `⏳ ملخص مرة/24 ساعة. التالي: ${n}.`,
    fr: (n) => `⏳ Résumé 1x/24h.\nProchain à ${n}.`,
    ru: (n) => `⏳ Отчет 1x/24ч. Следующий в ${n}.`,
    tr: (n) => `⏳ Özet 24 saatte 1 kez.\nSonraki: ${n}.`,
  },

  // ── AI-Prompt Sprach-Präfix ───────────────────────────────────────────────
  // Wird dem System-Prompt vorangestellt damit die AI in der richtigen Sprache antwortet
  ai_lang_instruction: {
    de: "",
    en: "IMPORTANT: Always respond in English, regardless of the language the user writes in.\n\n",
    es: "IMPORTANTE: Responde siempre en español, independientemente del idioma del usuario.\n\n",
    zh: "重要：无论用户使用何种语言，始终用中文回复。\n\n",
    ar: "مهم: أجب دائمًا باللغة العربية بغض النظر عن لغة المستخدم.\n\n",
    fr: "IMPORTANT : Réponds toujours en français, quelle que soit la langue de l'utilisateur.\n\n",
    ru: "ВАЖНО: Всегда отвечай на русском языке, независимо от языка пользователя.\n\n",
    tr: "ÖNEMLİ: Kullanıcının diline bakılmaksızın her zaman Türkçe yanıt ver.\n\n",
  },

  // ── Safelist-Disclaimer ───────────────────────────────────────────────────
  safelist_disclaimer: {
    de: "\n\n⚠️ <i>Hinweis: Die Aufnahme in die Safelist bedeutet, dass dieser User von einem Channel-Admin als vertrauenswürdig eingestuft wurde. Dies stellt jedoch <b>keine Garantie</b> dar und die Betreiber übernehmen <b>keinerlei Haftung</b>. Vertraue immer deinem eigenen Bauchgefühl.</i>",
    en: "\n\n⚠️ <i>Note: Being on the Safelist means this user was marked as trustworthy by a channel admin. This is <b>no guarantee</b> and the operators assume <b>no liability</b>. Always trust your own judgement.</i>",
    es: "\n\n⚠️ <i>Nota: Estar en la Safelist significa que un admin marcó a este usuario como confiable. Esto <b>no es una garantía</b> y los operadores <b>no asumen responsabilidad</b>. Confía en tu propio criterio.</i>",
    zh: "\n\n⚠️ <i>注意：加入安全名单意味着该用户被频道管理员标记为可信。这<b>不是保证</b>，运营者<b>不承担任何责任</b>。请相信自己的判断。</i>",
    ar: "\n\n⚠️ <i>ملاحظة: الوجود في القائمة الآمنة يعني توثيق المشرف لهذا المستخدم. هذا <b>ليس ضمانًا</b> ولا تتحمل الإدارة <b>أي مسؤولية</b>. ثق بحكمك الخاص.</i>",
    fr: "\n\n⚠️ <i>Remarque : Être sur la Safelist signifie qu'un admin a jugé cet utilisateur fiable. Ceci n'est <b>pas une garantie</b> et les opérateurs n'assument <b>aucune responsabilité</b>. Faites confiance à votre propre jugement.</i>",
    ru: "\n\n⚠️ <i>Примечание: Сейфлист означает, что администратор отметил пользователя надёжным. Это <b>не гарантия</b>, операторы не несут <b>никакой ответственности</b>. Доверяйте своей интуиции.</i>",
    tr: "\n\n⚠️ <i>Not: Güvenli listede olmak, bu kullanıcının bir kanal yöneticisi tarafından güvenilir olarak işaretlendiği anlamına gelir. Bu bir <b>garanti değildir</b> ve operatörler <b>hiçbir sorumluluk</b> kabul etmez. Kendi yargınıza güvenin.</i>",
  },
};

/**
 * Übersetzt einen Schlüssel.
 * Fallback-Reihenfolge: gewünschte Sprache → Englisch → Deutsch → Schlüssel
 */
function t(key, lang, ...args) {
  const entry = T[key];
  if (!entry) return key;
  const code = (lang || "de").split("-")[0].toLowerCase();
  const fn   = entry[code] || entry["en"] || entry["de"];
  if (typeof fn === "function") return fn(...args);
  return fn ?? key;
}

function detectLang(telegramUser) {
  if (!telegramUser?.language_code) return "de";
  const code = telegramUser.language_code.split("-")[0].toLowerCase();
  return SUPPORTED_LANGUAGES[code] ? code : "de";
}

/**
 * Gibt die Sprach-Anweisung für AI-Prompts zurück.
 * Wenn Kanalsprache ≠ Deutsch, wird der System-Prompt um diese Anweisung ergänzt
 * damit die AI in der richtigen Sprache antwortet.
 */
function getLangInstruction(lang) {
  const code = (lang || "de").split("-")[0].toLowerCase();
  return T.ai_lang_instruction[code] ?? T.ai_lang_instruction["de"];
}

/** Stub — wird von server.js aufgerufen, ist aber nicht nötig (alle Keys sind hardcoded). */
async function preloadTranslations() {
  return Promise.resolve();
}

module.exports = { t, detectLang, getLangInstruction, preloadTranslations, SUPPORTED_LANGUAGES };
