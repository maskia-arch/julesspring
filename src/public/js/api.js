const API_BASE = '/api/admin';

const api = {
    async request(endpoint, method = 'GET', body = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('admin_token')}`
            }
        };
        if (body) options.body = JSON.stringify(body);

        const response = await fetch(`${API_BASE}${endpoint}`, options);
        
        if (response.status === 401) {
            localStorage.removeItem('admin_token');
            const overlay = document.getElementById('login-overlay');
            const app = document.getElementById('admin-app');
            if (overlay) overlay.style.display = 'flex';
            if (app) app.style.display = 'none';
            return;
        }
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || error.message || 'API Fehler');
        }
        return response.json();
    },

    async getStats() {
        return this.request('/stats');
    },

    async getChats() {
        return this.request('/chats');
    },

    async updateChatStatus(chatId, isManual) {
        return this.request(`/chats/${chatId}/status`, 'PATCH', { is_manual_mode: isManual });
    },

    async getSettings() {
        return this.request('/settings');
    },

    async saveSettings(settings) {
        return this.request('/settings', 'POST', settings);
    },

    async getLearningQueue() {
        return this.request('/learning');
    },

    async resolveLearning(questionId, adminAnswer) {
        return this.request('/learning/resolve', 'POST', { questionId, adminAnswer });
    },

    async banUser(identifier, reason) {
        return this.request('/blacklist', 'POST', { identifier, reason });
    },

    async getBlacklist() {
        return this.request('/blacklist');
    },

    async removeBan(id) {
        return this.request(`/blacklist/${id}`, 'DELETE');
    },

    async syncSellauth() {
        return this.request('/sync-sellauth', 'POST');
    },

    async discoverLinks(url) {
        return this.request('/knowledge/discover', 'POST', { url });
    },

    async startScraping(urls) {
        return this.request('/scrape', 'POST', { urls });
    },

    async addManualKnowledge(title, content) {
        return this.request('/knowledge/manual', 'POST', { title, content });
    }
};
