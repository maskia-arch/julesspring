const { deepseek } = require('./env');

module.exports = {
  apiKey: deepseek.apiKey,
  baseURL: deepseek.baseURL || 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
  options: {
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 1
  },
  timeout: 60000
};
