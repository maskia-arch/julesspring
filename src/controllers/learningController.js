const supabase = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

const learningController = {
  async getQueue(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('learning_queue')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) throw error;
      res.json(data);
    } catch (error) {
      next(error);
    }
  },

  async addQuestion(req, res, next) {
    try {
      const { chatId, question } = req.body;

      const { data, error } = await supabase
        .from('learning_queue')
        .insert([{
          original_chat_id: chatId,
          unanswered_question: question,
          status: 'pending'
        }])
        .select()
        .single();

      if (error) throw error;

      await notificationService.notifyNewLearningCase(question);

      res.status(201).json(data);
    } catch (error) {
      next(error);
    }
  },

  async resolveQuestion(req, res, next) {
    try {
      const { questionId, adminAnswer } = req.body;

      if (!questionId || !adminAnswer) {
        return res.status(400).json({ error: 'QuestionID und Antwort erforderlich.' });
      }

      const success = await deepseekService.processLearningResponse(adminAnswer, questionId);

      if (success) {
        res.json({ 
          success: true, 
          message: 'Wissen erfolgreich in Vektor-Datenbank gespeichert.' 
        });
      } else {
        throw new Error('Fehler beim Verarbeiten des Wissens-Updates.');
      }
    } catch (error) {
      next(error);
    }
  },

  async deleteQuestion(req, res, next) {
    try {
      const { id } = req.params;

      const { error } = await supabase
        .from('learning_queue')
        .delete()
        .eq('id', id);

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = learningController;
