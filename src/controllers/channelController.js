/**
 * channelController.js  v1.4
 *
 * Verwaltet Telegram-Channels/Gruppen wo der Bot als Admin hinzugefügt wurde.
 * Channels werden automatisch erkannt wenn der Bot hinzugefügt wird (my_chat_member Event).
 */

const supabase        = require('../config/supabase');
const logger          = require('../utils/logger');

const channelController = {

  // ── GET /api/admin/channels ────────────────────────────────────────────
  async getChannels(req, res, next) {
    try {
      const { data } = await supabase
        .from('bot_channels')
        .select('*')
        .order('added_at', { ascending: false });
      res.json(data || []);
    } catch (e) { next(e); }
  },

  // ── PUT /api/admin/channels/:id ────────────────────────────────────────
  async updateChannel(req, res, next) {
    try {
      const { id } = req.params;
      const { mode, is_active, ai_command } = req.body;
      const { data, error } = await supabase
        .from('bot_channels')
        .update({ mode, is_active, ai_command, updated_at: new Date() })
        .eq('id', id).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e) { next(e); }
  },

  // ── DELETE /api/admin/channels/:id ────────────────────────────────────
  async deleteChannel(req, res, next) {
    try {
      await supabase.from('bot_channels').delete().eq('id', req.params.id);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // Intern: Channel registrieren wenn Bot hinzugefügt wird
  async registerChannel(chat, botStatus) {
    if (!['administrator', 'creator'].includes(botStatus)) return;
    if (!['channel', 'supergroup', 'group'].includes(chat.type)) return;

    try {
      await supabase.from('bot_channels').upsert([{
        id:         chat.id,
        title:      chat.title || '(kein Titel)',
        username:   chat.username || null,
        type:       chat.type,
        is_active:  true,
        updated_at: new Date()
      }], { onConflict: 'id' });
      logger.info(`[Channel] Registriert: ${chat.title} (${chat.id})`);
    } catch (e) {
      logger.warn('[Channel] Register fehlgeschlagen:', e.message);
    }
  },

  // Intern: Channel-Einstellungen laden (gecacht 5min)
  _channelCache: {},
  async getChannelSettings(chatId) {
    const cached = this._channelCache[chatId];
    if (cached && Date.now() - cached.ts < 300000) return cached.data;
    try {
      const { data } = await supabase.from('bot_channels').select('*').eq('id', chatId).maybeSingle();
      this._channelCache[chatId] = { data, ts: Date.now() };
      return data;
    } catch { return null; }
  }
};

module.exports = channelController;
