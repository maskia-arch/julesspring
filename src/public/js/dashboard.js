document.addEventListener('DOMContentLoaded', () => {
    initDashboard();
    
    document.getElementById('save-settings')?.addEventListener('click', saveSettings);
    document.getElementById('btn-ban')?.addEventListener('click', handleBan);
    document.getElementById('sync-sellauth')?.addEventListener('click', syncSellauth);
    document.getElementById('url-discover')?.addEventListener('click', discoverLinks);
    document.getElementById('start-scrape')?.addEventListener('click', startScraping);

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
        document.getElementById('total-tokens').textContent = `${data.stats.totalTokens.toLocaleString()} Token`;
        
        const badge = document.getElementById('learning-badge');
        badge.textContent = data.stats.pendingLearning;
        badge.style.display = data.stats.pendingLearning > 0 ? 'inline-block' : 'none';
        
        document.getElementById('version-tag').textContent = `v${data.version}`;
    } catch (err) {
        console.error('Stats Update Error:', err);
    }
}

async function loadChats() {
    const chatList = document.getElementById('chat-list');
    try {
        const chats = await api.getChats();
        chatList.innerHTML = chats.map(chat => `
            <div class="chat-item ${chat.is_manual_mode ? 'manual-active' : ''}" onclick="selectChat('${chat.id}')">
                <span class="chat-platform">${chat.platform === 'telegram' ? '✈️' : '🌐'}</span>
                <span class="chat-id">${chat.id.substring(0, 12)}...</span>
                <span class="chat-status">${chat.is_manual_mode ? 'MENSCH' : 'KI'}</span>
            </div>
        `).join('');
    } catch (err) {
        chatList.innerHTML = '<p class="error">Fehler beim Laden der Chats</p>';
    }
}

async function selectChat(chatId) {
    const details = document.getElementById('chat-details');
    details.innerHTML = '<p class="loading">Lade Chatverlauf...</p>';
    
    try {
        const response = await fetch(`/api/admin/chats/${chatId}/messages`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('admin_token')}` }
        });
        const data = await response.json();

        details.innerHTML = `
            <div class="chat-header">
                <h3>Chat: ${chatId}</h3>
                <div class="header-actions">
                    <label class="switch">
                        <input type="checkbox" id="status-${chatId}" ${data.is_manual ? 'checked' : ''} 
                               onchange="toggleChatStatus('${chatId}', this.checked)">
                        <span class="slider"></span> Manuell
                    </label>
                    <button onclick="quickBan('${chatId}')" class="btn-danger-sm">Bannen</button>
                </div>
            </div>
            <div class="message-history" id="history-${chatId}">
                ${data.messages.map(m => `
                    <div class="msg ${m.role}">
                        <div class="msg-bubble">
                            <small>${m.role.toUpperCase()}</small>
                            <p>${m.content}</p>
                            ${m.prompt_tokens ? `<small class="token-info">${m.prompt_tokens + m.completion_tokens} tkn</small>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="admin-reply-area">
                <textarea id="reply-${chatId}" placeholder="Antwort als Admin senden..."></textarea>
                <button onclick="sendAdminMessage('${chatId}')" class="btn-primary">Senden</button>
            </div>
        `;
        
        const historyDiv = document.getElementById(`history-${chatId}`);
        historyDiv.scrollTop = historyDiv.scrollHeight;
    } catch (err) {
        details.innerHTML = '<p class="error">Fehler beim Laden des Chats</p>';
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
    try {
        const queue = await api.getLearningQueue();
        if (!queue || queue.length === 0) {
            list.innerHTML = '<p class="placeholder">Aktuell keine Wissenslücken.</p>';
            return;
        }
        
        list.innerHTML = queue.map(item => `
            <div class="card learning-card">
                <div class="learning-content">
                    <p class="question-label">Kundenfrage:</p>
                    <p class="question-text">"${item.unanswered_question}"</p>
                    <textarea id="learn-ans-${item.id}" placeholder="Deine Antwort für die Wissensdatenbank..."></textarea>
                    <button onclick="resolveLearning('${item.id}')" class="btn-success">Wissen speichern & KI trainieren</button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = '<p class="error">Fehler beim Laden der Learning-Queue</p>';
    }
}

async function resolveLearning(questionId) {
    const answerField = document.getElementById(`learn-ans-${questionId}`);
    const answer = answerField.value;
    if (!answer) return alert('Bitte gib eine Antwort ein.');
    
    try {
        await api.resolveLearning(questionId, answer);
        alert('Wissen erfolgreich hinzugefügt!');
        loadLearningQueue();
        updateStats();
    } catch (err) {
        alert('Fehler beim Speichern des Wissens');
    }
}

async function handleBan() {
    const id = document.getElementById('ban-identifier').value;
    const reason = document.getElementById('ban-reason').value;
    if (!id) return alert('Bitte Identifikator eingeben');
    
    try {
        await api.banUser(id, reason);
        document.getElementById('ban-identifier').value = '';
        document.getElementById('ban-reason').value = '';
        alert('Nutzer erfolgreich gebannt.');
        loadBlacklist();
    } catch (err) {
        alert('Fehler beim Bannen');
    }
}

async function loadBlacklist() {
    const tbody = document.getElementById('blacklist-body');
    try {
        const list = await api.getBlacklist();
        if (!list || list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center">Blacklist ist leer</td></tr>';
            return;
        }
        tbody.innerHTML = list.map(item => `
            <tr>
                <td><code>${item.identifier}</code></td>
                <td>${item.reason || '-'}</td>
                <td>${new Date(item.created_at).toLocaleDateString()}</td>
                <td><button onclick="removeBan('${item.id}')" class="btn-text-danger">Löschen</button></td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" class="error">Fehler beim Laden</td></tr>';
    }
}

async function loadSettings() {
    try {
        const settings = await api.getSettings();
        document.getElementById('system-prompt').value = settings.system_prompt || '';
        document.getElementById('negative-prompt').value = settings.negative_prompt || '';
        document.getElementById('manual-msg-template').value = settings.manual_msg_template || '';
    } catch (err) {
        console.error('Settings Load Error');
    }
}

async function saveSettings() {
    const settings = {
        system_prompt: document.getElementById('system-prompt').value,
        negative_prompt: document.getElementById('negative-prompt').value,
        manual_msg_template: document.getElementById('manual-msg-template').value
    };
    try {
        await api.saveSettings(settings);
        alert('Einstellungen gespeichert!');
    } catch (err) {
        alert('Fehler beim Speichern der Einstellungen');
    }
}

async function syncSellauth() {
    const btn = document.getElementById('sync-sellauth');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Synchronisiere...';
    try {
        await api.syncSellauth();
        alert('Sellauth-Produkte erfolgreich importiert!');
        updateStats();
    } catch (err) {
        alert('Fehler bei Sellauth-Synchronisierung');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function quickBan(chatId) {
    if(confirm(`Möchtest du den Nutzer von Chat ${chatId} wirklich bannen?`)) {
        await api.banUser(chatId, 'Direktbann über Dashboard');
        loadBlacklist();
    }
}

async function startScraping() {
    const urlInput = document.getElementById('scrape-url').value;
    if (!urlInput) return alert('Bitte eine URL eingeben');

    const btn = document.getElementById('start-scrape');
    btn.textContent = 'Scrape läuft...';
    btn.disabled = true;

    try {
        await api.startScraping([urlInput]);
        alert('Webseite wurde erfolgreich gescannt und in die Wissensdatenbank aufgenommen!');
        updateStats();
    } catch (err) {
        alert('Fehler beim Scraping: ' + err.message);
    } finally {
        btn.textContent = 'Ausgewählte Seiten scrapen';
        btn.disabled = false;
    }
}
