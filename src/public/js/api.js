// api.js v1.1.15
// - Auto-Retry bei Netzwerkfehlern (bis zu 3 Versuche, exponential backoff)
// - Duplicate-Request-Schutz für GET-Requests
// - Stabiler Session-Handling
// - Kein App-Hide bei 401

var API_BASE = '/api/admin';

// Laufende GET-Requests (deduplizierung)
var _pending = {};

var api = {

    // ── Hauptmethode mit Retry ─────────────────────────────────────────────
    async request(endpoint, method, body) {
        method = method || 'GET';
        var maxRetries = (method === 'GET') ? 3 : 2;
        var attempt = 0;
        var lastErr;

        while (attempt < maxRetries) {
            attempt++;
            try {
                var result = await api._doRequest(endpoint, method, body);
                return result;
            } catch (err) {
                lastErr = err;
                // Nicht wiederholen bei: Auth-Fehler, 4xx Client-Fehler
                if (err._status && err._status >= 400 && err._status < 500) throw err;
                // Nicht wiederholen bei: letztesmal
                if (attempt >= maxRetries) break;
                // Warten vor Retry (500ms, 1500ms)
                var wait = attempt * 500;
                console.warn('[API] Retry ' + attempt + '/' + maxRetries + ' für ' + endpoint + ' in ' + wait + 'ms');
                await new Promise(function(r) { setTimeout(r, wait); });
            }
        }
        throw lastErr || new Error('Request fehlgeschlagen');
    },

    // ── Einzelner Request ─────────────────────────────────────────────────
    async _doRequest(endpoint, method, body) {
        var options = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '')
            }
        };
        if (body) options.body = JSON.stringify(body);

        // GET-Deduplizierung: Gleicher Endpoint → gleicher Promise
        var key = method + ':' + endpoint;
        if (method === 'GET' && _pending[key]) {
            return _pending[key];
        }

        var promise = fetch(API_BASE + endpoint, options).then(async function(response) {
            if (method === 'GET') delete _pending[key];

            if (response.status === 401) {
                _showSessionHint();
                return null;
            }

            if (!response.ok) {
                var msg = 'API Fehler (' + response.status + ')';
                try { var e = await response.json(); msg = e.error || e.message || msg; } catch(_) {}
                var err = new Error(msg);
                err._status = response.status;
                throw err;
            }

            try { return await response.json(); }
            catch(_) { return null; }

        }).catch(function(err) {
            if (method === 'GET') delete _pending[key];
            if (!err._status) {
                // Netzwerkfehler
                console.warn('[API] Netzwerkfehler ' + endpoint + ':', err.message);
            }
            throw err;
        });

        if (method === 'GET') _pending[key] = promise;
        return promise;
    },

    // ── API-Methoden ──────────────────────────────────────────────────────
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

// ── Session abgelaufen ────────────────────────────────────────────────────
var _sessionHintShown = false;
function _showSessionHint() {
    if (_sessionHintShown) return;
    _sessionHintShown = true;
    var el = document.getElementById('_session-hint');
    if (!el) {
        el = document.createElement('div');
        el.id = '_session-hint';
        el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;padding:10px 18px;border-radius:10px;z-index:99999;font-size:0.85rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:flex;align-items:center;gap:10px;';
        el.innerHTML = '🔑 Session abgelaufen — <button onclick="_reLogin()" style="background:#2563eb;border:none;color:white;padding:4px 12px;border-radius:6px;cursor:pointer;">Anmelden</button>';
        document.body.appendChild(el);
    }
    el.style.display = 'flex';
}

function _reLogin() {
    localStorage.removeItem('admin_token');
    _sessionHintShown = false;
    var h = document.getElementById('_session-hint');
    if (h) h.style.display = 'none';
    var o = document.getElementById('login-overlay');
    if (o) o.style.display = 'flex';
}
