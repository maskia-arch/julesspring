/* ════════════════════════════════════════════════════════════════════════════
 *  AI ADMINHELPER – Dashboard (v2.0.1)
 *  AdminHelper-only. Sämtlicher Berater-Code (Chats, Traffic, Coupons, Widget,
 *  Knowledge-Base-Browser, Learning-Queue, Sellauth-Sync) wurde entfernt.
 *  Pflicht-Regel: dieses File enthält weiterhin function renderWeekSchedule().
 * ════════════════════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────────────
var _dashboardInitialized = false;
var _currentKBChannel = null;
var _pushSubscribed   = false;
var _ahChannels       = [];
var _modTab           = 'pending';
var _engTab           = 'diss';

// ── Init / Loading-Gate ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    if (localStorage.getItem('admin_token') && !_dashboardInitialized) initDashboard();
});

async function initDashboard() {
    if (_dashboardInitialized) return;
    _dashboardInitialized = true;
    _showLoadingGate(true);

    // Nur Stats sind kritisch – Gate blockiert nie hart (Render-Cold-Start safe)
    var ok = false, att = 0;
    while (!ok && att < 4) {
        att++;
        try { await updateStats(); ok = true; }
        catch (e) { if (att < 4) await new Promise(function(r){ setTimeout(r, 1000); }); }
    }
    _showLoadingGate(false);

    // Sekundär-Daten parallel, fire-and-forget
    var jobs = [loadOverview, loadSettings, loadChannels];
    Promise.allSettled(jobs.map(function(fn) {
        return Promise.resolve().then(function(){ return (typeof fn === 'function') ? fn() : null; })
            .catch(function(e){ console.warn('[Preload]', e && e.message); });
    }));

    setTimeout(initPushNotifications, 1500);

    clearInterval(window._statsInterval);
    window._statsInterval = setInterval(function(){ _safeRun(updateStats); }, 20000);
}

// ── Stats / KPI-Leiste ──────────────────────────────────────────────────────
async function updateStats() {
    var d = await api.getStats();
    if (!d) throw new Error('Keine Stats vom Server');
    var st  = d.stats || {};
    var sv  = function(id, v){ var el = document.getElementById(id); if (el) el.textContent = v; };
    var num = function(n){ return (parseInt(n || 0) || 0).toLocaleString('de-DE'); };

    sv('s-channels', num(st.totalChannels));
    sv('s-active',   num(st.activeChannels));
    sv('s-members',  num(st.totalMembers));
    sv('s-scam',     num(st.scamEntries));
    sv('s-pending',  num(st.pendingFeedback));
    sv('s-credits',  num(st.creditsUsed));

    var cs = document.getElementById('s-credits-sub');
    if (cs) cs.textContent = st.creditLimit ? ('/ ' + num(st.creditLimit)) : 'verbraucht';
    var pend = document.getElementById('s-pending');
    if (pend && pend.parentElement) pend.parentElement.style.opacity = (st.pendingFeedback > 0) ? '1' : '0.55';
    var mb = document.getElementById('mod-badge');
    if (mb) { mb.textContent = st.pendingFeedback || 0; mb.style.display = (st.pendingFeedback > 0) ? 'inline-block' : 'none'; }
    sv('version-tag', 'v' + (d.version || '?'));
}

// ── Manueller Refresh ───────────────────────────────────────────────────────
async function hardRefresh() {
    var btn = document.getElementById('refresh-btn');
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    api.invalidate();
    try {
        await _safeRun(updateStats);
        var active = document.querySelector('.app-section[style*="block"]');
        if (active) refreshActiveSection(active.id.replace('-section', ''));
        showToast('✅ Daten aktualisiert');
    } catch (e) { showToast('❌ Refresh fehlgeschlagen: ' + e.message); }
    finally { if (btn) { btn.textContent = '↺'; btn.disabled = false; } }
}

// ── Einstellungen (nur AdminHelper-relevant) ────────────────────────────────
async function loadSettings() {
    try {
        var cached = _getCachedSettings();
        if (cached) _applySettings(cached);
        var s = await api.getSettings();
        if (!s) return;
        _saveSettingsCache(s);
        _applySettings(s);
    } catch (e) { console.warn('[Settings]', e.message); }
}
function _applySettings(s) {
    var sv = function(id, v){ var el = document.getElementById(id); if (el && v != null) el.value = v; };
    sv('sellauth-api-key', s.sellauth_api_key);
    sv('sellauth-shop-id', s.sellauth_shop_id);
    sv('sellauth-shop-url', s.sellauth_shop_url);
    sv('webhook-app-url',  s.webhook_url);
    if (typeof loadSmallTalkSettings === 'function') loadSmallTalkSettings(s);
}
function _getCachedSettings() { try { var v = localStorage.getItem('_settings_cache'); return v ? JSON.parse(v) : null; } catch(_) { return null; } }
function _saveSettingsCache(s) { try { localStorage.setItem('_settings_cache', JSON.stringify(s)); } catch(_) {} }
async function saveSettings() {
    var gv = function(id){ var el = document.getElementById(id); return el ? el.value : ''; };
    var settings = {
        sellauth_api_key:  gv('sellauth-api-key'),
        sellauth_shop_id:  gv('sellauth-shop-id'),
        sellauth_shop_url: gv('sellauth-shop-url')
    };
    var wu = gv('webhook-app-url');
    if (wu) settings.webhook_url = wu;
    try { await api.saveSettings(settings); showToast('✅ Einstellungen gespeichert!'); }
    catch (e) { showToast('❌ ' + (e && e.message || 'Fehler beim Speichern')); }
}

// ── Pflicht-Stub (Berater-Wochenplan entfernt, Funktion muss vorhanden sein) ─
function renderWeekSchedule() { /* AdminHelper-only: kein Wochenplan. Stub erfüllt Pflichtregel. */ return; }

// ── Modell-Normalisierung fürs Dropdown (alt → neu) ─────────────────────────
function _normAiModel(v) {
    var r = String(v || '').toLowerCase().trim();
    if (r.indexOf('grok') === 0 || r === 'grok') return 'grok';
    if (r === 'openai' || r.indexOf('gpt-') === 0) return 'openai';
    if (r === 'autoacts-think' || r === 'deepseek-reasoner' || r.indexOf('think') !== -1) return 'autoacts-think';
    return 'autoacts-fast'; // autoacts-fast / deepseek-chat / deepseek-v4-flash / leer
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

async function loadSmallTalkSettings(s) {
    if (!s) return;
    var el;
    if (s.smalltalk_system_prompt) {
        el = document.getElementById('smalltalk-system-prompt');
        if (el) el.value = s.smalltalk_system_prompt;
    }
    el = document.getElementById('smalltalk-model');
    if (el && s.smalltalk_model) el.value = _normAiModel(s.smalltalk_model);
    el = document.getElementById('smalltalk-max-tokens');
    if (el) el.value = s.smalltalk_max_tokens || 200;
    el = document.getElementById('smalltalk-temperature');
    if (el) el.value = s.smalltalk_temperature || 0.8;
    el = document.getElementById('smalltalk-require-approval');
    if (el) el.checked = s.smalltalk_require_approval !== false;

    // Token-Status anzeigen (Quelle: ENV/DB/keine) — Token kommt aus der Server-ENV
    var st = document.getElementById('smalltalk-bot-status');
    if (st) {
        if (s.smalltalk_token_set) {
            st.innerHTML = '<span style="color:#4ade80;font-size:0.78rem;">✅ Token vorhanden (' + (s.smalltalk_token_source === 'env' ? 'ENV-Variable' : 'Datenbank-Altwert') + ')</span>';
        } else {
            st.innerHTML = '<span style="color:#f59e0b;font-size:0.78rem;">⚠️ Kein Token gesetzt — SMALLTALK_BOT_TOKEN in Render setzen</span>';
        }
    }
}

async function saveSmallTalkSettings() {
    var gv = function(id) { var el=document.getElementById(id); return el?el.value:null; };
    var reqApproval = document.getElementById('smalltalk-require-approval')?.checked ?? true;
    try {
        await api.request('/settings', 'POST', {
            smalltalk_system_prompt:   gv('smalltalk-system-prompt'),
            smalltalk_model:           gv('smalltalk-model') || 'autoacts-fast',
            smalltalk_max_tokens:      parseInt(gv('smalltalk-max-tokens')) || 200,
            smalltalk_temperature:     parseFloat(gv('smalltalk-temperature')) || 0.8,
            smalltalk_require_approval: reqApproval
        });
        showToast('✅ Smalltalk-Einstellungen gespeichert!');
    } catch(e) { showToast('❌ ' + (e?.message || 'Unbekannter Fehler')); }
}

async function loadSmallTalkStatus() {
    var statusEl = document.getElementById('smalltalk-bot-status');
    if (!statusEl) return;
    statusEl.innerHTML = '<span style="color:#94a3b8;font-size:0.78rem;">⏳ Verbinde...</span>';
    try {
        var result = await api.request('/smalltalk/status');
        if (result && result.connected && result.bot) {
            statusEl.innerHTML = '<span style="color:#4ade80;font-size:0.78rem;">✅ Verbunden: @' + esc(result.bot.username || '') +
                ' · Quelle: ' + (result.source === 'env' ? 'ENV-Variable' : 'DB') + '</span>';
        } else {
            statusEl.innerHTML = '<span style="color:#ef4444;font-size:0.78rem;">❌ ' + esc((result && result.error) || 'Verbindungsfehler') + '</span>';
        }
    } catch(e) {
        statusEl.innerHTML = '<span style="color:#ef4444;font-size:0.78rem;">❌ ' + esc(e.message) + '</span>';
    }
}

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
    } catch(e) { showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.')); }
}

function _initPaketeTab() {
    if (_pkgTabLoaded) return;
    _pkgTabLoaded = true;
    // Webhook URL
    var wh = document.getElementById('webhook-url-display2');
    if (wh) wh.textContent = window.location.origin + '/api/webhooks/sellauth-packages';
    _safeRun(loadChannelAdminListPkg);
    _safeRun(loadPackagesPkg);
    _safeRun(loadRefillsPkg);
}

async function loadChannelAdminListPkg() {
    var el = document.getElementById('channel-admin-list-pkg'); if (!el) return;
    try {
        var [chs, pkgs] = await Promise.all([api.request('/channels/admin-list'), api.request('/packages')]);
        _allChannels = chs || []; _allPackages = pkgs || [];
        var html = (_allChannels.length ? _allChannels : []).map(function(ch) {
            var used = ch.token_used||0, lim = ch.token_limit||0, pct = lim?Math.min(100,Math.round(used/lim*100)):0;
            var exp = ch.credits_expire_at ? new Date(ch.credits_expire_at).toLocaleDateString('de-DE') : '–';
            var bc = pct>85?'#ef4444':pct>60?'#f59e0b':'#4ade80';
            return '<div style="background:#111;border-radius:8px;padding:12px;margin-bottom:8px;">' +
                '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
                    '<div style="font-weight:700;">'+(ch.title||ch.id)+'</div>' +
                    '<div style="font-size:0.7rem;color:'+(ch.ai_enabled?'#4ade80':'#ef4444')+';">'+(ch.ai_enabled?'✅':'❌')+'</div>' +
                '</div>' +
                '<div style="font-size:0.72rem;color:#64748b;margin-bottom:6px;">'+used.toLocaleString()+' / '+lim.toLocaleString()+' Credits · Bis: '+exp+'</div>' +
                '<div style="height:4px;background:#1a1a1a;border-radius:2px;margin-bottom:8px;"><div style="height:4px;width:'+pct+'%;background:'+bc+';border-radius:2px;"></div></div>' +
                '<div style="display:flex;gap:6px;">' +
                    '<button onclick="openChannelEditPkg('+JSON.stringify(ch.id)+')" style="background:#1e3a5f;color:#60a5fa;border:none;border-radius:4px;padding:4px 10px;font-size:0.75rem;cursor:pointer;">✏️ Credits/Laufzeit</button>' +
                    '<button onclick="openPackageBookPkg('+JSON.stringify(ch.id)+')" style="background:#14532d;color:#4ade80;border:none;border-radius:4px;padding:4px 10px;font-size:0.75rem;cursor:pointer;">📦 Paket buchen</button>' +
                '</div></div>';
        }).join('') || '<p style="color:#555;font-size:0.85rem;">Keine Channels.</p>';
        el.innerHTML = html;
    } catch(e) { if (el) el.innerHTML = '<p style="color:#ef4444;">'+esc(String(e))+'</p>'; }
}

function openChannelEditPkg(channelId) {
    var ch = _allChannels.find(function(c){ return c.id===channelId; });
    document.getElementById('ch-edit-id-pkg').value = channelId;
    if (ch) {
        document.getElementById('ch-edit-credits-pkg').value = ch.token_limit||'';
        document.getElementById('ch-edit-expires-pkg').value = ch.credits_expire_at ? ch.credits_expire_at.split('T')[0] : '';
        document.getElementById('ch-edit-ai-pkg').checked = !!ch.ai_enabled;
        document.getElementById('ch-edit-name-pkg').textContent = ch.title||channelId;
    }
    document.getElementById('ch-edit-form-pkg').style.display = 'block';
    document.getElementById('ch-pkg-form-pkg').style.display = 'none';
}

function openPackageBookPkg(channelId) {
    var ch = _allChannels.find(function(c){ return c.id===channelId; });
    document.getElementById('ch-pkg-id-pkg').value = channelId;
    document.getElementById('ch-pkg-name-pkg').textContent = ch?.title||channelId;
    var sel = document.getElementById('ch-pkg-select-pkg');
    sel.innerHTML = _allPackages.map(function(p){ return '<option value="'+p.id+'">'+esc(p.name)+' — '+p.credits.toLocaleString()+' Credits · '+parseFloat(p.price_eur).toFixed(2)+'€</option>'; }).join('');
    document.getElementById('ch-pkg-form-pkg').style.display = 'block';
    document.getElementById('ch-edit-form-pkg').style.display = 'none';
}

async function saveChannelEditPkg() {
    var channelId=document.getElementById('ch-edit-id-pkg').value;
    var credits=document.getElementById('ch-edit-credits-pkg').value;
    var expires=document.getElementById('ch-edit-expires-pkg').value;
    var aiEnabled=document.getElementById('ch-edit-ai-pkg').checked;
    var resetUsed=document.getElementById('ch-edit-reset-pkg').checked;
    try {
        await api.request('/channels/manual-credits','POST',{channelId,credits:credits||undefined,expiresAt:expires?expires+'T00:00:00.000Z':undefined,aiEnabled,resetUsed});
        showToast('✅ Channel gespeichert!');
        document.getElementById('ch-edit-form-pkg').style.display='none';
        loadChannelAdminListPkg();
    } catch(e) { showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.')); }
}

async function savePackageBookPkg() {
    var channelId=document.getElementById('ch-pkg-id-pkg').value;
    var packageId=document.getElementById('ch-pkg-select-pkg').value;
    if (!packageId) { alert('Bitte Paket wählen'); return; }
    if (!confirm('Paket manuell buchen?')) return;
    try {
        var r=await api.request('/channels/manual-package','POST',{channelId,packageId});
        showToast('✅ Paket gebucht! '+r.credits.toLocaleString()+' Credits bis '+new Date(r.expiresAt).toLocaleDateString('de-DE'));
        document.getElementById('ch-pkg-form-pkg').style.display='none';
        loadChannelAdminListPkg();
    } catch(e) { showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.')); }
}

async function loadPackagesPkg() {
    var el=document.getElementById('packages-list-pkg'); if(!el) return;
    var wh=document.getElementById('webhook-url-display2'); if(wh) wh.textContent=window.location.origin+'/api/webhooks/sellauth-packages';
    try {
        var pkgs=await api.request('/packages')||[];
        _allPackages=pkgs;
        if(!pkgs.length){el.innerHTML='<p style="color:#555;font-size:0.85rem;">Keine Pakete. Starter, Pro, Ultimate anlegen.</p>';return;}
        el.innerHTML=pkgs.map(function(p){
            return '<div style="background:#111;border-radius:6px;padding:10px;margin-bottom:6px;display:flex;align-items:center;gap:8px;">' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:700;color:#60a5fa;">'+esc(p.name)+'</div>' +
                    '<div style="font-size:0.75rem;color:#94a3b8;">'+(p.credits||0).toLocaleString()+' Credits · '+parseFloat(p.price_eur||0).toFixed(2)+' €</div>' +
                    (p.sellauth_product_id?'<div style="font-size:0.68rem;color:#555;">P:'+esc(String(p.sellauth_product_id))+' V:'+esc(String(p.sellauth_variant_id||'–'))+'</div>':'<div style="font-size:0.68rem;color:#ef4444;">⚠️ Variant-ID fehlt</div>') +
                '</div>' +
                '<button onclick="editPackagePkg('+JSON.stringify(p).replace(/"/g,"&quot;")+')" style="background:#1e3a5f;color:#60a5fa;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:0.75rem;">✏️</button>' +
                '<button onclick="deletePackagePkg(\''+p.id+'\')" class="icon-btn">🗑</button>' +
            '</div>';
        }).join('');
    } catch(e) { el.innerHTML='<p style="color:#ef4444;">'+esc(String(e))+'</p>'; }
}

function showPackageFormPkg(pkg) { document.getElementById('package-edit-form-pkg').style.display='block'; if(!pkg){['pkg-id-pkg','pkg-name-pkg','pkg-price-pkg','pkg-credits-pkg','pkg-desc-pkg','pkg-product-id-pkg','pkg-variant-id-pkg'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});document.getElementById('pkg-days-pkg').value=30;}}

function hidePackageFormPkg() { document.getElementById('package-edit-form-pkg').style.display='none'; }

function editPackagePkg(p) { showPackageFormPkg(p); document.getElementById('pkg-id-pkg').value=p?.id||''; document.getElementById('pkg-name-pkg').value=p?.name||''; document.getElementById('pkg-price-pkg').value=p?.price_eur||''; document.getElementById('pkg-credits-pkg').value=p?.credits||''; document.getElementById('pkg-desc-pkg').value=p?.description||''; document.getElementById('pkg-product-id-pkg').value=p?.sellauth_product_id||''; document.getElementById('pkg-variant-id-pkg').value=p?.sellauth_variant_id||''; document.getElementById('pkg-days-pkg').value=p?.duration_days||30; }

async function loadVariantsPkg() {
    var pid=document.getElementById('pkg-product-id-pkg').value.trim();
    if(!pid){alert('Bitte zuerst die Product-ID eingeben');return;}
    var sel=document.getElementById('pkg-variant-lookup-pkg');
    sel.innerHTML='<option>Lädt…</option>';
    try {
        var data=await api.request('/sellauth/product/'+pid+'/variants');
        if(!data.variants?.length){sel.innerHTML='<option>Keine Varianten gefunden</option>';return;}
        sel.innerHTML=data.variants.map(function(v){return '<option value="'+v.id+'">'+esc(v.name)+' (ID: '+v.id+') — '+parseFloat(v.price||0).toFixed(2)+' €</option>';}).join('');
        sel.onchange=function(){document.getElementById('pkg-variant-id-pkg').value=sel.value;};
        showToast('✅ '+data.variants.length+' Varianten geladen für "'+esc(data.product_name)+'"');
    } catch(e) { sel.innerHTML='<option>Fehler: '+esc(e.message)+'</option>'; }
}

async function savePackagePkg() {
    var id=document.getElementById('pkg-id-pkg').value; var name=document.getElementById('pkg-name-pkg').value.trim();
    var price=document.getElementById('pkg-price-pkg').value; var credits=document.getElementById('pkg-credits-pkg').value;
    var desc=document.getElementById('pkg-desc-pkg').value.trim(); var prodId=document.getElementById('pkg-product-id-pkg').value.trim();
    var varId=document.getElementById('pkg-variant-id-pkg').value.trim(); var days=document.getElementById('pkg-days-pkg').value||30;
    if(!name||!price||!credits){alert('Name, Preis und Credits sind Pflicht');return;}
    try { await api.request('/packages','POST',{id:id||undefined,name,price_eur:price,credits,description:desc||null,sellauth_product_id:prodId||null,sellauth_variant_id:varId||null,duration_days:parseInt(days)}); showToast('✅ Paket gespeichert!'); hidePackageFormPkg(); loadPackagesPkg(); } catch(e){showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.'));}
}

async function deletePackagePkg(id) { if(!confirm('Paket löschen?'))return; try{await api.request('/packages/'+id,'DELETE');loadPackagesPkg();}catch(e){showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.'));} }

async function loadRefillsPkg() {
    var el=document.getElementById('refills-list-pkg'); if(!el) return;
    try {
        var list=await api.request('/refills')||[];
        if(!list.length){el.innerHTML='<p style="color:#555;font-size:0.85rem;">Keine Refill-Optionen.</p>';return;}
        el.innerHTML=list.map(function(r){
            return '<div style="background:#111;border-radius:6px;padding:10px;margin-bottom:6px;display:flex;align-items:center;gap:8px;">' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:700;color:#4ade80;">🔋 '+esc(r.name)+'</div>' +
                    '<div style="font-size:0.75rem;color:#94a3b8;">+'+r.credits.toLocaleString()+' Credits · '+parseFloat(r.price_eur||0).toFixed(2)+' €</div>' +
                    (r.sellauth_variant_id?'<div style="font-size:0.68rem;color:#555;">P:'+esc(String(r.sellauth_product_id||'–'))+' V:'+esc(String(r.sellauth_variant_id))+'</div>':'<div style="font-size:0.68rem;color:#ef4444;">⚠️ Variant-ID fehlt</div>') +
                '</div>' +
                '<button onclick="editRefillPkg('+JSON.stringify(r).replace(/"/g,"&quot;")+')" style="background:#1e3a5f;color:#60a5fa;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:0.75rem;">✏️</button>' +
                '<button onclick="deleteRefillPkg(\''+r.id+'\')" class="icon-btn">🗑</button>' +
            '</div>';
        }).join('');
    } catch(e) { el.innerHTML='<p style="color:#ef4444;">'+esc(String(e))+'</p>'; }
}

function showRefillFormPkg(r) { document.getElementById('refill-edit-form-pkg').style.display='block'; }

function hideRefillFormPkg() { document.getElementById('refill-edit-form-pkg').style.display='none'; }

function editRefillPkg(r) { showRefillFormPkg(r); document.getElementById('rf-id-pkg').value=r?.id||''; document.getElementById('rf-name-pkg').value=r?.name||''; document.getElementById('rf-price-pkg').value=r?.price_eur||''; document.getElementById('rf-credits-pkg').value=r?.credits||''; document.getElementById('rf-desc-pkg').value=r?.description||''; document.getElementById('rf-product-id-pkg').value=r?.sellauth_product_id||''; document.getElementById('rf-variant-id-pkg').value=r?.sellauth_variant_id||''; }

async function loadVariantsRefillPkg() {
    var pid=document.getElementById('rf-product-id-pkg').value.trim();
    if(!pid){alert('Bitte zuerst Product-ID eingeben');return;}
    var sel=document.getElementById('rf-variant-lookup-pkg');
    sel.innerHTML='<option>Lädt…</option>';
    try {
        var data=await api.request('/sellauth/product/'+pid+'/variants');
        if(!data.variants?.length){sel.innerHTML='<option>Keine Varianten</option>';return;}
        sel.innerHTML=data.variants.map(function(v){return '<option value="'+v.id+'">'+esc(v.name)+' (ID: '+v.id+') — '+parseFloat(v.price||0).toFixed(2)+' €</option>';}).join('');
        sel.onchange=function(){document.getElementById('rf-variant-id-pkg').value=sel.value;};
        showToast('✅ '+data.variants.length+' Varianten geladen');
    } catch(e) { sel.innerHTML='<option>Fehler: '+esc(e.message)+'</option>'; }
}

async function saveRefillPkg() {
    var id=document.getElementById('rf-id-pkg').value; var name=document.getElementById('rf-name-pkg').value.trim();
    var price=document.getElementById('rf-price-pkg').value; var credits=document.getElementById('rf-credits-pkg').value;
    var desc=document.getElementById('rf-desc-pkg').value.trim(); var prodId=document.getElementById('rf-product-id-pkg').value.trim();
    var varId=document.getElementById('rf-variant-id-pkg').value.trim();
    if(!name||!price||!credits){alert('Name, Preis und Credits sind Pflicht');return;}
    try { await api.request('/refills','POST',{id:id||undefined,name,price_eur:price,credits,description:desc||null,sellauth_product_id:prodId||null,sellauth_variant_id:varId||null}); showToast('✅ Refill gespeichert!'); hideRefillFormPkg(); loadRefillsPkg(); } catch(e){showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.'));}
}

async function deleteRefillPkg(id) { if(!confirm('Refill löschen?'))return; try{await api.request('/refills/'+id,'DELETE');loadRefillsPkg();}catch(e){showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.'));} }

async function loadProUsers() {
    var el = document.getElementById('userinfo-pro-list');
    if (!el) return;
    try {
        var list = await api.request('/userinfo-pro') || [];
        if (!list.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Keine Pro-Nutzer.</p>'; return; }
        el.innerHTML = list.map(function(u) {
            var exp = u.expires_at ? new Date(u.expires_at).toLocaleDateString('de-DE') : '∞';
            return '<div style="background:#111;border-radius:6px;padding:10px;margin-bottom:6px;display:flex;align-items:center;gap:8px;">' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:700;">' + (u.username ? '@'+esc(u.username) : esc(String(u.user_id))) + '</div>' +
                    '<div style="font-size:0.7rem;color:#64748b;">ID: ' + esc(String(u.user_id)) + ' · Läuft ab: ' + exp + (u.note ? ' · '+esc(u.note) : '') + '</div>' +
                '</div>' +
                '<button onclick="removeProUser(\''+u.user_id+'\')" class="icon-btn">🗑</button>' +
            '</div>';
        }).join('');
    } catch(e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function addProUser() {
    var uid  = document.getElementById('ui-pro-id')?.value?.trim();
    var uname= document.getElementById('ui-pro-username')?.value?.trim();
    var note = document.getElementById('ui-pro-note')?.value?.trim();
    var exp  = document.getElementById('ui-pro-expires')?.value;
    if (!uid) { alert('Telegram ID erforderlich'); return; }
    try {
        await api.request('/userinfo-pro', 'POST', {
            user_id: parseInt(uid), username: uname||null,
            note: note||null, expires_at: exp||null
        });
        showToast('✅ Pro-Nutzer hinzugefügt!');
        ['ui-pro-id','ui-pro-username','ui-pro-note','ui-pro-expires'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
        loadProUsers();
    } catch(e) { showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.')); }
}

async function removeProUser(userId) {
    if (!confirm('Pro-Zugang entfernen?')) return;
    try { await api.request('/userinfo-pro/'+userId, 'DELETE'); loadProUsers(); }
    catch(e) { showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.')); }
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
    catch(e) { showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.')); }
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

async function triggerGlobalReset() {
    if (!confirm("WARNUNG: Möchtest du wirklich, dass der Bot aus ALLEN Gruppen austritt und alle Gruppen aus dem Dashboard gelöscht werden? Dies kann nicht rückgängig gemacht werden!")) {
        return;
    }
    var el = document.getElementById('channel-list');
    if (el) el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">⏳ Verlasse Gruppen und setze zurück...</p>';
    try {
        var result = await api.request('/channels/reset-leave-all', 'POST');
        alert("Reset erfolgreich! Der Bot ist aus " + (result.leftCount || 0) + " von " + (result.count || 0) + " Gruppen ausgetreten.");
    } catch(e) {
        alert("Fehler beim Reset: " + (e.message || String(e)));
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
                '<div style="margin-bottom:8px;">' +
                    '<label style="font-size:0.7rem;color:#64748b;display:block;margin-bottom:3px;">Credit-Budget (bestehend: ' + (ch.token_limit ? ch.token_limit.toLocaleString() : '–') + ')</label>' +
                    '<input type="number" class="ch-tlimit" data-id="'+ch.id+'" value="'+(ch.token_limit||'')+'" placeholder="Kein Limit" style="width:100%;padding:5px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;">' +
                '</div>' +

                // Cost display — nur Credits, keine USD-Angaben
                '<div style="background:#0d1117;border-radius:6px;padding:8px;margin-bottom:8px;font-size:0.75rem;">' +
                    '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:#64748b;">Credits verbraucht:</span><span>' + ((ch.token_used||0)).toLocaleString() + (ch.token_limit ? ' / ' + ch.token_limit.toLocaleString() : '') + '</span></div>' +
                    (ch.token_limit ? '<div style="height:4px;background:#1e1e1e;border-radius:2px;margin-bottom:4px;"><div style="height:100%;width:'+tokenPct+'%;background:'+barColor+';border-radius:2px;"></div></div>' : '') +
                    (ch.credits_expire_at ? '<div style="display:flex;justify-content:space-between;"><span style="color:#64748b;">Gültig bis:</span><span>' + new Date(ch.credits_expire_at).toLocaleDateString("de-DE") + '</span></div>' : '') +
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
                        '<div style="margin-bottom:5px;">' +
                            '<label style="font-size:0.7rem;color:#64748b;display:block;margin-bottom:2px;">KI-Modell</label>' +
                            '<select class="ch-aimodel" data-id="'+ch.id+'" style="width:100%;padding:5px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;font-size:0.8rem;">' +
                                (function(cur){ var n=_normAiModel(cur); function o(v,l){return '<option value="'+v+'"'+(n===v?' selected':'')+'>'+l+'</option>';} return o('autoacts-fast','AutoActsAi Fast (\u00d71.0)')+o('autoacts-think','AutoActsAi Think (\u00d71.25)')+o('openai','OpenAI (\u00d71.2)')+o('grok','Grok AI (\u00d71.5)'); })(ch.ai_model) +
                            '</select>' +
                        '</div>' +
                        '<button class="btn btn-secondary btn-sm ch-kb" data-id="'+ch.id+'" style="width:100%;margin-bottom:5px;">📚 Wissen ('+ch.kb_entry_count+' Einträge)</button>' +
                    '</div>' +
                '</div>' +

                // Action buttons
                '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
                    '<button class="btn btn-secondary btn-sm ch-schedule" data-id="'+ch.id+'" style="flex:1;">⏰ Geplant</button>' +
                    '<button class="btn btn-secondary btn-sm ch-scamlist" data-id="'+ch.id+'" style="flex:1;">⛔ Scamliste</button>' +
                    '<button class="btn btn-secondary btn-sm ch-safelist" data-id="'+ch.id+'" style="flex:1;opacity:'+(ch.ai_enabled?'1':'0.4')+';pointer-events:'+(ch.ai_enabled?'auto':'none')+';">🛡 Safelist</button>' +
                '</div>' +
                // Safelist + Feedback Toggles
                '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
                    '<button class="btn btn-sm ch-safelist-toggle" data-id="'+ch.id+'" data-sl="'+(ch.safelist_enabled?'1':'0')+'" style="flex:1;font-size:0.72rem;background:'+(ch.safelist_enabled?'#14532d':'#1e1e1e')+';color:'+(ch.safelist_enabled?'#4ade80':'#64748b')+';border:1px solid #333;border-radius:6px;padding:5px;cursor:pointer;">'+(ch.safelist_enabled?'🛡 Safelist: AN':'🛡 Safelist: AUS')+'</button>' +
                    '<button class="btn btn-sm ch-feedback-toggle" data-id="'+ch.id+'" data-fb="'+(ch.feedback_enabled?'1':'0')+'" style="flex:1;font-size:0.72rem;background:'+(ch.feedback_enabled?'#1e3a5f':'#1e1e1e')+';color:'+(ch.feedback_enabled?'#60a5fa':'#64748b')+';border:1px solid #333;border-radius:6px;padding:5px;cursor:pointer;">'+(ch.feedback_enabled?'💬 Feedback: AN':'💬 Feedback: AUS')+'</button>' +
                '</div>' +
                '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
                    '<button onclick="openPkgBookChannel('+JSON.stringify(ch.id)+')" style="flex:1;background:#14532d;color:#4ade80;border:none;border-radius:6px;padding:6px;cursor:pointer;font-size:0.8rem;">📦 Paket buchen</button>' +
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
                   .catch(function(e){ showToast('❌ ' + (e?.message || 'Fehler')); });
            }
            var fbTog = e.target.closest('.ch-feedback-toggle');
            if (fbTog) {
                var enableFb = fbTog.dataset.fb !== '1';
                api.request('/channels/' + fbTog.dataset.id + '/ai', 'PUT', { feedback_enabled: enableFb })
                   .then(function(){ showToast(enableFb ? '💬 Feedback-Erkennung aktiviert!' : '💬 Feedback-Erkennung deaktiviert'); loadChannels(); })
                   .catch(function(e){ showToast('❌ ' + (e?.message || 'Fehler')); });
            }
            if (safeEl) openSafelistModal(safeEl.dataset.id);
            if (approve) approveChannel(approve.dataset.id);
            if (reset)   resetChannelUsage(reset.dataset.id);
            if (del)     deleteChannel(del.dataset.id);
            if (kb)      openChannelKB(kb.dataset.id, '');
        });
        el.addEventListener('change', function(e) {
            var mode    = e.target.closest('.ch-mode');
            var aimodel = e.target.closest('.ch-aimodel');
            if (mode)    updateChannel(mode.dataset.id,    { mode:     mode.value    });
            if (aimodel) {
                api.request('/channels/' + aimodel.dataset.id + '/ai', 'PUT', { ai_model: aimodel.value })
                   .then(function(){ showToast('✅ Modell: ' + aimodel.value); })
                   .catch(function(e){ showToast('❌ ' + (e?.message || e?.error || 'Fehler. Bitte nochmal versuchen.')); });
            }
        });
        el.addEventListener('blur', function(e) {
            var cmd = e.target.closest('.ch-cmd');
            var tl  = e.target.closest('.ch-tlimit');
            var lm  = e.target.closest('.ch-limitmsg');
            var sp  = e.target.closest('.ch-sysprompt');
            if (cmd) updateChannel(cmd.dataset.id, { ai_command:    cmd.value });
            if (tl)  updateChannel(tl.dataset.id,  { token_limit:   tl.value  });

            if (lm)  updateChannel(lm.dataset.id,  { limit_message: lm.value  });
            if (sp)  updateChannel(sp.dataset.id,  { system_prompt: sp.value  });
        }, true);

    } catch(e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message)+'</p>'; }
}

function closeChannelKB() { var m=document.getElementById('channel-kb-modal'); if(m) m.style.display='none'; }

async function openPkgBookChannel(channelId) {
    var ch = (_allChannels || []).find(function(x){ return x.id === channelId; });
    var pkgs;
    try { pkgs = await api.request('/packages'); } catch(_) { pkgs = []; }
    if (!pkgs || !pkgs.length) { alert('Keine Pakete angelegt. Bitte zuerst unter Pakete > Channel-Pakete anlegen.'); return; }

    // Build modal overlay
    var overlay = document.createElement('div');
    overlay.id = 'pkg-book-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML =
        '<div style="background:#111;border-radius:12px;padding:20px;width:100%;max-width:400px;border:1px solid #1e3a5f;">' +
            '<div style="font-weight:700;color:#4ade80;margin-bottom:12px;font-size:1rem;">📦 Paket buchen für ' + esc((ch && ch.title) || channelId) + '</div>' +
            '<select id="pkg-book-select" style="width:100%;padding:10px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;margin-bottom:12px;">' +
                pkgs.map(function(p){
                    return '<option value="'+p.id+'">'+esc(p.name)+' — '+p.credits.toLocaleString()+' Credits · '+parseFloat(p.price_eur).toFixed(2)+'€ · '+( p.duration_days||30)+'d</option>';
                }).join('') +
            '</select>' +
            '<p style="font-size:0.75rem;color:#64748b;margin-bottom:12px;">Bucht das Paket manuell (kostenfrei). Credits werden sofort aktiviert.</p>' +
            '<div style="display:flex;gap:8px;">' +
                '<button onclick="confirmPkgBookChannel('+JSON.stringify(channelId)+')" style="flex:1;padding:10px;background:#14532d;color:#4ade80;border:none;border-radius:6px;cursor:pointer;font-weight:700;">✅ Buchen</button>' +
                '<button onclick="document.getElementById(\"pkg-book-overlay\").remove()" style="flex:1;padding:10px;background:#1a1a1a;color:#94a3b8;border:none;border-radius:6px;cursor:pointer;">Abbrechen</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(overlay);
}

async function confirmPkgBookChannel(channelId) {
    var packageId = document.getElementById('pkg-book-select')?.value;
    if (!packageId) return;
    document.getElementById('pkg-book-overlay')?.remove();
    try {
        var r = await api.request('/channels/manual-package', 'POST', { channelId, packageId });
        showToast('✅ Paket gebucht! ' + r.credits.toLocaleString() + ' Credits, läuft bis ' + new Date(r.expiresAt).toLocaleDateString('de-DE'));
        if (typeof loadChannels === 'function') loadChannels();
    } catch(e) { alert('Fehler: ' + (e.message || String(e))); }
}

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
    } catch(e) { showToast('❌ ' + (e?.message || 'Unbekannter Fehler')); }
}

async function deleteChannelKBEntry(channelId, entryId) {
    if (!confirm('Eintrag löschen?')) return;
    try {
        await api.request('/channels/' + channelId + '/kb/' + entryId, 'DELETE');
        await loadChannelKBEntries(channelId);
        loadChannels();
    } catch(e) { showToast('❌ ' + (e?.message || 'Unbekannter Fehler')); }
}

async function approveChannel(id) {
    try {
        await api.request('/channels/' + id, 'PUT', { is_approved: true, is_active: true });
        showToast('✅ Channel freigeschaltet!');
        loadChannels();
    } catch(e) { showToast('❌ ' + (e?.message || 'Unbekannter Fehler')); }
}

async function resetChannelUsage(id) {
    if (!confirm('Verbrauch zurücksetzen?')) return;
    try {
        await api.request('/channels/' + id + '/reset-usage', 'POST');
        showToast('✅ Verbrauch zurückgesetzt');
        loadChannels();
    } catch(e) { showToast('❌ ' + (e?.message || 'Unbekannter Fehler')); }
}

async function updateChannel(id, patch) {
    try { await api.request('/channels/' + id, 'PUT', patch); showToast('✅ Gespeichert'); }
    catch(e) { showToast('❌ ' + (e?.message || 'Unbekannter Fehler')); }
}

async function deleteChannel(id) {
    // Channel-Titel für klarere Warnung finden
    var card = document.querySelector('[data-id="' + id + '"]');
    var title = card?.querySelector('.channel-title')?.textContent?.trim()
             || card?.querySelector('h3, h4, b, strong')?.textContent?.trim()
             || id;

    var warning =
        '⚠️ Channel "' + title + '" wirklich löschen?\n\n' +
        'Folgendes passiert:\n' +
        '• Der Bot verlässt die Gruppe/den Channel\n' +
        '• ALLE Daten dieses Channels werden permanent gelöscht:\n' +
        '   – Wissens-Einträge & Kontext\n' +
        '   – Co-Admins, Safelist, Blacklist\n' +
        '   – Activity-Tracker Punkte\n' +
        '   – Geplante & wiederholende Nachrichten\n' +
        '   – Credit-Log & gekaufte Pakete\n' +
        '   – Moderations-Historie, Feedback, Statistiken\n\n' +
        'Diese Aktion ist NICHT umkehrbar.';

    if (!confirm(warning)) return;

    var btn = card?.querySelector('.delete-channel-btn, [onclick*="deleteChannel"]');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

    try {
        var result = await api.request('/channels/' + id, 'DELETE');
        var r = result?.report || {};

        // Erfolgs-Meldung mit Detail-Statistik
        var msg = '✅ Channel "' + title + '" entfernt';
        if (r.leaveChat?.ok)         msg += ' • Bot hat Gruppe verlassen';
        else if (r.leaveChat?.error) msg += ' • Bot konnte Gruppe nicht verlassen (' +
                                       String(r.leaveChat.error).substring(0, 50) + ')';
        if (r.tables?.cleaned !== undefined) {
            msg += ' • ' + r.tables.cleaned + ' Tabellen bereinigt';
            if (r.tables.failed > 0) msg += ' (' + r.tables.failed + ' Fehler)';
        }
        showToast(msg);

        // Fehlgeschlagene Tabellen in Console für Debug
        if (r.tables?.details?.length) {
            var failures = r.tables.details.filter(function(d) { return d.status === 'error'; });
            if (failures.length) console.warn('[deleteChannel] Fehler in Tabellen:', failures);
        }

        loadChannels();
    } catch(e) {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        showToast('❌ Löschen fehlgeschlagen: ' + (e?.message || 'Unbekannter Fehler'));
    }
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

async function initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('[Push] Nicht unterstützt in diesem Browser');
        _updatePushUI('unsupported');
        return;
    }

    // Permission-State sofort prüfen — wenn explizit verweigert, klare UX
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        _updatePushUI('denied');
        return;
    }

    try {
        // Service Worker registrieren (idempotent)
        var reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // Bestehende Subscription prüfen
        var existing = await reg.pushManager.getSubscription();
        if (existing) {
            // Subscription beim Backend re-syncen — der Server hat sie vielleicht
            // wegen 410/expired bereits gelöscht. Idempotenter Insert (Backend
            // dedupliziert via endpoint).
            try {
                await api.request('/push-subscription', 'POST',
                    { subscription: existing.toJSON() });
            } catch (resyncErr) {
                console.warn('[Push] Re-Sync mit Backend fehlgeschlagen:', resyncErr.message);
            }
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
        // 1. Permission explizit anfragen — sonst wirft pushManager.subscribe()
        //    bei "default" oder "denied" einen kryptischen NotAllowedError.
        if (typeof Notification !== 'undefined') {
            var perm = Notification.permission;
            if (perm !== 'granted') {
                perm = await Notification.requestPermission();
                if (perm !== 'granted') {
                    if (perm === 'denied') {
                        alert('Du hast Benachrichtigungen blockiert.\n\nSo aktivierst du sie:\n• Klicke das 🔒-Symbol in der Adresszeile\n• Benachrichtigungen → Zulassen\n• Seite neu laden');
                        _updatePushUI('denied');
                    } else {
                        _updatePushUI('unsubscribed');
                    }
                    return;
                }
            }
        }

        var reg = await navigator.serviceWorker.ready;

        // 2. VAPID Public Key vom Server laden
        var keyData = await api.request('/push/vapid-key');
        if (!keyData?.publicKey) {
            alert('VAPID_PUBLIC_KEY fehlt in den Server-Einstellungen. Bitte in Render.com Environment Variables setzen.');
            return;
        }

        // 3. Sicherstellen dass keine alte Subscription mehr existiert
        //    (sonst kann subscribe() InvalidStateError werfen)
        var oldSub = await reg.pushManager.getSubscription();
        if (oldSub) {
            try { await oldSub.unsubscribe(); } catch(_) {}
        }

        // 4. Subscription erstellen
        var subscription = await reg.pushManager.subscribe({
            userVisibleOnly:      true,
            applicationServerKey: _urlBase64ToUint8Array(keyData.publicKey)
        });

        // 5. Subscription an Server senden
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
            _updatePushUI('denied');
        } else if (e.name === 'AbortError') {
            alert('Push-Service nicht verfügbar. Versuche es später erneut oder nutze einen anderen Browser.');
            _updatePushUI('error');
        } else {
            alert('Push-Aktivierung fehlgeschlagen: ' + e.message);
            _updatePushUI('error');
        }
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
        showToast('❌ ' + (e?.message || 'Unbekannter Fehler'));
    }
}

async function sendTestPush() {
    try {
        await api.request('/push/test', 'POST');
        showToast('📨 Test-Benachrichtigung gesendet!');
    } catch(e) {
        showToast('❌ ' + (e?.message || 'Unbekannter Fehler'));
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
    } else if (status === 'denied') {
        html = '<div style="color:#fbbf24;font-size:0.875rem;">' +
            '🚫 Benachrichtigungen sind im Browser <b>blockiert</b>.<br>' +
            '<span style="color:#94a3b8;font-size:0.8rem;">Klicke auf das 🔒-Symbol links neben der URL → Benachrichtigungen → <b>Zulassen</b> → Seite neu laden.</span>' +
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

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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

function _getOrCreateModal(id) {
    var m = document.getElementById(id);
    if (!m) {
        m = document.createElement('div');
        m.id = id;
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99990;' +
            'display:none;align-items:flex-end;justify-content:center;';
        m.addEventListener('click', function(e) { if (e.target === m) m.style.display = 'none'; });
        document.body.appendChild(m);
    }
    return m;
}

function _closeModal(id) { var m = document.getElementById(id); if (m) m.style.display = 'none'; }

function loadChannelCosts() { return Promise.resolve(); }

async function _ahLoadChannels(force) {
    if (_ahChannels.length && !force) return _ahChannels;
    try { _ahChannels = await api.request('/channels') || []; } catch (_) { _ahChannels = []; }
    return _ahChannels;
}

async function _fillChannelSelect(selectId, opts) {
    opts = opts || {};
    var sel = document.getElementById(selectId);
    if (!sel) return;
    var chans = await _ahLoadChannels(opts.force);
    var cur = sel.value;
    var html = (opts.allOption !== false) ? '<option value="">Alle Channels</option>' : '';
    html += chans.map(function(c) {
        return '<option value="' + esc(String(c.id)) + '">' +
            (c.type === 'channel' ? '📢 ' : '👥 ') + esc(c.title || String(c.id)) + '</option>';
    }).join('');
    sel.innerHTML = html;
    if (cur) sel.value = cur;
}

function refreshActiveSection(id) {
    if (id === 'overview')   _safeRun(loadOverview);
    if (id === 'channels')   _safeRun(loadChannels);
    if (id === 'moderation') _safeRun(function(){ return loadModeration(_modTab); });
    if (id === 'engagement') _safeRun(function(){ return loadEngagement(_engTab); });
    if (id === 'geplant')    _safeRun(loadGeplant);
    if (id === 'settings')   { _safeRun(loadSettings); _safeRun(loadChannels); }
}

async function loadOverview() {
    var grid = document.getElementById('overview-kpi');
    var feedEl = document.getElementById('overview-feed');
    var topEl = document.getElementById('overview-top');
    if (!grid && !feedEl) return;
    try {
        var d = await api.request('/overview');
        if (!d) throw new Error('Keine Daten');
        var k = d.kpi || {};
        var num = function(n) { return (parseInt(n || 0) || 0).toLocaleString('de-DE'); };

        if (grid) {
            var cards = [
                ['📢', 'Channels', num(k.totalChannels), (k.approvedChannels||0) + ' freigeschaltet · ' + (k.pendingChannels||0) + ' offen', '#60a5fa'],
                ['🤖', 'KI aktiv',  num(k.activeChannels), 'von ' + num(k.totalChannels) + ' Channels', '#818cf8'],
                ['👥', 'Mitglieder', num(k.totalMembers), 'erfasst', '#4ade80'],
                ['⛔', 'Scamliste', num(k.scamEntries), num(k.bannedUsers) + ' gebannt', '#ef4444'],
                ['🛡', 'Safeliste', num(k.safelistEntries), 'verifiziert', '#22c55e'],
                ['⚠️', 'Offene Reviews', num(k.pendingFeedback), 'Feedback wartet', k.pendingFeedback > 0 ? '#f59e0b' : '#64748b'],
                ['🔇', 'Spam-Mutes', num(k.activeMutes), num(k.blacklistHits7d) + ' Wort-Treffer (7T)', '#f97316'],
                ['🗣', '@admin-Meldungen', num(k.adminReports7d), 'letzte 7 Tage', '#a78bfa'],
                ['⏰', 'Geplante Msgs', num(k.scheduledActive), 'aktiv', '#38bdf8'],
                ['⚔️', 'Diss-Battles', num(k.dissBattlesTotal), 'gesamt', '#fb7185'],
                ['📚', 'Wissen', num(k.kbEntries), 'KB-Einträge', '#2dd4bf'],
                ['🪙', 'Credits', num(k.creditsUsed), 'verbraucht' + (k.creditLimit ? ' / ' + num(k.creditLimit) : ''), '#fbbf24']
            ];
            grid.innerHTML = cards.map(function(c) {
                return '<div style="background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:14px;">' +
                    '<div style="font-size:1.3rem;">' + c[0] + '</div>' +
                    '<div style="font-size:1.5rem;font-weight:800;color:' + c[4] + ';margin-top:4px;">' + c[2] + '</div>' +
                    '<div style="font-size:0.72rem;color:#94a3b8;font-weight:600;margin-top:2px;">' + c[1] + '</div>' +
                    '<div style="font-size:0.66rem;color:#64748b;margin-top:2px;">' + c[3] + '</div>' +
                '</div>';
            }).join('');
        }

        if (topEl) {
            var tc = d.topChannels || [];
            if (!tc.length) { topEl.innerHTML = '<p style="color:#555;font-size:0.85rem;">Noch keine Daten.</p>'; }
            else topEl.innerHTML = tc.map(function(c) {
                var pct = c.token_limit ? Math.min(100, Math.round((c.token_used||0)/c.token_limit*100)) : 0;
                var col = pct > 85 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#4ade80';
                return '<div style="background:#111;border-radius:8px;padding:10px 12px;margin-bottom:6px;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                        '<span style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (c.type==='channel'?'📢 ':'👥 ') + esc(c.title) + '</span>' +
                        '<span style="font-size:0.78rem;color:#94a3b8;flex-shrink:0;">' + num(c.token_used) + (c.token_limit ? ' / ' + num(c.token_limit) : '') + '</span>' +
                    '</div>' +
                    (c.token_limit ? '<div style="height:5px;background:#1e1e1e;border-radius:3px;margin-top:6px;"><div style="height:100%;width:'+pct+'%;background:'+col+';border-radius:3px;"></div></div>' : '') +
                '</div>';
            }).join('');
        }

        if (feedEl) {
            var feed = d.feed || [];
            if (!feed.length) { feedEl.innerHTML = '<p style="color:#555;font-size:0.85rem;">Keine Aktivität.</p>'; }
            else feedEl.innerHTML = feed.map(function(f) {
                var icons = { report:'🗣', scam:'⛔', feedback_pos:'👍', feedback_neg:'👎' };
                return '<div style="display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid #161616;align-items:flex-start;">' +
                    '<span style="font-size:1rem;">' + (icons[f.kind] || '•') + '</span>' +
                    '<div style="flex:1;min-width:0;">' +
                        '<div style="font-size:0.8rem;color:#e2e8f0;">' + esc(f.text || '') + '</div>' +
                        '<div style="font-size:0.66rem;color:#64748b;">' + esc(f.channel || '') + (f.meta ? ' · ' + esc(String(f.meta)) : '') + ' · ' + (f.ts ? relTime(f.ts) : '') + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }
    } catch (e) {
        if (grid) grid.innerHTML = '<p style="color:#ef4444;font-size:0.85rem;">Übersicht konnte nicht laden: ' + esc(e.message||String(e)) + '</p>';
    }
}

async function loadModeration(tab, btn) {
    _modTab = tab || _modTab || 'pending';
    document.querySelectorAll('#moderation-section .mod-tab-btn').forEach(function(b){ b.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    else { var b2 = document.getElementById('modtab-' + _modTab); if (b2) b2.classList.add('active'); }
    await _fillChannelSelect('mod-channel-filter');
    if (_modTab === 'pending')   return loadModPending();
    if (_modTab === 'scam')      return loadModScam();
    if (_modTab === 'banned')    return loadModBanned();
    if (_modTab === 'spam')      return loadModSpam();
    if (_modTab === 'reports')   return loadModReports();
    if (_modTab === 'blacklist') return loadModBlacklistHits();
}

function _modChannelFilter() { var s = document.getElementById('mod-channel-filter'); return s && s.value ? ('?channel_id=' + encodeURIComponent(s.value)) : ''; }

function _modBox() { return document.getElementById('mod-content'); }

async function loadModPending() {
    var el = _modBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/moderation/pending');
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#4ade80;font-size:0.85rem;padding:8px;">✅ Keine offenen Reviews.</p>'; return; }
        el.innerHTML = rows.map(function(f) {
            var pos = f.feedback_type === 'positive';
            return '<div style="background:#111;border:1px solid '+(pos?'#14532d':'#3a1a1a')+';border-radius:8px;padding:12px;margin-bottom:8px;">' +
                '<div style="display:flex;justify-content:space-between;gap:8px;">' +
                    '<span style="font-weight:700;color:'+(pos?'#4ade80':'#f87171')+';">'+(pos?'👍 Positiv':'👎 Negativ')+'</span>' +
                    '<span style="font-size:0.66rem;color:#64748b;">'+esc(f.channel_title)+'</span>' +
                '</div>' +
                '<div style="font-size:0.8rem;margin-top:4px;">Ziel: <b>'+(f.target_username?'@'+esc(f.target_username):esc(String(f.target_user_id||'?')))+'</b>' +
                    (f.submitted_by_username ? ' · von @'+esc(f.submitted_by_username) : '') + '</div>' +
                (f.feedback_text ? '<div style="font-size:0.78rem;color:#cbd5e1;margin-top:4px;background:#0d1117;border-radius:6px;padding:6px;">'+esc(f.feedback_text)+'</div>' : '') +
                (f.ai_summary ? '<div style="font-size:0.72rem;color:#60a5fa;margin-top:4px;">🤖 '+esc(f.ai_summary)+'</div>' : '') +
                (f.proof_count ? '<div style="font-size:0.7rem;color:#a78bfa;margin-top:3px;">📎 '+f.proof_count+' Beweis(e)</div>' : '') +
                '<div style="display:flex;gap:6px;margin-top:8px;">' +
                    '<button onclick="approveFb('+JSON.stringify(f.id)+')" class="btn btn-success btn-sm" style="flex:1;">✅ Bestätigen</button>' +
                    '<button onclick="rejectFb('+JSON.stringify(f.id)+')" class="btn btn-secondary btn-sm" style="flex:1;">✖ Ablehnen</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function approveFb(id) {
    try { await api.request('/moderation/feedback/'+id+'/approve', 'POST'); showToast('✅ Bestätigt'); loadModPending(); _safeRun(updateStats); }
    catch (e) { showToast('❌ ' + (e?.message || 'Fehler')); }
}

async function rejectFb(id) {
    try { await api.request('/moderation/feedback/'+id+'/reject', 'POST'); showToast('🗑 Abgelehnt'); loadModPending(); _safeRun(updateStats); }
    catch (e) { showToast('❌ ' + (e?.message || 'Fehler')); }
}

async function loadModScam() {
    var el = _modBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/moderation/scam' + _modChannelFilter());
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine Scam-Einträge.</p>'; return; }
        el.innerHTML = rows.map(function(s) {
            return '<div style="background:#111;border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;gap:8px;align-items:flex-start;">' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:700;color:#ef4444;">⛔ '+(s.username?'@'+esc(s.username):esc(String(s.user_id||'?')))+'</div>' +
                    '<div style="font-size:0.68rem;color:#64748b;">'+esc(s.channel_title)+(s.user_id?' · TG-ID '+esc(String(s.user_id)):'')+'</div>' +
                    (s.reason ? '<div style="font-size:0.75rem;color:#94a3b8;margin-top:2px;">'+esc(String(s.reason).substring(0,120))+'</div>' : '') +
                '</div>' +
                '<button onclick="removeScamGlobal('+JSON.stringify(String(s.channel_id))+','+JSON.stringify(String(s.user_id||''))+')" class="icon-btn" style="flex-shrink:0;">🗑</button>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function removeScamGlobal(channelId, userId) {
    if (!userId) { showToast('❌ Keine User-ID'); return; }
    if (!confirm('Von Scamliste entfernen?')) return;
    try { await api.request('/scamlist/remove', 'POST', { channel_id: channelId, user_id: userId }); showToast('✅ Entfernt'); loadModScam(); }
    catch (e) { showToast('❌ ' + (e?.message || 'Fehler')); }
}

async function loadModBanned() {
    var el = _modBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/moderation/banned' + _modChannelFilter());
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine gebannten Nutzer.</p>'; return; }
        el.innerHTML = rows.map(function(s) {
            return '<div style="background:#111;border-radius:8px;padding:10px 12px;margin-bottom:6px;">' +
                '<div style="font-weight:700;color:#f87171;">🚫 '+(s.username?'@'+esc(s.username):esc(String(s.user_id||'?')))+'</div>' +
                '<div style="font-size:0.68rem;color:#64748b;">'+esc(s.channel_title)+(s.created_at?' · '+relTime(s.created_at):'')+'</div>' +
                (s.reason ? '<div style="font-size:0.75rem;color:#94a3b8;margin-top:2px;">'+esc(String(s.reason).substring(0,120))+'</div>' : '') +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function loadModSpam() {
    var el = _modBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/moderation/spam' + _modChannelFilter());
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine Spam-Verstöße.</p>'; return; }
        el.innerHTML = rows.map(function(v) {
            return '<div style="background:#111;border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;align-items:center;">' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:700;">'+(v.is_muted?'🔇':'⚠️')+' User '+esc(String(v.user_id))+'</div>' +
                    '<div style="font-size:0.68rem;color:#64748b;">'+esc(v.channel_title)+' · Warnungen: '+(v.warning_count||0)+(v.last_violation?' · '+relTime(v.last_violation):'')+'</div>' +
                '</div>' +
                (v.is_muted ? '<span style="font-size:0.66rem;background:#3a1a1a;color:#f87171;padding:2px 7px;border-radius:4px;flex-shrink:0;">stumm bis '+new Date(v.muted_until).toLocaleString('de-DE')+'</span>' : '') +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function loadModReports() {
    var el = _modBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/moderation/reports' + _modChannelFilter());
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine @admin-Meldungen.</p>'; return; }
        el.innerHTML = rows.map(function(r) {
            var catCol = { Werbung:'#f59e0b', Scam:'#ef4444', Spam:'#f97316', Beleidigung:'#a78bfa' }[r.ai_category] || '#64748b';
            return '<div style="background:#111;border-radius:8px;padding:10px 12px;margin-bottom:6px;">' +
                '<div style="display:flex;justify-content:space-between;gap:8px;">' +
                    '<span style="font-weight:700;color:'+catCol+';">🗣 '+esc(r.ai_category||'Meldung')+'</span>' +
                    '<span style="font-size:0.66rem;color:#64748b;">'+esc(r.channel_title)+'</span>' +
                '</div>' +
                '<div style="font-size:0.75rem;color:#cbd5e1;margin-top:3px;">Meldung von '+esc(String(r.reporter_name||r.reporter_id||'?'))+(r.target_name?' → '+esc(String(r.target_name)):'')+'</div>' +
                (r.reported_text ? '<div style="font-size:0.74rem;color:#94a3b8;margin-top:3px;background:#0d1117;border-radius:6px;padding:6px;">'+esc(String(r.reported_text).substring(0,160))+'</div>' : '') +
                (r.ai_summary ? '<div style="font-size:0.72rem;color:#60a5fa;margin-top:3px;">🤖 '+esc(r.ai_summary)+'</div>' : '') +
                (r.action_taken && r.action_taken !== 'none' ? '<div style="font-size:0.7rem;color:#fbbf24;margin-top:3px;">⚙️ Aktion: '+esc(r.action_taken)+'</div>' : '') +
                '<div style="font-size:0.64rem;color:#475569;margin-top:3px;">'+(r.created_at?relTime(r.created_at):'')+'</div>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function loadModBlacklistHits() {
    var el = _modBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/moderation/blacklist-hits' + _modChannelFilter());
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine Wort-Treffer.</p>'; return; }
        el.innerHTML = rows.map(function(h) {
            return '<div style="background:#111;border-radius:8px;padding:9px 12px;margin-bottom:6px;">' +
                '<div style="font-size:0.8rem;">🔠 <b style="color:#f97316;">'+esc(h.word_hit||'?')+'</b> · '+(h.username?'@'+esc(h.username):esc(String(h.user_id||'?')))+'</div>' +
                '<div style="font-size:0.66rem;color:#64748b;">'+esc(h.channel_title)+(h.created_at?' · '+relTime(h.created_at):'')+'</div>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function loadEngagement(tab, btn) {
    _engTab = tab || _engTab || 'diss';
    document.querySelectorAll('#engagement-section .eng-tab-btn').forEach(function(b){ b.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    else { var b2 = document.getElementById('engtab-' + _engTab); if (b2) b2.classList.add('active'); }
    await _fillChannelSelect('eng-channel-filter');
    if (_engTab === 'diss')      return loadEngDiss();
    if (_engTab === 'activity')  return loadEngActivity();
    if (_engTab === 'summaries') return loadEngSummaries();
}

function _engChannelFilter() { var s = document.getElementById('eng-channel-filter'); return s && s.value ? ('?channel_id=' + encodeURIComponent(s.value)) : ''; }

function _engBox() { return document.getElementById('eng-content'); }

async function loadEngDiss() {
    var el = _engBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/engagement/diss' + _engChannelFilter());
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Noch keine Diss-Battle-Ergebnisse.</p>'; return; }
        el.innerHTML = rows.map(function(r, i) {
            var medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':('#'+(i+1));
            return '<div style="background:#111;border-radius:8px;padding:9px 12px;margin-bottom:5px;display:flex;align-items:center;gap:10px;">' +
                '<span style="width:30px;text-align:center;font-weight:800;">'+medal+'</span>' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:700;">'+(r.username?'@'+esc(r.username):esc(String(r.user_id)))+'</div>' +
                    '<div style="font-size:0.66rem;color:#64748b;">'+esc(r.channel_title)+' · '+(r.wins||0)+'S / '+(r.losses||0)+'N</div>' +
                '</div>' +
                '<span style="font-weight:800;color:#fb7185;">'+(r.score||0)+'</span>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function loadEngActivity() {
    var el = _engBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/engagement/activity' + _engChannelFilter());
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Noch keine Aktivitätspunkte.</p>'; return; }
        el.innerHTML = rows.map(function(r, i) {
            var medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':('#'+(i+1));
            return '<div style="background:#111;border-radius:8px;padding:9px 12px;margin-bottom:5px;display:flex;align-items:center;gap:10px;">' +
                '<span style="width:30px;text-align:center;font-weight:800;">'+medal+'</span>' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:700;">'+(r.username?'@'+esc(r.username):esc(r.first_name||String(r.user_id)))+'</div>' +
                    '<div style="font-size:0.66rem;color:#64748b;">'+esc(r.channel_title)+' · '+(r.message_count||0)+' Nachrichten</div>' +
                '</div>' +
                '<span style="font-weight:800;color:#4ade80;">'+(r.points||0)+' P</span>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function loadEngSummaries() {
    var el = _engBox(); if (!el) return;
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var rows = await api.request('/engagement/summaries');
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Noch keine Tageszusammenfassungen erstellt.</p>'; return; }
        el.innerHTML = rows.map(function(c) {
            return '<div style="background:#111;border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:700;">'+(c.type==='channel'?'📢 ':'👥 ')+esc(c.channel_title)+'</div>' +
                    '<div style="font-size:0.66rem;color:#64748b;">Letzte Zusammenfassung: '+(c.last_summary_at?new Date(c.last_summary_at).toLocaleString('de-DE'):'–')+'</div>' +
                '</div>' +
                '<span style="font-size:0.7rem;color:#94a3b8;flex-shrink:0;">'+(c.last_summary_tokens||0)+' Tok</span>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function loadGeplant() {
    var el = document.getElementById('geplant-list');
    if (!el) return;
    await _fillChannelSelect('sched-channel', { allOption: false });
    await _fillChannelSelect('geplant-filter');
    el.innerHTML = '<p style="color:#555;font-size:0.85rem;">Lädt…</p>';
    try {
        var f = document.getElementById('geplant-filter');
        var qs = f && f.value ? ('?channel_id=' + encodeURIComponent(f.value)) : '';
        var rows = await api.request('/scheduled' + qs);
        if (!rows || !rows.length) { el.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px;">Keine geplanten Nachrichten.</p>'; return; }
        el.innerHTML = rows.map(function(m) {
            return '<div style="background:#111;border:1px solid '+(m.is_active?'#1e3a5f':'#2a2a2a')+';border-radius:8px;padding:10px 12px;margin-bottom:6px;">' +
                '<div style="display:flex;justify-content:space-between;gap:8px;">' +
                    '<span style="font-weight:700;font-size:0.82rem;">'+(m.is_active?'⏰':'⏸')+' '+esc(m.channel_title)+'</span>' +
                    '<button onclick="deleteScheduledMsg('+JSON.stringify(String(m.id))+')" class="icon-btn" style="flex-shrink:0;">🗑</button>' +
                '</div>' +
                '<div style="font-size:0.78rem;color:#cbd5e1;margin-top:4px;background:#0d1117;border-radius:6px;padding:6px;">'+esc(String(m.message||'').substring(0,200))+'</div>' +
                '<div style="font-size:0.66rem;color:#64748b;margin-top:4px;">Nächste Ausführung: '+(m.next_run_at?new Date(m.next_run_at).toLocaleString('de-DE'):'–')+(m.repeat?' · 🔁 '+esc(m.repeat):' · einmalig')+'</div>' +
            '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}

async function createScheduledMsg() {
    var ch = document.getElementById('sched-channel');
    var msg = document.getElementById('sched-message');
    var when = document.getElementById('sched-when');
    var rep = document.getElementById('sched-repeat');
    if (!ch || !ch.value) { showToast('❌ Channel wählen'); return; }
    if (!msg || !msg.value.trim()) { showToast('❌ Nachricht eingeben'); return; }
    var payload = {
        channel_id: ch.value,
        message: msg.value.trim(),
        next_run_at: (when && when.value) ? new Date(when.value).toISOString() : new Date(Date.now()+60000).toISOString(),
        repeat: (rep && rep.value) ? rep.value : null
    };
    try {
        await api.request('/scheduled', 'POST', payload);
        showToast('✅ Geplant!');
        if (msg) msg.value = ''; if (when) when.value = '';
        loadGeplant(); _safeRun(updateStats);
    } catch (e) { showToast('❌ ' + (e?.message || 'Fehler')); }
}

async function deleteScheduledMsg(id) {
    if (!confirm('Geplante Nachricht löschen?')) return;
    try { await api.request('/scheduled/'+id, 'DELETE'); showToast('🗑 Gelöscht'); loadGeplant(); _safeRun(updateStats); }
    catch (e) { showToast('❌ ' + (e?.message || 'Fehler')); }
}

function openScheduleModal(channelId) {
    var modal = _getOrCreateModal('schedule-modal');
    modal.innerHTML =
        '<div style="background:#0d1117;border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:600px;max-height:88vh;overflow-y:auto;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
                '<h3 style="color:white;font-size:1rem;margin:0;">⏰ Geplante Nachricht</h3>' +
                '<button onclick="_closeModal(\'schedule-modal\')" style="background:#333;border:none;color:white;border-radius:5px;padding:4px 10px;cursor:pointer;">✕</button>' +
            '</div>' +
            '<textarea id="sm-msg" rows="4" placeholder="Nachrichtentext…" style="width:100%;padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;margin-bottom:8px;"></textarea>' +
            '<label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:3px;">Zeitpunkt (leer = in 1 Min.)</label>' +
            '<input type="datetime-local" id="sm-when" style="width:100%;padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;margin-bottom:8px;">' +
            '<label style="font-size:0.72rem;color:#94a3b8;display:block;margin-bottom:3px;">Wiederholung</label>' +
            '<select id="sm-repeat" style="width:100%;padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e2e8f0;margin-bottom:12px;">' +
                '<option value="">Einmalig</option><option value="hourly">Stündlich</option><option value="daily">Täglich</option><option value="weekly">Wöchentlich</option>' +
            '</select>' +
            '<button onclick="_submitScheduleModal('+JSON.stringify(String(channelId))+')" class="btn btn-success btn-full">💾 Planen</button>' +
        '</div>';
    modal.style.display = 'flex';
}

async function _submitScheduleModal(channelId) {
    var msg = document.getElementById('sm-msg');
    var when = document.getElementById('sm-when');
    var rep = document.getElementById('sm-repeat');
    if (!msg || !msg.value.trim()) { showToast('❌ Nachricht eingeben'); return; }
    try {
        await api.request('/scheduled', 'POST', {
            channel_id: channelId,
            message: msg.value.trim(),
            next_run_at: (when && when.value) ? new Date(when.value).toISOString() : new Date(Date.now()+60000).toISOString(),
            repeat: (rep && rep.value) ? rep.value : null
        });
        showToast('✅ Geplant!');
        _closeModal('schedule-modal');
        if (typeof loadGeplant === 'function') loadGeplant();
        _safeRun(updateStats);
    } catch (e) { showToast('❌ ' + (e?.message || 'Fehler')); }
}

function openSafelistModal(channelId) {
    var modal = _getOrCreateModal('safelist-modal');
    modal.innerHTML =
        '<div style="background:#0d1117;border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:600px;max-height:88vh;overflow-y:auto;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
                '<h3 style="color:white;font-size:1rem;margin:0;">🛡 Safeliste</h3>' +
                '<button onclick="_closeModal(\'safelist-modal\')" style="background:#333;border:none;color:white;border-radius:5px;padding:4px 10px;cursor:pointer;">✕</button>' +
            '</div>' +
            '<div id="safelist-entries"><p style="color:#555;">Lädt…</p></div>' +
        '</div>';
    modal.style.display = 'flex';
    _loadSafelistEntries(channelId);
}

async function _loadSafelistEntries(channelId) {
    var el = document.getElementById('safelist-entries');
    if (!el) return;
    try {
        // Safeliste = positive, approved Feedbacks (über vorhandene Channel-Daten gespiegelt)
        var rows = await api.request('/moderation/scam?channel_id=' + encodeURIComponent(channelId)).catch(function(){ return []; });
        // Hinweis: dedizierte Safelist-Ansicht erfolgt über das Telegram-Menü /safeliste.
        el.innerHTML = '<p style="color:#94a3b8;font-size:0.82rem;line-height:1.5;">Die Safeliste wird im Telegram-Bot über <b>/safeliste</b> verwaltet. ' +
            'Verifizierte Mitglieder ergeben sich aus bestätigten positiven Bewertungen (siehe <b>Moderation → Offene Reviews</b>).</p>';
    } catch (e) { el.innerHTML = '<p style="color:#ef4444;">'+esc(e.message||String(e))+'</p>'; }
}