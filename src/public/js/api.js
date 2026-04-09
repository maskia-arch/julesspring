// api.js - var statt const damit api global erreichbar ist
var API_BASE = '/api/admin';

var api = {
    async request(endpoint, method, body) {
        method = method || 'GET';
        var options = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '')
            }
        };
        if (body) options.body = JSON.stringify(body);

        var response = await fetch(API_BASE + endpoint, options);

        if (response.status === 401) {
            localStorage.removeItem('admin_token');
            var overlay = document.getElementById('login-overlay');
            var app = document.getElementById('admin-app');
            if (overlay) overlay.style.display = 'flex';
            if (app) app.style.display = 'none';
            return null;
        }

        if (!response.ok) {
            var errMsg = 'API Fehler';
            try { var e = await response.json(); errMsg = e.error || e.message || errMsg; } catch(x) {}
            throw new Error(errMsg);
        }
        return response.json();
    },

    getStats:           function() { return api.request('/stats'); },
    getChats:           function() { return api.request('/chats'); },
    getChatMessages:    function(id) { return api.request('/chats/' + id + '/messages'); },
    updateChatStatus:   function(id, m) { return api.request('/chats/' + id + '/status', 'PATCH', { is_manual_mode: m }); },
    getSettings:        function() { return api.request('/settings'); },
    saveSettings:       function(s) { return api.request('/settings', 'POST', s); },
    getLearningQueue:   function() { return api.request('/learning'); },
    resolveLearning:    function(id, ans) { return api.request('/learning/resolve', 'POST', { questionId: id, adminAnswer: ans }); },
    banUser:            function(id, r) { return api.request('/blacklist', 'POST', { identifier: id, reason: r }); },
    getBlacklist:       function() { return api.request('/blacklist'); },
    removeBan:          function(id) { return api.request('/blacklist/' + id, 'DELETE'); },
    discoverLinks:      function(url) { return api.request('/knowledge/discover', 'POST', { url: url }); },
    addManualKnowledge: function(t, c, cat) { return api.request('/knowledge/manual', 'POST', { title: t, content: c, category_id: cat }); }
};
