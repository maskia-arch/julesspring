const supabase = require('../config/supabase');

const supabaseService = {
  async getRelevantContext(embedding, matchThreshold = 0.7, matchCount = 3) {
    const { data, error } = await supabase.rpc('match_knowledge', {
      query_embedding: embedding,
      match_threshold: matchThreshold,
      match_count: matchCount
    });

    if (error) throw error;
    return data || [];
  },

  async saveMessage(chatId, role, content) {
    const { data, error } = await supabase
      .from('messages')
      .insert([{ chat_id: chatId, role, content }])
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async saveKnowledge(content, embedding, metadata = {}) {
    const { data, error } = await supabase
      .from('knowledge_base')
      .insert([{
        content,
        embedding,
        metadata,
        created_at: new Date()
      }])
      .select();

    if (error) throw error;
    return data;
  },

  async getChatHistory(chatId, limit = 10) {
    const { data, error } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data ? data.reverse() : [];
  },

  async updateChatActivity(chatId) {
    await supabase
      .from('chats')
      .update({ updated_at: new Date() })
      .eq('id', chatId);
  }
};

module.exports = supabaseService;
