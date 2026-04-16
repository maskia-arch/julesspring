/**
 * messageProcessor.js v1.3.5
 *
 * Token-Strategie:
 * - Letzte N Nachrichten senden (default: 4, konfigurierbar)
 * - Alle 5 Nachrichten: Chat-Zusammenfassung async aktualisieren
 * - Summary wird mitgesendet → ersetzt ältere History
 * - Ergebnis: ~60-70% weniger Input-Tokens
 */

const supabase            = require('../config/supabase');
const deepseekService     = require('./deepseekService');
const telegramService     = require('./telegramService');
const embeddingService    = require('./embeddingService');
const notificationService = require('./notificationService');
const abuseDetector       = require('./abuseDetector');
const couponService       = require('./couponService');
const logger              = require('../utils/logger');

let _settingsCache     = null;
let _settingsCacheTime = 0;
const CACHE_TTL        = 30_000;

const messageProcessor = {

  async handle({ platform, chatId, text, metadata = {} }) {
    const t0 = Date.now();

    // 1. Abuse-Check
    const abuse = await abuseDetector.check(chatId, text);
    if (abuse.blocked) {
      if (abuse.reason === 'rate_limit' && platform === 'telegram') {
        await telegramService.sendMessage(chatId, 'Bitte nicht so viele Nachrichten auf einmal. Kurz warten.').catch(() => {});
      }
      return null;
    }

    // 2. Chat + Settings parallel
    const [chat, settings] = await Promise.all([
      this._getOrCreateChat(chatId, platform, metadata),
      this._loadSettings()
    ]);
    if (!chat) throw new Error('Chat konnte nicht angelegt werden');

    const isFirstMessage = !chat._existed;

    // 3. Nutzer-Nachricht speichern (fire & forget)
    void (async () => {
      try {
        await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
      } catch (e) { logger.warn('[MP] msg insert:', e.message); }
    })();

    this._updateChatPreview(chat.id, text, 'user');

    // 4. Push-Benachrichtigung
    void (async () => {
      try {
        await notificationService.sendNewMessageNotification({
          chatId: chat.id, text, firstName: metadata?.first_name || null,
          platform, isFirstMessage
        });
      } catch (_) {}
    })();

    // 5. Human Handover: KI aus
    if (chat.is_manual_mode) {
      logger.info(`[MP] Manuell-Modus: ${chatId}`);
      return null;
    }

    // 6. Typing
    if (platform === 'telegram') telegramService.sendTypingAction(chatId).catch(() => {});

    // 7. Token-optimierte History (last N + summary)
    const maxHistory     = parseInt(settings.max_history_msgs)  || 4;
    const summaryInterval = parseInt(settings.summary_interval) || 5;

    const [context, allHistory, chatData] = await Promise.all([
      this._searchKnowledge(text, settings),
      supabase.from('messages').select('role, content')
        .eq('chat_id', chat.id)
        .neq('role', 'system')
        .order('created_at', { ascending: false })
        .limit(Math.max(maxHistory + summaryInterval, 20))
        .then(r => (r.data || []).reverse()),
      supabase.from('chats')
        .select('chat_summary, summary_msg_count')
        .eq('id', chat.id)
        .single()
        .then(r => r.data || {})
    ]);

    // Letzten N Nachrichten für den API-Call
    const recentHistory = allHistory.slice(-maxHistory);
    const chatSummary   = chatData.chat_summary || null;

    logger.info(`[MP] ${Date.now()-t0}ms – RAG:${context.length} hist:${recentHistory.length}/${allHistory.length} summary:${chatSummary ? 'ja' : 'nein'}`);

    // 8. KI-Antwort
    // Coupon-Kontext NUR bei coupon-bezogenen Fragen laden (spart Tokens)
    const COUPON_KEYWORDS = /rabatt|coupon|gutschein|code|aktions?|angebot|deal|discount|promo|spare|sparen|reduz/i;
    let couponContext = null;
    if (COUPON_KEYWORDS.test(text)) {
      try {
        const activeCoupon = await couponService.getActiveCoupon();
        if (activeCoupon) {
          const exp = new Date(activeCoupon.expires_at).toLocaleDateString('de-DE');
          couponContext = `AKTUELLER COUPON: Code "${activeCoupon.code}" - ${activeCoupon.description} (gültig bis ${exp})`;
        } else {
          couponContext = 'AKTUELLER COUPON: Kein aktiver Coupon heute.';
        }
      } catch (_) {}
    }

    const fullSummary = [chatSummary, couponContext].filter(Boolean).join('\n\n') || null;

    // Wenn Produkt-Query ohne ausreichende KB-Abdeckung → Safety-Kontext vorschalten
    let finalContext = context;
    if (typeof _ragProductMiss !== 'undefined' && _ragProductMiss) {
      finalContext = [{
        content: '⚠️ WICHTIG: Diese Anfrage hat KEINE ausreichenden Produkt-Treffer in der Wissensdatenbank. KEIN Produkt oder Link erfinden! Weise stattdessen auf @autoacts für individuelle Tarifberatung hin.'
      }, ...(context || [])];
    }

    const aiResult = await Promise.race([
      deepseekService.generateResponse(text, recentHistory, finalContext, chat.id, settings, fullSummary),
      new Promise((_, reject) => setTimeout(() => reject(new Error('KI-Timeout')), 60000))
    ]);

    // 9. Telegram senden
    if (platform === 'telegram') {
      await telegramService.sendMessage(chatId, aiResult.text);
    }

    logger.info(`[MP] Gesamt: ${Date.now()-t0}ms | in:${aiResult.promptTokens} out:${aiResult.completionTokens} cached:${aiResult.cachedTokens||0}`);

    // 10. DB fire & forget
    void (async () => {
      try {
        await supabase.from('messages').insert([{
          chat_id: chat.id, role: 'assistant', content: aiResult.text,
          prompt_tokens:     aiResult.promptTokens     || 0,
          completion_tokens: aiResult.completionTokens || 0,
          embedding_tokens:  this._lastEmbeddingTokens || 0
        }]);
        this._lastEmbeddingTokens = 0;
      } catch (e) { logger.warn('[MP] ai insert:', e.message); }
    })();

    this._updateChatPreview(chat.id, aiResult.text, 'assistant');

    // 11. Learning Queue bei [UNKLAR]
    if (aiResult.text.includes('[UNKLAR]')) {
      void (async () => {
        try {
          await supabase.from('learning_queue').insert([{
            original_chat_id: chat.id, unanswered_question: text, status: 'pending'
          }]);
        } catch (_) {}
      })();
    }

    // 12. Asynchrone Zusammenfassung alle N Nachrichten
    const totalMsgs = allHistory.length + 1; // +1 für aktuelle Nachricht
    if (totalMsgs % summaryInterval === 0 && totalMsgs > 0) {
      void (async () => {
        try {
          const msgsForSummary = allHistory.slice(0, -maxHistory); // Ältere Nachrichten
          if (msgsForSummary.length < 2) return;

          logger.info(`[MP] Starte Zusammenfassung für Chat ${chat.id} (${msgsForSummary.length} ältere Nachrichten)`);
          const newSummary = await deepseekService.summarizeChat(msgsForSummary, chatData.chat_summary);

          if (newSummary) {
            await supabase.from('chats').update({
              chat_summary:      newSummary,
              summary_msg_count: totalMsgs,
              last_summarized_at: new Date()
            }).eq('id', chat.id);
            logger.info(`[MP] Zusammenfassung aktualisiert für ${chat.id}`);
          }
        } catch (e) { logger.warn('[MP] Summary fehlgeschlagen:', e.message); }
      })();
    }

    return aiResult.text;
  },

  // ── RAG ────────────────────────────────────────────────────────────────────
  async _searchKnowledge(query, settings) {
    try {
      const embResult = await embeddingService.createEmbedding(query);
      const vector    = embResult.embedding || embResult;
      if (embResult.tokens) this._lastEmbeddingTokens = embResult.tokens;

      const threshold = parseFloat(settings.rag_threshold)  || 0.45;
      const maxCount  = parseInt(settings.rag_match_count)  || 8;

      // ── Adaptiver RAG ──────────────────────────────────────────────────────
      // Stufe 1: Probe mit 3 Einträgen + Score-Rückgabe
      // Wenn Top-Treffer sehr gut (>=0.85) → 1-2 Einträge reichen
      // Wenn Top-Treffer gut (>=0.70)      → 3-4 Einträge
      // Wenn Top-Treffer schwach (<0.70)   → volles Kontingent

      const { data: probe } = await supabase.rpc('match_knowledge', {
        query_embedding:  vector,
        match_threshold:  threshold,
        match_count:      3
      });

      const topScore = probe?.[0]?.similarity || 0;

      // Sehr guter Treffer: Top-Ergebnis hat hohe Ähnlichkeit → maximal 2 Dokumente
      if (topScore >= 0.82) {
        const exact = probe.filter(r => r.similarity >= 0.75);
        let _ragProductMiss = false;
      logger.info(`[RAG] Hohe Konfidenz (${topScore.toFixed(3)}) → ${exact.length} Dok.`);
        return exact.slice(0, 2);
      }

      // Guter Treffer: 3-4 Dokumente reichen
      if (topScore >= 0.65 && probe?.length >= 2) {
        logger.info(`[RAG] Mittlere Konfidenz (${topScore.toFixed(3)}) → ${probe.length} Dok.`);
        return probe;
      }

      // Schwacher Treffer: volles Kontingent mit niedrigerem Threshold
      const { data: full } = await supabase.rpc('match_knowledge', {
        query_embedding:  vector,
        match_threshold:  Math.max(threshold - 0.15, 0.20),
        match_count:      maxCount
      });

      const result = full?.length ? full : (probe || []);
      logger.info(`[RAG] Niedrige Konfidenz (${topScore.toFixed(3)}) → ${result.length} Dok.`);
      // Bei Produktanfragen ohne passende DB-Einträge: Safety-Flag setzen
      const isProductQuery = /(esim|tarif|preis|gb|land|country|sim|daten|data|reise|travel|paket|kaufen|bestellen|angebot)/i.test(text);
      if (isProductQuery && topScore < 0.45) {
        _ragProductMiss = true;
        logger.info('[RAG] Produkt-Query ohne ausreichende KB-Abdeckung – @autoacts-Fallback aktiv');
      }
      return result;

    } catch (err) {
      logger.warn(`[MP] Embedding: ${err.message}`);
      return [];
    }
  },

  // ── Settings-Cache ─────────────────────────────────────────────────────────
  async _loadSettings() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < CACHE_TTL) return _settingsCache;
    try {
      const { data } = await supabase.from('settings').select('*').single();
      _settingsCache = {
        system_prompt:   data?.system_prompt    || 'Du bist ein hilfreicher Assistent.',
        negative_prompt: data?.negative_prompt  || '',
        ai_model:        data?.ai_model         || 'deepseek-chat',
        ai_max_tokens:   data?.ai_max_tokens    || 1024,
        ai_temperature:  data?.ai_temperature   || 0.5,
        rag_threshold:   data?.rag_threshold    || 0.45,
        rag_match_count: data?.rag_match_count  || 8,
        max_history_msgs:  data?.max_history_msgs  || 4,
        summary_interval:  data?.summary_interval  || 5,
      };
      _settingsCacheTime = now;
      return _settingsCache;
    } catch {
      return {
        system_prompt: 'Du bist ein hilfreicher Assistent.', ai_model: 'deepseek-chat',
        ai_max_tokens: 1024, ai_temperature: 0.5, rag_threshold: 0.45, rag_match_count: 8,
        max_history_msgs: 4, summary_interval: 5
      };
    }
  },

  async _isRephrasing(text, history) {
    // Prüft ob die aktuelle Nachricht nur eine Wiederholung/Verbesserung der letzten ist
    if (!history || history.length < 2) return false;
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return false;

    const prev = (lastUserMsg.content || '').toLowerCase().trim();
    const curr = text.toLowerCase().trim();

    // Identisch oder sehr kurz → Verbesserung
    if (curr === prev) return true;
    if (curr.length < 8 && prev.length > 10) return false; // Zu kurz um zu urteilen

    // Tippfehler-Korrektur-Patterns (z.B. "e sil" → "e sim", "esil" → "esim")
    const normalizeMsg = s => s.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const normPrev = normalizeMsg(prev);
    const normCurr = normalizeMsg(curr);

    // Levenshtein-Distanz < 40% der Länge → Umformulierung
    const maxLen = Math.max(normPrev.length, normCurr.length);
    if (maxLen === 0) return false;
    const dist = this._levenshtein(normPrev, normCurr);
    if (dist / maxLen < 0.40 && dist > 0) return true;

    // Gleiche Kernwörter (> 60% Überschneidung)
    const words1 = new Set(normPrev.split(' ').filter(w => w.length > 2));
    const words2 = new Set(normCurr.split(' ').filter(w => w.length > 2));
    if (words1.size === 0 || words2.size === 0) return false;
    const overlap = [...words1].filter(w => words2.has(w)).length;
    const similarity = overlap / Math.max(words1.size, words2.size);
    return similarity > 0.65;
  },

  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n; if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => i === 0
      ? Array.from({ length: n + 1 }, (_, j) => j)
      : [i, ...new Array(n).fill(0)]
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  },

  _updateChatPreview(chatId, message, role) {
    void (async () => {
      try {
        await supabase.from('chats').update({
          last_message:      (message || '').substring(0, 120),
          last_message_role: role,
          updated_at:        new Date()
        }).eq('id', chatId);
      } catch (_) {}
    })();
  },

  async _getOrCreateChat(chatId, platform, metadata) {
    try {
      const { data: existing } = await supabase
        .from('chats').select('id, is_manual_mode, platform, auto_muted, flag_count, chat_summary')
        .eq('id', chatId).maybeSingle();

      if (existing) return { ...existing, _existed: true };

      const ins = { id: chatId, platform, metadata: metadata || {} };
      if (metadata?.first_name) ins.first_name = metadata.first_name;
      if (metadata?.username)   ins.username   = metadata.username;

      const { data: created, error } = await supabase.from('chats')
        .insert([ins]).select('id, is_manual_mode, platform, auto_muted, flag_count, chat_summary').single();

      if (error?.code === '23505') {
        const { data: retry } = await supabase.from('chats')
          .select('id, is_manual_mode, platform, auto_muted, flag_count, chat_summary').eq('id', chatId).single();
        return retry ? { ...retry, _existed: true } : { id: chatId, is_manual_mode: false, platform, _existed: false };
      }
      return { ...(created || { id: chatId, is_manual_mode: false, platform }), _existed: false };
    } catch (err) {
      logger.error(`[MP] _getOrCreateChat: ${err.message}`);
      return { id: chatId, is_manual_mode: false, platform, _existed: false };
    }
  }
};

module.exports = messageProcessor;
