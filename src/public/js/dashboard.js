// ── Init ─────────────────────────────────────────────────────────────────────
let _allChats = [];
let _currentChatId = null;
let _allCategories = [];
let _currentKbCatId = null;

document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('admin_token')) initDashboard();
    setInterval(updateStats, 30000);
    setInterval(() => { if (_currentChatId) refreshCurrentChat(); }, 15000);
});

async function initDashboard() {
    await Promise.all([ updateStats(), loadChats(), loadSettings(), loadLearningQueue(), loadBlacklist() ]);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function updateStats() {
    try {
        const d = await api.getStats();
        const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        s('s-chats',     d.stats.totalChats);
        s('s-knowledge', d.stats.knowledgeEntries);
        s('s-cost',      d.stats.totalCost);
        s('version-tag', `v${d.version}`);
        const badge = document.getElementById('learning-badge');
        if (badge) { badge.textContent = d.stats.pendingLearning; badge.style.display = d.stats.pendingLearning > 0 ? 'inline-block' : 'none'; }
    } catch(e) { console.error('Stats:', e); }
}

// ── Chat List ─────────────────────────────────────────────────────────────────
async function loadChats() {
    const el = document.getElementById('chat-list');
    if (!el) return;
    try {
        _allChats = await api.getChats() || [];
        renderChatList(_allChats);
    } catch(e) { el.innerHTML = '<p style="padding:1rem;color:#666;font-size:0.85rem;">Ladefehler</p>'; }
}

function renderChatList(chats) {
    const el = document.getElementById('chat-list');
    if (!el) return;
    if (!chats?.length) {
        el.innerHTML = '<p style="padding:1.5rem;color:#555;font-size:0.85rem;text-align:center;">Noch keine Chats.<br>Wenn Kunden schreiben, erscheinen sie hier.</p>';
        return;
    }
    el.innerHTML = chats.map(c => {
        const name      = c.first_name || c.username || c.id.substring(0,12);
        const preview   = c.last_message ? truncate(c.last_message, 42) : 'Kein Inhalt';
        const roleIcon  = c.last_message_role === 'assistant' ? '🤖 ' : '';
        const time      = c.updated_at ? relativeTime(c.updated_at) : '';
        const platform  = c.platform || 'telegram';
        const avatarCls = platform === 'telegram' ? 'telegram-avatar' : 'web-avatar';
        const avatarTxt = platform === 'telegram' ? '✈️' : '🌐';
        const selected  = _currentChatId === c.id ? 'selected' : '';
        const manual    = c.is_manual_mode ? 'manual-active' : '';
        const modeBadge = c.is_manual_mode
            ? '<span class="chat-mode-badge badge-manual">MANUELL</span>'
            : '<span class="chat-mode-badge badge-ai">KI</span>';
        return `
            <div class="chat-item ${selected} ${manual}" onclick="selectChat('${esc(c.id)}')" data-chat-id="${esc(c.id)}">
                <div class="chat-avatar ${avatarCls}">${avatarTxt}</div>
                <div class="chat-item-body">
                    <div class="chat-item-top">
                        <span class="chat-item-name">${esc(name)}</span>
                        <span class="chat-item-time">${time}</span>
                    </div>
                    <div class="chat-item-preview">
                        <span class="preview-role">${roleIcon}</span>${esc(preview)}
                    </div>
                </div>
                ${modeBadge}
            </div>`;
    }).join('');
}

function filterChats(query) {
    if (!query) { renderChatList(_allChats); return; }
    const q = query.toLowerCase();
    renderChatList(_allChats.filter(c =>
        c.id.toLowerCase().includes(q) ||
        (c.first_name||'').toLowerCase().includes(q) ||
        (c.username||'').toLowerCase().includes(q) ||
        (c.last_message||'').toLowerCase().includes(q)
    ));
}

// ── Chat Window ───────────────────────────────────────────────────────────────
async function selectChat(chatId) {
    _currentChatId = chatId;
    // Aktiv markieren
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('selected'));
    document.querySelector(`.chat-item[data-chat-id="${chatId}"]`)?.classList.add('selected');

    const win = document.getElementById('chat-window');
    win.innerHTML = '<div class="chat-empty-state"><p style="color:#444;">Lädt…</p></div>';

    try {
        const data = await api.getChatMessages(chatId);
        const info = data.chat_info || {};
        const name = info.first_name || info.username || chatId.substring(0,14);

        win.innerHTML = `
            <div class="chat-window-header">
                <div class="chat-avatar ${info.platform==='telegram'?'telegram-avatar':'web-avatar'}" style="width:36px;height:36px;font-size:0.9rem;">
                    ${info.platform==='telegram'?'✈️':'🌐'}
                </div>
                <div class="chat-window-info">
                    <div class="chat-window-name">${esc(name)}</div>
                    <div class="chat-window-meta">${esc(chatId)} · ${info.platform||'telegram'}</div>
                </div>
                <div class="chat-window-actions">
                    <div class="toggle-wrap">
                        <span class="toggle-label" id="mode-label-${esc(chatId)}">${data.is_manual?'Manuell':'KI aktiv'}</span>
                        <label class="toggle">
                            <input type="checkbox" id="mode-${esc(chatId)}" ${data.is_manual?'checked':''}
                                   onchange="toggleChatStatus('${esc(chatId)}', this.checked)">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <button onclick="quickBan('${esc(chatId)}')" class="btn-danger" style="padding:6px 10px;font-size:0.75rem;">⛔</button>
                    <button onclick="loadChats()" class="icon-btn" title="Aktualisieren">↻</button>
                </div>
            </div>

            <div class="messages-area" id="msg-area-${esc(chatId)}">
                ${renderMessages(data.messages || [])}
            </div>

            <div class="chat-input-bar">
                <textarea id="reply-${esc(chatId)}" placeholder="Nachricht als Admin senden…" rows="1"
                    onkeydown="handleReplyKey(event,'${esc(chatId)}')"
                    oninput="autoResize(this)"></textarea>
                <button class="send-btn" onclick="sendAdminMessage('${esc(chatId)}')">➤</button>
            </div>`;

        // Scroll to bottom
        const area = document.getElementById(`msg-area-${chatId}`);
        if (area) area.scrollTop = area.scrollHeight;

    } catch(e) { win.innerHTML = `<div class="chat-empty-state"><p style="color:#ef4444;">Fehler: ${esc(e.message)}</p></div>`; }
}

function renderMessages(messages) {
    if (!messages.length) return '<p style="text-align:center;color:#444;padding:2rem;font-size:0.875rem;">Noch keine Nachrichten.</p>';

    let html = '';
    let lastDate = null;

    messages.forEach(m => {
        const date = new Date(m.created_at).toLocaleDateString('de-DE', { day:'2-digit', month:'short', year:'numeric' });
        if (date !== lastDate) {
            html += `<div class="date-sep">${date}</div>`;
            lastDate = date;
        }
        const time   = new Date(m.created_at).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
        const cls    = m.role + (m.is_manual ? ' manual' : '');
        const tokens = m.prompt_tokens ? `<span class="msg-tokens">${(m.prompt_tokens||0)+(m.completion_tokens||0)}tkn</span>` : '';
        const label  = m.role === 'assistant' ? (m.is_manual ? '👤 Admin' : '🤖 KI') : '👤 Nutzer';

        html += `
            <div class="msg-row ${cls}">
                <div class="msg-bubble">
                    ${m.content.replace(/\n/g,'<br>')}
                    <div class="msg-meta">
                        <span style="color:inherit;opacity:0.5;">${label}</span>
                        ${tokens}
                        <span>${time}</span>
                    </div>
                </div>
            </div>`;
    });
    return html;
}

async function refreshCurrentChat() {
    if (!_currentChatId) return;
    try {
        const data  = await api.getChatMessages(_currentChatId);
        const area  = document.getElementById(`msg-area-${_currentChatId}`);
        if (!area) return;
        const wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60;
        area.innerHTML = renderMessages(data.messages || []);
        if (wasAtBottom) area.scrollTop = area.scrollHeight;
    } catch {}
}

async function sendAdminMessage(chatId) {
    const ta      = document.getElementById(`reply-${chatId}`);
    const content = ta?.value?.trim();
    if (!content) return;
    ta.value = ''; ta.style.height = 'auto';
    try {
        await api.request('/manual-message', 'POST', { chatId, content });
        await refreshCurrentChat();
        loadChats();
    } catch(e) { alert('Fehler: ' + e.message); }
}

function handleReplyKey(e, chatId) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdminMessage(chatId); }
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

async function toggleChatStatus(chatId, isManual) {
    try {
        await api.updateChatStatus(chatId, isManual);
        const label = document.getElementById(`mode-label-${chatId}`);
        if (label) label.textContent = isManual ? 'Manuell' : 'KI aktiv';
        loadChats();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function quickBan(chatId) {
    if (!confirm(`Nutzer ${chatId} bannen?`)) return;
    try { await api.banUser(chatId, 'Direktbann'); showToast('✅ Gebannt'); loadBlacklist(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

// ── Learning ──────────────────────────────────────────────────────────────────
async function loadLearningQueue() {
    const el = document.getElementById('learning-list');
    if (!el) return;
    try {
        const queue = await api.getLearningQueue();
        if (!queue?.length) { el.innerHTML = '<p style="color:#555;padding:8px;font-size:0.875rem;">Keine offenen Fragen. 🎉</p>'; return; }
        el.innerHTML = queue.map(item => `
            <div class="card">
                <p style="font-size:0.75rem;color:#666;margin-bottom:4px;">Kundenfrage:</p>
                <p style="font-weight:700;margin-bottom:10px;">"${esc(item.unanswered_question)}"</p>
                <textarea id="learn-ans-${item.id}" rows="4" placeholder="Deine Antwort → wird in die Wissensdatenbank gespeichert…" style="margin-bottom:8px;"></textarea>
                <button onclick="resolveLearning('${item.id}')" class="btn-success btn-full">✅ Speichern & KI trainieren</button>
            </div>`).join('');
    } catch(e) { el.innerHTML = '<p style="color:#ef4444;">Ladefehler</p>'; }
}

async function resolveLearning(id) {
    const ans = document.getElementById(`learn-ans-${id}`)?.value?.trim();
    if (!ans) return alert('Bitte Antwort eingeben');
    try { await api.resolveLearning(id, ans); showToast('✅ Wissen gespeichert!'); loadLearningQueue(); updateStats(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

// ── Knowledge ─────────────────────────────────────────────────────────────────
async function loadKbCategories() {
    const el = document.getElementById('kb-cat-list');
    if (!el) return;
    try {
        _allCategories = await api.request('/knowledge/categories') || [];
        // Dropdowns befüllen
        ['manual-cat-id','scrape-cat-id'].forEach(selId => {
            const sel = document.getElementById(selId);
            if (!sel) return;
            sel.innerHTML = '<option value="">– Keine Kategorie –</option>' +
                _allCategories.map(c => `<option value="${c.id}">${c.icon||''} ${esc(c.name)}</option>`).join('');
        });
        // Sidebar
        el.innerHTML = `
            <div class="kb-cat-item ${!_currentKbCatId?'active':''}" onclick="filterKbByCategory(null)">
                <span>🗂</span><span style="flex:1;">Alle</span>
            </div>` +
            _allCategories.map(c => `
                <div class="kb-cat-item ${_currentKbCatId===c.id?'active':''}" onclick="filterKbByCategory(${c.id})">
                    <span class="kb-cat-dot" style="background:${c.color}"></span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.icon||''} ${esc(c.name)}</span>
                    <button class="kb-cat-del" onclick="event.stopPropagation();deleteCategory(${c.id})">✕</button>
                </div>`).join('');
    } catch(e) { console.error('Categories:', e); }
}

async function loadKbEntries(catId) {
    const el = document.getElementById('kb-entries-list');
    if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.875rem;padding:8px;">Lädt…</p>';
    try {
        const url = catId ? `/knowledge/entries?category_id=${catId}` : '/knowledge/entries';
        const entries = await api.request(url) || [];
        if (!entries.length) { el.innerHTML = '<p style="color:#555;padding:8px;font-size:0.875rem;">Keine Einträge.</p>'; return; }
        el.innerHTML = entries.map(e => {
            const cat = e.knowledge_categories;
            const catPill = cat
                ? `<span class="pill" style="background:${cat.color}22;color:${cat.color};">${cat.icon||''} ${esc(cat.name)}</span>`
                : '';
            return `
                <div class="kb-entry">
                    <div class="kb-entry-body">
                        ${catPill}
                        <div class="kb-entry-title">${esc(e.title||'(kein Titel)')}</div>
                        <div class="kb-entry-preview">${esc(e.content_preview)}</div>
                        <div class="kb-entry-footer">
                            <span>${esc(e.source)}</span>
                            <span>·</span>
                            <span>${new Date(e.created_at).toLocaleDateString('de-DE')}</span>
                        </div>
                    </div>
                    <button onclick="deleteKbEntry('${e.id}')" class="icon-btn" style="flex-shrink:0;" title="Löschen">🗑</button>
                </div>`;
        }).join('');
    } catch(e) { el.innerHTML = `<p style="color:#ef4444;">Fehler: ${esc(e.message)}</p>`; }
}

function filterKbByCategory(catId) {
    _currentKbCatId = catId;
    document.querySelectorAll('.kb-cat-item').forEach(el => el.classList.remove('active'));
    const idx = catId
        ? _allCategories.findIndex(c => c.id === catId)
        : -1;
    document.querySelectorAll('.kb-cat-item')[idx + 1]?.classList.add('active');
    loadKbEntries(catId);
}

async function deleteKbEntry(id) {
    if (!confirm('Eintrag löschen?')) return;
    try { await api.request(`/knowledge/entries/${id}`, 'DELETE'); loadKbEntries(_currentKbCatId); updateStats(); showToast('🗑 Gelöscht'); }
    catch(e) { alert('Fehler: ' + e.message); }
}

function toggleAddCat() {
    const f = document.getElementById('add-cat-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function addCategory() {
    const name  = document.getElementById('new-cat-name')?.value?.trim();
    const color = document.getElementById('new-cat-color')?.value || '#4a9eff';
    const icon  = document.getElementById('new-cat-icon')?.value?.trim() || '📌';
    if (!name) return alert('Name eingeben');
    try {
        await api.request('/knowledge/categories', 'POST', { name, color, icon });
        document.getElementById('new-cat-name').value = '';
        document.getElementById('add-cat-form').style.display = 'none';
        showToast('✅ Kategorie angelegt');
        loadKbCategories();
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function deleteCategory(id) {
    if (!confirm('Kategorie löschen? Einträge bleiben erhalten.')) return;
    try { await api.request(`/knowledge/categories/${id}`, 'DELETE'); showToast('🗑 Gelöscht'); loadKbCategories(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

async function saveManualKnowledge() {
    const title   = document.getElementById('manual-kb-title')?.value?.trim();
    const content = document.getElementById('manual-kb-content')?.value?.trim();
    const cat_id  = document.getElementById('manual-cat-id')?.value || null;
    const btn     = document.getElementById('save-manual-kb');
    if (!content) return alert('Inhalt eingeben!');
    btn.disabled = true; btn.textContent = 'Speichert…';
    try {
        await api.addManualKnowledge(title, content, cat_id);
        showToast('✅ Wissen gespeichert!');
        document.getElementById('manual-kb-title').value  = '';
        document.getElementById('manual-kb-content').value = '';
        updateStats();
        loadKbEntries(_currentKbCatId);
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '💾 Wissen speichern & KI trainieren'; }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function discoverLinks() {
    const url = document.getElementById('scrape-url')?.value?.trim();
    if (!url) return alert('URL eingeben');
    const btn = document.getElementById('url-discover');
    btn.textContent = '🔍 Suche…'; btn.disabled = true;
    document.getElementById('link-list').innerHTML = '';
    try {
        const data = await api.discoverLinks(url);
        const ll   = document.getElementById('link-list');
        if (!data.links?.length) { ll.innerHTML = '<p style="color:#666;padding:8px;font-size:0.875rem;">Keine Links gefunden.</p>'; return; }
        ll.innerHTML = `
            <div class="link-discovery-box">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:0.8rem;color:#888;">
                    <span>${data.links.length} Links gefunden</span>
                    <div><button onclick="setAllLinks(true)" class="btn-secondary" style="padding:3px 8px;font-size:0.75rem;">Alle</button> <button onclick="setAllLinks(false)" class="btn-secondary" style="padding:3px 8px;font-size:0.75rem;margin-left:4px;">Keine</button></div>
                </div>
                ${data.links.map(l => `<div class="link-item"><input type="checkbox" name="scrape-links" value="${esc(l)}" checked><label>${l.length>80?l.substring(0,80)+'…':l}</label></div>`).join('')}
            </div>`;
        document.getElementById('start-scrape').style.display = 'block';
    } catch(e) { document.getElementById('link-list').innerHTML = `<p style="color:#ef4444;padding:8px;">⚠️ ${esc(e.message)}</p>`; }
    finally { btn.textContent = '🔍 Links finden'; btn.disabled = false; }
}

function setAllLinks(v) { document.querySelectorAll('input[name="scrape-links"]').forEach(el => el.checked = v); }

async function startScraping() {
    const links  = Array.from(document.querySelectorAll('input[name="scrape-links"]:checked')).map(el => el.value);
    const cat_id = document.getElementById('scrape-cat-id')?.value || null;
    if (!links.length) return alert('Mindestens einen Link auswählen');
    const btn = document.getElementById('start-scrape');
    btn.textContent = `⏳ ${links.length} Seiten werden gescannt…`; btn.disabled = true;
    try {
        const r = await api.request('/scrape', 'POST', { urls: links, category_id: cat_id });
        showToast(`✅ ${r.processedUrls} Seiten, ${r.savedChunks} Chunks gespeichert`);
        updateStats(); loadKbEntries(_currentKbCatId);
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.textContent = '▶ Ausgewählte Seiten scrapen'; btn.disabled = false; }
}

// ── Sellauth ──────────────────────────────────────────────────────────────────
async function testSellauth() {
    const s = await api.getSettings();
    if (!s.sellauth_api_key || !s.sellauth_shop_id) return alert('API Key und Shop ID in Einstellungen → Sellauth eintragen!');
    try {
        const r = await api.request('/sellauth/test', 'POST', { apiKey: s.sellauth_api_key, shopId: s.sellauth_shop_id });
        if (r.ok) showToast(`✅ Verbunden: ${r.shopName}`);
        else alert('❌ ' + r.error);
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function loadSellauthPreview() {
    const preview = document.getElementById('sa-preview');
    const list    = document.getElementById('sa-product-list');
    preview.style.display = 'block';
    list.innerHTML = '<p style="color:#666;">Lädt Produkte…</p>';
    try {
        const data = await api.request('/sellauth/preview');
        document.getElementById('sa-product-count').textContent = data.total;
        list.innerHTML = data.products.map(p => `
            <div class="sa-card">
                <div class="sa-card-title">
                    ${esc(p.name)}
                    <span class="badge-type ${p.type==='variant'?'badge-variant':'badge-single'}">${p.type==='variant'?`${p.variants} Varianten`:'Einzelprodukt'}</span>
                    ${p.stock !== null ? `<span style="font-size:0.75rem;color:#888;margin-left:auto;">Bestand: ${p.stock}</span>` : ''}
                </div>
                ${p.price ? `<div style="color:#f59e0b;font-size:0.85rem;">💰 ${p.price} ${p.currency}</div>` : ''}
                <div class="sa-link">🔗 ${esc(p.url)}</div>
            </div>`).join('');
    } catch(e) { list.innerHTML = `<p style="color:#ef4444;">${esc(e.message)}</p>`; }
}

async function syncSellauth() {
    const btn = document.getElementById('btn-sync-sellauth');
    btn.textContent = '⏳ Synchronisiere…'; btn.disabled = true;
    try {
        const r = await api.request('/sellauth/sync', 'POST');
        showToast(`✅ ${r.message}`);
        updateStats();
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.textContent = '🔄 Synchronisieren'; btn.disabled = false; }
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
    try {
        const s = await api.getSettings();
        const sv  = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
        sv('system-prompt',       s.system_prompt);
        sv('negative-prompt',     s.negative_prompt);
        sv('welcome-message',     s.welcome_message);
        sv('manual-msg-template', s.manual_msg_template);
        sv('sellauth-api-key',    s.sellauth_api_key);
        sv('sellauth-shop-id',    s.sellauth_shop_id);
        sv('sellauth-shop-url',   s.sellauth_shop_url);
        // Model sliders
        const setSlider = (id, val) => {
            const el = document.getElementById(id);
            if (el) { el.value = val; el.dispatchEvent(new Event('input')); }
        };
        setSlider('ai-max-tokens',   s.ai_max_tokens   || 1024);
        setSlider('ai-temperature',  s.ai_temperature  || 0.5);
        setSlider('rag-threshold',   s.rag_threshold   || 0.45);
        setSlider('rag-match-count', s.rag_match_count || 8);
        // Model select
        const modelSel = document.getElementById('ai-model');
        if (modelSel && s.ai_model) modelSel.value = s.ai_model;
    } catch(e) { console.error('Settings:', e); }
}

async function saveSettings() {
    const gv  = id => document.getElementById(id)?.value ?? '';
    const settings = {
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
    try { await api.saveSettings(settings); showToast('✅ Gespeichert!'); }
    catch(e) { alert('Fehler: ' + e.message); }
}

// ── Blacklist ─────────────────────────────────────────────────────────────────
async function loadBlacklist() {
    const tbody = document.getElementById('blacklist-body');
    if (!tbody) return;
    try {
        const list = await api.getBlacklist();
        if (!list?.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:1rem;color:#555;">Leer</td></tr>'; return; }
        tbody.innerHTML = list.map(item => `
            <tr>
                <td><code style="font-size:0.8rem;">${esc(item.identifier)}</code></td>
                <td style="color:#aaa;">${esc(item.reason||'–')}</td>
                <td style="color:#555;">${new Date(item.created_at).toLocaleDateString('de-DE')}</td>
                <td><button onclick="removeBan('${item.id}')" class="btn-danger" style="padding:4px 10px;font-size:0.75rem;">Löschen</button></td>
            </tr>`).join('');
    } catch(e) { tbody.innerHTML = '<tr><td colspan="4" style="color:#ef4444;padding:10px;">Ladefehler</td></tr>'; }
}

async function handleBan() {
    const id     = document.getElementById('ban-identifier')?.value?.trim();
    const reason = document.getElementById('ban-reason')?.value?.trim();
    if (!id) return alert('Identifikator eingeben');
    try { await api.banUser(id, reason); document.getElementById('ban-identifier').value=''; document.getElementById('ban-reason').value=''; showToast('✅ Gebannt'); loadBlacklist(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

async function removeBan(id) {
    if (!confirm('Bann aufheben?')) return;
    try { await api.removeBan(id); loadBlacklist(); showToast('✅ Bann aufgehoben'); }
    catch(e) { alert('Fehler: ' + e.message); }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(s, n) { return s && s.length > n ? s.substring(0, n) + '…' : (s||''); }

function relativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)   return 'jetzt';
    if (mins < 60)  return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)   return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 7)   return `${days}d`;
    return new Date(iso).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' });
}

function showToast(msg) {
    let t = document.getElementById('_toast');
    if (!t) {
        t = document.createElement('div');
        t.id = '_toast';
        t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:10px;z-index:99999;font-weight:600;font-size:0.875rem;box-shadow:0 8px 24px rgba(0,0,0,0.5);transition:opacity 0.3s;pointer-events:none;';
        document.body.appendChild(t);
    }
    t.style.background = msg.includes('❌') ? '#991b1b' : '#15803d';
    t.style.color = '#fff';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._t);
    t._t = setTimeout(() => t.style.opacity='0', 3500);
}
