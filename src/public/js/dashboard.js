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

    // Intervalle
    clearInterval(window._statsInterval);
    clearInterval(window._chatsInterval);
    window._statsInterval = setInterval(function() { _safeRun(updateStats); }, 30000);
    window._chatsInterval = setInterval(function() {
        _safeRun(loadChats);
        if (_currentChat) _safeRun(refreshMessages);
    }, 8000);
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
        sv('s-cost',     d.stats.totalCost);
        sv('s-tokens',   (d.stats.totalTokens||0).toLocaleString() + ' Token');
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
        var data = await api.getChatMessages(chatId);
        var info = data.chat_info || {};
        var name = info.first_name || info.username || chatId.substring(0, 16);
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
        var data = await api.getChatMessages(_currentChat);
        if (!data) return; // Server nicht erreichbar - Nachrichten nicht leeren
        var area = document.getElementById('msg-' + _currentChat);
        if (!area) return;
        var atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
        area.innerHTML = renderMsgs(data.messages || []);
        if (atBottom) scrollBottom('msg-' + _currentChat);
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
            return '<div class="kb-entry">' +
                '<div class="kb-entry-body">' +
                    catPill +
                    '<div class="kb-entry-title">' + esc(e.title || '(kein Titel)') + '</div>' +
                    '<div class="kb-entry-preview">' + esc(e.content_preview) + '</div>' +
                    '<div class="kb-entry-meta"><span>' + esc(e.source) + '</span><span>·</span><span>' + new Date(e.created_at).toLocaleDateString('de-DE') + '</span></div>' +
                '</div>' +
                '<button onclick="delKbEntry(\'' + e.id + '\')" class="icon-btn" style="flex-shrink:0;" title="Löschen">🗑</button>' +
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
        widget_powered_by:   gv('widget-powered-by')
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
        _safeRun(loadSessions);
        // Alle 15s live aktualisieren
        clearInterval(_liveInterval);
        _liveInterval = setInterval(function() {
            _safeRun(loadLiveVisitors);
        }, 15000);
    } else {
        clearInterval(_liveInterval);
    }
            if (id === 'settings')  _safeRun(loadSettings);
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

    // Button states
    ['24h','week','month'].forEach(function(r) {
        var btn = document.getElementById('traffic-btn-' + r);
        if (btn) btn.className = range === r ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
    });

    var labels = { '24h': '24 Stunden', 'week': '7 Tage', 'month': '30 Tage' };
    var title = document.getElementById('traffic-chart-title');
    if (title) title.textContent = 'Sessions & Chats – ' + (labels[range] || '7 Tage');

    try {
        var data = await fetch('/api/admin/traffic?range=' + range, {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token')||'') }
        }).then(function(r){ return r.json(); });
        if (!data) return;

        var sv = function(id,v) { var e=document.getElementById(id); if(e) e.textContent=v; };
        sv('t-visitors',  data.totals?.sessions     || 0);
        sv('t-pageviews', data.totals?.pageviews     || 0);
        sv('t-wchats',    data.totals?.widgetChats   || 0);
        sv('t-tchats',    data.totals?.telegramChats || 0);

        var days     = data.days || [];
        var lbls     = days.map(function(d) { return d.label || d.date || ''; });
        var sessions  = days.map(function(d) { return d.sessions || 0; });
        var chats     = days.map(function(d) { return d.chats    || 0; });
        var pageviews = days.map(function(d) { return d.pageviews|| 0; });

        drawTrafficChart(lbls, sessions, chats, pageviews);
    } catch(e) {
        console.warn('[Traffic]', e.message);
    }
}

function drawTrafficChart(labels, visitors, chats, pageviews) {
    var canvas = document.getElementById('traffic-chart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');

    // Destroy old chart
    if (_trafficChart) { _trafficChart.destroy(); _trafficChart = null; }

    // Simple canvas chart (no external lib needed)
    var allVals = visitors.concat(chats).concat(pageviews);
    var maxVal  = Math.max.apply(null, allVals) || 1;
    var W = canvas.offsetWidth || 340;
    var H = 200;
    canvas.width  = W;
    canvas.height = H;

    var pad = { t:10, r:10, b:30, l:30 };
    var cW  = W - pad.l - pad.r;
    var cH  = H - pad.t - pad.b;
    var n   = labels.length;
    var step = n > 1 ? cW / (n - 1) : cW;

    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = '#1e2d3d'; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
        var y = pad.t + cH - (g / 4) * cH;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cW, y); ctx.stroke();
        ctx.fillStyle = '#4a5568'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
        ctx.fillText(Math.round((g / 4) * maxVal), pad.l - 4, y + 4);
    }

    // X labels (every nth)
    var skip = n > 14 ? 3 : (n > 7 ? 2 : 1);
    ctx.fillStyle = '#4a5568'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    for (var i = 0; i < n; i++) {
        if (i % skip === 0) {
            var x = pad.l + i * step;
            ctx.fillText(labels[i], x, H - 4);
        }
    }

    // Draw a line series
    function drawLine(data, color) {
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
        ctx.beginPath();
        for (var k = 0; k < data.length; k++) {
            var px = pad.l + k * step;
            var py = pad.t + cH - (data[k] / maxVal) * cH;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        // Dots
        ctx.fillStyle = color;
        for (var k2 = 0; k2 < data.length; k2++) {
            var px2 = pad.l + k2 * step;
            var py2 = pad.t + cH - (data[k2] / maxVal) * cH;
            ctx.beginPath(); ctx.arc(px2, py2, 3, 0, Math.PI*2); ctx.fill();
        }
    }

    drawLine(pageviews, '#3b82f6');
    drawLine(visitors,  '#10b981');
    drawLine(chats,     '#f59e0b');

    // Legend
    var legend = document.getElementById('traffic-legend');
    if (legend) legend.innerHTML =
        '<span style="color:#3b82f6">● Seitenaufrufe</span>' +
        '<span style="color:#10b981">● Besucher</span>' +
        '<span style="color:#f59e0b">● Chats</span>';
}


// ── Live Visitors ─────────────────────────────────────────────────────────────
var _liveInterval = null;

var _selectedVisitor = null;

async function loadLiveVisitors() {
    try {
        var data = await fetch('/api/admin/traffic/live', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '') }
        }).then(function(r){ return r.json(); });

        var countEl = document.getElementById('live-count');
        if (countEl) {
            countEl.textContent = (data.live || 0) + ' online';
            countEl.style.background = data.live > 0 ? '#14532d' : '#1e3a5f';
            countEl.style.color      = data.live > 0 ? '#4ade80' : '#60a5fa';
        }

        var listEl = document.getElementById('live-visitors-list');
        if (!listEl) return;

        if (!data.visitors || !data.visitors.length) {
            listEl.innerHTML = '<p style="color:#555;font-size:0.82rem;padding:8px;">Keine aktiven Besucher in den letzten 15 Minuten.</p>';
            return;
        }

        listEl.innerHTML = data.visitors.map(function(v) {
            var ago = Math.round((Date.now() - new Date(v.lastSeen)) / 1000);
            var agoStr = ago < 60 ? ago + 's' : ago < 3600 ? Math.round(ago/60) + 'min' : Math.round(ago/3600) + 'h';
            var isRecent = ago < 180;
            var dotColor = isRecent ? '#4ade80' : '#f59e0b';
            var dotAnim  = isRecent ? 'animation:vspulse 2s infinite' : '';
            var chatBadge = v.hadChat ? '<span style="font-size:0.65rem;background:#1e3a5f;color:#60a5fa;padding:1px 5px;border-radius:4px;margin-left:4px;">💬</span>' : '';
            var shortId = (v.chatId || '').substring(0, 14) + '…';
            var sid = esc(v.sessionId || '');
            var cid = v.chatId || '';
            var cp  = v.currentPage || '?';
            var safeClick = 'openVisitorDetail(this.getAttribute(\'data-cid\'),this.getAttribute(\'data-sid\'),this.getAttribute(\'data-cp\'))';
            return '<div data-cid="' + esc(cid) + '" data-sid="' + esc(sid) + '" data-cp="' + esc(cp) + '" onclick="' + safeClick + '" ' +
                'style="display:flex;align-items:center;gap:9px;padding:10px;border-radius:8px;background:#111;margin-bottom:6px;cursor:pointer;">' +
                '<span style="width:10px;height:10px;border-radius:50%;background:' + dotColor + ';display:inline-block;flex-shrink:0;' + dotAnim + ';"></span>' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-size:0.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + cp + chatBadge + '</div>' +
                    '<div style="font-size:0.72rem;color:#64748b;margin-top:2px;">' + shortId + ' · ' + agoStr + ' · ' + (v.pageCount || 1) + ' Seiten</div>' +
                '</div>' +
                '<span style="color:#64748b;font-size:0.8rem;">›</span>' +
            '</div>';
        }).join('');
    } catch(e) {
        var listEl = document.getElementById('live-visitors-list');
        if (listEl) listEl.innerHTML = '<p style="color:#ef4444;font-size:0.82rem;">' + esc(e.message) + '</p>';
    }
}

async function openVisitorDetail(chatId, sessionId, currentPage) {
    _selectedVisitor = { chatId: chatId, sessionId: sessionId };
    var panel = document.getElementById('visitor-detail-panel');
    if (!panel) return;
    panel.style.display = 'block';

    var titleEl = document.getElementById('visitor-detail-title');
    if (titleEl) titleEl.textContent = currentPage || chatId.substring(0, 20);
    var idEl = document.getElementById('visitor-detail-id');
    if (idEl) idEl.textContent = chatId;

    var actEl = document.getElementById('visitor-detail-acts');
    if (actEl) actEl.innerHTML = '<p style="color:#555;font-size:0.82rem;">Lädt...</p>';

    try {
        var sessions = await fetch('/api/admin/traffic/sessions?limit=100', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token')||'') }
        }).then(function(r){ return r.json(); }).catch(function(){ return []; });

        var visitorSessions = (sessions || []).filter(function(s){ return s.chat_id === chatId; });

        if (!actEl) return;
        if (!visitorSessions.length) {
            actEl.innerHTML = '<p style="color:#555;font-size:0.82rem;">Keine Sessions gefunden.</p>';
            return;
        }

        actEl.innerHTML = visitorSessions.map(function(s) {
            var dt = new Date(s.started_at).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
            var ago = Math.round((Date.now() - new Date(s.last_seen)) / 1000);
            var agoStr = ago < 60 ? ago+'s' : ago < 3600 ? Math.round(ago/60)+'min' : Math.round(ago/3600)+'h';
            var dot = '<span style="width:8px;height:8px;border-radius:50%;background:' + (s.is_active ? '#4ade80' : '#555') + ';display:inline-block;margin-right:5px;flex-shrink:0;"></span>';
            return '<div style="padding:10px;background:#111;border-radius:8px;margin-bottom:6px;">' +
                '<div style="font-size:0.85rem;font-weight:600;display:flex;align-items:center;margin-bottom:4px;">' + dot + esc(s.entry_page || '?') + '</div>' +
                '<div style="font-size:0.75rem;color:#64748b;">' +
                    dt + ' · ' + (s.page_count || 1) + ' Seiten' +
                    (s.had_chat ? ' · <span style="color:#60a5fa;">💬 Chat</span>' : '') +
                    ' · ' + agoStr + ' ago' +
                '</div>' +
                (s.last_page && s.last_page !== s.entry_page ? '<div style="font-size:0.72rem;color:#555;margin-top:2px;">→ ' + esc(s.last_page) + '</div>' : '') +
            '</div>';
        }).join('');
    } catch(e) {
        if (actEl) actEl.innerHTML = '<p style="color:#ef4444;font-size:0.8rem;">' + esc(e.message) + '</p>';
    }
}

function closeVisitorDetail() {
    var panel = document.getElementById('visitor-detail-panel');
    if (panel) panel.style.display = 'none';
    _selectedVisitor = null;
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


async function loadSessions() {
    var el = document.getElementById('sessions-list');
    if (!el) return;
    try {
        var data = await fetch('/api/admin/traffic/sessions?limit=30', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token')||'') }
        }).then(function(r){ return r.json(); });

        if (!data?.length) { el.innerHTML = '<p style="color:#555;font-size:0.82rem;">Keine Sessions.</p>'; return; }

        el.innerHTML = data.map(function(s) {
            var started = new Date(s.started_at).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
            var ago = Math.round((Date.now() - new Date(s.last_seen)) / 1000);
            var agoStr = ago < 60 ? ago+'s' : ago < 3600 ? Math.round(ago/60)+'min' : Math.round(ago/3600)+'h';
            var statusDot = s.is_active
                ? '<span style="width:8px;height:8px;border-radius:50%;background:#4caf50;display:inline-block;margin-right:4px;animation:vspulse 2s infinite"></span>'
                : '<span style="width:8px;height:8px;border-radius:50%;background:#888;display:inline-block;margin-right:4px;"></span>';
            return '<div style="padding:8px 0;border-bottom:1px solid #1a1a1a;display:flex;gap:8px;align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-size:0.82rem;font-weight:600;display:flex;align-items:center;gap:4px;">' + statusDot + esc(s.entry_page||'?') + '</div>' +
                    '<div style="font-size:0.72rem;color:#64748b;margin-top:1px;">' +
                        started + ' · ' + (s.page_count||0) + ' Seiten' +
                        (s.had_chat ? ' · <span style="color:#60a5fa">💬 Chat</span>' : '') +
                    '</div>' +
                    (s.last_page && s.last_page !== s.entry_page ? '<div style="font-size:0.7rem;color:#555;">→ '+esc(s.last_page)+'</div>' : '') +
                '</div>' +
                '<div style="font-size:0.7rem;color:#555;white-space:nowrap;">' + agoStr + '</div>' +
            '</div>';
        }).join('');
    } catch(e) { el.innerHTML = '<p style="color:#ef4444;font-size:0.8rem;">'+esc(e.message)+'</p>'; }
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
