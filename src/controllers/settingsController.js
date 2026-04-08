const supabase = require('../config/supabase');

const settingsController = {
  async getSettings(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      res.json(data || {});
    } catch (error) {
      next(error);
    }
  },

  async updateSettings(req, res, next) {
    try {
      const settings = req.body;
      const { data, error } = await supabase
        .from('settings')
        .upsert({ 
          id: 1, 
          ...settings, 
          updated_at: new Date() 
        })
        .select();

      if (error) throw error;
      res.json(data[0]);
    } catch (error) {
      next(error);
    }
  },

  async updatePrompts(req, res, next) {
    try {
      const { system_prompt, manual_handover_msg } = req.body;
      const { data, error } = await supabase
        .from('settings')
        .upsert({ 
          id: 1, 
          system_prompt, 
          manual_handover_msg, 
          updated_at: new Date() 
        })
        .select();

      if (error) throw error;
      res.json(data[0]);
    } catch (error) {
      next(error);
    }
  },

  async getIntegrationKeys(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('sellauth_api_key, telegram_token')
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      res.json(data || {});
    } catch (error) {
      next(error);
    }
  }
};

module.exports = settingsController;
