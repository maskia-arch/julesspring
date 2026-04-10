// ── State ─────────────────────────────────────────────────────────────────────
var _allChats     = [];
var _currentChat  = null;
var _kbCatId      = null;
var _allKbCats    = [];

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    if (localStorage.getItem('admin_token')) initDashboard();
    setInterval(updateStats, 30000);
    setInterval(function() { if (_currentChat) refreshMessages(); }, 15000);
});

function initDashboard() {
    updateStats();
    loadChats();
    loadSettings();
    loadLearningQueue();
    loadBlacklist();
    // Push Notifications initialisieren
    setTimeout(initPushNotifications, 1500);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function updateStats() {
    try {
        var d = await api.getStats();
        if (!d || !d.stats) return; // Server nicht erreichbar - still bleiben
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
    } catch(e) { console.error('Stats Fehler:', e.message); }
}

// ── Chat List ─────────────────────────────────────────────────────────────────
async function loadChats() {
    var el = document.getElementById('chat-list');
    if (!el) return;
    try {
        var chats = await api.getChats();
        if (chats === null) return; // Netzwerkfehler - Liste nicht leeren
        _allChats = chats || [];
        renderChatList(_allChats);
    } catch(e) {
        if (el && el.children.length === 0) {
            el.innerHTML = '<p style="padding:1rem;color:#666;font-size:0.85rem;">Lade Chats...</p>';
        }
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
        rag_match_count:     parseInt(gv('rag-match-count'))  || 8
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
            alert('VAPID_PUBLIC_KEY fehlt in den Server-Einstellungen.
Bitte in Render.com Environment Variables setzen.');
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
