/**
 * ValueShop25 Chat Widget v1.3
 * Einbetten: <script src="https://ai-agent-lix6.onrender.com/widget.js"></script>
 */
(function() {
  'use strict';

  var API = (function() {
    // Auto-detect API base von script src
    var scripts = document.querySelectorAll('script[src*="widget.js"]');
    if (scripts.length) {
      var src = scripts[scripts.length - 1].src;
      return src.replace('/widget.js', '');
    }
    return 'https://ai-agent-lix6.onrender.com';
  })();

  var WIDGET_ID  = 'vs25-widget';
  var chatId     = null;
  var isOpen     = false;
  var isTyping   = false;
  var msgHistory = [];

  // ── Styles ──────────────────────────────────────────────────────────────────
  var CSS = `
    #vs25-widget * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    #vs25-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 99998;
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, #0a4f8c, #1a8fd1);
      box-shadow: 0 4px 20px rgba(10,79,140,0.5);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
      border: none; outline: none;
    }
    #vs25-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(10,79,140,0.65); }
    #vs25-bubble svg { width: 28px; height: 28px; fill: white; }
    #vs25-bubble .vs25-badge {
      position: absolute; top: -2px; right: -2px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #22c55e; border: 2px solid white;
      display: none;
    }
    #vs25-bubble .vs25-badge.active { display: block; }

    #vs25-chat-panel {
      position: fixed; bottom: 96px; right: 24px; z-index: 99999;
      width: 360px; max-width: calc(100vw - 32px);
      height: 540px; max-height: calc(100vh - 120px);
      background: #0d1117;
      border-radius: 20px; overflow: hidden;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06);
      display: none; flex-direction: column;
      animation: vs25-slideUp 0.22s ease-out;
    }
    #vs25-chat-panel.open { display: flex; }
    @keyframes vs25-slideUp {
      from { opacity: 0; transform: translateY(16px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* Header */
    .vs25-header {
      padding: 14px 16px; display: flex; align-items: center; gap: 10px;
      background: linear-gradient(135deg, #0a4f8c, #1a8fd1);
      flex-shrink: 0;
    }
    .vs25-avatar {
      width: 38px; height: 38px; border-radius: 50%;
      background: rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; flex-shrink: 0;
    }
    .vs25-header-info { flex: 1; min-width: 0; }
    .vs25-header-name { color: white; font-weight: 700; font-size: 0.95rem; }
    .vs25-header-status { color: rgba(255,255,255,0.7); font-size: 0.75rem; display: flex; align-items: center; gap: 4px; }
    .vs25-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; display: inline-block; animation: vs25-pulse 2s infinite; }
    @keyframes vs25-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    .vs25-close-btn { background: none; border: none; color: rgba(255,255,255,0.7); cursor: pointer; padding: 4px; border-radius: 6px; font-size: 1.1rem; line-height: 1; }
    .vs25-close-btn:hover { color: white; background: rgba(255,255,255,0.15); }

    /* FAQ Bar */
    .vs25-faq-bar {
      padding: 10px 12px; background: #0d1825; border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex; gap: 6px; overflow-x: auto; flex-shrink: 0;
    }
    .vs25-faq-bar::-webkit-scrollbar { display: none; }
    .vs25-faq-chip {
      flex-shrink: 0; padding: 5px 10px; border-radius: 20px;
      background: rgba(26,143,209,0.15); border: 1px solid rgba(26,143,209,0.3);
      color: #7dd3fc; font-size: 0.72rem; cursor: pointer; white-space: nowrap;
      transition: background 0.15s;
    }
    .vs25-faq-chip:hover { background: rgba(26,143,209,0.3); }

    /* Messages */
    .vs25-messages {
      flex: 1; overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 4px;
      background: #0d1117;
    }
    .vs25-messages::-webkit-scrollbar { width: 4px; }
    .vs25-messages::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

    .vs25-msg { display: flex; flex-direction: column; max-width: 82%; margin-bottom: 2px; }
    .vs25-msg.user { align-self: flex-end; }
    .vs25-msg.bot  { align-self: flex-start; }
    .vs25-bubble-msg {
      padding: 9px 13px; border-radius: 16px; font-size: 0.875rem; line-height: 1.5;
      word-break: break-word; white-space: pre-wrap;
    }
    .vs25-msg.user .vs25-bubble-msg {
      background: #1a8fd1; color: white; border-bottom-right-radius: 4px;
    }
    .vs25-msg.bot .vs25-bubble-msg {
      background: #1a2433; color: #e2e8f0; border-bottom-left-radius: 4px;
    }
    .vs25-time { font-size: 0.62rem; color: #4a5568; margin-top: 2px; padding: 0 4px; }
    .vs25-msg.user .vs25-time { text-align: right; }

    /* Typing indicator */
    .vs25-typing .vs25-bubble-msg { display: flex; align-items: center; gap: 4px; padding: 12px 14px; }
    .vs25-typing span { width: 7px; height: 7px; border-radius: 50%; background: #4a5568; display: inline-block; animation: vs25-bounce 1.3s infinite; }
    .vs25-typing span:nth-child(2) { animation-delay: 0.2s; }
    .vs25-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes vs25-bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }

    /* Input */
    .vs25-input-area {
      padding: 10px 12px; background: #0d1825; border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0;
    }
    .vs25-input {
      flex: 1; background: #1a2433; border: 1px solid rgba(255,255,255,0.08);
      color: #e2e8f0; border-radius: 20px; padding: 10px 14px;
      font-size: 0.875rem; font-family: inherit; resize: none;
      max-height: 100px; overflow-y: auto; line-height: 1.4;
      outline: none;
    }
    .vs25-input:focus { border-color: #1a8fd1; }
    .vs25-input::placeholder { color: #4a5568; }
    .vs25-send {
      width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0;
      background: #1a8fd1; border: none; color: white; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s; font-size: 1rem;
    }
    .vs25-send:hover { background: #0a6faa; }
    .vs25-send:disabled { background: #1a2433; cursor: not-allowed; opacity: 0.5; }

    /* Powered by */
    .vs25-footer {
      text-align: center; padding: 5px; color: #2d3748; font-size: 0.62rem;
      background: #0d1825; flex-shrink: 0;
    }
  `;

  // ── DOM aufbauen ─────────────────────────────────────────────────────────────
  function init() {
    if (document.getElementById(WIDGET_ID)) return;

    var container = document.createElement('div');
    container.id  = WIDGET_ID;

    // Styles
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Bubble
    container.innerHTML = `
      <button id="vs25-bubble" aria-label="Chat öffnen" title="Chat öffnen">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
        </svg>
        <span class="vs25-badge"></span>
      </button>
      <div id="vs25-chat-panel">
        <div class="vs25-header">
          <div class="vs25-avatar">🤖</div>
          <div class="vs25-header-info">
            <div class="vs25-header-name">ValueShop25 Support</div>
            <div class="vs25-header-status"><span class="vs25-dot"></span> Online</div>
          </div>
          <button class="vs25-close-btn" id="vs25-close" aria-label="Schließen">✕</button>
        </div>
        <div class="vs25-faq-bar" id="vs25-faq-bar"></div>
        <div class="vs25-messages" id="vs25-messages"></div>
        <div class="vs25-input-area">
          <textarea class="vs25-input" id="vs25-input" placeholder="Schreibe eine Nachricht..." rows="1"></textarea>
          <button class="vs25-send" id="vs25-send" aria-label="Senden">➤</button>
        </div>
        <div class="vs25-footer">Powered by ValueShop25 AI</div>
      </div>
    `;

    document.body.appendChild(container);

    // Events
    document.getElementById('vs25-bubble').addEventListener('click', toggleChat);
    document.getElementById('vs25-close').addEventListener('click', closeChat);
    document.getElementById('vs25-send').addEventListener('click', sendMessage);
    document.getElementById('vs25-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.getElementById('vs25-input').addEventListener('input', autoResizeInput);

    // Init mit Server
    initSession();

    // Seitenbesuch tracken bei Navigation
    trackPageVisit();
    window.addEventListener('popstate', trackPageVisit);
  }

  // ── Session initialisieren ────────────────────────────────────────────────────
  function initSession() {
    // Gespeicherte ChatID aus localStorage
    var savedId = localStorage.getItem('vs25_chat_id');

    fetch(API + '/api/widget/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fingerprint: getFingerprint(),
        pageUrl:     location.href,
        pageTitle:   document.title,
        chatId:      savedId
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.banned) return; // Stumm bleiben wenn gebannt

      chatId = data.chatId;
      localStorage.setItem('vs25_chat_id', chatId);

      // Welcome-Nachricht
      if (data.welcome && data.isNew) {
        addMessage('bot', data.welcome);
      }

      // Verlauf laden
      loadHistory();
    })
    .catch(function() {});

    // FAQ laden
    loadFaq();
  }

  function loadHistory() {
    if (!chatId) return;
    fetch(API + '/api/widget/history', {
      headers: { 'X-Chat-ID': chatId }
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var msgs = data.messages || [];
      if (msgs.length > 0 && !document.getElementById('vs25-messages').children.length) {
        msgs.slice(-20).forEach(function(m) {
          addMessage(m.role === 'user' ? 'user' : 'bot', m.content, true);
        });
        scrollToBottom();
      }
    })
    .catch(function() {});
  }

  function loadFaq() {
    fetch(API + '/api/widget/faq')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var bar = document.getElementById('vs25-faq-bar');
      if (!bar) return;
      (data.faqs || []).forEach(function(q) {
        var chip = document.createElement('button');
        chip.className   = 'vs25-faq-chip';
        chip.textContent = q;
        chip.addEventListener('click', function() {
          openChat();
          document.getElementById('vs25-input').value = q;
          sendMessage();
        });
        bar.appendChild(chip);
      });
    })
    .catch(function() {});
  }

  // ── Nachricht senden ──────────────────────────────────────────────────────────
  function sendMessage() {
    if (isTyping || !chatId) return;
    var input = document.getElementById('vs25-input');
    var text  = (input.value || '').trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';
    addMessage('user', text);
    showTyping(true);

    document.getElementById('vs25-send').disabled = true;

    fetch(API + '/api/widget/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-ID': chatId },
      body:    JSON.stringify({ message: text, chatId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      showTyping(false);
      document.getElementById('vs25-send').disabled = false;
      if (data.reply) {
        addMessage('bot', data.reply);
      }
    })
    .catch(function() {
      showTyping(false);
      document.getElementById('vs25-send').disabled = false;
      addMessage('bot', 'Entschuldigung, etwas ist schiefgelaufen. Bitte versuche es erneut.');
    });
  }

  // ── Seitenbesuch tracken ──────────────────────────────────────────────────────
  function trackPageVisit() {
    if (!chatId) { setTimeout(trackPageVisit, 2000); return; }
    fetch(API + '/api/widget/activity', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-ID': chatId },
      body:    JSON.stringify({ pageUrl: location.href, pageTitle: document.title, chatId })
    }).catch(function() {});
  }

  // ── UI Helfer ─────────────────────────────────────────────────────────────────
  function addMessage(role, text, noScroll) {
    var container = document.getElementById('vs25-messages');
    if (!container) return;

    var div  = document.createElement('div');
    div.className = 'vs25-msg ' + role;

    var time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<div class="vs25-bubble-msg">${escHtml(text)}</div><div class="vs25-time">${time}</div>`;
    container.appendChild(div);
    if (!noScroll) scrollToBottom();
  }

  function showTyping(show) {
    isTyping = show;
    var existing = document.getElementById('vs25-typing-indicator');
    if (!show) { if (existing) existing.remove(); return; }
    if (existing) return;
    var div = document.createElement('div');
    div.id = 'vs25-typing-indicator';
    div.className = 'vs25-msg bot vs25-typing';
    div.innerHTML = '<div class="vs25-bubble-msg"><span></span><span></span><span></span></div>';
    document.getElementById('vs25-messages').appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    var el = document.getElementById('vs25-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function autoResizeInput() {
    var el = this || document.getElementById('vs25-input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  }

  function toggleChat() { isOpen ? closeChat() : openChat(); }

  function openChat() {
    if (isOpen) return;
    isOpen = true;
    document.getElementById('vs25-chat-panel').classList.add('open');
    document.getElementById('vs25-input').focus();
    scrollToBottom();
  }

  function closeChat() {
    isOpen = false;
    document.getElementById('vs25-chat-panel').classList.remove('open');
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\n/g,'<br>');
  }

  function getFingerprint() {
    // Einfacher Browser-Fingerprint
    return btoa([
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone
    ].join('|')).substring(0, 32);
  }

  // ── Start ────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
