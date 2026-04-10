// api.js v1.1.9
// - fetch() wrapped in try/catch (handles "Failed to fetch" / server cold-start)
// - 401: zeigt Re-Login Toast, versteckt NICHT die App
// - Netzwerkfehler: gibt null zurück statt zu crashen

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

        var response;
        try {
            response = await fetch(API_BASE + endpoint, options);
        } catch (networkErr) {
            // Server nicht erreichbar (cold start, Neustart, Netzwerk) → nicht crashen
            console.warn('[API] Netzwerkfehler (' + endpoint + '):', networkErr.message);
            return null;
        }

        if (response.status === 401) {
            // Token abgelaufen → Toast anzeigen, App NICHT verstecken
            _showSessionHint();
            return null;
        }

        if (!response.ok) {
            var errMsg = 'API Fehler (' + response.status + ')';
            try {
                var e = await response.json();
                errMsg = e.error || e.message || errMsg;
            } catch (_) {}
            throw new Error(errMsg);
        }

        try {
            return await response.json();
        } catch (_) {
            return null;
        }
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

// Session-Hinweis (kein Redirect, kein App-Hide)
var _sessionHintShown = false;
function _showSessionHint() {
    if (_sessionHintShown) return;
    _sessionHintShown = true;

    var el = document.getElementById('_session-hint');
    if (!el) {
        el = document.createElement('div');
        el.id = '_session-hint';
        el.style.cssText = [
            'position:fixed', 'top:60px', 'left:50%', 'transform:translateX(-50%)',
            'background:#1e3a5f', 'color:#93c5fd', 'border:1px solid #2563eb',
            'padding:12px 20px', 'border-radius:10px', 'z-index:99999',
            'font-size:0.875rem', 'font-weight:600', 'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
            'display:flex', 'align-items:center', 'gap:12px'
        ].join(';');
        el.innerHTML = '🔑 Session abgelaufen — <button onclick="_reLogin()" style="background:var(--primary);border:none;color:white;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:0.85rem;">Neu anmelden</button>';
        document.body.appendChild(el);
    }
    el.style.display = 'flex';
}

function _reLogin() {
    localStorage.removeItem('admin_token');
    _sessionHintShown = false;
    var hint = document.getElementById('_session-hint');
    if (hint) hint.style.display = 'none';
    var overlay = document.getElementById('login-overlay');
    if (overlay) overlay.style.display = 'flex';
}
