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
            window.location.href = '/login.html';
            return;
        }
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'API Fehler');
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
        return this.request(`/chats/${chatId}/status`, 'POST', { is_manual_mode: isManual });
    },

    async getSettings() {
        return this.request('/settings');
    },

    async saveSettings(settings) {
        return this.request('/settings', 'POST', settings);
    },

    async getLearningQueue() {
        return this.request('/learning/queue');
    },

    async resolveLearning(questionId, adminAnswer) {
        return this.request('/learning/resolve', 'POST', { questionId, adminAnswer });
    },

    async banUser(identifier, reason) {
        return this.request('/security/ban', 'POST', { identifier, reason });
    },

    async getBlacklist() {
        return this.request('/security/blacklist');
    },

    async removeBan(id) {
        return this.request(`/security/ban/${id}`, 'DELETE');
    },

    async saveSubscription(subscription) {
        return this.request('/push/subscribe', 'POST', { subscription });
    },

    async syncSellauth() {
        return this.request('/integrations/sellauth/sync', 'POST');
    },

    async discoverLinks(url) {
        return this.request('/knowledge/discover', 'POST', { url });
    },

    async startScraping(urls) {
        return this.request('/knowledge/scrape', 'POST', { urls });
    }
};
