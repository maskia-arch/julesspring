const axios = require('axios');
const supabase = require('../config/supabase');
const { deepseek, openai } = require('../config/env');
const logger = require('../utils/logger');

const deepseekService = {

  // Haupt-Funktion: wird vom chatController aufgerufen
  async generateResponse(userMessage, history = [], contextDocs = [], chatId = null) {
    try {
      const { data: settings } = await supabase
        .from('settings')
        .select('system_prompt, negative_prompt')
        .single();

      const contextText = contextDocs && contextDocs.length > 0
        ? contextDocs.map(c => c.content).join('\n---\n')
        : 'Kein spezifischer Kontext verfügbar.';

      const negativePrompt = settings?.negative_prompt
        ? `\n\nWICHTIGE REGELN (unbedingt beachten):\n${settings.negative_prompt}`
        : '';

      const systemContent = `${settings?.system_prompt || 'Du bist ein hilfreicher Assistent.'}

KONTEXT AUS WISSENSDATENBANK:
${contextText}
${negativePrompt}

ANWEISUNG: Falls du eine Frage anhand des Kontexts nicht beantworten kannst, antworte mit dem Präfix "[UNKLAR]" gefolgt von einer höflichen Erklärung.`;

      const messages = [
        { role: 'system', content: systemContent },
        ...(history || []),
        { role: 'user', content: userMessage }
      ];

      const response = await axios.post(
        `${deepseek.baseUrl}/v1/chat/completions`,
        {
          model: 'deepseek-chat',
          messages,
          temperature: 0.5,
          max_tokens: 1024
        },
        {
          headers: {
            'Authorization': `Bearer ${deepseek.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const choice = response.data.choices[0].message.content;
      const usage = response.data.usage || {};

      // Wissenslücke erkannt → in Learning Queue eintragen
      if (choice.includes('[UNKLAR]') && chatId) {
        await supabase.from('learning_queue').insert([{
          original_chat_id: chatId,
          unanswered_question: userMessage,
          status: 'pending'
        }]);

        return {
          text: 'Ich bin mir bei dieser Frage leider nicht sicher genug. Ein Mitarbeiter wurde benachrichtigt und wird sich so schnell wie möglich melden. 🙏',
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0
        };
      }

      return {
        text: choice,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0
      };
    } catch (error) {
      logger.error('DeepSeek generateResponse Error:', error.message);
      throw new Error('KI-Antwort konnte nicht generiert werden.');
    }
  },

  // Embedding für Vektorsuche (OpenAI text-embedding-3-small)
  async generateEmbedding(text) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        {
          model: 'text-embedding-3-small',
          input: text.replace(/\n/g, ' ').substring(0, 8000)
        },
        {
          headers: { 'Authorization': `Bearer ${openai.apiKey}` },
          timeout: 15000
        }
      );
      return response.data.data[0].embedding;
    } catch (error) {
      logger.error('Embedding Error:', error.message);
      throw new Error('Embedding-Generierung fehlgeschlagen.');
    }
  },

  // Learning Queue: Admin-Antwort → Wissensdatenbank
  async processLearningResponse(adminAnswer, questionId) {
    try {
      const { data: question, error } = await supabase
        .from('learning_queue')
        .select('*')
        .eq('id', questionId)
        .single();

      if (error || !question) throw new Error('Frage nicht gefunden');

      const combinedContent = `Frage: ${question.unanswered_question}\nAntwort: ${adminAnswer}`;
      const embedding = await this.generateEmbedding(combinedContent);

      await supabase.from('knowledge_base').insert([{
        content: combinedContent,
        embedding,
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
