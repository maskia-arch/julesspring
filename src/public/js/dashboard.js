document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('admin_token')) {
        initDashboard();
    }

    document.getElementById('save-settings')?.addEventListener('click', saveSettings);
    document.getElementById('btn-ban')?.addEventListener('click', handleBan);
    document.getElementById('sync-sellauth')?.addEventListener('click', syncSellauth);
    document.getElementById('url-discover')?.addEventListener('click', discoverLinks);
    document.getElementById('start-scrape')?.addEventListener('click', startScraping);
    document.getElementById('save-manual-kb')?.addEventListener('click', saveManualKnowledge);

    setInterval(updateStats, 30000);
});

async function initDashboard() {
    await updateStats();
    await loadChats();
    await loadSettings();
    await loadLearningQueue();
    await loadBlacklist();
}

async function updateStats() {
    try {
        const data = await api.getStats();
        document.getElementById('total-chats').textContent = data.stats.totalChats;
        document.getElementById('manual-chats').textContent = data.stats.activeManual;
        document.getElementById('knowledge-entries').textContent = data.stats.knowledgeEntries;
        document.getElementById('total-cost').textContent = data.stats.totalCost;
        document.getElementById('total-tokens').textContent = `${(data.stats.totalTokens || 0).toLocaleString()} Token`;

        const badge = document.getElementById('learning-badge');
        if (badge) {
            badge.textContent = data.stats.pendingLearning;
            badge.style.display = data.stats.pendingLearning > 0 ? 'inline-block' : 'none';
        }
        document.getElementById('version-tag').textContent = `v${data.version}`;
    } catch (err) {
        console.error('Stats Update Error:', err);
    }
}

async function loadChats() {
    const chatList = document.getElementById('chat-list');
    try {
        const chats = await api.getChats();
        if (!chats || chats.length === 0) {
            chatList.innerHTML = '<p style="padding:1rem;color:#888;">Noch keine Chats.</p>';
            return;
        }
        chatList.innerHTML = chats.map(chat => `
            <div class="chat-item ${chat.is_manual_mode ? 'manual-active' : ''}" onclick="selectChat('${chat.id}')">
                <span class="chat-platform">${chat.platform === 'telegram' ? '✈️' : '🌐'}</span>
                <span class="chat-id" title="${chat.id}">${chat.id.substring(0, 14)}...</span>
                <span class="chat-status ${chat.is_manual_mode ? 'badge-manual' : ''}">${chat.is_manual_mode ? 'MENSCH' : 'KI'}</span>
            </div>
        `).join('');
    } catch (err) {
        chatList.innerHTML = '<p class="error" style="padding:1rem;">Fehler beim Laden der Chats</p>';
    }
}

async function selectChat(chatId) {
    const details = document.getElementById('chat-details');
    details.innerHTML = '<p class="loading" style="padding:1rem;">Lade Chatverlauf...</p>';

    try {
        const response = await fetch(`/api/admin/chats/${chatId}/messages`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('admin_token')}` }
        });
        const data = await response.json();

        details.innerHTML = `
            <div class="chat-header" style="padding:1rem;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
                <h3 style="margin:0;font-size:0.95rem;">💬 ${chatId}</h3>
                <div style="display:flex;gap:8px;align-items:center;">
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input type="checkbox" id="status-${chatId}" ${data.is_manual ? 'checked' : ''}
                               onchange="toggleChatStatus('${chatId}', this.checked)">
                        <span>Manuell</span>
                    </label>
                    <button onclick="quickBan('${chatId}')" style="background:#dc3545;font-size:0.8rem;padding:4px 10px;">Bannen</button>
                </div>
            </div>
            <div class="message-history" id="history-${chatId}" style="flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:8px;">
                ${(data.messages || []).map(m => `
                    <div class="msg ${m.role}" style="display:flex;${m.role === 'user' ? 'justify-content:flex-start' : 'justify-content:flex-end'}">
                        <div style="max-width:75%;padding:8px 12px;border-radius:12px;background:${m.role === 'user' ? '#f1f5f9' : m.is_manual ? '#fef3c7' : '#dbeafe'};font-size:0.9rem;">
                            <small style="color:#888;display:block;margin-bottom:4px;">${m.role.toUpperCase()}${m.is_manual ? ' (Admin)' : ''}</small>
                            <p style="margin:0;">${escapeHtml(m.content)}</p>
                            ${m.prompt_tokens ? `<small style="color:#aaa;">${(m.prompt_tokens || 0) + (m.completion_tokens || 0)} tkn</small>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="admin-reply-area" style="padding:1rem;border-top:1px solid #eee;display:flex;gap:8px;">
                <textarea id="reply-${chatId}" placeholder="Antwort als Admin senden..." style="flex:1;resize:none;" rows="2"></textarea>
                <button onclick="sendAdminMessage('${chatId}')" style="background:#28a745;align-self:flex-end;">Senden</button>
            </div>
        `;

        const historyDiv = document.getElementById(`history-${chatId}`);
        if (historyDiv) historyDiv.scrollTop = historyDiv.scrollHeight;
    } catch (err) {
        details.innerHTML = '<p class="error" style="padding:1rem;">Fehler beim Laden des Chats</p>';
    }
}

// BUGFIX: Fehlende Funktion
async function sendAdminMessage(chatId) {
    const textarea = document.getElementById(`reply-${chatId}`);
    const content = textarea?.value?.trim();
    if (!content) return alert('Bitte eine Nachricht eingeben.');

    try {
        await api.request('/manual-message', 'POST', { chatId, content });
        textarea.value = '';
        // Chat neu laden um Nachricht anzuzeigen
        await selectChat(chatId);
    } catch (err) {
        alert('Fehler beim Senden: ' + err.message);
    }
}

async function toggleChatStatus(chatId, isManual) {
    try {
        await api.updateChatStatus(chatId, isManual);
        updateStats();
        loadChats();
    } catch (err) {
        alert('Status-Update fehlgeschlagen');
    }
}

async function loadLearningQueue() {
    const list = document.getElementById('learning-list');
    if (!list) return;
    try {
        const queue = await api.getLearningQueue();
        if (!queue || queue.length === 0) {
            list.innerHTML = '<p class="placeholder" style="padding:1rem;color:#888;">Aktuell keine Wissenslücken.</p>';
            return;
        }
        list.innerHTML = queue.map(item => `
            <div class="card learning-card" style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:1rem;margin-bottom:1rem;">
                <p style="font-size:0.8rem;color:#888;margin:0 0 4px;">Kundenfrage:</p>
                <p style="font-weight:600;margin:0 0 10px;">"${escapeHtml(item.unanswered_question)}"</p>
                <textarea id="learn-ans-${item.id}" placeholder="Deine Antwort für die Wissensdatenbank..." rows="3" style="width:100%;margin-bottom:8px;"></textarea>
                <button onclick="resolveLearning('${item.id}')" style="background:#28a745;width:100%;">✅ Wissen speichern & KI trainieren</button>
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = '<p class="error" style="padding:1rem;">Fehler beim Laden der Learning-Queue</p>';
    }
}

async function resolveLearning(questionId) {
    const answerField = document.getElementById(`learn-ans-${questionId}`);
    const answer = answerField?.value?.trim();
    if (!answer) return alert('Bitte gib eine Antwort ein.');
    try {
        await api.resolveLearning(questionId, answer);
        alert('✅ Wissen erfolgreich hinzugefügt!');
        loadLearningQueue();
        updateStats();
    } catch (err) {
        alert('Fehler beim Speichern des Wissens: ' + err.message);
    }
}

async function handleBan() {
    const id = document.getElementById('ban-identifier')?.value?.trim();
    const reason = document.getElementById('ban-reason')?.value?.trim();
    if (!id) return alert('Bitte Identifikator eingeben');
    try {
        await api.banUser(id, reason);
        document.getElementById('ban-identifier').value = '';
        document.getElementById('ban-reason').value = '';
        alert('✅ Nutzer erfolgreich gebannt.');
        loadBlacklist();
    } catch (err) {
        alert('Fehler beim Bannen: ' + err.message);
    }
}

// BUGFIX: Fehlende removeBan Funktion
async function removeBan(id) {
    if (!confirm('Bann wirklich aufheben?')) return;
    try {
        await api.removeBan(id);
        loadBlacklist();
    } catch (err) {
        alert('Fehler beim Entbannen: ' + err.message);
    }
}

async function loadBlacklist() {
    const tbody = document.getElementById('blacklist-body');
    if (!tbody) return;
    try {
        const list = await api.getBlacklist();
        if (!list || list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:1rem;color:#888;">Blacklist ist leer</td></tr>';
            return;
        }
        tbody.innerHTML = list.map(item => `
            <tr>
                <td><code>${escapeHtml(item.identifier)}</code></td>
                <td>${escapeHtml(item.reason || '-')}</td>
                <td>${new Date(item.created_at).toLocaleDateString('de-DE')}</td>
                <td><button onclick="removeBan('${item.id}')" style="background:#dc3545;font-size:0.8rem;padding:4px 10px;">Löschen</button></td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:red;padding:1rem;">Fehler beim Laden</td></tr>';
    }
}

async function loadSettings() {
    try {
        const settings = await api.getSettings();
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        set('system-prompt', settings.system_prompt);
        set('negative-prompt', settings.negative_prompt);
        set('welcome-message', settings.welcome_message);
        set('manual-msg-template', settings.manual_msg_template);
        set('sellauth-api-key', settings.sellauth_api_key);
    } catch (err) {
        console.error('Settings Load Error:', err);
    }
}

async function saveSettings() {
    const get = (id) => document.getElementById(id)?.value || '';
    const settings = {
        system_prompt: get('system-prompt'),
        negative_prompt: get('negative-prompt'),
        welcome_message: get('welcome-message'),
        manual_msg_template: get('manual-msg-template'),
        sellauth_api_key: get('sellauth-api-key')
    };
    try {
        await api.saveSettings(settings);
        showToast('✅ Einstellungen gespeichert!');
    } catch (err) {
        alert('Fehler beim Speichern: ' + err.message);
    }
}

async function saveManualKnowledge() {
    const title = document.getElementById('manual-kb-title')?.value?.trim();
    const content = document.getElementById('manual-kb-content')?.value?.trim();
    const btn = document.getElementById('save-manual-kb');

    if (!content) return alert('Bitte Inhalt eingeben!');

    try {
        btn.disabled = true;
        btn.innerText = 'Speichert...';
        await api.addManualKnowledge(title, content);
        showToast('✅ Wissen erfolgreich hinzugefügt!');
        document.getElementById('manual-kb-title').value = '';
        document.getElementById('manual-kb-content').value = '';
        updateStats();
    } catch (e) {
        alert('Fehler: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerText = 'Wissen speichern';
    }
}

async function syncSellauth() {
    const btn = document.getElementById('sync-sellauth');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Synchronisiere...';
    try {
        await api.syncSellauth();
        showToast('✅ Sellauth-Produkte erfolgreich importiert!');
        updateStats();
    } catch (err) {
        alert('Fehler: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = orig;
    }
}

async function discoverLinks() {
    const urlInput = document.getElementById('scrape-url');
    const url = urlInput?.value?.trim();
    if (!url) return alert('Bitte eine Basis-URL eingeben');

    const btn = document.getElementById('url-discover');
    btn.textContent = '🔍 Suche Links...';
    btn.disabled = true;
    document.getElementById('link-list').innerHTML = '';

    try {
        const data = await api.discoverLinks(url);
        const linkList = document.getElementById('link-list');

        if (data.links && data.links.length > 0) {
            linkList.innerHTML = `
                <div class="link-selection-area">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <h4 style="margin:0;">${data.links.length} Links gefunden</h4>
                        <div>
                            <button onclick="selectAllLinks(true)" style="background:#6c757d;font-size:0.8rem;padding:4px 8px;">Alle</button>
                            <button onclick="selectAllLinks(false)" style="background:#6c757d;font-size:0.8rem;padding:4px 8px;margin-left:4px;">Keine</button>
                        </div>
                    </div>
                    ${data.links.map(link => `
                        <div class="link-item">
                            <input type="checkbox" name="scrape-links" value="${escapeHtml(link)}" checked>
                            <label title="${link}">${link.length > 70 ? link.substring(0, 70) + '...' : link}</label>
                        </div>
                    `).join('')}
                </div>
            `;
            document.getElementById('start-scrape').style.display = 'block';
        } else {
            linkList.innerHTML = '<p style="color:#888;padding:8px;">Keine weiteren Links gefunden.</p>';
        }
    } catch (err) {
        document.getElementById('link-list').innerHTML = `<p style="color:#dc3545;padding:8px;">⚠️ ${err.message}</p>`;
    } finally {
        btn.textContent = 'Links finden';
        btn.disabled = false;
    }
}

function selectAllLinks(checked) {
    document.querySelectorAll('input[name="scrape-links"]').forEach(el => el.checked = checked);
}

async function quickBan(chatId) {
    if (confirm(`Möchtest du den Nutzer von Chat ${chatId} wirklich bannen?`)) {
        try {
            await api.banUser(chatId, 'Direktbann über Dashboard');
            showToast('✅ Nutzer gebannt');
            loadBlacklist();
        } catch (e) {
            alert('Fehler: ' + e.message);
        }
    }
}

async function startScraping() {
    const selectedLinks = Array.from(document.querySelectorAll('input[name="scrape-links"]:checked')).map(el => el.value);
    if (selectedLinks.length === 0) return alert('Bitte mindestens einen Link auswählen');

    const btn = document.getElementById('start-scrape');
    const orig = btn.textContent;
    btn.textContent = `⏳ Scrape läuft... (0/${selectedLinks.length})`;
    btn.disabled = true;

    try {
        const result = await api.startScraping(selectedLinks);
        showToast(`✅ ${result.processedUrls || selectedLinks.length} Seiten gescannt, ${result.savedChunks || '?'} Chunks gespeichert!`);
        updateStats();
    } catch (err) {
        alert('Fehler beim Scraping: ' + err.message);
    } finally {
        btn.textContent = orig;
        btn.disabled = false;
    }
}

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showToast(msg) {
    let toast = document.getElementById('toast-msg');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-msg';
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#28a745;color:white;padding:12px 20px;border-radius:8px;z-index:9999;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}
