// api.js v1.2.0 - no null caching, dedup, retry
var API_BASE = '/api/admin';
var _cache   = {};
var _pending = {};

var CACHE_TTLS = {
    '/stats':    15000,
    '/settings': 60000,
    '/blacklist':30000,
    '/learning': 10000,
    '/chats':     5000,
    '/knowledge/categories': 120000
};

var api = {
    async request(endpoint, method, body) {
        method = method || 'GET';

        // Nur GET cachen, nur wenn Wert nicht null
        if (method === 'GET') {
            var ttl = CACHE_TTLS[endpoint];
            if (ttl) {
                var cached = _cache[endpoint];
                if (cached && cached.data !== null && (Date.now() - cached.ts) < ttl) {
                    return cached.data;
                }
            }
            if (_pending[endpoint]) return _pending[endpoint];
        }

        var maxRetries = (method === 'GET') ? 3 : 2;
        var attempt = 0, lastErr;

        while (attempt < maxRetries) {
            attempt++;
            try {
                var result = await api._doFetch(endpoint, method, body);
                // Null NICHT cachen (Server-Fehler oder Cold-Start)
                if (method === 'GET' && result !== null && CACHE_TTLS[endpoint]) {
                    _cache[endpoint] = { data: result, ts: Date.now() };
                }
                return result;
            } catch (err) {
                lastErr = err;
                if (err._status >= 400 && err._status < 500) throw err;
                if (attempt >= maxRetries) break;
                await new Promise(function(r) { setTimeout(r, attempt * 600); });
            }
        }
        throw lastErr || new Error('Request fehlgeschlagen');
    },

    async _doFetch(endpoint, method, body) {
        var opts = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '')
            }
        };
        if (body) opts.body = JSON.stringify(body);

        var promise = fetch(API_BASE + endpoint, opts).then(async function(res) {
            if (method === 'GET') delete _pending[endpoint];

            if (res.status === 401) { _showSessionHint(); return null; }

            if (!res.ok) {
                var msg = 'Fehler ' + res.status;
                try { var e = await res.json(); msg = e.error || e.message || msg; } catch(_) {}
                var err = new Error(msg);
                err._status = res.status;
                throw err;
            }
            try { return await res.json(); } catch(_) { return null; }
        }).catch(function(err) {
            if (method === 'GET') delete _pending[endpoint];
            if (!err._status) console.warn('[API]', endpoint + ':', err.message);
            throw err;
        });

        if (method === 'GET') _pending[endpoint] = promise;
        return promise;
    },

    invalidate: function(ep) { if (ep) delete _cache[ep]; else _cache = {}; },

    getStats:         function() { return api.request('/stats'); },
    getChats:         function() { return api.request('/chats'); },
    getChatMessages:  function(id) { return api.request('/chats/' + id + '/messages'); },
    updateChatStatus: function(id, m) { return api.request('/chats/' + id + '/status', 'PATCH', { is_manual_mode: m }); },
    getSettings:      function() { return api.request('/settings'); },
    saveSettings:     function(s) { api.invalidate('/settings'); return api.request('/settings', 'POST', s); },
    getLearningQueue: function() { return api.request('/learning'); },
    resolveLearning:  function(id, ans) { api.invalidate('/learning'); return api.request('/learning/resolve', 'POST', { questionId: id, adminAnswer: ans }); },
    banUser:          function(id, r) { api.invalidate('/blacklist'); return api.request('/blacklist', 'POST', { identifier: id, reason: r }); },
    getBlacklist:     function() { return api.request('/blacklist'); },
    removeBan:        function(id) { api.invalidate('/blacklist'); return api.request('/blacklist/' + id, 'DELETE'); },
    discoverLinks:    function(url) { return api.request('/knowledge/discover', 'POST', { url: url }); },
    addManualKnowledge: function(t, c, cat) { return api.request('/knowledge/manual', 'POST', { title: t, content: c, category_id: cat }); },
    getFlaggedChats:  function() { return api.request('/flags/chats'); },
    flagChat:         function(id, reason) { return api.request('/flags', 'POST', { chatId: id, reason: reason }); },
    unflagChat:       function(id) { return api.request('/flags/' + id, 'DELETE'); },
    unmuteChat:       function(id) { return api.request('/flags/' + id + '/unmute', 'POST'); }
};

var _hintShown = false;
function _showSessionHint() {
    if (_hintShown) return; _hintShown = true;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;padding:10px 18px;border-radius:10px;z-index:99999;font-size:0.85rem;font-weight:600;display:flex;align-items:center;gap:10px;';
    el.innerHTML = '🔑 Session abgelaufen — <button onclick="localStorage.removeItem(\'admin_token\');window.location.reload()" style="background:#2563eb;border:none;color:white;padding:4px 12px;border-radius:6px;cursor:pointer;">Anmelden</button>';
    document.body.appendChild(el);
}
