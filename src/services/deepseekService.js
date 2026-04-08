const axios = require('axios');
const supabase = require('../config/supabase');
const { deepseek, openai } = require('../config/env');
const logger = require('../utils/logger');

const deepseekService = {
  async generateEmbedding(text) {
    try {
      const response = await axios.post('https://api.openai.com/v1/embeddings', {
        model: 'text-embedding-3-small',
        input: text
      }, {
        headers: { 'Authorization': `Bearer ${openai.apiKey}` }
      });
      return response.data.data[0].embedding;
    } catch (error) {
      logger.error('Embedding Error:', error.message);
      throw error;
    }
  },

  async getChatResponse(chatId, userMessage, context = []) {
    try {
      const { data: settings } = await supabase
        .from('settings')
        .select('system_prompt, negative_prompt')
        .single();

      const { data: history } = await supabase
        .from('messages')
        .select('role, content')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true })
        .limit(10);

      const contextText = context.map(c => c.content).join('\n---\n');
      
      const fullSystemPrompt = `${settings.system_prompt}
      
      KONTEXT AUS WISSENSDATENBANK:
      ${contextText}
      
      WICHTIGE REGELN (NEGATIV-PROMPTS):
      ${settings.negative_prompt}
      
      ZUSATZ-INSTRUKTION: 
      Falls du eine technische Frage zu Geräte-Kompatibilität (z.B. Nothing Phone, iPhone) nicht im Kontext findest, nutze dein internes Wissen, aber weise den Nutzer an, in den Geräteeinstellungen nach "eSIM hinzufügen" zu suchen. 
      Falls du die Antwort absolut nicht weißt, antworte mit: "[UNKLAR] Entschuldigung, das muss ich intern klären."`;

      const messages = [
        { role: 'system', content: fullSystemPrompt },
        ...history,
        { role: 'user', content: userMessage }
      ];

      const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        messages: messages,
        temperature: 0.5
      }, {
        headers: { 'Authorization': `Bearer ${deepseek.apiKey}` }
      });

      const aiContent = response.data.choices[0].message.content;

      if (aiContent.includes('[UNKLAR]')) {
        await supabase.from('learning_queue').insert([{
          original_chat_id: chatId,
          unanswered_question: userMessage,
          status: 'pending'
        }]);
        
        return "Ich bin mir bei dieser spezifischen Frage zu unseren eSIM-Tarifen unsicher. Ich habe soeben einen Experten informiert, der sich hier im Chat bei dir melden wird.";
      }

      return aiContent;
    } catch (error) {
      logger.error('DeepSeek API Error:', error.message);
      throw error;
    }
  },

  async processLearningResponse(adminAnswer, questionId) {
    try {
      const { data: question } = await supabase
        .from('learning_queue')
        .select('*')
        .eq('id', questionId)
        .single();

      const combinedContent = `Frage: ${question.unanswered_question} \nAntwort: ${adminAnswer}`;
      const embedding = await this.generateEmbedding(combinedContent);

      await supabase.from('knowledge_base').insert([{
        content: combinedContent,
        embedding: embedding,
        source: 'learning_chat'
      }]);

      await supabase
        .from('learning_queue')
        .update({ status: 'resolved' })
        .eq('id', questionId);

      return true;
    } catch (error) {
      logger.error('Learning Process Error:', error.message);
      throw error;
    }
  }
};

module.exports = deepseekService;
