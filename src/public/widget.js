/**
 * ValueShop25 Chat Widget v1.3.3
 */
(function() {
  'use strict';
  var API = (function() {
    var s = document.querySelectorAll('script[src*="widget.js"]');
    return s.length ? s[s.length-1].src.replace('/widget.js','') : 'https://ai-agent-lix6.onrender.com';
  })();

  var chatId=null, isOpen=false, isTyping=false, _proactiveDone=false, _handoverActive=false, _proTimer=null;

  function getSmartTitle() {
    var url = location.pathname;
    var m = url.match(/\/product\/([^/?#]+)/);
    if (m) return m[1].replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
    var cm = url.match(/\/category\/([^/?#]+)/);
    if (cm) return 'Kategorie: ' + cm[1].replace(/-/g,' ');
    if (/\/checkout/i.test(url)) return 'Checkout';
    if (/\/cart|warenkorb/i.test(url)) return 'Warenkorb';
    if (url === '/' || url === '') return 'Startseite';
    var t = (document.title||'').split(/\s[–|-]\s/)[0].trim();
    return t.length > 50 ? t.substring(0,50)+'…' : (t||'Seite');
  }

  var CSS = '#vs25-widget *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '#vs25-bbl{position:fixed;bottom:24px;right:24px;z-index:99998;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#0a4f8c,#1a8fd1);box-shadow:0 4px 24px rgba(10,79,140,.55);cursor:pointer;border:none;outline:none;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s}' +
    '#vs25-bbl:hover{transform:scale(1.08);box-shadow:0 6px 32px rgba(10,79,140,.7)}' +
    '#vs25-bbl svg{width:28px;height:28px;fill:white}' +
    '.vs25-notif{position:absolute;top:-3px;right:-3px;width:18px;height:18px;border-radius:50%;background:#ef4444;border:2px solid white;font-size:10px;font-weight:700;color:white;display:none;align-items:center;justify-content:center}' +
    '.vs25-notif.on{display:flex}' +
    '#vs25-inv{position:fixed;bottom:96px;right:24px;z-index:99997;background:white;color:#1a1a1a;border-radius:16px 16px 4px 16px;padding:12px 16px 12px 14px;max-width:230px;box-shadow:0 4px 20px rgba(0,0,0,.2);font-size:.875rem;line-height:1.4;cursor:pointer;display:none;animation:vs25pi .3s ease-out}' +
    '#vs25-inv.on{display:block}' +
    '#vs25-inv::after{content:"";position:absolute;bottom:-8px;right:20px;width:0;height:0;border-left:8px solid transparent;border-top:8px solid white}' +
    '.vs25-ix{position:absolute;top:4px;right:6px;font-size:.72rem;color:#999;cursor:pointer;background:none;border:none;line-height:1}' +
    '@keyframes vs25pi{from{opacity:0;transform:scale(.85) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}' +
    '#vs25-panel{position:fixed;z-index:99999;display:none;flex-direction:column;background:#0d1117;box-shadow:0 8px 40px rgba(0,0,0,.6);bottom:96px;right:24px;width:370px;height:560px;border-radius:20px;overflow:hidden}' +
    '#vs25-panel.on{display:flex;animation:vs25su .22s ease-out}' +
    '@keyframes vs25su{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}' +
    '@media(max-width:480px){#vs25-panel{bottom:0!important;right:0!important;width:100%!important;height:100%!important;border-radius:0!important;max-height:100dvh}#vs25-bbl{bottom:20px;right:16px}}' +
    '.vs25-hdr{background:linear-gradient(135deg,#0a4f8c,#1a8fd1);padding:14px 14px 12px;display:flex;align-items:center;gap:10px;flex-shrink:0}' +
    '.vs25-av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}' +
    '.vs25-hi{flex:1;min-width:0}' +
    '.vs25-hn{color:white;font-weight:700;font-size:.95rem}' +
    '.vs25-hs{color:rgba(255,255,255,.75);font-size:.72rem;display:flex;align-items:center;gap:4px}' +
    '.vs25-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;animation:vs25p 2s infinite}' +
    '@keyframes vs25p{0%,100%{opacity:1}50%{opacity:.5}}' +
    '.vs25-hb{background:none;border:none;cursor:pointer;padding:5px;border-radius:6px;color:rgba(255,255,255,.75);font-size:.85rem;line-height:1;transition:all .15s}' +
    '.vs25-hb:hover{color:white;background:rgba(255,255,255,.15)}' +
    '.vs25-hb.on{background:rgba(220,38,38,.3);color:#fca5a5}' +
    '.vs25-msgs{flex:1;overflow-y:auto;padding:12px 12px 4px;display:flex;flex-direction:column;gap:3px;background:#0d1117}' +
    '.vs25-msgs::-webkit-scrollbar{width:3px}.vs25-msgs::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:2px}' +
    '.vs25-msg{display:flex;flex-direction:column;max-width:82%}' +
    '.vs25-msg.u{align-self:flex-end}.vs25-msg.b{align-self:flex-start}' +
    '.vs25-bub{padding:9px 13px;border-radius:16px;font-size:.875rem;line-height:1.55;word-break:break-word;white-space:pre-wrap}' +
    '.vs25-msg.u .vs25-bub{background:#1a8fd1;color:white;border-bottom-right-radius:4px}' +
    '.vs25-msg.b .vs25-bub{background:#1a2433;color:#e2e8f0;border-bottom-left-radius:4px}' +
    '.vs25-ts{font-size:.62rem;color:#4a5568;margin-top:2px;padding:0 3px}' +
    '.vs25-msg.u .vs25-ts{text-align:right}' +
    '.vs25-typ .vs25-bub{display:flex;align-items:center;gap:4px;padding:12px 14px}' +
    '.vs25-typ span{width:7px;height:7px;border-radius:50%;background:#4a5568;animation:vs25b 1.3s infinite}' +
    '.vs25-typ span:nth-child(2){animation-delay:.2s}.vs25-typ span:nth-child(3){animation-delay:.4s}' +
    '@keyframes vs25b{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}' +
    '.vs25-fq{padding:8px 12px 4px;background:#0d1825;border-top:1px solid rgba(255,255,255,.05);flex-shrink:0}' +
    '.vs25-fqs{display:flex;gap:7px;overflow-x:auto;padding-bottom:2px}' +
    '.vs25-fqs::-webkit-scrollbar{display:none}' +
    '.vs25-chip{flex-shrink:0;background:rgba(26,143,209,.12);border:1px solid rgba(26,143,209,.35);color:#7dd3fc;font-size:.72rem;padding:6px 11px;border-radius:20px;cursor:pointer;white-space:nowrap;transition:background .15s,transform .1s}' +
    '.vs25-chip:hover{background:rgba(26,143,209,.28);transform:translateY(-1px)}' +
    '.vs25-ir{padding:8px 10px 10px;background:#0d1825;display:flex;gap:8px;align-items:flex-end;flex-shrink:0}' +
    '.vs25-inp{flex:1;background:#1a2433;border:1px solid rgba(255,255,255,.08);color:#e2e8f0;border-radius:20px;padding:10px 14px;font-size:.875rem;font-family:inherit;resize:none;max-height:100px;overflow-y:auto;line-height:1.4;outline:none}' +
    '.vs25-inp:focus{border-color:rgba(26,143,209,.5)}.vs25-inp::placeholder{color:#4a5568}' +
    '.vs25-snd{width:40px;height:40px;border-radius:50%;flex-shrink:0;background:#1a8fd1;border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;font-size:1rem}' +
    '.vs25-snd:hover{background:#0a6faa}.vs25-snd:disabled{background:#1a2433;opacity:.5;cursor:not-allowed}' +
    '.vs25-ft{text-align:center;padding:5px;color:#2d3748;font-size:.6rem;background:#0d1825;flex-shrink:0}';

  var INVITES = ['💬 Hast du Fragen? Ich helfe dir gerne!','🤔 Noch unsicher? Ich berate dich kostenlos!','👋 Kann ich dir bei der Auswahl helfen?','🔍 Passende eSIM gesucht? Ich finde sie!'];

  function init() {
    if (document.getElementById('vs25-widget')) return;
    var w = document.createElement('div'); w.id='vs25-widget';
    var st = document.createElement('style'); st.textContent=CSS; document.head.appendChild(st);
    var inv = INVITES[Math.floor(Math.random()*INVITES.length)];
    w.innerHTML =
      '<button id="vs25-bbl" aria-label="Chat öffnen"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg><span class="vs25-notif" id="vs25-notif">1</span></button>' +
      '<div id="vs25-inv"><button class="vs25-ix" id="vs25-ix">✕</button>'+esc(inv)+'</div>' +
      '<div id="vs25-panel">' +
        '<div class="vs25-hdr"><div class="vs25-av">🤖</div><div class="vs25-hi"><div class="vs25-hn">ValueShop25 Support</div><div class="vs25-hs"><span class="vs25-dot"></span> Online</div></div><button class="vs25-hb" id="vs25-hob" title="Mitarbeiter anfordern">👤</button><button class="vs25-hb" id="vs25-cls">✕</button></div>' +
        '<div class="vs25-msgs" id="vs25-msgs"></div>' +
        '<div class="vs25-fq"><div class="vs25-fqs" id="vs25-fqs"></div></div>' +
        '<div class="vs25-ir"><textarea class="vs25-inp" id="vs25-inp" placeholder="Schreibe eine Nachricht…" rows="1"></textarea><button class="vs25-snd" id="vs25-snd">➤</button></div>' +
        '<div class="vs25-ft">Powered by ValueShop25 AI</div>' +
      '</div>';
    document.body.appendChild(w);
    document.getElementById('vs25-bbl').onclick = openChat;
    document.getElementById('vs25-cls').onclick = closeChat;
    document.getElementById('vs25-snd').onclick = sendMsg;
    document.getElementById('vs25-hob').onclick = doHandover;
    document.getElementById('vs25-inv').onclick = function(e){ if(e.target.id==='vs25-ix'){hideInv();return;} hideInv(); openChat(); };
    document.getElementById('vs25-ix').onclick = function(e){ e.stopPropagation(); hideInv(); };
    document.getElementById('vs25-inp').addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();} });
    document.getElementById('vs25-inp').addEventListener('input', function(){ this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,100)+'px'; });
    startSession();
    loadFaq();
    _proTimer = setTimeout(showInv, 25000);
  }

  function startSession() {
    var saved = localStorage.getItem('vs25_cid');
    fetch(API+'/api/widget/init', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ fingerprint:fp(), pageUrl:location.href, pageTitle:getSmartTitle(), chatId:saved }) })
    .then(function(r){return r.json();}).then(function(d){
      if (d.banned) return;
      chatId = d.chatId; localStorage.setItem('vs25_cid', chatId);
      if (d.welcome && d.isNew) addMsg('b', d.welcome);
      loadHist();
    }).catch(function(){});
  }

  function loadHist() {
    if (!chatId) return;
    fetch(API+'/api/widget/history', { headers:{'X-Chat-ID':chatId} })
    .then(function(r){return r.json();}).then(function(d){
      var msgs=d.messages||[], el=document.getElementById('vs25-msgs');
      if (msgs.length&&el&&!el.children.length) { msgs.slice(-20).forEach(function(m){addMsg(m.role==='user'?'u':'b',m.content,true);}); scrl(); }
    }).catch(function(){});
  }

  function loadFaq() {
    fetch(API+'/api/widget/faq').then(function(r){return r.json();}).then(function(d){
      var bar=document.getElementById('vs25-fqs'); if(!bar) return; bar.innerHTML='';
      (d.faqs||[]).forEach(function(q){
        var c=document.createElement('button'); c.className='vs25-chip'; c.textContent=q;
        c.onclick=function(){ openChat(); document.getElementById('vs25-inp').value=q; sendMsg(); };
        bar.appendChild(c);
      });
    }).catch(function(){});
  }

  function sendMsg() {
    if (isTyping||!chatId) return;
    var inp=document.getElementById('vs25-inp'), text=(inp.value||'').trim();
    if (!text) return;
    inp.value=''; inp.style.height='auto';
    addMsg('u', text); showTyp(true);
    document.getElementById('vs25-snd').disabled=true;
    fetch(API+'/api/widget/message', { method:'POST', headers:{'Content-Type':'application/json','X-Chat-ID':chatId}, body:JSON.stringify({message:text,chatId}) })
    .then(function(r){return r.json();}).then(function(d){
      showTyp(false); document.getElementById('vs25-snd').disabled=false;
      if (d.reply) addMsg('b', d.reply);
    }).catch(function(){ showTyp(false); document.getElementById('vs25-snd').disabled=false; addMsg('b','Fehler. Bitte erneut versuchen.'); });
  }

  function doHandover() {
    if (!chatId) return;
    _handoverActive=!_handoverActive;
    var btn=document.getElementById('vs25-hob'); if(btn) btn.classList.toggle('on',_handoverActive);
    fetch(API+'/api/widget/handover', {method:'POST',headers:{'Content-Type':'application/json','X-Chat-ID':chatId},body:JSON.stringify({chatId,request:_handoverActive})}).catch(function(){});
    addMsg('b', _handoverActive ? 'Mitarbeiter benachrichtigt. KI pausiert.' : 'KI-Support wieder aktiv.');
    if (btn) btn.title = _handoverActive ? 'KI reaktivieren' : 'Mitarbeiter anfordern';
  }

  function openChat() {
    if (isOpen) return; isOpen=true; hideInv(); _proactiveDone=true; clearTimeout(_proTimer);
    document.getElementById('vs25-notif').classList.remove('on');
    document.getElementById('vs25-panel').classList.add('on');
    setTimeout(function(){ document.getElementById('vs25-inp')?.focus(); scrl(); }, 50);
    trackPage();
  }

  function closeChat() { isOpen=false; document.getElementById('vs25-panel').classList.remove('on'); }

  function showInv() {
    if (_proactiveDone||isOpen) return;
    document.getElementById('vs25-inv').classList.add('on');
    document.getElementById('vs25-notif').classList.add('on');
    _proactiveDone=true;
  }
  function hideInv() { document.getElementById('vs25-inv').classList.remove('on'); }

  function trackPage() {
    if (!chatId) { setTimeout(trackPage,2000); return; }
    fetch(API+'/api/widget/activity', {method:'POST',headers:{'Content-Type':'application/json','X-Chat-ID':chatId},body:JSON.stringify({pageUrl:location.href,pageTitle:getSmartTitle(),chatId})}).catch(function(){});
  }

  function addMsg(role, text, noScroll) {
    var el=document.getElementById('vs25-msgs'); if(!el) return;
    var d=document.createElement('div'); d.className='vs25-msg '+role;
    var t=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    d.innerHTML='<div class="vs25-bub">'+esc(text)+'</div><div class="vs25-ts">'+t+'</div>';
    el.appendChild(d); if(!noScroll) scrl();
  }

  function showTyp(show) {
    isTyping=show; var ex=document.getElementById('vs25-typ');
    if (!show){if(ex)ex.remove();return;} if(ex) return;
    var d=document.createElement('div'); d.id='vs25-typ'; d.className='vs25-msg b vs25-typ';
    d.innerHTML='<div class="vs25-bub"><span></span><span></span><span></span></div>';
    document.getElementById('vs25-msgs').appendChild(d); scrl();
  }

  function scrl(){ var e=document.getElementById('vs25-msgs'); if(e) e.scrollTop=e.scrollHeight; }
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
  function fp(){ return btoa([navigator.userAgent,navigator.language,screen.width+'x'+screen.height,Intl.DateTimeFormat().resolvedOptions().timeZone].join('|')).substring(0,32); }

  var _lastUrl=location.href;
  setInterval(function(){
    if(location.href!==_lastUrl){ _lastUrl=location.href; if(chatId) trackPage(); if(!isOpen){_proactiveDone=false; clearTimeout(_proTimer); _proTimer=setTimeout(showInv,25000);} }
  }, 1500);

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
