// ── State ─────────────────────────────────────────────────────────────────────
var _allChats     = [];
var _currentChat  = null;
var _kbCatId      = null;
var _allKbCats    = [];

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    // Fallback: falls auto-login im HTML den initDashboard nicht aufgerufen hat
    if (localStorage.getItem('admin_token') && !_dashboardInitialized) {
        initDashboard();
    }
// Intervals managed by initDashboard
});

// Dashboard-Loader mit Loading-Gate
// App wird erst angezeigt wenn Stats + Chats erfolgreich geladen
var _dashboardInitialized = false;
async function initDashboard() {
    if (_dashboardInitialized) return; // Nur einmal ausführen
    _dashboardInitialized = true;
    _showLoadingGate(true);

    // Kritische Daten laden (Stats + Chats müssen klappen)
    var loaded = false;
    var attempts = 0;

    while (!loaded && attempts < 5) {
        attempts++;
        try {
            await Promise.all([updateStats(), loadChats()]);
            loaded = true;
        } catch(e) {
            console.warn('[Dashboard] Ladeversuch ' + attempts + ' fehlgeschlagen:', e.message);
            if (attempts < 5) await new Promise(function(r) { setTimeout(r, 1200); });
        }
    }

    _showLoadingGate(false);

    if (!loaded) {
        _showLoadError();
        return;
    }

    // Sekundäre Daten laden (non-blocking)
    _safeRun(loadSettings);
    _safeRun(loadLearningQueue);
    _safeRun(loadBlacklist);
    setTimeout(initPushNotifications, 2000);

    // Coupon + Wochenplan vorladen (1.5s nach Settings)
    setTimeout(function() {
        _safeRun(loadActiveCoupon);
        _safeRun(loadWeekSchedule);
        _safeRun(loadCouponHistory);
    }, 1500);

    // Traffic Chart vorwärmen
    setTimeout(function() {
        _safeRun(function() { return loadTraffic('week'); });
        _safeRun(loadLiveVisitors);
        _safeRun(loadSessions);
        _safeRun(loadActivityFeed);
    }, 2500);

    // Knowledge Kategorien vorladen
    setTimeout(function() { _safeRun(loadKbCategories); }, 3000);
    // Channel-Liste vorladen
    setTimeout(function() { _safeRun(loadChannels); }, 3500);
    setTimeout(function() { _safeRun(loadChannelCosts); }, 4000);

    // Intervalle
    clearInterval(window._statsInterval);
    clearInterval(window._chatsInterval);
    clearInterval(window._msgsInterval);
    window._statsInterval = setInterval(function() { _safeRun(updateStats); }, 15000);
    window._chatsInterval = setInterval(function() {
        _safeRun(loadChats);
    }, 8000);
    // Nachrichten im aktiven Chat schneller aktualisieren (3s)
    window._msgsInterval = setInterval(function() {
        if (_currentChat) _safeRun(refreshMessages);
    }, 3000);
}

function _showLoadingGate(show) {
    var el = document.getElementById('_loading-gate');
    if (!el && show) {
        el = document.createElement('div');
        el.id = '_loading-gate';
        el.style.cssText = 'position:fixed;inset:0;background:#111;z-index:9998;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
        el.innerHTML = '<div style="font-size:2.5rem;">🤖</div>' +
            '<div style="color:#60a5fa;font-size:1rem;font-weight:600;">AI Admin lädt...</div>' +
            '<div style="width:200px;height:4px;background:#1e293b;border-radius:2px;overflow:hidden;">' +
                '<div id="_load-bar" style="height:100%;background:linear-gradient(90deg,#2563eb,#4ade80);border-radius:2px;width:0%;transition:width 0.5s;"></div>' +
            '</div>' +
            '<div id="_load-msg" style="color:#64748b;font-size:0.8rem;"></div>';
        document.body.appendChild(el);
        // Animierter Ladebalken
        var w = 0;
        el._bar = setInterval(function() {
            w = Math.min(w + 8, 85); // max 85% bis Daten da
            var bar = document.getElementById('_load-bar');
            if (bar) bar.style.width = w + '%';
        }, 300);
    }
    if (el) {
        if (!show) {
            var bar = document.getElementById('_load-bar');
            if (bar) bar.style.width = '100%';
            clearInterval(el._bar);
            setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
        }
    }
}

function _showLoadError() {
    var app = document.getElementById('app-content');
    if (app) app.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60vh;gap:16px;color:#94a3b8;text-align:center;padding:2rem;">' +
        '<div style="font-size:2rem;">⚠️</div>' +
        '<div style="font-size:1rem;font-weight:600;">Dashboard konnte nicht laden</div>' +
        '<div style="font-size:0.85rem;color:#64748b;">Server nicht erreichbar oder DB-Fehler.<br>Render-Logs prüfen.</div>' +
        '<button onclick="window.location.reload()" class="btn btn-primary" style="margin-top:8px;">↺ Neu laden</button>' +
        '</div>';
}

async function _safeRun(fn) {
    try { await fn(); }
    catch(e) { console.warn('[Dashboard]', fn.name || '', e.message); }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function updateStats() {
    try {
        var d = await api.getStats();
        if (!d || !d.stats) throw new Error('Keine Stats vom Server');
        var sv = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
        sv('s-chats',    d.stats.totalChats);
        sv('s-manual',   d.stats.activeManual);
        sv('s-knowledge',d.stats.knowledgeEntries);
        // Haupt-Stats setzen
        sv('s-cost',   d.stats.totalCost);
        sv('s-tokens', (parseInt(d.stats.totalTokens||0)).toLocaleString() + ' Token');

        // Channel-KI-Kosten hinzurechnen (parallel, kein Cache)
        api.request('/channels').then(function(channels) {
            if (!channels || !channels.length) return;
            var baseCost   = parseFloat((d.stats.totalCost||'0').toString().replace(/[^0-9.]/g,'')) || 0;
            var baseTokens = parseInt(d.stats.totalTokens||0) || 0;
            var chanCost   = channels.reduce(function(s,ch){ return s + parseFloat(ch.usd_spent||0); }, 0);
            var chanTokens = channels.reduce(function(s,ch){ return s + parseInt(ch.token_used||0); }, 0);
            if (chanCost > 0 || chanTokens > 0) {
                sv('s-cost',   (baseCost + chanCost).toFixed(4) + ' $');
                sv('s-tokens', (baseTokens + chanTokens).toLocaleString() + ' Token');
            }
        }).catch(function(){});
        sv('version-tag','v' + d.version);
        var badge = document.getElementById('learning-badge');
        if (badge) {
            badge.textContent = d.stats.pendingLearning;
            badge.style.display = d.stats.pendingLearning > 0 ? 'inline-block' : 'none';
        }
    } catch(e) { throw e; } // rethrow → Loading-Gate kann Fehler erkennen
}

// ── Chat List ─────────────────────────────────────────────────────────────────
async function loadChats() {
    var el = document.getElementById('chat-list');
    if (!el) return;
    try {
        var chats = await api.getChats();
        if (chats === null) throw new Error('Keine Chats vom Server');
        _allChats = chats || [];
        renderChatList(_allChats);
    } catch(e) {
        throw e; // rethrow → Loading-Gate erkennt Fehler
    }
}

function renderChatList(chats) {
    var el = document.getElementById('chat-list');
    if (!chats || !chats.length) {
        el.innerHTML = '<p style="padding:1.5rem 1rem;color:#555;font-size:0.82rem;text-align:center;">Noch keine Chats.<br>Kunden-Nachrichten erscheinen hier.</p>';
        return;
    }
    el.innerHTML = chats.map(function(c) {
        var name     = c.first_name || c.username || (c.id + '').substring(0, 12);
        var preview  = c.last_message ? trunc(c.last_message, 40) : 'Kein Inhalt';
        var prefix   = c.last_message_role === 'assistant' ? '🤖 ' : '';
        var time     = c.updated_at ? relTime(c.updated_at) : '';
        var isTg     = c.platform !== 'web_widget';
        var avCls    = isTg ? 'avatar-tg' : 'avatar-web';
        var avIcon   = isTg ? '✈️' : '🌐';
        var selected = _currentChat === c.id ? 'selected' : '';
        var manual   = c.is_manual_mode ? 'manual-active' : '';
        var modeCls  = c.is_manual_mode ? 'mode-manual' : 'mode-ai';
        var modeText = c.is_manual_mode ? 'MENSCH' : 'KI';
        return '<div class="chat-item ' + selected + ' ' + manual + '" onclick="selectChat(\'' + esc(c.id) + '\')" data-id="' + esc(c.id) + '">' +
            '<div class="chat-avatar ' + avCls + '">' + avIcon + '</div>' +
            '<div class="chat-item-body">' +
                '<div class="chat-item-row1">' +
                    '<span class="ci-name" title="' + esc(c.id) + '">' + esc(name) + '</span>' +
                    '<span class="ci-time">' + time + '</span>' +
                '</div>' +
                '<div class="ci-preview">' + prefix + esc(preview) + '</div>' +
            '</div>' +
            '<span class="ci-mode ' + modeCls + '">' + modeText + '</span>' +
        '</div>';
    }).join('');
}

function filterChats(q) {
    if (!q) { renderChatList(_allChats); return; }
    q = q.toLowerCase();
    renderChatList(_allChats.filter(function(c) {
        return (c.id+'').toLowerCase().includes(q) ||
               (c.first_name||'').toLowerCase().includes(q) ||
               (c.username||'').toLowerCase().includes(q) ||
               (c.last_message||'').toLowerCase().includes(q);
    }));
}

// ── Chat Window ───────────────────────────────────────────────────────────────
async function selectChat(chatId) {
    _currentChat = chatId;
    // Selection highlight
    document.querySelectorAll('.chat-item').forEach(function(el) { el.classList.remove('selected'); });
    var row = document.querySelector('.chat-item[data-id="' + chatId + '"]');
    if (row) row.classList.add('selected');

    var win = document.getElementById('chat-window');
    win.innerHTML = '<div class="chat-placeholder"><p style="color:#444;">Lädt…</p></div>';

    // Mobile: show chat window
    var sec = document.getElementById('chats-section');
    if (sec) sec.classList.add('chat-open');

    try {
        // Cache-Buster: stellt sicher wir bekommen die neuesten Nachrichten
        var data = await api.request('/chats/' + chatId + '/messages?t=' + Date.now());
        var info = data.chat_info || {};
        // Name: first_name > username > metadata fallback > truncated ID
        var meta = info.metadata || {};
        var name = info.first_name || info.username ||
                   meta.first_name || meta.username ||
                   (chatId.length > 10 ? chatId.substring(0, 10) + '…' : chatId);
        var isTg = info.platform !== 'web_widget';
        var avCls = isTg ? 'avatar-tg' : 'avatar-web';

        win.innerHTML =
            '<div class="cw-header">' +
                '<div class="chat-avatar ' + avCls + '" style="width:36px;height:36px;font-size:0.9rem;">' + (isTg?'✈️':'🌐') + '</div>' +
                '<div class="cw-info">' +
                    '<div class="cw-name">' + esc(name) + '</div>' +
                    '<div class="cw-sub">' + esc(chatId) + ' &middot; ' + (info.platform||'telegram') + '</div>' +
                '</div>' +
                '<div class="cw-actions">' +
                    '<div class="toggle-row">' +
                        '<span id="mode-lbl-' + esc(chatId) + '">' + (data.is_manual ? 'Manuell' : 'KI aktiv') + '</span>' +
                        '<label class="toggle">' +
                            '<input type="checkbox" id="mode-chk-' + esc(chatId) + '" ' + (data.is_manual?'checked':'') + ' onchange="toggleMode(\'' + esc(chatId) + '\',this.checked)">' +
                            '<span class="toggle-track"></span>' +
                        '</label>' +
                    '</div>' +
                    '<button onclick="quickBan(\'' + esc(chatId) + '\')" class="btn btn-danger" style="padding:5px 9px;font-size:0.75rem;" title="Bannen">⛔</button>' +
    '<button class="icon-btn back-btn" onclick="closeChat()" title="Zurück" style="display:none;">←</button>' +
                    (window.innerWidth > 700 ? '' : '<button onclick="closeChat()" class="icon-btn" title="Zurück">←</button>') +
                '</div>' +
            '</div>' +
            '<div class="messages-area" id="msg-' + esc(chatId) + '">' + renderMsgs(data.messages || []) + '</div>' +
            '<div class="chat-input-bar">' +
                '<textarea id="reply-' + esc(chatId) + '" rows="1" placeholder="Nachricht als Admin…" ' +
                    'onkeydown="replyKey(event,\'' + esc(chatId) + '\')" oninput="autoH(this)"></textarea>' +
                '<button class="send-btn" onclick="sendMsg(\'' + esc(chatId) + '\')">➤</button>' +
            '</div>';

        scrollBottom('msg-' + chatId);
    } catch(e) {
        win.innerHTML = '<div class="chat-placeholder"><p style="color:#ef4444;">Fehler: ' + esc(e.message) + '</p></div>';
    }
}

function closeChat() {
    _currentChat = null;
    var sec = document.getElementById('chats-section');
    if (sec) sec.classList.remove('chat-open');
    var win = document.getElementById('chat-window');
    if (win) win.innerHTML = '<div class="chat-placeholder"><span style="font-size:3rem;">💬</span><p>Chat auswählen</p></div>';
}

function renderMsgs(messages) {
    if (!messages.length) return '<p style="text-align:center;color:#444;padding:2rem;font-size:0.85rem;">Noch keine Nachrichten.</p>';

    var html = '';
    var lastDate = null;

    messages.forEach(function(m) {
        var date = new Date(m.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
        if (date !== lastDate) {
            html += '<div class="date-sep">' + date + '</div>';
            lastDate = date;
        }
        var time   = new Date(m.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        var isMan  = m.is_manual ? ' manual' : '';
        var who    = m.role === 'assistant' ? (m.is_manual ? '👤 Admin' : '🤖 KI') : '👤 Nutzer';
        var tkns   = (m.prompt_tokens||0) + (m.completion_tokens||0);
        var tkBadge= tkns > 0 ? '<span class="tk-badge">' + tkns + 'tkn</span>' : '';

        html += '<div class="msg-row ' + m.role + isMan + '">' +
            '<div class="msg-bubble">' +
                esc(m.content).replace(/\n/g, '<br>') +
                '<div class="msg-footer">' +
                    '<span style="opacity:0.5;">' + who + '</span>' +
                    tkBadge +
                    '<span>' + time + '</span>' +
                '</div>' +
            '</div>' +
        '</div>';
    });
    return html;
}

async function refreshMessages() {
    if (!_currentChat) return;
    try {
        // Cache-Buster: verhindert dass _pending-Dedup veraltete Antwort zurückgibt
        var data = await api.request('/chats/' + _currentChat + '/messages?t=' + Date.now());
        if (!data || !data.messages) return;
        var area = document.getElementById('msg-' + _currentChat);
        if (!area) return;
        var prevCount = area.querySelectorAll('.msg-row').length;
        var atBottom  = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
        area.innerHTML = renderMsgs(data.messages);
        // Scroll to bottom if: was at bottom OR new messages arrived
        if (atBottom || data.messages.length > prevCount) scrollBottom('msg-' + _currentChat);
    } catch(e) {}
}

async function sendMsg(chatId) {
    var ta = document.getElementById('reply-' + chatId);
    var content = ta ? ta.value.trim() : '';
    if (!content) return;
    ta.value = ''; ta.style.height = 'auto';
    try {
        await api.request('/manual-message', 'POST', { chatId: chatId, content: content });
        await refreshMessages();
        loadChats();
    } catch(e) { alert('Fehler: ' + e.message); }
}

function replyKey(e, chatId) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(chatId); }
}

function autoH(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

function scrollBottom(id) {
    var el = document.getElementById(id);
    if (el) el.scrollTop = el.scrollHeight;
}

async function toggleMode(chatId, isManual) {
    try {
        await api.updateChatStatus(chatId, isManual);
        var lbl = document.getElementById('mode-lbl-' + chatId);
        if (lbl) lbl.textContent = isManual ? 'Manuell' : 'KI aktiv';
        loadChats();
        updateStats();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function quickBan(chatId) {
    if (!confirm('Nutzer ' + chatId + ' bannen?')) return;
    try {
        await api.banUser(chatId, 'Direktbann über Dashboard');
        showToast('✅ Nutzer gebannt');
        loadBlacklist();
        loadChats();
    } catch(e) { alert('Fehler: ' + e.message); }
}

// ── Learning ──────────────────────────────────────────────────────────────────
async function loadLearningQueue() {
    var el = document.getElementById('learning-list');
    if (!el) return;
    try {
        var queue = await api.getLearningQueue();
        if (queue === null) return; // Netzwerkfehler - nicht leeren
        queue = queue || [];
        if (!queue.length) {
            el.innerHTML = '<p style="color:#555;font-size:0.875rem;">Keine offenen Fragen. 🎉</p>';
            return;
        }
        el.innerHTML = queue.map(function(item) {
            var date = new Date(item.created_at).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        return '<div class="card">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                    '<p style="font-size:0.75rem;color:#888;margin:0;">Kundenfrage:</p>' +
                    '<span style="font-size:0.7rem;color:#555;">' + date + '</span>' +
                '</div>' +
                '<p style="font-weight:700;margin-bottom:10px;line-height:1.4;">"' + esc(item.unanswered_question) + '"</p>' +
                '<textarea id="learn-' + item.id + '" rows="3" placeholder="Antwort eingeben → wird in Wissensdatenbank gespeichert…" style="width:100%;margin-bottom:8px;"></textarea>' +
                '<div style="display:flex;gap:8px;">' +
                    '<button onclick="resolveLearning(\'' + item.id + '\')" class="btn btn-success" style="flex:1;">✅ Wissen speichern</button>' +
                    '<button onclick="rejectLearning(\'' + item.id + '\')" class="btn btn-danger" style="padding:11px 14px;" title="Ablehnen — Wissenslücke bleibt bestehen">✕</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch(e) {
        el.innerHTML = '<p style="color:#ef4444;">Fehler beim Laden: ' + esc(e.message) + '</p>';
    }
}

async function resolveLearning(id) {
    var el = document.getElementById('learn-' + id);
    var ans = el ? el.value.trim() : '';
    if (!ans) return alert('Bitte eine Antwort eingeben');
    try {
        await api.resolveLearning(id, ans);
        showToast('✅ Wissen gespeichert!');
        loadLearningQueue();
        updateStats();
    } catch(e) { alert('Fehler: ' + e.message); }
}

// ── Knowledge ─────────────────────────────────────────────────────────────────
async function loadKbCategories() {
    try {
        _allKbCats = await api.request('/knowledge/categories') || [];
        // Dropdowns
        ['manual-cat-id', 'scrape-cat-id'].forEach(function(selId) {
            var sel = document.getElementById(selId);
            if (!sel) return;
            sel.innerHTML = '<option value="">– Keine Kategorie –</option>' +
                _allKbCats.map(function(c) {
                    return '<option value="' + c.id + '">' + (c.icon||'') + ' ' + esc(c.name) + '</option>';
                }).join('');
        });
        // Sidebar
        var list = document.getElementById('kb-cat-list');
        if (list) {
            list.innerHTML =
                '<div class="kb-cat-item ' + (!_kbCatId ? 'active' : '') + '" onclick="filterKbByCategory(null)" id="kb-cat-all">' +
                    '<span>🗂</span><span style="flex:1;">Alle</span>' +
                '</div>' +
                _allKbCats.map(function(c) {
                    return '<div class="kb-cat-item ' + (_kbCatId === c.id ? 'active' : '') + '" onclick="filterKbByCategory(' + c.id + ')">' +
                        '<span class="kb-cat-dot" style="background:' + c.color + '"></span>' +
                        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (c.icon||'') + ' ' + esc(c.name) + '</span>' +
                        '<button onclick="event.stopPropagation();delCat(' + c.id + ')" style="background:none;border:none;color:#555;cursor:pointer;padding:0 2px;font-size:0.75rem;">✕</button>' +
                    '</div>';
                }).join('');
        }
    } catch(e) { console.error('Categories:', e.message); }
}

async function loadKbEntries(catId) {
    var el = document.getElementById('kb-entries-list');
    if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Lädt…</p>';
    try {
        var url = catId ? '/knowledge/entries?category_id=' + catId : '/knowledge/entries';
        var entries = await api.request(url) || [];
        if (!entries.length) {
            el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine Einträge.</p>';
            return;
        }
        el.innerHTML = entries.map(function(e) {
            var cat = e.knowledge_categories;
            var catPill = cat
                ? '<div class="cat-pill" style="background:' + cat.color + '22;color:' + cat.color + ';">' + (cat.icon||'') + ' ' + esc(cat.name) + '</div>'
                : '';
            var syncBadge = e.metadata && e.metadata.enriched
                ? '<span style="background:#1e3a5f;color:#60a5fa;font-size:0.62rem;padding:1px 5px;border-radius:3px;margin-left:4px;">🤖 KI</span>'
                : '';
            return '<div class="kb-entry" data-entry-id="' + e.id + '">' +
                '<div class="kb-entry-body">' +
                    catPill +
                    '<div class="kb-entry-title">' + esc(e.title || '(kein Titel)') + syncBadge + '</div>' +
                    '<div class="kb-entry-preview">' + esc(e.content_preview) + '</div>' +
                    '<div class="kb-entry-meta"><span>' + esc(e.source) + '</span><span>·</span><span>' + new Date(e.created_at).toLocaleDateString('de-DE') + '</span></div>' +
                '</div>' +
                '<div style="display:flex;gap:4px;flex-shrink:0;">' +
                    '<button onclick="openKbEdit(\'' + e.id + '\')" class="icon-btn" title="Bearbeiten" style="background:#1e3a5f;color:#60a5fa;">✏️</button>' +
                    '<button onclick="syncKbEntry(\'' + e.id + '\')" class="icon-btn" title="Mit KI synchronisieren" style="background:#14532d;color:#4ade80;">🤖</button>' +
                    '<button onclick="delKbEntry(\'' + e.id + '\')" class="icon-btn" style="flex-shrink:0;" title="Löschen">🗑</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch(e) {
        el.innerHTML = '<p style="color:#ef4444;padding:8px;">Fehler: ' + esc(e.message) + '</p>';
    }
}

function filterKbByCategory(catId) {
    _kbCatId = catId;
    document.querySelectorAll('.kb-cat-item').forEach(function(el) { el.classList.remove('active'); });
    var active = catId ? document.querySelector('.kb-cat-item[onclick="filterKbByCategory(' + catId + ')"]') : document.getElementById('kb-cat-all');
    if (active) active.classList.add('active');
    loadKbEntries(catId);
}


// ── Wissens-Eintrag bearbeiten ────────────────────────────────────────────────

var _editingEntryId = null;

async function openKbEdit(id) {
    _editingEntryId = id;
    // Load full content
    try {
        var entries = await api.request('/knowledge/entries?id=' + id) || [];
        // Load related entries
        var related = await api.request('/knowledge/entries/' + id + '/related').catch(function(){return [];}) || [];

        var entry = entries.find(function(e){ return e.id === id; });
        if (!entry) {
            // Try direct fetch if not in current list
            entry = { id, title: '', content: '', category_id: null };
        }

        // Build modal
        var cats = _allKbCats || [];
        var catOptions = cats.map(function(c) {
            return '<option value="' + c.id + '"' + (entry.category_id == c.id ? ' selected' : '') + '>' + esc(c.icon || '') + ' ' + esc(c.name) + '</option>';
        }).join('');

        var relatedHtml = related.length
            ? '<div style="margin-top:10px;font-size:0.78rem;color:#64748b;">' +
              '📎 ' + related.length + ' verwandte Einträge werden beim Sync ebenfalls aktualisiert.</div>'
            : '';

        var modal = document.getElementById('kb-edit-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'kb-edit-modal';
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:flex-end;justify-content:center;';
            document.body.appendChild(modal);
        }

        modal.innerHTML =
            '<div style="background:#0d1117;border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:600px;max-height:85vh;overflow-y:auto;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
                    '<h3 style="color:white;font-size:1rem;margin:0;">✏️ Eintrag bearbeiten</h3>' +
                    '<button onclick="closeKbEdit()" style="background:#333;border:none;color:white;border-radius:5px;padding:4px 10px;cursor:pointer;">✕</button>' +
                '</div>' +
                '<div class="form-group"><label>Titel</label>' +
                    '<input type="text" id="kb-edit-title" value="' + esc(entry.title || '') + '" placeholder="Titel..." style="width:100%;">' +
                '</div>' +
                '<div class="form-group"><label>Kategorie</label>' +
                    '<select id="kb-edit-cat" style="width:100%;padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;">' +
                    '<option value="">– Keine –</option>' + catOptions + '</select>' +
                '</div>' +
                '<div class="form-group"><label>Inhalt</label>' +
                    '<textarea id="kb-edit-content" rows="8" style="width:100%;padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.875rem;resize:vertical;">' + esc(entry.content || '') + '</textarea>' +
                '</div>' +
                relatedHtml +
                '<div style="display:flex;gap:8px;margin-top:12px;">' +
                    '<button onclick="saveKbEdit()" class="btn btn-success" style="flex:1;">💾 Speichern</button>' +
                    '<button onclick="syncKbEntry(\''+id+'\',true)" class="btn btn-primary" style="flex:1;">🤖 KI-Sync</button>' +
                '</div>' +
            '</div>';

        modal.style.display = 'flex';
        setTimeout(function(){ document.getElementById('kb-edit-content')?.focus(); }, 100);
    } catch(e) { alert('Fehler: ' + e.message); }
}

function closeKbEdit() {
    var modal = document.getElementById('kb-edit-modal');
    if (modal) modal.style.display = 'none';
    _editingEntryId = null;
}

async function saveKbEdit() {
    if (!_editingEntryId) return;
    var title    = document.getElementById('kb-edit-title')?.value.trim();
    var content  = document.getElementById('kb-edit-content')?.value.trim();
    var catId    = document.getElementById('kb-edit-cat')?.value;
    if (!content) { alert('Inhalt darf nicht leer sein.'); return; }

    try {
        await api.request('/knowledge/entries/' + _editingEntryId, 'PUT', {
            title: title || null, content, category_id: catId ? parseInt(catId) : null
        });
        showToast('✅ Eintrag aktualisiert');
        closeKbEdit();
        loadKbEntries(_kbCatId);
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function syncKbEntry(id, fromModal) {
    if (!confirm('Eintrag via OpenAI neu strukturieren und kategorisieren?\nAlle verwandten Einträge werden ebenfalls aktualisiert.')) return;
    if (fromModal) closeKbEdit();

    showToast('⏳ KI-Sync läuft…');
    try {
        var result = await api.request('/knowledge/entries/' + id + '/sync', 'POST');
        showToast('✅ KI-Sync: ' + (result.savedEntries || 0) + ' Einträge aktualisiert');
        loadKbEntries(_kbCatId);
        updateStats();
    } catch(e) { alert('KI-Sync Fehler: ' + e.message); }
}


// ══════════════════════════════════════════════════════════════════════
// Channel Management (v1.4)
// ══════════════════════════════════════════════════════════════════════


// ── Smalltalk Agent Settings ──────────────────────────────────────────────────

async function loadSmallTalkSettings(s) {
    if (!s) return;
    var el;
    if (s.smalltalk_system_prompt) {
        el = document.getElementById('smalltalk-system-prompt');
        if (el) el.value = s.smalltalk_system_prompt;
    }
    el = document.getElementById('smalltalk-model');
    if (el && s.smalltalk_model) el.value = s.smalltalk_model;
    el = document.getElementById('smalltalk-max-tokens');
    if (el) el.value = s.smalltalk_max_tokens || 200;
    el = document.getElementById('smalltalk-temperature');
    if (el) el.value = s.smalltalk_temperature || 0.8;
    el = document.getElementById('smalltalk-require-approval');
    if (el) el.checked = s.smalltalk_require_approval !== false;
    // Bot-Token nicht vorbelegen aus Sicherheitsgründen (nur Platzhalter wenn gesetzt)
    el = document.getElementById('smalltalk-bot-token');
    if (el && s.smalltalk_bot_token) el.placeholder = '●●●●● (gesetzt)';

    // KB-Kategorien in Dropdown laden
    var catSel = document.getElementById('smalltalk-kb-category');
    if (catSel && _allKbCats && _allKbCats.length) {
        catSel.innerHTML = '<option value="">– Keine –</option>' +
            _allKbCats.map(function(cat) {
                return '<option value="'+cat.id+'"'+(s.smalltalk_kb_category_id==cat.id?' selected':'')+'>'+esc(cat.icon||'')+' '+esc(cat.name)+'</option>';
            }).join('');
    }
}

async function saveSmallTalkSettings() {
    var gv = function(id) { var el=document.getElementById(id); return el?el.value:null; };
    var catId    = gv('smalltalk-kb-category');
    var botToken = gv('smalltalk-bot-token');
    var reqApproval = document.getElementById('smalltalk-require-approval')?.checked ?? true;
    try {
        await api.request('/settings', 'POST', {
            smalltalk_system_prompt:   gv('smalltalk-system-prompt'),
            smalltalk_model:           gv('smalltalk-model') || 'deepseek-chat',
            smalltalk_max_tokens:      parseInt(gv('smalltalk-max-tokens')) || 200,
            smalltalk_temperature:     parseFloat(gv('smalltalk-temperature')) || 0.8,
            smalltalk_kb_category_id:  catId ? parseInt(catId) : null,
            smalltalk_bot_token:       botToken || null,
            smalltalk_require_approval: reqApproval
        });
        showToast('✅ Smalltalk-Einstellungen gespeichert!');
        // Wenn Token gesetzt: sofort Verbindung testen
        if (botToken) {
            setTimeout(function() { loadSmallTalkStatus(); }, 1500);
        }
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function loadSmallTalkStatus() {
    var statusEl = document.getElementById('smalltalk-bot-status');
    if (!statusEl) return;
    statusEl.innerHTML = '<span style="color:#94a3b8;font-size:0.78rem;">⏳ Verbinde...</span>';
    try {
        var result = await api.request('/smalltalk/status');
        if (result.ok && result.bot) {
            statusEl.innerHTML = '<span style="color:#4ade80;font-size:0.78rem;">✅ Verbunden: @' + esc(result.bot.username || '') +
                (result.webhook ? ' · Webhook: ✅' : ' · Webhook: ⚠️ nicht gesetzt') + '</span>';
        } else {
            statusEl.innerHTML = '<span style="color:#ef4444;font-size:0.78rem;">❌ ' + esc(result.error || 'Verbindungsfehler') + '</span>';
        }
    } catch(e) {
        statusEl.innerHTML = '<span style="color:#ef4444;font-size:0.78rem;">❌ ' + esc(e.message) + '</span>';
    }
}


// ── Channel-Gruppen (Linking) ─────────────────────────────────────────────────


// ── Scamlist Dashboard ────────────────────────────────────────────────────────

async function loadScamlist(channelId) {
    var modal = _getOrCreateModal('scamlist-manage-modal');
    modal.innerHTML =
        '<div style="background:#0d1117;border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:600px;max-height:85vh;overflow-y:auto;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
                '<h3 style="color:white;font-size:1rem;margin:0;">⛔ Scamliste</h3>' +
                '<button onclick="_closeModal(\"scamlist-manage-modal\")" style="background:#333;border:none;color:white;border-radius:5px;padding:4px 10px;cursor:pointer;">✕</button>' +
            '</div>' +
            '<div id="scamlist-entries-' + channelId + '"><p style="color:#555;">Lädt…</p></div>' +
        '</div>';
    modal.style.display = 'flex';

    try {
        var entries = await api.request('/scamlist?channel_id=' + channelId) || [];
        var el = document.getElementById('scamlist-entries-' + channelId);
        if (!el) return;
        if (!entries.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Keine Einträge.</p>'; return; }
        el.innerHTML = entries.map(function(e) {
            var prof = e.tg_profile || {};
            return '<div style="background:#111;border-radius:6px;padding:10px;margin-bottom:6px;">' +
                '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<div style="flex:1;">' +
                        '<div style="font-weight:700;color:#ef4444;">⛔ @'+(e.username||e.user_id)+'</div>' +
                        (prof.id ? '<div style="font-size:0.68rem;color:#64748b;">TG-ID: '+prof.id+(prof.first_name ? ' · '+prof.first_name : '')+'</div>' : '') +
                        '<div style="font-size:0.75rem;color:#94a3b8;margin-top:3px;">'+(e.reason||'').substring(0,80)+'</div>' +
                        (e.ai_summary ? '<div style="font-size:0.72rem;color:#60a5fa;margin-top:3px;">🤖 '+e.ai_summary.substring(0,100)+'</div>' : '') +
                    '</div>' +
                    '<button class="btn btn-sm scam-remove-btn" data-cid="'+channelId+'" data-uid="'+e.user_id+'" style="background:#3a1a1a;color:#ef4444;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;flex-shrink:0;">🗑 Entfernen</button>' +
                '</div>' +
            '</div>';
        }).join('');

        el.addEventListener('click', function(ev) {
            var btn = ev.target.closest('.scam-remove-btn');
            if (btn) removeFromScamlistUI(btn.dataset.cid, btn.dataset.uid);
        });
    } catch(e) { console.error(e); }
}

async function removeFromScamlistUI(channelId, userId) {
    if (!confirm('Von Scamliste entfernen?')) return;
    try {
        await api.request('/scamlist/remove', 'POST', { channel_id: channelId, user_id: userId });
        showToast('✅ Entfernt!');
        loadScamlist(channelId);
    } catch(e) { alert(e.message||String(e)); }
}

async function loadChannelGroups() {
    var el = document.getElementById('channel-groups-list');
    if (!el) return;
    try {
        var groups = await api.request('/channel-groups') || [];
        if (!groups.length) {
            el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Keine Gruppen. Erstelle eine um Channels zu verknüpfen.</p>';
            return;
        }
        el.innerHTML = groups.map(function(g) {
            var members = (g.channel_group_members || []).map(function(m) {
                return '<span style="background:#1e3a5f;color:#60a5fa;font-size:0.68rem;padding:2px 5px;border-radius:3px;margin-right:3px;">'+(m.bot_channels?.title||m.channel_id)+'</span>';
            }).join('');
            return '<div style="background:#111;border-radius:6px;padding:10px;margin-bottom:6px;display:flex;align-items:center;gap:8px;">'+
                '<div style="flex:1;"><div style="font-weight:700;font-size:0.85rem;">'+esc(g.name)+'</div>'+
                '<div style="margin-top:4px;">'+members+'</div></div>'+
                '<button onclick="deleteChannelGroup(\''+g.id+'\')" class="icon-btn">🗑</button>'+
            '</div>';
        }).join('');
    } catch(e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function createChannelGroupUI() {
    // Show channel multi-select
    var el = document.getElementById('channel-list');
    var channelCards = el ? el.querySelectorAll('[data-chid]') : [];
    if (!channelCards.length) { alert('Erst Channels laden.'); return; }
    var name = prompt('Name der Gruppe (z.B. "ValueShop Channels"):');
    if (!name) return;
    var ids = [];
    channelCards.forEach(function(card) {
        if (confirm('Channel "' + (card.querySelector('[style*="font-weight:700"]')?.textContent || card.dataset.chid) + '" hinzufügen?')) {
            ids.push(card.dataset.chid);
        }
    });
    if (ids.length < 2) { alert('Mindestens 2 Channels benötigt.'); return; }
    try {
        await api.request('/channel-groups', 'POST', { name, channel_ids: ids });
        showToast('✅ Gruppe erstellt!');
        loadChannelGroups();
    } catch(e) { alert('Fehler: ' + (e.message||String(e))); }
}

async function deleteChannelGroup(id) {
    if (!confirm('Gruppe auflösen?')) return;
    try { await api.request('/channel-groups/' + id, 'DELETE'); loadChannelGroups(); }
    catch(e) { alert(e.message||String(e)); }
}

async function registerChannelManually() {
    var chatId = document.getElementById('manual-chat-id')?.value?.trim();
    if (!chatId) { alert('Chat-ID eingeben (z.B. -1001234567890)'); return; }
    showToast('⏳ Registriere...');
    try {
        var result = await api.request('/channels/register', 'POST', { chat_id: chatId });
        if (result.success) {
            showToast('✅ ' + (result.channel?.title || chatId) + ' registriert!');
            var el = document.getElementById('manual-chat-id');
            if (el) el.value = '';
            await loadChannels();
        } else {
            alert('Fehler: ' + (result.error || 'Unbekannt'));
        }
    } catch(e) { alert('Fehler: ' + (e.message || String(e))); }
}

async function scanAndLoadChannels() {
    var el = document.getElementById('channel-list');
    if (el) el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">⏳ Scanne...</p>';
    try {
        var result = await api.request('/channels/scan', 'POST');
        var msg = '✅ Scan: ' + (result.registered || 0) + ' aktiv von ' + (result.scanned || 0);
        showToast(msg);
    } catch(e) {
        showToast('❌ Scan-Fehler: ' + (e.message || String(e)));
    }
    await loadChannels();
}

async function loadChannels() {
    var el = document.getElementById('channel-list');
    if (!el) return;
    // Invalidate cache to force fresh data
    if (api.invalidate) api.invalidate('/channels');
    try {
        var channels = await api.request('/channels') || [];
        if (!channels.length) {
            el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Noch keine Channels erkannt.<br>Füge den Bot als Admin hinzugefügt ein.</p>';
            return;
        }
        el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Lade...</p>';
        el.innerHTML = '';
        channels.forEach(function(ch) {
            var card = document.createElement('div');
            var borderColor = ch.is_approved ? '#14532d' : '#3a1a1a';
            card.style.cssText = 'background:#111;border-radius:8px;margin-bottom:6px;border:1px solid '+borderColor+';overflow:hidden;';
            card.dataset.chid = ch.id;

            var tokenPct = ch.token_limit ? Math.min(100, Math.round((ch.token_used||0)/ch.token_limit*100)) : 0;
            var barColor = tokenPct > 85 ? '#ef4444' : tokenPct > 60 ? '#f59e0b' : '#4ade80';

            // ── Collapsed Header (immer sichtbar) ─────────────────────────────
            var header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none;';
            header.innerHTML =
                '<span style="font-size:1.05rem;">'+(ch.type==='channel'?'📢':'👥')+'</span>' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+esc(ch.title||ch.id)+'</div>' +
                    '<div style="font-size:0.68rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                        (ch.type||'group') +
                        (ch.username ? ' · @'+esc(ch.username) : '') +
                        (ch.added_by_username ? ' · Admin: @'+esc(ch.added_by_username) : '') +
                    '</div>' +
                '</div>' +
                // Badges
                '<div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">' +
                    '<span style="font-size:0.65rem;background:#1e3a5f;color:#60a5fa;padding:1px 5px;border-radius:3px;">📚 '+(ch.kb_entry_count||0)+'</span>' +
                    (ch.is_approved
                        ? '<span style="font-size:0.65rem;background:#14532d;color:#4ade80;padding:1px 5px;border-radius:3px;">✅</span>'
                        : '<span style="font-size:0.65rem;background:#3a1a1a;color:#f87171;padding:1px 5px;border-radius:3px;">⏳</span>') +
                    (ch.ai_enabled
                        ? '<span style="font-size:0.65rem;background:#1e3a5f;color:#818cf8;padding:1px 5px;border-radius:3px;">🤖</span>'
                        : '') +
                    '<span style="color:#64748b;font-size:0.8rem;margin-left:2px;" class="ch-toggle-icon">▾</span>' +
                '</div>';

            // ── Expanded Body (initial hidden) ─────────────────────────────────
            var body = document.createElement('div');
            body.style.cssText = 'display:none;padding:0 12px 12px;border-top:1px solid #1e1e1e;';
            body.innerHTML =
                // Approve button
                (!ch.is_approved
                    ? '<button class="btn btn-success btn-sm ch-approve" data-id="'+ch.id+'" style="width:100%;margin:10px 0 6px;">🔓 Freischalten</button>'
                    : '<div style="margin-top:10px;"></div>') +

                // Mode + command
                '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
                    '<select class="ch-mode" data-id="'+ch.id+'" style="flex:1;padding:6px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;">' +
                        ['smalltalk','berater'].map(function(m){ return '<option value="'+m+'"'+(ch.mode===m?' selected':'')+'>'+m+'</option>'; }).join('') +
                    '</select>' +
                    '<input type="text" class="ch-cmd" data-id="'+ch.id+'" value="'+esc(ch.ai_command||'/ai')+'" placeholder="/ai" style="width:70px;padding:6px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;text-align:center;">' +
                '</div>' +

                // System prompt
                '<div style="margin-bottom:8px;">' +
                    '<label style="font-size:0.7rem;color:#64748b;display:block;margin-bottom:3px;">System-Prompt</label>' +
                    '<textarea class="ch-sysprompt" data-id="'+ch.id+'" rows="2" placeholder="Eigene Persönlichkeit…" style="width:100%;padding:6px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.75rem;resize:vertical;">'+esc(ch.system_prompt||'')+'</textarea>' +
                '</div>' +

                // Token limits
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">' +
                    '<div><label style="font-size:0.7rem;color:#64748b;">Token-Budget (Volumen)</label><input type="number" class="ch-tlimit" data-id="'+ch.id+'" value="'+(ch.token_limit||'')+'" placeholder="∞" style="width:100%;padding:5px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;"></div>' +
                    '<div><label style="font-size:0.7rem;color:#64748b;">USD-Limit</label><input type="number" step="0.01" class="ch-ulimit" data-id="'+ch.id+'" value="'+(ch.usd_limit||'')+'" placeholder="∞" style="width:100%;padding:5px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;"></div>' +
                '</div>' +

                // Cost display
                '<div style="background:#0d1117;border-radius:6px;padding:8px;margin-bottom:8px;font-size:0.75rem;">' +
                    '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:#64748b;">Tokens:</span><span>'+((ch.token_used||0)).toLocaleString()+(ch.token_limit?' / '+ch.token_limit.toLocaleString():'')+'</span></div>' +
                    (ch.token_limit ? '<div style="height:4px;background:#1e1e1e;border-radius:2px;margin-bottom:4px;"><div style="height:100%;width:'+tokenPct+'%;background:'+barColor+';border-radius:2px;"></div></div>' : '') +
                    '<div style="display:flex;justify-content:space-between;"><span style="color:#64748b;">Kosten:</span><span style="color:#f59e0b;">$'+parseFloat(ch.usd_spent||0).toFixed(5)+(ch.usd_limit?' / $'+ch.usd_limit:'')+'</span></div>' +
                '</div>' +

                // Limit message
                '<input type="text" class="ch-limitmsg" data-id="'+ch.id+'" value="'+esc(ch.limit_message||'')+'" placeholder="Limit-Meldung…" style="width:100%;padding:5px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.75rem;margin-bottom:8px;">' +

                // AI toggle
                '<div style="border-top:1px solid #1e3a5f;padding-top:8px;margin-bottom:8px;">' +
                    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
                        '<span style="font-size:0.75rem;font-weight:700;color:'+(ch.ai_enabled?'#60a5fa':'#64748b')+';">'+(ch.ai_enabled?'🤖 KI aktiv':'🔒 KI gesperrt')+'</span>' +
                        '<button class="btn btn-sm ch-ai-toggle" data-id="'+ch.id+'" data-ai="'+(ch.ai_enabled?'1':'0')+'" style="padding:3px 8px;font-size:0.7rem;background:'+(ch.ai_enabled?'#14532d':'#1e3a5f')+';color:'+(ch.ai_enabled?'#4ade80':'#94a3b8')+';border:none;border-radius:4px;cursor:pointer;">'+(ch.ai_enabled?'✅ Deaktivieren':'🔓 Aktivieren')+'</button>' +
                    '</div>' +
                    '<div style="opacity:'+(ch.ai_enabled?'1':'0.35')+';pointer-events:'+(ch.ai_enabled?'auto':'none')+'">' +
                        '<button class="btn btn-secondary btn-sm ch-kb" data-id="'+ch.id+'" style="width:100%;margin-bottom:5px;">📚 Wissen ('+ch.kb_entry_count+' Einträge)</button>' +
                    '</div>' +
                '</div>' +

                // Action buttons
                '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
                    '<button class="btn btn-secondary btn-sm ch-schedule" data-id="'+ch.id+'" style="flex:1;">⏰ Geplant</button>' +
                    '<button class="btn btn-secondary btn-sm ch-scamlist" data-id="'+ch.id+'" style="flex:1;">⛔ Scamliste</button>' +
                    '<button class="btn btn-secondary btn-sm ch-safelist" data-id="'+ch.id+'" style="flex:1;opacity:'+(ch.ai_enabled?'1':'0.4')+';pointer-events:'+(ch.ai_enabled?'auto':'none')+';">🛡 Safelist</button>' +
                '</div>' +
                '<div style="display:flex;gap:6px;">' +
                    '<button class="btn btn-secondary btn-sm ch-reset" data-id="'+ch.id+'" style="flex:1;">↺ Reset</button>' +
                    '<button class="icon-btn ch-delete" data-id="'+ch.id+'">🗑</button>' +
                '</div>';

            // Toggle logic
            header.onclick = function() {
                var isOpen = body.style.display !== 'none';
                body.style.display = isOpen ? 'none' : 'block';
                var icon = header.querySelector('.ch-toggle-icon');
                if (icon) icon.textContent = isOpen ? '▾' : '▴';
            };

            card.appendChild(header);
            card.appendChild(body);
            el.appendChild(card);
        });

        el.addEventListener('click', function(e) {
            var aiTog   = e.target.closest('.ch-ai-toggle');
            var sched   = e.target.closest('.ch-schedule');
            var safeEl  = e.target.closest('.ch-safelist');
            var approve = e.target.closest('.ch-approve');
            var reset   = e.target.closest('.ch-reset');
            var del     = e.target.closest('.ch-delete');
            var kb      = e.target.closest('.ch-kb');
            if (aiTog) {
                var enable = aiTog.dataset.ai !== '1';
                if (!confirm(enable ? 'KI-Features aktivieren?' : 'KI-Features deaktivieren?')) return;
                api.request('/channels/' + aiTog.dataset.id + '/ai', 'PUT', { ai_enabled: enable })
                   .then(function(){ showToast(enable ? '🤖 KI aktiviert!' : '🔒 KI deaktiviert'); loadChannels(); })
                   .catch(function(e){ alert('Fehler: ' + (e.message||String(e))); });
            }
            if (sched)  openScheduleModal(sched.dataset.id);
            var scamBtn = e.target.closest('.ch-scamlist');
            if (scamBtn) loadScamlist(scamBtn.dataset.id);
            var slTog = e.target.closest('.ch-safelist-toggle');
            if (slTog) {
                var enableSl = slTog.dataset.sl !== '1';
                api.request('/channels/' + slTog.dataset.id + '/ai', 'PUT', { safelist_enabled: enableSl })
                   .then(function(){ showToast(enableSl ? '🛡 Safelist aktiviert!' : '🛡 Safelist deaktiviert'); loadChannels(); })
                   .catch(function(e){ alert('Fehler: ' + (e.message||String(e))); });
            }
            if (safeEl) openSafelistModal(safeEl.dataset.id);
            if (approve) approveChannel(approve.dataset.id);
            if (reset)   resetChannelUsage(reset.dataset.id);
            if (del)     deleteChannel(del.dataset.id);
            if (kb)      openChannelKB(kb.dataset.id, '');
        });
        el.addEventListener('change', function(e) {
            var mode = e.target.closest('.ch-mode');
            if (mode) updateChannel(mode.dataset.id, { mode: mode.value });
        });
        el.addEventListener('blur', function(e) {
            var cmd = e.target.closest('.ch-cmd');
            var tl  = e.target.closest('.ch-tlimit');
            var ul  = e.target.closest('.ch-ulimit');
            var lm  = e.target.closest('.ch-limitmsg');
            var sp  = e.target.closest('.ch-sysprompt');
            if (cmd) updateChannel(cmd.dataset.id, { ai_command:    cmd.value });
            if (tl)  updateChannel(tl.dataset.id,  { token_limit:   tl.value  });
            if (ul)  updateChannel(ul.dataset.id,  { usd_limit:     ul.value  });
            if (lm)  updateChannel(lm.dataset.id,  { limit_message: lm.value  });
            if (sp)  updateChannel(sp.dataset.id,  { system_prompt: sp.value  });
        }, true);

    } catch(e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message)+'</p>'; }
}

// ── Channel KB Management ─────────────────────────────────────────────────────

var _currentKBChannel = null;

function closeChannelKB() { var m=document.getElementById('channel-kb-modal'); if(m) m.style.display='none'; }

async function openChannelKB(channelId, btnText) {
    _currentKBChannel = channelId;
    var modal = document.getElementById('channel-kb-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'channel-kb-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:99999;display:flex;align-items:flex-end;justify-content:center;';
        document.body.appendChild(modal);
    }

    modal.innerHTML =
        '<div style="background:#0d1117;border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:600px;max-height:85vh;overflow-y:auto;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
                '<h3 style="color:white;font-size:1rem;margin:0;">📚 Channel Wissen</h3>' +
                '<button onclick="closeChannelKB()" style="background:#333;border:none;color:white;border-radius:5px;padding:4px 10px;cursor:pointer;">✕</button>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
                '<textarea id="ch-kb-new-content" rows="4" placeholder="Neues Wissen eingeben (wird von OpenAI aufbereitet und kategorisiert)…" style="width:100%;padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.85rem;resize:vertical;"></textarea>' +
                '<button onclick="addChannelKBEntry()" class="btn btn-success btn-sm" style="width:100%;margin-top:6px;">🤖 Hinzufügen (via OpenAI)</button>' +
            '</div>' +
            '<div id="ch-kb-list"><p style="color:#555;font-size:0.85rem;">Lädt…</p></div>' +
        '</div>';

    modal.style.display = 'flex';
    await loadChannelKBEntries(channelId);
}

async function loadChannelKBEntries(channelId) {
    var list = document.getElementById('ch-kb-list');
    if (!list) return;
    try {
        var entries = await api.request('/channels/' + channelId + '/kb') || [];
        if (!entries.length) {
            list.innerHTML = '<p style="color:#555;font-size:0.85rem;">Keine Einträge. Füge Wissen über das Formular hinzu.</p>';
            return;
        }
        // Gruppiert nach Kategorie
        var byCat = {};
        entries.forEach(function(e) {
            if (!byCat[e.category]) byCat[e.category] = [];
            byCat[e.category].push(e);
        });
        list.innerHTML = Object.keys(byCat).map(function(cat) {
            return '<div style="margin-bottom:12px;">' +
                '<div style="font-size:0.7rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">📁 ' + esc(cat) + '</div>' +
                byCat[cat].map(function(e) {
                    return '<div style="background:#111;border-radius:6px;padding:8px;margin-bottom:4px;display:flex;gap:8px;align-items:flex-start;">' +
                        '<div style="flex:1;">' +
                            (e.title ? '<div style="font-size:0.78rem;font-weight:700;color:#e2e8f0;margin-bottom:2px;">'+esc(e.title)+'</div>' : '') +
                            '<div style="font-size:0.72rem;color:#94a3b8;">' + esc((e.content||'').substring(0,120)) + (e.content.length > 120 ? '…' : '') + '</div>' +
                        '</div>' +
                        '<button class="ch-kb-del-entry icon-btn" data-cid="'+channelId+'" data-eid="'+e.id+'" style="flex-shrink:0;font-size:0.7rem;">🗑</button>' +
                    '</div>';
                }).join('') +
            '</div>';
        }).join('');
    } catch(e) { list.innerHTML = '<p style="color:#ef4444;">'+esc(e.message)+'</p>'; }

    // Event delegation for delete buttons
    if (list) {
        list.onclick = function(e) {
            var btn = e.target.closest('.ch-kb-del-entry');
            if (btn) deleteChannelKBEntry(btn.dataset.cid, btn.dataset.eid);
        };
    }
}

async function addChannelKBEntry() {
    var ta = document.getElementById('ch-kb-new-content');
    if (!ta || !ta.value.trim()) return;
    var content = ta.value.trim();
    showToast('⏳ OpenAI verarbeitet Eintrag…');
    try {
        await api.request('/channels/' + _currentKBChannel + '/kb', 'POST', { content });
        ta.value = '';
        showToast('✅ Eintrag hinzugefügt!');
        await loadChannelKBEntries(_currentKBChannel);
        loadChannels(); // KB-Zähler aktualisieren
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function deleteChannelKBEntry(channelId, entryId) {
    if (!confirm('Eintrag löschen?')) return;
    try {
        await api.request('/channels/' + channelId + '/kb/' + entryId, 'DELETE');
        await loadChannelKBEntries(channelId);
        loadChannels();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function approveChannel(id) {
    try {
        await api.request('/channels/' + id, 'PUT', { is_approved: true, is_active: true });
        showToast('✅ Channel freigeschaltet!');
        loadChannels();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function resetChannelUsage(id) {
    if (!confirm('Verbrauch zurücksetzen?')) return;
    try {
        await api.request('/channels/' + id + '/reset-usage', 'POST');
        showToast('✅ Verbrauch zurückgesetzt');
        loadChannels();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function updateChannel(id, patch) {
    try { await api.request('/channels/' + id, 'PUT', patch); showToast('✅ Gespeichert'); }
    catch(e) { alert('Fehler: ' + e.message); }
}

async function deleteChannel(id) {
    if (!confirm('Channel entfernen?')) return;
    try { await api.request('/channels/' + id, 'DELETE'); loadChannels(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

async function delKbEntry(id) {
    if (!confirm('Eintrag löschen?')) return;
    try {
        await api.request('/knowledge/entries/' + id, 'DELETE');
        showToast('🗑 Gelöscht');
        loadKbEntries(_kbCatId);
        updateStats();
    } catch(e) { alert('Fehler: ' + e.message); }
}

function toggleAddCat() {
    var f = document.getElementById('add-cat-form');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function addCategory() {
    var name  = (document.getElementById('new-cat-name')?.value||'').trim();
    var color = document.getElementById('new-cat-color')?.value || '#4a9eff';
    var icon  = (document.getElementById('new-cat-icon')?.value||'').trim() || '📌';
    if (!name) return alert('Name eingeben');
    try {
        await api.request('/knowledge/categories', 'POST', { name: name, color: color, icon: icon });
        document.getElementById('new-cat-name').value = '';
        document.getElementById('add-cat-form').style.display = 'none';
        showToast('✅ Kategorie angelegt');
        loadKbCategories();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function delCat(id) {
    if (!confirm('Kategorie löschen? Einträge bleiben erhalten.')) return;
    try {
        await api.request('/knowledge/categories/' + id, 'DELETE');
        showToast('🗑 Kategorie gelöscht');
        loadKbCategories();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function saveManualKnowledge() {
    var title   = (document.getElementById('manual-kb-title')?.value||'').trim();
    var content = (document.getElementById('manual-kb-content')?.value||'').trim();
    var catId   = document.getElementById('manual-cat-id')?.value || null;
    var btn     = document.getElementById('save-manual-kb');
    if (!content) return alert('Bitte Inhalt eingeben!');
    btn.disabled = true; btn.textContent = 'Speichert…';
    try {
        await api.addManualKnowledge(title, content, catId);
        showToast('✅ Wissen gespeichert!');
        document.getElementById('manual-kb-title').value   = '';
        document.getElementById('manual-kb-content').value = '';
        updateStats();
        loadKbEntries(_kbCatId);
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '💾 Wissen speichern & KI trainieren'; }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function discoverLinks() {
    var url = (document.getElementById('scrape-url')?.value||'').trim();
    if (!url) return alert('URL eingeben');
    var btn = document.getElementById('url-discover');
    btn.textContent = '🔍 Suche…'; btn.disabled = true;
    document.getElementById('link-list').innerHTML = '';
    try {
        var data = await api.discoverLinks(url);
        var ll   = document.getElementById('link-list');
        if (!data.links || !data.links.length) {
            ll.innerHTML = '<p style="color:#888;padding:8px;font-size:0.85rem;">Keine Links gefunden.</p>';
            return;
        }
        var rows = data.links.map(function(l) {
            return '<div class="link-item"><input type="checkbox" name="scrape-links" value="' + esc(l) + '" checked>' +
                '<label>' + (l.length > 80 ? l.substring(0, 80) + '…' : l) + '</label></div>';
        }).join('');
        ll.innerHTML = '<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px;max-height:240px;overflow-y:auto;">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:0.8rem;color:#888;">' +
                '<span>' + data.links.length + ' Links</span>' +
                '<span><button onclick="setAllLinks(true)" class="btn btn-secondary" style="padding:2px 7px;font-size:0.72rem;">Alle</button> ' +
                '<button onclick="setAllLinks(false)" class="btn btn-secondary" style="padding:2px 7px;font-size:0.72rem;">Keine</button></span>' +
            '</div>' + rows + '</div>';
        document.getElementById('start-scrape').style.display = 'block';
    } catch(e) {
        document.getElementById('link-list').innerHTML = '<p style="color:#ef4444;padding:8px;">⚠️ ' + esc(e.message) + '</p>';
    }
    finally { btn.textContent = '🔍 Links finden'; btn.disabled = false; }
}

function setAllLinks(v) {
    document.querySelectorAll('input[name="scrape-links"]').forEach(function(el) { el.checked = v; });
}

async function startScraping() {
    var links  = Array.from(document.querySelectorAll('input[name="scrape-links"]:checked')).map(function(el) { return el.value; });
    var catId  = document.getElementById('scrape-cat-id')?.value || null;
    if (!links.length) return alert('Mindestens einen Link auswählen');
    var btn = document.getElementById('start-scrape');
    btn.textContent = '⏳ ' + links.length + ' Seiten werden gescannt…'; btn.disabled = true;
    try {
        var r = await api.request('/scrape', 'POST', { urls: links, category_id: catId });
        showToast('✅ ' + r.processedUrls + ' Seiten, ' + r.savedChunks + ' Chunks gespeichert');
        updateStats();
        loadKbEntries(_kbCatId);
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.textContent = '▶ Ausgewählte Seiten scrapen'; btn.disabled = false; }
}

// ── Sellauth ──────────────────────────────────────────────────────────────────
async function testSellauth() {
    try {
        var s = await api.getSettings();
        if (!s.sellauth_api_key || !s.sellauth_shop_id) {
            return alert('Bitte zuerst API Key und Shop ID unter ⚙️ Settings → Sellauth speichern!');
        }
        var r = await api.request('/sellauth/test', 'POST', { apiKey: s.sellauth_api_key, shopId: s.sellauth_shop_id });
        if (r.ok) showToast('✅ Verbunden: ' + r.shopName);
        else alert('❌ Verbindung fehlgeschlagen: ' + r.error);
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function loadSellauthPreview() {
    var preview = document.getElementById('sa-preview');
    var list    = document.getElementById('sa-product-list');
    if (!preview || !list) return;
    preview.style.display = 'block';
    list.innerHTML = '<p style="color:#888;">Lade Produkte…</p>';
    try {
        var data = await api.request('/sellauth/preview');
        document.getElementById('sa-product-count').textContent = data.total;
        list.innerHTML = data.products.map(function(p) {
            var typeBadge = p.type === 'variant'
                ? '<span class="sa-badge sa-variant-badge">' + p.variants + ' Varianten</span>'
                : '<span class="sa-badge sa-single-badge">Einzelprodukt</span>';
            return '<div class="sa-card">' +
                '<div class="sa-title">' + esc(p.name) + ' ' + typeBadge +
                    (p.stock !== null ? '<span style="margin-left:auto;font-size:0.75rem;color:#888;">Bestand: ' + p.stock + '</span>' : '') +
                '</div>' +
                (p.price ? '<div style="color:#f59e0b;font-size:0.85rem;margin-bottom:4px;">💰 ' + p.price + ' ' + (p.currency||'EUR') + '</div>' : '') +
                '<div class="sa-link">🔗 ' + esc(p.url) + '</div>' +
            '</div>';
        }).join('');
    } catch(e) { list.innerHTML = '<p style="color:#ef4444;">' + esc(e.message) + '</p>'; }
}

async function syncSellauth() {
    var btn = document.getElementById('btn-sync-sellauth');
    btn.textContent = '⏳ Synchronisiere…'; btn.disabled = true;
    try {
        var r = await api.request('/sellauth/sync', 'POST');
        if (!r) { showToast('❌ Kein Ergebnis - Server prüfen'); return; }
        var msg = r.message || '';
        if (r.details && r.details.deletedOld) msg += ' (' + r.details.deletedOld + ' alte bereinigt)';
        showToast('✅ ' + msg);
        updateStats();
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.textContent = '🔄 Jetzt synchronisieren'; btn.disabled = false; }
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
    try {
        // 1. Sofort aus localStorage-Cache laden (kein Flimmern)
        var cached = _getCachedSettings();
        if (cached) _applySettings(cached);

        // 2. Vom Server laden und Cache aktualisieren
        var s = await api.getSettings();
        if (!s) return;
        _saveSettingsCache(s);
        _applySettings(s);
    } catch(e) { console.error('Settings Ladefehler:', e.message); }
}

// Settings auf UI-Elemente anwenden
function _applySettings(s) {
    var sv = function(id, val) { var el = document.getElementById(id); if (el && val != null) el.value = val; };
    sv('system-prompt',       s.system_prompt);
    sv('negative-prompt',     s.negative_prompt);
    sv('welcome-message',     s.welcome_message);
    sv('manual-msg-template', s.manual_msg_template);
    sv('sellauth-api-key',    s.sellauth_api_key);
    sv('sellauth-shop-id',    s.sellauth_shop_id);
    sv('sellauth-shop-url',   s.sellauth_shop_url);
    sv('webhook-app-url',     s.webhook_url);
    sv('ai-model',            s.ai_model);
    var setSlider = function(id, val, dispId) {
        var el = document.getElementById(id);
        if (el && val != null) {
            el.value = val;
            var disp = document.getElementById(dispId);
            if (disp) disp.textContent = (id === 'ai-temperature' || id === 'rag-threshold') ? parseFloat(val).toFixed(2) : val;
        }
    };
    setSlider('ai-max-tokens',   s.ai_max_tokens   || 1024, 'token-disp');
    setSlider('ai-temperature',  s.ai_temperature  || 0.5,  'temp-disp');
    setSlider('rag-threshold',   s.rag_threshold   || 0.45, 'thresh-disp');
    setSlider('rag-match-count', s.rag_match_count || 8,    'count-disp');
    setSlider('max-history-msgs', s.max_history_msgs || 4, 'hist-disp');
    setSlider('summary-interval', s.summary_interval || 5, 'summ-disp');
    // Widget powered-by
    var pwEl = document.getElementById('widget-powered-by');
    if (pwEl && s.widget_powered_by != null) pwEl.value = s.widget_powered_by;
    // Coupon settings
    
    loadSmallTalkSettings(s);
var ceEl = document.getElementById('coupon-enabled'); if(ceEl) ceEl.checked = !!s.coupon_enabled;
    var sv2 = function(id, v){ var el=document.getElementById(id); if(el&&v!=null) el.value=v; };
    sv2('coupon-discount', s.coupon_discount || 10);
    sv2('coupon-type', s.coupon_type || 'percentage');
    sv2('coupon-description', s.coupon_description || '');
    sv2('coupon-max-uses', s.coupon_max_uses || '');
    var shEl = document.getElementById('coupon-schedule-hour');
    if(shEl){ shEl.value = s.coupon_schedule_hour || 0; var shD = document.getElementById('schedule-hour-disp'); if(shD) shD.textContent = s.coupon_schedule_hour || 0; }
}

// Settings-Cache
function _getCachedSettings() {
    try { var v = localStorage.getItem('_settings_cache'); return v ? JSON.parse(v) : null; } catch(_) { return null; }
}
function _saveSettingsCache(s) {
    try { localStorage.setItem('_settings_cache', JSON.stringify(s)); } catch(_) {}
}


async function saveSettings() {
    var gv = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var settings = {
        system_prompt:       gv('system-prompt'),
        negative_prompt:     gv('negative-prompt'),
        welcome_message:     gv('welcome-message'),
        manual_msg_template: gv('manual-msg-template'),
        sellauth_api_key:    gv('sellauth-api-key'),
        sellauth_shop_id:    gv('sellauth-shop-id'),
        sellauth_shop_url:   gv('sellauth-shop-url'),
        ai_model:            gv('ai-model'),
        ai_max_tokens:       parseInt(gv('ai-max-tokens'))    || 1024,
        ai_temperature:      parseFloat(gv('ai-temperature')) || 0.5,
        rag_threshold:       parseFloat(gv('rag-threshold'))  || 0.45,
        rag_match_count:     parseInt(gv('rag-match-count'))  || 8
    };
    try {
        await api.saveSettings(settings);
        showToast('✅ Einstellungen gespeichert!');
    } catch(e) { alert('Fehler beim Speichern: ' + e.message); }
}

// ── Blacklist ─────────────────────────────────────────────────────────────────
async function loadFlaggedChats() {
    var el = document.getElementById('flagged-list');
    if (!el) return;
    try {
        var chats = await api.getFlaggedChats() || [];
        if (!chats.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine geflaggten Chats.</p>'; return; }
        el.innerHTML = chats.map(function(c) {
            var name = c.first_name || c.username || c.id.substring(0,12);
            var mutedBadge = c.auto_muted ? '<span style="background:#431407;color:#f87171;padding:1px 6px;border-radius:4px;font-size:0.7rem;">STUMM</span>' : '';
            return '<div style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid #2a2a2a;">' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:600;font-size:0.875rem;">' + esc(name) + ' ' + mutedBadge + '</div>' +
                    '<div style="font-size:0.75rem;color:#888;">🚩 ' + c.flag_count + ' Flags' + (c.mute_reason ? ' · ' + esc(c.mute_reason) : '') + '</div>' +
                '</div>' +
                (c.auto_muted ? '<button onclick="unmuteChat(\'' + esc(c.id) + '\')" class="btn btn-secondary btn-sm">Stummschaltung aufheben</button>' : '') +
                '<button onclick="unflagChat(\'' + esc(c.id) + '\')" class="btn btn-danger btn-sm">Flags löschen</button>' +
            '</div>';
        }).join('');
    } catch(e) { el.innerHTML = '<p style="color:#ef4444;font-size:0.85rem;">Fehler: ' + esc(e.message) + '</p>'; }
}

async function unflagChat(chatId) {
    try { await api.unflagChat(chatId); showToast('✅ Flags gelöscht'); loadFlaggedChats(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

async function unmuteChat(chatId) {
    try { await api.unmuteChat(chatId); showToast('✅ Stummschaltung aufgehoben'); loadFlaggedChats(); loadChats(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

async function loadBlacklist() {
    var tbody = document.getElementById('blacklist-body');
    if (!tbody) return;
    try {
        var list = await api.getBlacklist();
        if (list === null) return;
        list = list || [];
        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:1rem;color:#555;">Blacklist ist leer</td></tr>';
            return;
        }
        tbody.innerHTML = list.map(function(item) {
            return '<tr>' +
                '<td><code style="font-size:0.8rem;">' + esc(item.identifier) + '</code></td>' +
                '<td style="color:#aaa;">' + esc(item.reason||'–') + '</td>' +
                '<td style="color:#555;">' + new Date(item.created_at).toLocaleDateString('de-DE') + '</td>' +
                '<td><button onclick="removeBan(\'' + item.id + '\')" class="btn btn-danger" style="padding:3px 9px;font-size:0.75rem;">Löschen</button></td>' +
            '</tr>';
        }).join('');
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:#ef4444;padding:10px;">Fehler: ' + esc(e.message) + '</td></tr>';
    }
}

async function handleBan() {
    var id     = (document.getElementById('ban-identifier')?.value||'').trim();
    var reason = (document.getElementById('ban-reason')?.value||'').trim();
    if (!id) return alert('Identifikator eingeben');
    try {
        await api.banUser(id, reason);
        document.getElementById('ban-identifier').value = '';
        document.getElementById('ban-reason').value     = '';
        showToast('✅ Nutzer gebannt');
        loadBlacklist();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function removeBan(id) {
    if (!confirm('Bann aufheben?')) return;
    try {
        await api.removeBan(id);
        showToast('✅ Bann aufgehoben');
        loadBlacklist();
    } catch(e) { alert('Fehler: ' + e.message); }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function trunc(s, n) { return s && s.length > n ? s.substring(0, n) + '…' : (s||''); }

function relTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var m    = Math.floor(diff / 60000);
    if (m < 1)  return 'jetzt';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    var d = Math.floor(h / 24);
    if (d < 7)  return d + 'd';
    return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

async function rejectLearning(id) {
    if (!confirm('Anfrage ablehnen und löschen?\nDie Wissenslücke bleibt bestehen.')) return;
    try {
        var result = await api.request('/learning/' + id, 'DELETE');
        showToast('🗑 Anfrage abgelehnt');
        loadLearningQueue();
        updateStats();
    } catch(e) { alert('Fehler beim Löschen: ' + e.message); }
}

// ── Sellauth Sync mit Hintergrund-Job ────────────────────────────────────────
var _syncJobId      = null;
var _syncPollTimer  = null;

async function syncSellauth() {
    var btn = document.getElementById('btn-sync-sellauth');
    btn.disabled = true;

    // Fortschrittsanzeige einblenden
    _showSyncProgress(0, 'Starte Sync...');

    try {
        var r = await api.request('/sellauth/sync', 'POST');
        if (!r || !r.jobId) {
            _hideSyncProgress();
            btn.disabled = false;
            alert('Fehler beim Starten des Syncs');
            return;
        }

        _syncJobId = r.jobId;
        showToast('⏳ Sync läuft im Hintergrund...');
        // Polling starten — läuft auch wenn Tab gewechselt wird
        _startSyncPolling();
    } catch(e) {
        _hideSyncProgress();
        btn.disabled = false;
        alert('Fehler: ' + e.message);
    }
}

function _startSyncPolling() {
    if (_syncPollTimer) clearInterval(_syncPollTimer);
    _syncPollTimer = setInterval(async function() {
        if (!_syncJobId) { clearInterval(_syncPollTimer); return; }
        try {
            var job = await api.request('/sellauth/sync-status/' + _syncJobId);
            if (!job) return; // Netzwerkfehler - weiter versuchen

            _showSyncProgress(job.progress, job.step);

            if (job.status === 'done') {
                clearInterval(_syncPollTimer);
                _syncJobId = null;
                _hideSyncProgress();
                var r = job.result || {};
                var msg = (r.saved || 0) + ' Produkte';
                if (r.blogPosts)   msg += ', ' + r.blogPosts + ' Blog-Posts';
                if (r.categories)  msg += ', ' + r.categories + ' Kategorien';
                showToast('✅ Sync fertig: ' + msg + ' importiert');
                updateStats();
                document.getElementById('btn-sync-sellauth').disabled = false;
            } else if (job.status === 'error') {
                clearInterval(_syncPollTimer);
                _syncJobId = null;
                _hideSyncProgress();
                alert('Sync Fehler: ' + job.step);
                document.getElementById('btn-sync-sellauth').disabled = false;
            }
        } catch(e) { /* Netzwerkfehler ignorieren */ }
    }, 2000); // Alle 2 Sekunden pollen
}

function _showSyncProgress(pct, step) {
    var box = document.getElementById('_sync-progress');
    if (!box) {
        box = document.createElement('div');
        box.id = '_sync-progress';
        box.style.cssText = 'position:fixed;bottom:70px;right:20px;background:#1a2a3a;border:1px solid #2563eb;border-radius:12px;padding:14px 18px;z-index:9998;min-width:280px;box-shadow:0 8px 24px rgba(0,0,0,0.5);';
        box.innerHTML = '<div style="font-size:0.8rem;color:#93c5fd;font-weight:700;margin-bottom:8px;">🔄 Sellauth Sync läuft</div>' +
            '<div style="background:#0d1929;border-radius:6px;height:8px;overflow:hidden;margin-bottom:6px;">' +
                '<div id="_sync-bar" style="height:100%;background:linear-gradient(90deg,#2563eb,#4ade80);border-radius:6px;transition:width 0.5s;width:0%;"></div>' +
            '</div>' +
            '<div id="_sync-step" style="font-size:0.75rem;color:#94a3b8;"></div>';
        document.body.appendChild(box);
    }
    box.style.display = 'block';
    var bar  = document.getElementById('_sync-bar');
    var step_el = document.getElementById('_sync-step');
    if (bar)     bar.style.width = (pct || 0) + '%';
    if (step_el) step_el.textContent = step || '';
}

function _hideSyncProgress() {
    var box = document.getElementById('_sync-progress');
    if (box) box.style.display = 'none';
}

async function saveSettings() {
    var gv = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var settings = {
        system_prompt:       gv('system-prompt'),
        negative_prompt:     gv('negative-prompt'),
        welcome_message:     gv('welcome-message'),
        manual_msg_template: gv('manual-msg-template'),
        sellauth_api_key:    gv('sellauth-api-key'),
        sellauth_shop_id:    gv('sellauth-shop-id'),
        sellauth_shop_url:   gv('sellauth-shop-url'),
        webhook_url:         gv('webhook-app-url'),
        ai_model:            gv('ai-model'),
        ai_max_tokens:       parseInt(gv('ai-max-tokens'))    || 1024,
        ai_temperature:      parseFloat(gv('ai-temperature')) || 0.5,
        rag_threshold:       parseFloat(gv('rag-threshold'))  || 0.45,
        rag_match_count:     parseInt(gv('rag-match-count'))  || 8,
        max_history_msgs:    parseInt(gv('max-history-msgs')) || 4,
        summary_interval:    parseInt(gv('summary-interval')) || 5,
        widget_powered_by:   gv('widget-powered-by'),
        // Coupon settings
        coupon_enabled:      !!(document.getElementById('coupon-enabled')?.checked),
        coupon_discount:     parseInt(gv('coupon-discount'))      || 10,
        coupon_type:         gv('coupon-type')                    || 'percentage',
        coupon_description:  gv('coupon-description'),
        coupon_max_uses:     parseInt(gv('coupon-max-uses'))       || null,
        coupon_schedule_hour: parseInt(gv('coupon-schedule-hour')) || 0
    };

    var saveBtn = document.getElementById('save-settings') ||
                  document.querySelector('button[onclick="saveSettings()"]');
    var origText = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Speichert...'; }

    try {
        var saved = await api.saveSettings(settings);
        if (saved) {
            // Server-Antwort als neuen Cache speichern
            _saveSettingsCache(saved);
            _applySettings(saved);
        }
        showToast('✅ Einstellungen gespeichert!');
    } catch(e) {
        showToast('❌ Fehler: ' + e.message);
        alert('Speichern fehlgeschlagen: ' + e.message + '\n\nBitte versuche es erneut.');
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = origText || '💾 Speichern'; }
    }
}


// ── Web Push Notifications ────────────────────────────────────────────────────

var _pushSubscribed = false;

async function initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('[Push] Nicht unterstützt in diesem Browser');
        _updatePushUI('unsupported');
        return;
    }

    try {
        // Service Worker registrieren
        var reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // Bestehende Subscription prüfen
        var existing = await reg.pushManager.getSubscription();
        if (existing) {
            _pushSubscribed = true;
            _updatePushUI('subscribed');
            return;
        }
        _updatePushUI('unsubscribed');
    } catch(e) {
        console.warn('[Push] SW-Registrierung fehlgeschlagen:', e.message);
        _updatePushUI('error');
    }
}

async function subscribePush() {
    var btn = document.getElementById('push-subscribe-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Wird aktiviert...'; }

    try {
        var reg = await navigator.serviceWorker.ready;

        // VAPID Public Key vom Server laden
        var keyData = await api.request('/push/vapid-key');
        if (!keyData?.publicKey) {
            alert('VAPID_PUBLIC_KEY fehlt in den Server-Einstellungen. Bitte in Render.com Environment Variables setzen.');
            return;
        }

        // Subscription erstellen
        var subscription = await reg.pushManager.subscribe({
            userVisibleOnly:      true,
            applicationServerKey: _urlBase64ToUint8Array(keyData.publicKey)
        });

        // Subscription an Server senden
        await api.request('/push-subscription', 'POST', { subscription: subscription.toJSON() });

        _pushSubscribed = true;
        _updatePushUI('subscribed');
        showToast('✅ Push-Benachrichtigungen aktiviert!');

        // Sofort Testbenachrichtigung senden
        setTimeout(async function() {
            try { await api.request('/push/test', 'POST'); } catch(_) {}
        }, 1000);

    } catch(e) {
        console.error('[Push] Subscribe fehlgeschlagen:', e.message);
        if (e.name === 'NotAllowedError') {
            alert('Benachrichtigungen wurden blockiert. Bitte in den Browser-Einstellungen erlauben.');
        } else {
            alert('Push-Aktivierung fehlgeschlagen: ' + e.message);
        }
        _updatePushUI('error');
    } finally {
        if (btn) { btn.disabled = false; }
    }
}

async function unsubscribePush() {
    try {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
        _pushSubscribed = false;
        _updatePushUI('unsubscribed');
        showToast('🔕 Push-Benachrichtigungen deaktiviert');
    } catch(e) {
        alert('Fehler: ' + e.message);
    }
}

async function sendTestPush() {
    try {
        await api.request('/push/test', 'POST');
        showToast('📨 Test-Benachrichtigung gesendet!');
    } catch(e) {
        alert('Fehler: ' + e.message);
    }
}

function _updatePushUI(status) {
    var container = document.getElementById('push-status');
    if (!container) return;

    var html = '';
    if (status === 'unsupported') {
        html = '<div style="color:#888;font-size:0.85rem;">⚠️ Web Push wird in diesem Browser nicht unterstützt. Bitte Chrome auf Android verwenden.</div>';
    } else if (status === 'subscribed') {
        html = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<span style="color:#4ade80;font-size:0.875rem;">✅ Benachrichtigungen aktiv</span>' +
            '<button onclick="sendTestPush()" class="btn btn-secondary btn-sm">📨 Test senden</button>' +
            '<button onclick="unsubscribePush()" class="btn btn-danger btn-sm">Deaktivieren</button>' +
            '</div>';
    } else if (status === 'unsubscribed') {
        html = '<div>' +
            '<p style="color:#94a3b8;font-size:0.85rem;margin-bottom:8px;">Erhalte Benachrichtigungen wenn Kunden schreiben — auch wenn das Dashboard geschlossen ist.</p>' +
            '<button id="push-subscribe-btn" onclick="subscribePush()" class="btn btn-success">🔔 Benachrichtigungen aktivieren</button>' +
            '</div>';
    } else {
        html = '<div style="color:#ef4444;font-size:0.85rem;">❌ Fehler beim Laden. Seite neu laden und erneut versuchen.</div>';
    }
    container.innerHTML = html;
}

function _urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}



// ── Manueller Hard-Refresh ────────────────────────────────────────────────────
async function hardRefresh() {
    var btn = document.getElementById('refresh-btn');
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    api.invalidate(); // Gesamten Cache leeren
    try {
        await Promise.all([updateStats(), loadChats()]);
        // Aktive Sektion auch aktualisieren
        var active = document.querySelector('.app-section[style*="block"], .app-section[style*="flex"]');
        if (active) {
            var id = active.id.replace('-section','');
            if (id === 'learning')  _safeRun(loadLearningQueue);
            if (id === 'knowledge') { _safeRun(loadKbCategories); _safeRun(loadKbEntries); }
            if (id === 'security')  { _safeRun(loadFlaggedChats); _safeRun(loadBlacklist); }
    if (id === 'traffic')   {
        _safeRun(function() { return loadTraffic('week'); });
        _safeRun(loadLiveVisitors);
        _safeRun(loadActivityFeed);
        // Alle 15s live aktualisieren
        clearInterval(_liveInterval);
        _liveInterval = setInterval(function() {
            _safeRun(loadLiveVisitors);
        }, 15000);
    } else {
        clearInterval(_liveInterval);
    }
            if (id === 'settings')  { _safeRun(loadSettings); _safeRun(loadChannels); }
        }
        showToast('✅ Daten aktualisiert');
    } catch(e) {
        showToast('❌ Refresh fehlgeschlagen: ' + e.message);
    } finally {
        if (btn) { btn.textContent = '↺'; btn.disabled = false; }
    }
}


async function lookupIp() {
    var ip = (document.getElementById('ip-lookup-input')?.value || '').trim();
    if (!ip) return alert('IP-Adresse eingeben');
    var result = document.getElementById('ip-lookup-result');
    if (result) result.innerHTML = '<p style="color:#888;padding:8px;">Suche...</p>';
    try {
        var data = await api.request('/visitors/ip/' + encodeURIComponent(ip));
        if (!data) { result.innerHTML = '<p style="color:#666;">Kein Ergebnis</p>'; return; }
        var banBtn = data.isBanned
            ? '<span style="color:#4ade80;font-size:0.85rem;">Bereits gebannt</span>'
            : '<button onclick="banIpFromLookup(\'' + esc(ip) + '\')" class="btn btn-danger btn-sm">Bannen</button>';
        result.innerHTML = '<div class="card" style="margin-top:10px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
                '<span style="font-weight:700;">' + esc(ip) + '</span>' + banBtn +
            '</div>' +
            '<div style="font-size:0.8rem;color:#94a3b8;margin-bottom:8px;">' +
                'Erster Besuch: ' + (data.summary.firstSeen ? new Date(data.summary.firstSeen).toLocaleString('de-DE') : '-') + '<br>' +
                'Letzter Besuch: ' + (data.summary.lastSeen ? new Date(data.summary.lastSeen).toLocaleString('de-DE') : '-') + '<br>' +
                'Seiten besucht: ' + (data.summary.pageCount || 0) + '<br>' +
                'Chat-ID: ' + esc(data.chatId || '-') +
            '</div>' +
            (data.activities?.length ? '<div style="font-size:0.8rem;font-weight:600;margin-bottom:4px;">Aktivitäten:</div>' +
                '<div style="max-height:150px;overflow-y:auto;font-size:0.75rem;color:#94a3b8;">' +
                data.activities.map(function(a) {
                    return '<div style="padding:2px 0;">' + new Date(a.created_at).toLocaleString('de-DE') + ' - ' + esc(a.activity) + '</div>';
                }).join('') + '</div>' : '') +
            '</div>';
    } catch(e) { if (result) result.innerHTML = '<p style="color:#ef4444;">' + esc(e.message) + '</p>'; }
}

async function banIpFromLookup(ip) {
    var reason = prompt('Bann-Grund:') || 'IP-Bann';
    if (reason === null) return;
    try {
        await api.request('/visitors/ip/' + encodeURIComponent(ip) + '/ban', 'POST', { reason });
        showToast('Gebannt: ' + ip);
        lookupIp();
        loadBlacklist();
    } catch(e) { alert('Fehler: ' + e.message); }
}


// ── Widget Settings & Embed Codes ────────────────────────────────────────────

var _widgetBaseUrl = window.location.origin; // auto-detect from dashboard

function initWidgetTab() {
    var base = _widgetBaseUrl;
    var scriptUrl = base + '/widget.js';

    // Standard embed
    var standard = '<script src="' + scriptUrl + '"><\/script>';
    var el = document.getElementById('embed-standard');
    if (el) el.value = standard;

    // Async embed
    var async_code = [
        '<script>',
        '  (function() {',
        '    var s = document.createElement("script");',
        '    s.src = "' + scriptUrl + '";',
        '    s.async = true;',
        '    document.head.appendChild(s);',
        '  })();',
        '<\/script>'
    ].join('\n');
    var el2 = document.getElementById('embed-async');
    if (el2) el2.value = async_code;

    // GTM embed
    var gtm_code = [
        '<script>',
        '  var s = document.createElement("script");',
        '  s.src = "' + scriptUrl + '";',
        '  document.head.appendChild(s);',
        '<\/script>'
    ].join('\n');
    var el3 = document.getElementById('embed-gtm');
    if (el3) el3.value = gtm_code;

    // Color picker preview
    var colorInput = document.getElementById('widget-color');
    var colorVal   = document.getElementById('widget-color-val');
    if (colorInput) {
        colorInput.addEventListener('input', function() {
            if (colorVal) colorVal.textContent = this.value;
        });
    }
}

function copyEmbed(elementId) {
    var el = document.getElementById(elementId);
    if (!el) return;
    el.select();
    try {
        document.execCommand('copy');
        showToast('✅ Code kopiert!');
    } catch(e) {
        // Fallback
        navigator.clipboard.writeText(el.value).then(function() {
            showToast('✅ Code kopiert!');
        }).catch(function() {
            showToast('Bitte manuell kopieren (Strg+C)');
        });
    }
}


// ── Traffic Dashboard ─────────────────────────────────────────────────────────
var _trafficChart = null;
var _trafficRange = 'week';

async function loadTraffic(range) {
    range = range || _trafficRange;
    _trafficRange = range;

    // Toggle button styles
    var wb = document.getElementById('traffic-btn-week');
    var mb = document.getElementById('traffic-btn-month');
    if (wb) { wb.className = range === 'week' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'; }
    if (mb) { mb.className = range === 'month' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'; }

    var title = document.getElementById('traffic-chart-title');
    if (title) title.textContent = 'Besucher & Chats – ' + (range === 'week' ? '7 Tage' : '30 Tage');

    try {
        var data = await api.request('/traffic?range=' + range);
        if (!data) return;

        // Update totals
        var sv = function(id,v) { var e=document.getElementById(id); if(e) e.textContent=v; };
        sv('t-visitors',  data.totals?.visitors  || 0);
        sv('t-pageviews', data.totals?.pageviews  || 0);
        sv('t-wchats',    data.totals?.widgetChats || 0);
        sv('t-tchats',    data.totals?.telegramChats || 0);

        // Chart
        var days      = data.days || [];
        var labels    = days.map(function(d) { return d.label || d.date || ''; });
        var visitors  = days.map(function(d) { return d.sessions  || 0; });
        var chats     = days.map(function(d) { return d.chats     || 0; });
        var pageviews = days.map(function(d) { return d.pageviews || 0; });

        drawTrafficChart(labels, visitors, chats, pageviews);
    } catch(e) {
        console.warn('[Traffic]', e.message);
    }
}

function drawTrafficChart(labels, visitors, chats, pageviews) {
    var canvas = document.getElementById('traffic-chart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');

    // Modern canvas chart with gradient fill
    var W = canvas.offsetWidth || 340;
    var H = 220;
    canvas.width  = W * (window.devicePixelRatio || 1);
    canvas.height = H * (window.devicePixelRatio || 1);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    var pad = { t:16, r:12, b:36, l:36 };
    var cW  = W - pad.l - pad.r;
    var cH  = H - pad.t - pad.b;
    var n   = labels.length;
    if (n === 0) return;
    var step = n > 1 ? cW / (n - 1) : cW;

    var allVals = visitors.concat(chats).concat(pageviews);
    var maxVal  = Math.max.apply(null, allVals.concat([1]));
    var yScale  = function(v) { return pad.t + cH - (v / maxVal) * cH; };
    var xAt     = function(i) { return pad.l + i * step; };

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    // Horizontal grid
    var gridCount = 4;
    for (var g = 0; g <= gridCount; g++) {
        var gy = pad.t + (g / gridCount) * cH;
        ctx.strokeStyle = g === gridCount ? '#1e3a5f' : '#121f2e';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cW, gy); ctx.stroke();
        var val = Math.round(maxVal * (1 - g / gridCount));
        if (val > 0 || g === gridCount) {
            ctx.fillStyle = '#3d5168'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
            ctx.fillText(val, pad.l - 6, gy + 4);
        }
    }

    // Draw filled line series
    function drawSeries(data, lineColor, fillColor) {
        if (!data.some(function(v){ return v > 0; })) return;
        // Filled area
        var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + cH);
        grad.addColorStop(0, fillColor); grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.moveTo(xAt(0), yScale(data[0]));
        for (var i = 1; i < data.length; i++) ctx.lineTo(xAt(i), yScale(data[i]));
        ctx.lineTo(xAt(data.length-1), pad.t + cH);
        ctx.lineTo(xAt(0), pad.t + cH); ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();
        // Line
        ctx.beginPath(); ctx.strokeStyle = lineColor; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
        ctx.moveTo(xAt(0), yScale(data[0]));
        for (var j = 1; j < data.length; j++) ctx.lineTo(xAt(j), yScale(data[j]));
        ctx.stroke();
        // Dots for non-zero
        data.forEach(function(v, idx) {
            if (v === 0) return;
            ctx.beginPath(); ctx.fillStyle = lineColor;
            ctx.arc(xAt(idx), yScale(v), 4, 0, Math.PI*2); ctx.fill();
        });
    }

    drawSeries(pageviews, '#3b82f6', 'rgba(59,130,246,0.18)');
    drawSeries(visitors,  '#10b981', 'rgba(16,185,129,0.15)');
    drawSeries(chats,     '#f59e0b', 'rgba(245,158,11,0.15)');

    // X labels
    var skip = n > 20 ? 4 : n > 10 ? 2 : 1;
    ctx.fillStyle = '#4a5568'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    for (var xi = 0; xi < n; xi++) {
        if (xi % skip === 0) ctx.fillText(labels[xi], xAt(xi), H - 8);
    }

    // Legend
    var legend = document.getElementById('traffic-legend');
    if (legend) legend.innerHTML =
        '<span style="color:#3b82f6">● Seitenaufrufe</span>' +
        '<span style="color:#10b981">● Besucher</span>' +
        '<span style="color:#f59e0b">● Chats</span>';
}


// ── Live Visitors ─────────────────────────────────────────────────────────────
var _liveInterval = null;

async function loadLiveVisitors() {
    try {
        var data = await fetch('/api/admin/traffic/live', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '') }
        }).then(function(r){ return r.json(); });

        var countEl = document.getElementById('live-count');
        if (countEl) countEl.textContent = (data.live || 0) + ' online';

        var listEl = document.getElementById('live-visitors-list');
        if (!listEl) return;

        if (!data.visitors?.length) {
            listEl.innerHTML = '<p style="color:#555;font-size:0.82rem;padding:4px;">Keine aktiven Besucher gerade.</p>';
            return;
        }

        listEl.innerHTML = data.visitors.map(function(v) {
            var ago = Math.round((Date.now() - new Date(v.lastSeen)) / 1000);
            var agoStr = ago < 60 ? ago + 's' : Math.round(ago/60) + 'min';
            var ua = (v.userAgent || '').toLowerCase();
            var device = ua.includes('mobile') ? '📱' : (ua.includes('tablet') ? '📲' : '🖥️');
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #1a1a1a;">' +
                '<span style="font-size:1.1rem;">' + device + '</span>' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-size:0.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(v.currentPage) + '</div>' +
                    '<div style="font-size:0.7rem;color:#555;">' + agoStr + ' ago · ' + v.pageCount + ' Seiten</div>' +
                '</div>' +
                '<button onclick="showChatById(\'' + esc(v.chatId) + '\')" class="btn btn-secondary btn-sm" style="font-size:0.7rem;padding:2px 8px;">Chat</button>' +
            '</div>';
        }).join('');
    } catch(e) {
        var listEl = document.getElementById('live-visitors-list');
        if (listEl) listEl.innerHTML = '<p style="color:#555;font-size:0.82rem;">Keine Daten.</p>';
    }
}

async function loadActivityFeed() {
    try {
        var data = await fetch('/api/admin/visitors', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '') }
        }).then(function(r){ return r.json(); });

        var el = document.getElementById('activity-feed');
        if (!el) return;
        if (!data?.length) { el.innerHTML = '<p style="color:#555;">Keine Aktivitäten.</p>'; return; }

        el.innerHTML = data.slice(0, 20).map(function(v) {
            var dt = v.last_seen ? new Date(v.last_seen).toLocaleString('de-DE', {hour:'2-digit',minute:'2-digit'}) : '';
            return '<div style="padding:4px 0;border-bottom:1px solid #1a1a1a;display:flex;gap:8px;align-items:center;">' +
                '<span style="font-size:0.72rem;color:#555;white-space:nowrap;">' + dt + '</span>' +
                '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📍 ' + esc((v.user_agent||'Unbekannt').substring(0,40)) + '</span>' +
                '<span style="font-size:0.7rem;color:#64748b;">' + (v.page_count||0) + ' S.</span>' +
            '</div>';
        }).join('');
    } catch(e) {}
}

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showChatById(chatId) {
    if (!chatId) return;
    showSection('chats');
    // Find and click the chat
    setTimeout(function() {
        var items = document.querySelectorAll('.chat-item');
        items.forEach(function(item) {
            if (item.dataset.chatId === chatId) item.click();
        });
    }, 300);
}


// ── Coupon Management ─────────────────────────────────────────────────────────

async function loadActiveCoupon() {
    var el = document.getElementById('active-coupon-display');
    try {
        var data = await api.request('/coupons/active');
        if (!el) return;
        if (!data || !data.code) {
            el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Kein aktiver Coupon.</p>';
            return;
        }
        var exp = data.expires_at ? new Date(data.expires_at).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '–';
        el.innerHTML =
            '<div style="background:#052e16;border:1px solid #14532d;border-radius:8px;padding:12px;">' +
            '<div style="font-size:1.6rem;font-weight:900;letter-spacing:4px;color:#4ade80;font-family:monospace;">' + esc(data.code) + '</div>' +
            '<div style="font-size:0.875rem;color:#86efac;margin-top:4px;">' + esc(data.description || '') + '</div>' +
            '<div style="font-size:0.75rem;color:#555;margin-top:6px;">Gültig bis: ' + exp + '</div>' +
            '</div>';
    } catch(e) {
        if (el) el.innerHTML = '<p style="color:#ef4444;font-size:0.82rem;">' + esc(e.message) + '</p>';
    }
}

async function createCouponNow() {
    var btn = event.target;
    btn.disabled = true; btn.textContent = '⏳ Erstelle...';
    try {
        var data = await api.request('/coupons/create-now', 'POST');
        if (data.success) {
            showToast('✅ Coupon erstellt: ' + data.coupon.code);
            loadActiveCoupon();
        }
    } catch(e) {
        alert('Fehler: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '⚡ Jetzt neuen Coupon erstellen';
    }
}

var WOCHENTAGE_KURZ = ['Mo','Di','Mi','Do','Fr','Sa','So'];

async function loadCouponHistory() {
    var card = document.getElementById('coupon-history-card');
    var list = document.getElementById('coupon-history-list');
    if (!card || !list) return;
    card.style.display = 'block';
    try {
        var data = await api.request('/coupons/history');
        if (!data || !data.length) { list.innerHTML = '<p style="color:#555;font-size:0.85rem;">Kein Verlauf.</p>'; return; }

        // Group by weekday for summary row
        var byDay = {};
        data.forEach(function(row) {
            var d = (row.weekday !== null && row.weekday !== undefined) ? row.weekday : -1;
            if (!byDay[d]) byDay[d] = { calls: 0, count: 0, day: d };
            byDay[d].calls += (row.ki_call_count || 0);
            byDay[d].count++;
        });

        var summaryHtml = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:12px;">';
        for (var dd = 0; dd < 7; dd++) {
            var entry = byDay[dd] || { calls: 0, count: 0 };
            var isToday = ((new Date().getDay()||7)-1) === dd;
            summaryHtml += '<div style="background:#111;border-radius:6px;padding:6px 4px;text-align:center;border:1px solid ' + (isToday ? '#2563eb' : '#1e1e1e') + ';">' +
                '<div style="font-size:0.72rem;color:#64748b;margin-bottom:2px;">' + WOCHENTAGE_KURZ[dd] + '</div>' +
                '<div style="font-size:1rem;font-weight:700;color:#4ade80;">' + entry.calls + '</div>' +
                '<div style="font-size:0.62rem;color:#555;">KI-Aufrufe</div>' +
            '</div>';
        }
        summaryHtml += '</div>';

        // Individual entries (simplified)
        var rowsHtml = data.slice(0, 14).map(function(row) {
            var dt      = new Date(row.created_at).toLocaleString('de-DE',{day:'2-digit',month:'2-digit'});
            var dayName = row.weekday !== null ? (WOCHENTAGE_KURZ[row.weekday] || '?') : '?';
            var active  = row.is_active;
            var disc    = (row.discount || 0) + (row.type === 'percentage' ? '%' : '€');
            return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #1a1a1a;">' +
                '<span style="background:#1a1a1a;color:#94a3b8;padding:2px 7px;border-radius:5px;font-size:0.72rem;font-weight:700;min-width:28px;text-align:center;">' + dayName + '</span>' +
                '<span style="font-family:monospace;font-size:0.8rem;color:' + (active ? '#4ade80' : '#555') + ';flex:1;">' + esc(row.code || '') + '</span>' +
                '<span style="font-size:0.78rem;color:#60a5fa;">' + disc + '</span>' +
                '<span style="font-size:0.72rem;color:#f59e0b;white-space:nowrap;">🤖 ' + (row.ki_call_count || 0) + 'x</span>' +
                '<span style="font-size:0.68rem;color:#555;">' + dt + '</span>' +
            '</div>';
        }).join('');

        list.innerHTML = summaryHtml + rowsHtml;
    } catch(e) { list.innerHTML = '<p style="color:#ef4444;">' + esc(e.message) + '</p>'; }
}


// ── Wochenplan ────────────────────────────────────────────────────────────────

var WEEKDAYS = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
var _weekSchedule = [];

async function loadWeekSchedule() {
    var el = document.getElementById('week-schedule-list');
    if (!el) return;
    try {
        var data = await fetch('/api/admin/coupons/schedule', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token')||'') }
        }).then(function(r){ return r.json(); });

        _weekSchedule = data || [];

        // Fill missing days with defaults
        for (var d = 0; d < 7; d++) {
            if (!_weekSchedule.find(function(s){ return s.weekday === d; })) {
                _weekSchedule.push({ weekday: d, enabled: true, discount: 10, type: 'percentage', description: '' });
            }
        }
        _weekSchedule.sort(function(a,b){ return a.weekday - b.weekday; });
        renderWeekSchedule();
    } catch(e) {
        if (el) el.innerHTML = '<p style="color:#ef4444;">' + esc(e.message) + '</p>';
    }
}


function renderWeekSchedule() {
    var el = document.getElementById('week-schedule-list');
    if (!el) return;
    var jsDay = new Date().getDay();
    var today = jsDay === 0 ? 6 : jsDay - 1;
    el.innerHTML = '';

    _weekSchedule.forEach(function(s) {
        var isToday = s.weekday === today;
        var row = document.createElement('div');
        row.style.cssText = 'background:#111;border-radius:8px;padding:12px;margin-bottom:8px;border:1px solid ' + (isToday ? '#2563eb' : '#1e1e1e') + ';';

        var top = document.createElement('div');
        top.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:nowrap;';

        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = (s.enabled !== false);
        cb.style.cssText = 'width:18px;height:18px;cursor:pointer;flex-shrink:0;';
        cb.onchange = (function(day){ return function(){ _updateScheduleField(day, 'enabled', this.checked); }; })(s.weekday);

        var daySpan = document.createElement('span');
        daySpan.style.cssText = 'font-weight:700;font-size:0.9rem;flex:1;' + (isToday ? 'color:#60a5fa;' : '');
        daySpan.textContent = WEEKDAYS[s.weekday] + (isToday ? ' ← heute' : '');

        var discInp = document.createElement('input');
        discInp.type = 'number'; discInp.min = 1; discInp.max = 99; discInp.value = (s.discount || 10);
        discInp.style.cssText = 'width:56px;padding:5px 6px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.875rem;text-align:center;';
        discInp.onchange = (function(day){ return function(){ _updateScheduleField(day, 'discount', +this.value); }; })(s.weekday);

        var typeEl = document.createElement('select');
        typeEl.style.cssText = 'padding:5px 6px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;';
        var optP = document.createElement('option'); optP.value = 'percentage'; optP.textContent = '%';
        var optF = document.createElement('option'); optF.value = 'fixed';      optF.textContent = '€';
        if (s.type === 'fixed') optF.selected = true; else optP.selected = true;
        typeEl.appendChild(optP); typeEl.appendChild(optF);
        typeEl.onchange = (function(day){ return function(){ _updateScheduleField(day, 'type', this.value); }; })(s.weekday);

        top.appendChild(cb); top.appendChild(daySpan); top.appendChild(discInp); top.appendChild(typeEl);

        var descInp = document.createElement('input');
        descInp.type = 'text'; descInp.placeholder = 'Beschreibung für KI...';
        descInp.value = s.description || '';
        descInp.style.cssText = 'width:100%;padding:6px 10px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;';
        descInp.oninput = (function(day){ return function(){ _updateScheduleField(day, 'description', this.value); }; })(s.weekday);

        row.appendChild(top); row.appendChild(descInp);
        el.appendChild(row);
    });
}

function _updateScheduleField(weekday, field, value) {
    var entry = _weekSchedule.find(function(s){ return s.weekday === weekday; });
    if (entry) entry[field] = value;
}

async function saveWeekSchedule() {
    var btn = document.querySelector('button[onclick="saveWeekSchedule()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Speichert...'; }
    try {
        await fetch('/api/admin/coupons/schedule', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('admin_token')||'')
            },
            body: JSON.stringify({ schedule: _weekSchedule })
        });
        showToast('✅ Wochenplan gespeichert!');
    } catch(e) {
        alert('Fehler: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '💾 Wochenplan speichern'; }
    }
}

function showToast(msg) {
    var t = document.getElementById('_toast');
    if (!t) {
        t = document.createElement('div');
        t.id = '_toast';
        t.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:11px 18px;border-radius:9px;' +
            'z-index:99999;font-weight:600;font-size:0.875rem;box-shadow:0 8px 24px rgba(0,0,0,0.5);' +
            'transition:opacity 0.3s;pointer-events:none;color:#fff;';
        document.body.appendChild(t);
    }
    t.style.background = msg.startsWith('✅') ? '#15803d' : (msg.startsWith('🗑') ? '#374151' : '#991b1b');
    t.textContent      = msg;
    t.style.opacity    = '1';
    clearTimeout(t._t);
    t._t = setTimeout(function() { t.style.opacity = '0'; }, 3500);
}
