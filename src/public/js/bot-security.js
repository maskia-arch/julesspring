/**
 * bot-security.js
 *
 * Client-seitige Logik für Bot-Monitoring & Traffic-Filterung.
 */

(function() {
  'use strict';

  var _secState = {
    category: 'all',
    status: 'all',
    search: '',
    page: 1,
    limit: 50,
    loading: false,
    activeTab: 'bots'
  };

  async function apiCall(endpoint, method, body) {
    if (typeof api !== 'undefined' && typeof api.request === 'function') {
      return await api.request(endpoint, method, body);
    }
    var token = localStorage.getItem('admin_token') || '';
    var opts = {
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    };
    if (body) opts.body = JSON.stringify(body);
    var r = await fetch('/api/admin' + endpoint, opts);
    if (!r.ok) {
      var msg = 'Fehler ' + r.status;
      try { var d = await r.json(); msg = d.error || d.message || msg; } catch (_) {}
      throw new Error(msg);
    }
    return await r.json();
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2 || countryCode === '??' || countryCode === 'XX') return '🌐';
    var codePoints = countryCode
      .toUpperCase()
      .split('')
      .map(function(c) { return 127397 + c.charCodeAt(0); });
    return String.fromCodePoint.apply(String, codePoints);
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return 'Unbekannt';
    var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 30) return 'Gerade eben';
    if (diff < 60) return 'vor ' + diff + 's';
    if (diff < 3600) return 'vor ' + Math.floor(diff / 60) + ' Min.';
    if (diff < 86400) return 'vor ' + Math.floor(diff / 3600) + ' Std.';
    return new Date(dateStr).toLocaleDateString('de-DE');
  }

  async function loadBotSecurity() {
    if (_secState.loading) return;
    _secState.loading = true;

    var tableBody = document.getElementById('bot-table-body');
    if (tableBody && !tableBody.children.length) {
      tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#94a3b8;">⏳ Lade aktive Bots und Traffic-Daten...</td></tr>';
    }

    try {
      var qs = new URLSearchParams({
        category: _secState.category,
        status: _secState.status,
        search: _secState.search,
        page: _secState.page,
        limit: _secState.limit
      }).toString();

      var res = await apiCall('/security/bots?' + qs, 'GET');
      var data = res || { stats: {}, bots: [] };
      renderStats(data.stats || {});
      renderBots(data.bots || []);
    } catch (err) {
      console.error('[BotSecurity] Fehler beim Laden:', err);
      if (tableBody) {
        tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#ef4444;">❌ Fehler beim Laden der Bot-Daten: ' + esc(err.message) + '</td></tr>';
      }
    } finally {
      _secState.loading = false;
    }
  }

  function renderStats(stats) {
    var elTotal = document.getElementById('sec-stat-total');
    var elHelpful = document.getElementById('sec-stat-helpful');
    var elMalicious = document.getElementById('sec-stat-malicious');
    var elBlocked = document.getElementById('sec-stat-blocked');
    var elScans = document.getElementById('sec-stat-scans');
    var elAutoBlock = document.getElementById('sec-autoblock-toggle');

    if (elTotal) elTotal.textContent = (stats.totalBots || 0).toLocaleString('de-DE');
    if (elHelpful) elHelpful.textContent = (stats.helpfulCount || 0).toLocaleString('de-DE');
    if (elMalicious) elMalicious.textContent = (stats.maliciousCount || 0).toLocaleString('de-DE');
    if (elBlocked) elBlocked.textContent = (stats.blockedCount || 0).toLocaleString('de-DE');
    if (elScans) elScans.textContent = (stats.totalScans || 0).toLocaleString('de-DE');

    if (elAutoBlock) {
      elAutoBlock.checked = !!stats.autoBlockEnabled;
    }
  }

  function renderBots(bots) {
    var tableBody = document.getElementById('bot-table-body');
    if (!tableBody) return;

    if (!bots || bots.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:#64748b;">Keine Bots für den ausgewählten Filter gefunden.</td></tr>';
      return;
    }

    var html = bots.map(function(b) {
      // Badge für Einstufung
      var catBadge = '';
      if (b.isHelpful) {
        catBadge = '<span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);font-size:0.75rem;padding:3px 8px;border-radius:6px;">✅ Hilfreich (Suchmaschine)</span>';
      } else if (b.category === 'analysis') {
        catBadge = '<span class="badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);font-size:0.75rem;padding:3px 8px;border-radius:6px;">ℹ️ Analyse / SEO-Audit</span>';
      } else {
        catBadge = '<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);font-size:0.75rem;padding:3px 8px;border-radius:6px;font-weight:600;">⚠️ Aggressiver Scraper</span>';
      }

      // Herkunft mit Flagge
      var flag = getFlagEmoji(b.originCountryCode);
      var countryLabel = b.originCountry ? flag + ' ' + esc(b.originCountry) : '🌐 Unbekannt';
      var orgLabel = b.originOrg ? esc(b.originOrg) : (b.originCity ? esc(b.originCity) : 'Unbekannter Host');

      // Status
      var statusBadge = b.isBlocked
        ? '<span class="badge" style="background:#dc2626;color:#fff;font-size:0.72rem;padding:2px 7px;border-radius:4px;font-weight:700;">⛔ GESPERRT</span>'
        : '<span class="badge" style="background:rgba(34,197,94,0.1);color:#4ade80;font-size:0.72rem;padding:2px 7px;border-radius:4px;">🟢 Aktiv</span>';

      // Aktionsbutton
      var actionBtn = b.isBlocked
        ? '<button onclick="window.BotSecurityUI.unblockBot(\'' + esc(b.id) + '\', \'' + esc(b.ip) + '\')" class="btn btn-sm btn-success" style="font-size:0.75rem;padding:5px 10px;border-radius:6px;cursor:pointer;">✅ Freigeben</button>'
        : '<button onclick="window.BotSecurityUI.blockBot(\'' + esc(b.id) + '\', \'' + esc(b.ip) + '\', \'' + esc(b.botName) + '\')" class="btn btn-sm btn-danger" style="font-size:0.75rem;padding:5px 10px;border-radius:6px;background:#ef4444;color:#fff;border:none;cursor:pointer;">⛔ Traffic verbieten</button>';

      // Pfade-Snippet
      var pathInfo = b.lastPath ? '<div style="font-size:0.72rem;color:#94a3b8;margin-top:3px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;max-width:200px;" title="' + esc(b.lastPath) + '">🎯 ' + esc(b.lastPath) + '</div>' : '';

      return '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">' +
        // Spalte 1: Bot & IP
        '<td style="padding:10px 12px;vertical-align:top;">' +
          '<div style="font-weight:700;color:#f8fafc;font-size:0.88rem;display:flex;align-items:center;gap:6px;">' +
            esc(b.botName) + ' ' + statusBadge +
          '</div>' +
          '<div style="font-family:monospace;font-size:0.78rem;color:#38bdf8;margin-top:2px;">' + esc(b.ip) + '</div>' +
          '<div style="font-size:0.72rem;color:#64748b;margin-top:2px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(b.userAgent) + '">' + esc(b.userAgent) + '</div>' +
        '</td>' +

        // Spalte 2: Einstufung
        '<td style="padding:10px 12px;vertical-align:top;">' +
          catBadge +
          '<div style="font-size:0.72rem;color:#94a3b8;margin-top:4px;line-height:1.3;max-width:200px;">' + esc(b.description || '') + '</div>' +
        '</td>' +

        // Spalte 3: Herkunft & Provider
        '<td style="padding:10px 12px;vertical-align:top;">' +
          '<div style="font-weight:600;font-size:0.83rem;color:#e2e8f0;">' + countryLabel + '</div>' +
          '<div style="font-size:0.75rem;color:#94a3b8;margin-top:2px;">' + orgLabel + '</div>' +
        '</td>' +

        // Spalte 4: Scan-Aktivität & Frequenz
        '<td style="padding:10px 12px;vertical-align:top;">' +
          '<div style="font-weight:700;color:#f8fafc;font-size:0.85rem;">' + (b.requestCount || 1).toLocaleString('de-DE') + ' Scans</div>' +
          '<div style="font-size:0.74rem;color:#f59e0b;margin-top:2px;">' + esc(b.scanFrequency) + '</div>' +
          pathInfo +
        '</td>' +

        // Spalte 5: Zuletzt gesehen
        '<td style="padding:10px 12px;vertical-align:top;font-size:0.78rem;color:#94a3b8;white-space:nowrap;">' +
          formatRelativeTime(b.lastSeen) +
        '</td>' +

        // Spalte 6: Aktionen
        '<td style="padding:10px 12px;vertical-align:top;text-align:right;">' +
          actionBtn +
        '</td>' +
      '</tr>';
    }).join('');

    tableBody.innerHTML = html;
  }

  async function blockBot(id, ip, botName) {
    var reason = prompt('Traffic für IP ' + ip + ' (' + botName + ') verbieten?\n\nGrund für Sperrung (optional):', 'Aggressives Scraping / Unerwünschter Bot');
    if (reason === null) return;

    try {
      await apiCall('/security/bots/block', 'POST', {
        id: id,
        ip: ip,
        botName: botName,
        reason: reason.trim() || 'Vom Administrator gesperrt'
      });
      if (typeof showToast === 'function') showToast('⛔ Traffic für ' + ip + ' erfolgreich gesperrt!');
      loadBotSecurity();
    } catch (err) {
      alert('Fehler beim Sperren: ' + err.message);
    }
  }

  async function unblockBot(id, ip) {
    if (!confirm('Traffic für IP ' + ip + ' wieder freigeben?')) return;

    try {
      await apiCall('/security/bots/unblock', 'POST', { id: id, ip: ip });
      if (typeof showToast === 'function') showToast('✅ Traffic für ' + ip + ' wieder freigegeben!');
      loadBotSecurity();
    } catch (err) {
      alert('Fehler beim Entsperren: ' + err.message);
    }
  }

  async function toggleAutoBlock(checkbox) {
    var enabled = checkbox.checked;
    try {
      await apiCall('/security/settings', 'POST', {
        autoBlockScrapers: enabled,
        blockThreshold: 30
      });
      if (typeof showToast === 'function') {
        showToast(enabled ? '🛡️ Auto-Block für aggressive Scraper aktiviert!' : '🔒 Auto-Block deaktiviert');
      }
    } catch (err) {
      checkbox.checked = !enabled;
      alert('Fehler: ' + err.message);
    }
  }

  async function handleManualBlock() {
    var input = document.getElementById('manual-ban-ip');
    var reasonInput = document.getElementById('manual-ban-reason');
    if (!input || !input.value.trim()) {
      alert('Bitte eine IP-Adresse oder ein Bot-Muster eingeben.');
      return;
    }

    var target = input.value.trim();
    var reason = (reasonInput && reasonInput.value.trim()) || 'Manueller Admin-Bann';

    try {
      await apiCall('/security/bots/block', 'POST', {
        ip: target,
        botName: 'Manuell',
        reason: reason
      });
      input.value = '';
      if (reasonInput) reasonInput.value = '';
      if (typeof showToast === 'function') showToast('⛔ ' + target + ' erfolgreich blockiert!');
      loadBotSecurity();
    } catch (err) {
      alert('Fehler beim Sperren: ' + err.message);
    }
  }

  function setCategoryFilter(cat, btn) {
    _secState.category = cat;
    _secState.page = 1;
    document.querySelectorAll('.sec-cat-filter').forEach(function(b) {
      b.style.background = '#1a1a1a';
      b.style.color = '#94a3b8';
      b.style.borderColor = '#333';
    });
    if (btn) {
      btn.style.background = '#1e3a5f';
      btn.style.color = '#93c5fd';
      btn.style.borderColor = '#2563eb';
    }
    loadBotSecurity();
  }

  function setStatusFilter(status, btn) {
    _secState.status = status;
    _secState.page = 1;
    loadBotSecurity();
  }

  function handleSearch(val) {
    _secState.search = val || '';
    _secState.page = 1;
    clearTimeout(handleSearch._t);
    handleSearch._t = setTimeout(loadBotSecurity, 350);
  }

  function showSecSubTab(tab) {
    _secState.activeTab = tab;
    var tabBots = document.getElementById('sec-tab-bots');
    var tabBlacklist = document.getElementById('sec-tab-blacklist');
    var tabFlagged = document.getElementById('sec-tab-flagged');

    var btnBots = document.getElementById('sec-btn-bots');
    var btnBlacklist = document.getElementById('sec-btn-blacklist');
    var btnFlagged = document.getElementById('sec-btn-flagged');

    if (tabBots) tabBots.style.display = tab === 'bots' ? 'block' : 'none';
    if (tabBlacklist) tabBlacklist.style.display = tab === 'blacklist' ? 'block' : 'none';
    if (tabFlagged) tabFlagged.style.display = tab === 'flagged' ? 'block' : 'none';

    var activeStyle = 'background:#1e3a5f;color:#93c5fd;border-color:#2563eb;font-weight:700;';
    var inactiveStyle = 'background:#171717;color:#94a3b8;border-color:#252525;font-weight:normal;';

    if (btnBots) btnBots.style.cssText += tab === 'bots' ? activeStyle : inactiveStyle;
    if (btnBlacklist) btnBlacklist.style.cssText += tab === 'blacklist' ? activeStyle : inactiveStyle;
    if (btnFlagged) btnFlagged.style.cssText += tab === 'flagged' ? activeStyle : inactiveStyle;

    if (tab === 'bots') loadBotSecurity();
    else if (tab === 'blacklist' && typeof loadBlacklist === 'function') loadBlacklist();
    else if (tab === 'flagged' && typeof loadFlaggedChats === 'function') loadFlaggedChats();
  }

  // Global exposieren
  window.BotSecurityUI = {
    loadBotSecurity: loadBotSecurity,
    blockBot: blockBot,
    unblockBot: unblockBot,
    toggleAutoBlock: toggleAutoBlock,
    handleManualBlock: handleManualBlock,
    setCategoryFilter: setCategoryFilter,
    setStatusFilter: setStatusFilter,
    handleSearch: handleSearch,
    showSecSubTab: showSecSubTab
  };

  window.loadBotSecurity = loadBotSecurity;
})();
