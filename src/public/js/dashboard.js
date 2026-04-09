// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('admin_token')) initDashboard();
    document.getElementById('url-discover')?.addEventListener('click', discoverLinks);
    document.getElementById('start-scrape')?.addEventListener('click', startScraping);
    setInterval(updateStats, 30000);
});

async function initDashboard() {
    await Promise.all([ updateStats(), loadChats(), loadSettings(), loadLearningQueue(), loadBlacklist() ]);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function updateStats() {
    try {
        const d = await api.getStats();
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('total-chats',      d.stats.totalChats);
        set('manual-chats',     d.stats.activeManual);
        set('knowledge-entries',d.stats.knowledgeEntries);
        set('total-cost',       d.stats.totalCost);
        set('total-tokens',     `${(d.stats.totalTokens||0).toLocaleString()} Token`);
        set('version-tag',      `v${d.version}`);
        const badge = document.getElementById('learning-badge');
        if (badge) { badge.textContent = d.stats.pendingLearning; badge.style.display = d.stats.pendingLearning > 0 ? 'inline-block' : 'none'; }
    } catch(e) { console.error('Stats Error:', e); }
}

// ── Chats ─────────────────────────────────────────────────────────────────────
async function loadChats() {
    const el = document.getElementById('chat-list');
    if (!el) return;
    try {
        const chats = await api.getChats();
        if (!chats?.length) { el.innerHTML = '<p style="padding:1rem;color:#555;font-size:0.85rem;">Noch keine Chats.</p>'; return; }
        el.innerHTML = chats.map(c => `
            <div class="chat-item ${c.is_manual_mode ? 'manual-active' : ''}" onclick="selectChat('${esc(c.id)}')">
                <span>${c.platform === 'telegram' ? '✈️' : '🌐'}</span>
                <span style="flex:1;font-size:0.8rem;color:#aaa;font-family:monospace;" title="${esc(c.id)}">${c.id.substring(0,15)}…</span>
                <span style="font-size:0.7rem;font-weight:700;${c.is_manual_mode ? 'color:#ef4444;' : 'color:#555;'}">${c.is_manual_mode ? 'MENSCH' : 'KI'}</span>
            </div>`).join('');
    } catch(e) { el.innerHTML = '<p style="padding:1rem;color:#ef4444;font-size:0.875rem;">Ladefehler</p>'; }
}

async function selectChat(chatId) {
    const details = document.getElementById('chat-details');
    details.innerHTML = '<p style="padding:2rem;color:#555;">Lädt…</p>';
    try {
        const data = await api.getChatMessages(chatId);
        details.style.flexDirection = 'column';
        details.innerHTML = `
            <div style="padding:10px 14px;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:center;background:#1a1a1a;">
                <code style="font-size:0.8rem;color:#888;">${esc(chatId)}</code>
                <div style="display:flex;gap:8px;align-items:center;">
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.875rem;">
                        <input type="checkbox" id="mode-${esc(chatId)}" ${data.is_manual?'checked':''} onchange="toggleChatStatus('${esc(chatId)}',this.checked)">
                        Manuell
                    </label>
                    <button onclick="quickBan('${esc(chatId)}')" style="background:#dc3545;font-size:0.75rem;padding:4px 10px;">⛔ Bannen</button>
                </div>
            </div>
            <div class="message-history" id="history-${esc(chatId)}">
                ${(data.messages||[]).map(m => `
                    <div class="msg-row ${m.role}">
                        <div class="msg-bubble">
                            <small style="color:#555;display:block;margin-bottom:3px;">${m.role.toUpperCase()}${m.is_manual?' 👤':''}</small>
                            <div>${esc(m.content).replace(/\n/g,'<br>')}</div>
                            ${m.prompt_tokens?`<small style="color:#444;">${(m.prompt_tokens||0)+(m.completion_tokens||0)} tkn</small>`:''}
                        </div>
                    </div>`).join('')}
            </div>
            <div style="padding:10px;border-top:1px solid #2a2a2a;display:flex;gap:8px;background:#1a1a1a;">
                <textarea id="reply-${esc(chatId)}" rows="2" placeholder="Antwort als Admin senden…" style="flex:1;resize:none;background:#252525;border:1px solid #444;color:#e2e8f0;padding:8px;border-radius:6px;font-family:inherit;"></textarea>
                <button onclick="sendAdminMessage('${esc(chatId)}')" style="background:#28a745;align-self:flex-end;">Senden</button>
            </div>`;
        const h = document.getElementById(`history-${chatId}`);
        if (h) h.scrollTop = h.scrollHeight;
    } catch(e) { details.innerHTML = '<p style="padding:2rem;color:#ef4444;">Ladefehler</p>'; }
}

async function sendAdminMessage(chatId) {
    const ta = document.getElementById(`reply-${chatId}`);
    const content = ta?.value?.trim();
    if (!content) return;
    try {
        await api.request('/manual-message', 'POST', { chatId, content });
        ta.value = '';
        selectChat(chatId);
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function toggleChatStatus(chatId, isManual) {
    try { await api.updateChatStatus(chatId, isManual); loadChats(); updateStats(); }
    catch(e) { alert('Fehler: ' + e.message); }
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
        if (!queue?.length) { el.innerHTML = '<p style="color:#555;padding:8px;">Keine offenen Fragen.</p>'; return; }
        el.innerHTML = queue.map(item => `
            <div style="background:#1e1e1e;border:1px solid #333;border-radius:10px;padding:14px;margin-bottom:10px;">
                <p style="font-size:0.75rem;color:#888;margin:0 0 4px;">Kundenfrage:</p>
                <p style="font-weight:600;margin:0 0 10px;color:#e2e8f0;">"${esc(item.unanswered_question)}"</p>
                <textarea id="learn-ans-${item.id}" rows="3" placeholder="Deine Antwort → wird in Wissensdatenbank gespeichert…" style="width:100%;margin-bottom:8px;background:#252525;border:1px solid #444;color:#e2e8f0;padding:8px;border-radius:6px;box-sizing:border-box;"></textarea>
                <button onclick="resolveLearning('${item.id}')" style="background:#28a745;width:100%;">✅ Wissen speichern & KI trainieren</button>
            </div>`).join('');
    } catch(e) { el.innerHTML = '<p style="color:#ef4444;">Ladefehler</p>'; }
}

async function resolveLearning(id) {
    const ans = document.getElementById(`learn-ans-${id}`)?.value?.trim();
    if (!ans) return alert('Bitte eine Antwort eingeben');
    try { await api.resolveLearning(id, ans); showToast('✅ Wissen gespeichert!'); loadLearningQueue(); updateStats(); }
    catch(e) { alert('Fehler: ' + e.message); }
}

// ── Knowledge Base ────────────────────────────────────────────────────────────
let _currentKbCatId = null;

async function loadKbCategories() {
    const el = document.getElementById('kb-cat-list');
    if (!el) return;
    try {
        const cats = await api.request('/knowledge/categories');
        _allCategories = cats || [];

        // Dropdown für manuellen Eintrag + Scraper füllen
        ['manual-cat-id','scrape-cat-id'].forEach(selId => {
            const sel = document.getElementById(selId);
            if (!sel) return;
            sel.innerHTML = '<option value="">-- Keine Kategorie --</option>' +
                cats.map(c => `<option value="${c.id}">${c.icon||''} ${esc(c.name)}</option>`).join('');
        });

        // Sidebar
        const countEl = document.getElementById('kb-total-count');
        el.innerHTML = `
            <div class="kb-cat-item ${!_currentKbCatId ? 'active' : ''}" onclick="filterKbByCategory(null)" id="kb-cat-all">
                <span>🗂</span> <span style="flex:1;">Alle</span>
            </div>` +
            cats.map(c => `
                <div class="kb-cat-item ${_currentKbCatId===c.id ? 'active' : ''}" onclick="filterKbByCategory(${c.id})" id="kb-cat-${c.id}">
                    <span class="kb-cat-dot" style="background:${c.color}"></span>
                    <span style="flex:1;">${c.icon||''} ${esc(c.name)}</span>
                    <button onclick="event.stopPropagation();deleteCategory(${c.id})" style="background:none;border:none;color:#555;cursor:pointer;padding:0 2px;font-size:0.8rem;">✕</button>
                </div>`).join('');
    } catch(e) { console.error('Categories Error:', e); }
}

async function loadKbEntries(catId) {
    const el = document.getElementById('kb-entries-list');
    if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.875rem;">Lädt…</p>';
    try {
        const url = catId ? `/knowledge/entries?category_id=${catId}` : '/knowledge/entries';
        const entries = await api.request(url);
        if (!entries?.length) { el.innerHTML = '<p style="color:#555;padding:8px;">Noch keine Einträge in dieser Kategorie.</p>'; return; }

        document.getElementById('knowledge-entries').textContent = entries.length;

        el.innerHTML = entries.map(e => `
            <div class="kb-entry-card">
                <div style="flex:1;">
                    ${e.knowledge_categories ? `<span class="badge-pill" style="background:${e.knowledge_categories.color}22;color:${e.knowledge_categories.color};margin-bottom:6px;">${e.knowledge_categories.icon||''} ${esc(e.knowledge_categories.name)}</span>` : ''}
                    <div style="font-weight:600;color:#e2e8f0;">${esc(e.title||'(kein Titel)')}</div>
                    <div class="kb-entry-preview">${esc(e.content_preview)}</div>
                    <div class="kb-entry-meta">Quelle: ${esc(e.source)} · ${new Date(e.created_at).toLocaleDateString('de-DE')}</div>
                </div>
                <button onclick="deleteKbEntry('${e.id}')" style="background:none;border:1px solid #444;color:#888;padding:4px 10px;font-size:0.75rem;flex-shrink:0;">🗑</button>
            </div>`).join('');
    } catch(e) { el.innerHTML = '<p style="color:#ef4444;">Ladefehler</p>'; }
}

function filterKbByCategory(catId) {
    _currentKbCatId = catId;
    document.querySelectorAll('.kb-cat-item').forEach(el => el.classList.remove('active'));
    const target = catId ? document.getElementById(`kb-cat-${catId}`) : document.getElementById('kb-cat-all');
    if (target) target.classList.add('active');
    loadKbEntries(catId);
}

async function deleteKbEntry(id) {
    if (!confirm('Eintrag wirklich löschen?')) return;
    try { await api.request(`/knowledge/entries/${id}`, 'DELETE'); loadKbEntries(_currentKbCatId); updateStats(); showToast('🗑 Eintrag gelöscht'); }
    catch(e) { alert('Fehler: ' + e.message); }
}

function showAddCategory() {
    const f = document.getElementById('add-cat-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function addCategory() {
    const name  = document.getElementById('new-cat-name')?.value?.trim();
    const color = document.getElementById('new-cat-color')?.value || '#4a9eff';
    const icon  = document.getElementById('new-cat-icon')?.value?.trim() || '📌';
    if (!name) return alert('Bitte Namen eingeben');
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
    try { await api.request(`/knowledge/categories/${id}`, 'DELETE'); loadKbCategories(); showToast('🗑 Kategorie gelöscht'); }
    catch(e) { alert('Fehler: ' + e.message); }
}

async function saveManualKnowledge() {
    const title    = document.getElementById('manual-kb-title')?.value?.trim();
    const content  = document.getElementById('manual-kb-content')?.value?.trim();
    const cat_id   = document.getElementById('manual-cat-id')?.value || null;
    const btn      = document.getElementById('save-manual-kb');
    if (!content) return alert('Bitte Inhalt eingeben!');
    btn.disabled = true; btn.textContent = 'Speichert…';
    try {
        await api.addManualKnowledge(title, content, cat_id);
        showToast('✅ Wissen gespeichert!');
        document.getElementById('manual-kb-title').value = '';
        document.getElementById('manual-kb-content').value = '';
        updateStats();
        loadKbEntries(_currentKbCatId);
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '💾 Wissen speichern & KI trainieren'; }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function discoverLinks() {
    const url = document.getElementById('scrape-url')?.value?.trim();
    if (!url) return alert('Bitte URL eingeben');
    const btn = document.getElementById('url-discover');
    btn.textContent = '🔍 Suche…'; btn.disabled = true;
    document.getElementById('link-list').innerHTML = '';
    try {
        const data = await api.discoverLinks(url);
        const ll = document.getElementById('link-list');
        if (!data.links?.length) { ll.innerHTML = '<p style="color:#888;">Keine Links gefunden.</p>'; return; }
        ll.innerHTML = `
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px;max-height:240px;overflow-y:auto;">
                <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                    <span style="font-size:0.8rem;color:#888;">${data.links.length} Links</span>
                    <div><button onclick="setAllLinks(true)" style="background:#4a5568;font-size:0.75rem;padding:3px 8px;">Alle</button> <button onclick="setAllLinks(false)" style="background:#4a5568;font-size:0.75rem;padding:3px 8px;">Keine</button></div>
                </div>
                ${data.links.map(l => `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid #2a2a2a;align-items:center;"><input type="checkbox" name="scrape-links" value="${esc(l)}" checked><label style="font-size:0.8rem;color:#aaa;word-break:break-all;">${l.length>80?l.substring(0,80)+'…':l}</label></div>`).join('')}
            </div>`;
        document.getElementById('start-scrape').style.display = 'block';
    } catch(e) { document.getElementById('link-list').innerHTML = `<p style="color:#ef4444;">⚠️ ${esc(e.message)}</p>`; }
    finally { btn.textContent = '🔍 Links finden'; btn.disabled = false; }
}

function setAllLinks(v) { document.querySelectorAll('input[name="scrape-links"]').forEach(el => el.checked = v); }

async function startScraping() {
    const links = Array.from(document.querySelectorAll('input[name="scrape-links"]:checked')).map(el => el.value);
    const cat_id = document.getElementById('scrape-cat-id')?.value || null;
    if (!links.length) return alert('Mindestens einen Link auswählen');
    const btn = document.getElementById('start-scrape');
    btn.textContent = `⏳ Läuft… (0/${links.length})`; btn.disabled = true;
    try {
        const r = await api.request('/scrape', 'POST', { urls: links, category_id: cat_id });
        showToast(`✅ ${r.processedUrls} Seiten gescannt, ${r.savedChunks} Chunks gespeichert`);
        updateStats();
        loadKbEntries(_currentKbCatId);
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.textContent = '▶ Ausgewählte Seiten scrapen'; btn.disabled = false; }
}

// ── Sellauth ──────────────────────────────────────────────────────────────────
async function loadSellauthStatus() {
    const badge = document.getElementById('sa-status-badge');
    const { data: settings } = await supabase_check();
    // Nur prüfen ob konfiguriert
    try {
        const s = await api.getSettings();
        if (s.sellauth_api_key && s.sellauth_shop_id) {
            badge.innerHTML = '<span class="status-dot dot-green"></span> Konfiguriert';
        }
    } catch(_) {}
}

async function testSellauth() {
    const s = await api.getSettings();
    if (!s.sellauth_api_key || !s.sellauth_shop_id) return alert('Bitte zuerst API Key und Shop ID in den Einstellungen speichern!');
    try {
        const r = await api.request('/sellauth/test', 'POST', { apiKey: s.sellauth_api_key, shopId: s.sellauth_shop_id });
        if (r.ok) {
            showToast(`✅ Verbunden mit Shop: ${r.shopName}`);
            const info = document.getElementById('sa-connection-info');
            document.getElementById('sa-shop-name').textContent = r.shopName;
            info.style.display = 'block';
        } else { alert('❌ Verbindung fehlgeschlagen: ' + r.error); }
    } catch(e) { alert('Fehler: ' + e.message); }
}

async function loadSellauthPreview() {
    const preview = document.getElementById('sa-preview');
    const list    = document.getElementById('sa-product-list');
    list.innerHTML = '<p style="color:#888;">Lade Produkte…</p>';
    preview.style.display = 'block';
    try {
        const data = await api.request('/sellauth/preview');
        document.getElementById('sa-product-count').textContent = data.total;
        list.innerHTML = data.products.map(p => `
            <div class="sa-product-card">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="sa-product-name">${esc(p.name)}</span>
                    <span class="sa-badge ${p.type}">${p.type === 'variant' ? `${p.variants} Varianten` : 'Einzelprodukt'}</span>
                </div>
                ${p.price ? `<div style="color:#f59e0b;font-size:0.875rem;margin-top:4px;">💰 ${p.price} ${p.currency}</div>` : ''}
                <div style="margin-top:6px;"><span class="sa-link">${esc(p.url)}</span></div>
                ${p.stock !== null ? `<div style="font-size:0.75rem;color:#888;margin-top:4px;">Bestand: ${p.stock}</div>` : ''}
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
        if (r.details?.errors?.length) {
            console.warn('Sellauth Fehler:', r.details.errors);
        }
    } catch(e) { alert('Fehler: ' + e.message); }
    finally { btn.textContent = '🔄 Jetzt synchronisieren'; btn.disabled = false; }
}

// Dummy für Status
async function supabase_check() { return { data: {} }; }

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
    try {
        const s = await api.getSettings();
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        set('system-prompt',        s.system_prompt);
        set('negative-prompt',      s.negative_prompt);
        set('welcome-message',      s.welcome_message);
        set('manual-msg-template',  s.manual_msg_template);
        set('sellauth-api-key',     s.sellauth_api_key);
        set('sellauth-shop-id',     s.sellauth_shop_id);
        set('sellauth-shop-url',    s.sellauth_shop_url);
    } catch(e) { console.error('Settings Error:', e); }
}

async function saveSettings() {
    const get = id => document.getElementById(id)?.value || '';
    const settings = {
        system_prompt:       get('system-prompt'),
        negative_prompt:     get('negative-prompt'),
        welcome_message:     get('welcome-message'),
        manual_msg_template: get('manual-msg-template'),
        sellauth_api_key:    get('sellauth-api-key'),
        sellauth_shop_id:    get('sellauth-shop-id'),
        sellauth_shop_url:   get('sellauth-shop-url')
    };
    try { await api.saveSettings(settings); showToast('✅ Einstellungen gespeichert!'); }
    catch(e) { alert('Fehler: ' + e.message); }
}

// ── Blacklist ─────────────────────────────────────────────────────────────────
async function loadBlacklist() {
    const tbody = document.getElementById('blacklist-body');
    if (!tbody) return;
    try {
        const list = await api.getBlacklist();
        if (!list?.length) { tbody.innerHTML = '<tr><td colspan="4" style="padding:12px;text-align:center;color:#555;">Leer</td></tr>'; return; }
        tbody.innerHTML = list.map(item => `
            <tr style="border-bottom:1px solid #2a2a2a;">
                <td style="padding:10px;"><code style="font-size:0.8rem;">${esc(item.identifier)}</code></td>
                <td style="padding:10px;color:#aaa;font-size:0.875rem;">${esc(item.reason||'–')}</td>
                <td style="padding:10px;color:#666;font-size:0.8rem;">${new Date(item.created_at).toLocaleDateString('de-DE')}</td>
                <td style="padding:10px;"><button onclick="removeBan('${item.id}')" style="background:#dc3545;font-size:0.75rem;padding:4px 10px;">Löschen</button></td>
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

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = 'success') {
    let t = document.getElementById('_toast');
    if (!t) {
        t = document.createElement('div');
        t.id = '_toast';
        t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:10px;z-index:99999;font-weight:600;font-size:0.9rem;box-shadow:0 8px 20px rgba(0,0,0,0.4);transition:opacity 0.3s;';
        document.body.appendChild(t);
    }
    t.style.background = type === 'error' ? '#dc2626' : '#16a34a';
    t.style.color = '#fff';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => t.style.opacity = '0', 3000);
}

let _allCategories = [];
