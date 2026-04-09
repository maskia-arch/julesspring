const API_BASE = '/api/admin';

const api = {
    async request(endpoint, method = 'GET', body = null) {
        const opts = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('admin_token')}`
            }
        };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(`${API_BASE}${endpoint}`, opts);

        if (res.status === 401) {
            localStorage.removeItem('admin_token');
            document.getElementById('login-overlay').style.display = 'flex';
            document.getElementById('admin-app').style.display = 'none';
            return null;
        }

        if (!res.ok) {
            let msg = 'API Fehler';
            try { const e = await res.json(); msg = e.error || e.message || msg; } catch(_) {}
            throw new Error(msg);
        }
        return res.json();
    },

    getStats:           () => api.request('/stats'),
    getChats:           () => api.request('/chats'),
    getChatMessages:    (id) => api.request(`/chats/${id}/messages`),
    updateChatStatus:   (id, m) => api.request(`/chats/${id}/status`, 'PATCH', { is_manual_mode: m }),
    getSettings:        () => api.request('/settings'),
    saveSettings:       (s) => api.request('/settings', 'POST', s),
    getLearningQueue:   () => api.request('/learning'),
    resolveLearning:    (id, ans) => api.request('/learning/resolve', 'POST', { questionId: id, adminAnswer: ans }),
    banUser:            (id, r) => api.request('/blacklist', 'POST', { identifier: id, reason: r }),
    getBlacklist:       () => api.request('/blacklist'),
    removeBan:          (id) => api.request(`/blacklist/${id}`, 'DELETE'),
    discoverLinks:      (url) => api.request('/knowledge/discover', 'POST', { url }),
    addManualKnowledge: (t, c, cat) => api.request('/knowledge/manual', 'POST', { title: t, content: c, category_id: cat }),
};
