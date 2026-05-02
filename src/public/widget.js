/**
 * ValueShop25 Chat Widget v1.3.7
 * WhatsApp-inspiriertes Design, Status-Dot, Toggle-Switch, Session-Tracking
 *
 * v1.5.38 (Bot-Version):
 *   • Chat-ID wird in sessionStorage statt localStorage abgelegt → bei Tab-
 *     Schließen / Verlassen der Domain ist der Chat aus Kundensicht weg.
 *   • Beim Verlassen der Seite (pagehide) wird sessionStorage zusätzlich
 *     proaktiv gelöscht, damit auch Browser-Backforward-Cache nichts behält.
 *   • Backend-seitig bleibt die Historie erhalten – das Dashboard zeigt
 *     den Verlauf weiterhin bis zur manuellen Löschung.
 */
(function(){
'use strict';
var API=(function(){var s=document.querySelectorAll('script[src*="widget.js"]');return s.length?s[s.length-1].src.replace('/widget.js',''):'https://ai-agent-lix6.onrender.com';})();
var chatId=null,isOpen=false,isTyping=false,_proDone=false,_handover=false,_faqUsed=false,_proTimer=null,_statusInt=null;

// ─── Storage-Wrapper: sessionStorage statt localStorage ─────────────────────
// sessionStorage hält die Chat-ID nur solange wie der Tab offen ist.
// Beim Schließen / Verlassen der Domain ist der Chat aus Kundensicht "weg".
var STORAGE_KEY='vs25_cid';
function _ssGet(){ try { return sessionStorage.getItem(STORAGE_KEY); } catch(_) { return null; } }
function _ssSet(v){ try { sessionStorage.setItem(STORAGE_KEY,v); } catch(_) {} }
function _ssClear(){
  try { sessionStorage.removeItem(STORAGE_KEY); } catch(_) {}
  // Defensiv: falls noch alte localStorage-Reste vorhanden sind, weg damit.
  try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
}
// Migration: falls ein alter Eintrag noch in localStorage hängt, einmalig
// in die Session übernehmen und dann aus localStorage entfernen.
try {
  var _legacy = localStorage.getItem(STORAGE_KEY);
  if (_legacy && !_ssGet()) _ssSet(_legacy);
  if (_legacy) localStorage.removeItem(STORAGE_KEY);
} catch(_) {}

function smartTitle(){
  var url=location.pathname;
  var m=url.match(/\/product\/([^/?#]+)/);if(m)return m[1].replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
  var cm=url.match(/\/category\/([^/?#]+)/);if(cm)return 'Kategorie: '+cm[1].replace(/-/g,' ');
  if(/\/checkout/i.test(url))return'Checkout';if(/\/cart|warenkorb/i.test(url))return'Warenkorb';
  if(url==='/'||url==='')return'Startseite';
  var t=(document.title||'').split(/\s[–|-]\s/)[0].trim();return t.length>50?t.substring(0,50)+'…':(t||'Seite');
}

// ── CSS ───────────────────────────────────────────────────────────────────────
var CSS=[
'#vs25 *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}',
// Bubble – 63px (5% larger than 60px)
'#vs25-bbl{position:fixed;bottom:24px;right:22px;z-index:99998;width:63px;height:63px;border-radius:50%;background:linear-gradient(145deg,#025c4c,#128c7e);box-shadow:0 4px 20px rgba(2,92,76,.5);cursor:pointer;border:none;outline:none;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s}',
'#vs25-bbl:hover{transform:scale(1.07)}',
'#vs25-bbl svg{width:30px;height:30px;fill:white}',
// Status dot on bubble
'#vs25-status-dot{position:absolute;bottom:3px;right:3px;width:14px;height:14px;border-radius:50%;border:2.5px solid white;background:#4caf50;transition:background .3s}',
'#vs25-status-dot.online{background:#4caf50;box-shadow:0 0 0 3px rgba(76,175,80,.3);animation:vspulse 2s infinite}',
'#vs25-status-dot.manual{background:#ff9800;box-shadow:0 0 0 3px rgba(255,152,0,.3);animation:vspulse 2s infinite}',
'#vs25-status-dot.offline{background:#f44336;animation:none}',
'@keyframes vspulse{0%,100%{opacity:1}50%{opacity:.55}}',
// Proactive invite bubble
'#vs25-inv{position:fixed;bottom:100px;right:22px;z-index:99997;background:white;color:#111;border-radius:12px 12px 2px 12px;padding:11px 32px 11px 13px;max-width:230px;box-shadow:0 2px 16px rgba(0,0,0,.2);font-size:.84rem;line-height:1.4;cursor:pointer;display:none;animation:vspop .3s ease-out}',
'#vs25-inv.on{display:block}#vs25-inv::after{content:"";position:absolute;bottom:-6px;right:16px;border-left:6px solid transparent;border-top:6px solid white}',
'.vs25-ix{position:absolute;top:4px;right:7px;font-size:.7rem;color:#999;cursor:pointer;background:none;border:none;line-height:1}',
'@keyframes vspop{from{opacity:0;transform:scale(.88) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}',
// Panel
'#vs25-pnl{position:fixed;z-index:99999;display:none;flex-direction:column;bottom:0;right:0;width:100%;height:88%;border-radius:16px 16px 0 0;overflow:hidden;background:#ece5dd;transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1)}',
'#vs25-pnl.on{display:flex;transform:translateY(0)}',
'@media(min-width:540px){#vs25-pnl{bottom:96px;right:20px;width:390px;height:620px;border-radius:16px;transform:none;transition:none}}',
'@media(min-width:540px) #vs25-pnl.on{display:flex}',
// Drag handle
'.vs25-drag{display:none;justify-content:center;padding:10px 0 4px;background:#128c7e;flex-shrink:0}',
'.vs25-drag span{width:32px;height:4px;border-radius:2px;background:rgba(255,255,255,.4)}',
'@media(max-width:539px){.vs25-drag{display:flex}}',
// Header – WhatsApp dark green
'.vs25-hdr{background:#075e54;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0}',
'.vs25-hdr-av{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;position:relative}',
'.vs25-hdr-av .vs25-av-dot{position:absolute;bottom:1px;right:1px;width:11px;height:11px;border-radius:50%;border:2px solid #075e54;background:#4caf50}',
'.vs25-hdr-av .vs25-av-dot.manual{background:#ff9800}',
'.vs25-hdr-av .vs25-av-dot.offline{background:#f44336}',
'.vs25-hdr-info{flex:1;min-width:0}',
'.vs25-hdr-name{color:white;font-weight:700;font-size:.93rem;line-height:1.2}',
'.vs25-hdr-sub{color:rgba(255,255,255,.75);font-size:.72rem;margin-top:2px}',
// KI Toggle in header
'.vs25-toggle-wrap{display:flex;align-items:center;gap:6px;flex-shrink:0}',
'.vs25-toggle-label{color:rgba(255,255,255,.8);font-size:.72rem;font-weight:600}',
'.vs25-toggle{position:relative;width:38px;height:20px;cursor:pointer;flex-shrink:0}',
'.vs25-toggle input{opacity:0;width:0;height:0;position:absolute}',
'.vs25-slider{position:absolute;inset:0;background:#aaa;border-radius:20px;transition:.3s;cursor:pointer}',
'.vs25-slider::before{content:"";position:absolute;height:14px;width:14px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.3s}',
'.vs25-toggle input:checked + .vs25-slider{background:#25d366}',
'.vs25-toggle input:checked + .vs25-slider::before{transform:translateX(18px)}',
// Close button - Windows style
'.vs25-cls{width:28px;height:28px;border-radius:4px;background:none;border:none;color:rgba(255,255,255,.75);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.9rem;transition:all .15s;flex-shrink:0}',
'.vs25-cls:hover{background:#e81123;color:white;border-radius:3px}',
// Messages area – WhatsApp beige
'.vs25-msgs{flex:1;overflow-y:auto;padding:10px 10px 6px;display:flex;flex-direction:column;gap:2px;background:#ece5dd;background-image:url("data:image/svg+xml,%3Csvg width=\'200\' height=\'200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3C/svg%3E")}',
'.vs25-msgs::-webkit-scrollbar{width:4px}.vs25-msgs::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:2px}',
'.vs25-msg{display:flex;flex-direction:column;max-width:80%;margin-bottom:1px}',
'.vs25-msg.u{align-self:flex-end}',
'.vs25-msg.b{align-self:flex-start}',
// WhatsApp-style bubbles
'.vs25-bub{padding:8px 12px 20px;border-radius:8px;font-size:.9rem;line-height:1.55;word-break:break-word;white-space:pre-wrap;position:relative}',
'.vs25-msg.b .vs25-bub{background:white;color:#111;border-top-left-radius:2px;box-shadow:0 1px 1px rgba(0,0,0,.1)}',
'.vs25-msg.u .vs25-bub{background:#dcf8c6;color:#111;border-top-right-radius:2px;box-shadow:0 1px 1px rgba(0,0,0,.1)}',
// Timestamps inside bubble (WhatsApp style)
'.vs25-ts{position:absolute;bottom:4px;right:8px;font-size:.62rem;color:rgba(0,0,0,.4)}',
'.vs25-msg.u .vs25-ts{color:rgba(0,0,0,.4)}',
// Date separator
'.vs25-date-sep{text-align:center;margin:8px 0;font-size:.72rem;color:rgba(0,0,0,.55)}',
'.vs25-date-sep span{background:rgba(255,255,255,.65);padding:3px 10px;border-radius:8px}',
// Typing
'.vs25-typ .vs25-bub{display:flex;align-items:center;gap:4px;padding:12px 16px;min-width:60px}',
'.vs25-typ span{width:8px;height:8px;border-radius:50%;background:#aaa;animation:vsb 1.3s infinite}',
'.vs25-typ span:nth-child(2){animation-delay:.2s}.vs25-typ span:nth-child(3){animation-delay:.4s}',
'@keyframes vsb{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}',
// FAQ Grid – all visible, tap-friendly rectangles
'.vs25-fq{padding:8px 10px 4px;background:#f0f0f0;border-top:1px solid #ddd;flex-shrink:0}',
'.vs25-fqg{display:flex;flex-wrap:wrap;gap:5px}',
'.vs25-chip{background:white;border:1px solid #128c7e;color:#075e54;font-size:.78rem;font-weight:600;padding:7px 10px;border-radius:6px;cursor:pointer;line-height:1.3;transition:background .15s;text-align:left;min-width:0;flex:0 1 calc(50% - 3px)}',
'.vs25-chip:hover{background:#e7f5f3}',
'.vs25-chip:active{background:#d0ede8}',
// Input area
'.vs25-ir{padding:8px 10px;background:#f0f0f0;display:flex;gap:6px;align-items:flex-end;flex-shrink:0;border-top:1px solid #ddd}',
'.vs25-inp{flex:1;background:white;border:none;color:#111;border-radius:22px;padding:10px 15px;font-size:.9rem;font-family:inherit;resize:none;max-height:100px;overflow-y:auto;line-height:1.4;outline:none;box-shadow:0 1px 3px rgba(0,0,0,.1)}',
'.vs25-snd{width:42px;height:42px;border-radius:50%;flex-shrink:0;background:#128c7e;border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;font-size:1.1rem;box-shadow:0 1px 3px rgba(0,0,0,.2)}',
'.vs25-snd:hover{background:#075e54}',
'.vs25-snd:disabled{background:#ccc;cursor:not-allowed;box-shadow:none}',
'.vs25-ft{text-align:center;padding:4px;color:#888;font-size:.62rem;background:#f0f0f0;flex-shrink:0}'
].join('');

var INVITES=['💬 Fragen zur eSIM? Ich helfe sofort!','🤔 Noch unsicher? Kostenlose Beratung!','👋 Passende eSIM finden – frag mich!','🔍 Ich finde den richtigen Tarif für dich!'];

function build(){
  if(document.getElementById('vs25')) return;
  var w=document.createElement('div'); w.id='vs25';
  var st=document.createElement('style'); st.textContent=CSS; document.head.appendChild(st);
  var inv=INVITES[Math.floor(Math.random()*INVITES.length)];

  w.innerHTML=
    '<button id="vs25-bbl" aria-label="Chat öffnen">'+
      '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>'+
      '<span id="vs25-status-dot" class="online"></span>'+
    '</button>'+
    '<div id="vs25-inv"><button class="vs25-ix" id="vs25-ix">✕</button>'+esc(inv)+'</div>'+
    '<div id="vs25-pnl">'+
      '<div class="vs25-drag"><span></span></div>'+
      '<div class="vs25-hdr">'+
        '<div class="vs25-hdr-av">🤖<span class="vs25-av-dot" id="vs25-av-dot"></span></div>'+
        '<div class="vs25-hdr-info">'+
          '<div class="vs25-hdr-name">ValueShop25 Support</div>'+
          '<div class="vs25-hdr-sub" id="vs25-hdr-sub">KI Assistent · Online</div>'+
        '</div>'+
        '<div class="vs25-toggle-wrap">'+
          '<span class="vs25-toggle-label">KI</span>'+
          '<label class="vs25-toggle"><input type="checkbox" id="vs25-ki-toggle" checked><span class="vs25-slider"></span></label>'+
        '</div>'+
        '<button class="vs25-cls" id="vs25-cls" title="Schließen" aria-label="Schließen">✕</button>'+
      '</div>'+
      '<div class="vs25-msgs" id="vs25-msgs"></div>'+
      '<div class="vs25-fq" id="vs25-fq"><div class="vs25-fqg" id="vs25-fqg"></div></div>'+
      '<div class="vs25-ir">'+
        '<textarea class="vs25-inp" id="vs25-inp" placeholder="Nachricht…" rows="1"></textarea>'+
        '<button class="vs25-snd" id="vs25-snd" aria-label="Senden"><svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>'+
      '</div>'+
      '<div class="vs25-ft"><span id="vs25-ft-text">Powered by ValueShop25 AI</span></div>'+
    '</div>';

  document.body.appendChild(w);

  document.getElementById('vs25-bbl').onclick=openChat;
  document.getElementById('vs25-cls').onclick=closeChat;
  document.getElementById('vs25-snd').onclick=sendMsg;
  document.getElementById('vs25-ki-toggle').onchange=toggleKI;
  document.getElementById('vs25-inv').onclick=function(e){if(e.target.id==='vs25-ix'){hideInv();return;}hideInv();openChat();};
  document.getElementById('vs25-ix').onclick=function(e){e.stopPropagation();hideInv();};
  document.getElementById('vs25-inp').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
  document.getElementById('vs25-inp').addEventListener('input',function(){
    this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';
    hideFaq();
  });

  passiveTrack();startSession();loadFaq();
  _proTimer=setTimeout(showInv,28000);

  // ─── Auto-Cleanup beim Verlassen der Seite ────────────────────────────────
  // pagehide deckt sowohl Tab-Schließen als auch Domain-Wechsel ab
  // (zuverlässiger als beforeunload, kompatibel mit BFCache).
  window.addEventListener('pagehide', function(e){
    if (!e.persisted) {
      _ssClear();
      chatId = null;
    }
  });
  // Fallback für ältere Browser
  window.addEventListener('beforeunload', function(){
    _ssClear();
  });
}

function passiveTrack(){
  // Lightweight beacon - updates existing session, never creates new one
  var saved=_ssGet()||chatId;
  fetch(API+'/api/widget/beacon',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({fingerprint:fp(),pageUrl:location.href,pageTitle:smartTitle(),chatId:saved}),keepalive:true})
  .then(function(r){return r.json();}).then(function(d){
    if(d.chatId&&!_ssGet()) _ssSet(d.chatId);
  }).catch(function(){});
}

function startSession(){
  fetch(API+'/api/widget/config').then(function(r){return r.json();}).then(function(d){
    var ft=document.getElementById('vs25-ft-text');
    if(ft){if(d.poweredBy===null||d.poweredBy===''){ft.parentElement.style.display='none';}else if(d.poweredBy){ft.textContent=d.poweredBy;}}
  }).catch(function(){});

  var saved=_ssGet();

  // RESUME: if we already know this visitor (current browser session),
  // skip full init to avoid duplicate sessions.
  if(saved){
    chatId=saved;
    loadHist();
    startStatusPoll();
    passiveTrack(); // Just update last_seen on existing session
    return;
  }

  // NEW VISITOR: full init creates session + chatId
  fetch(API+'/api/widget/init',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({fingerprint:fp(),pageUrl:location.href,pageTitle:smartTitle(),chatId:null})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.banned) return;
    chatId=d.chatId; _ssSet(chatId);
    if(d.welcome) addMsg('b',d.welcome);
    loadHist(); startStatusPoll();
  }).catch(function(){});
}

function loadHist(){
  if(!chatId) return;
  fetch(API+'/api/widget/history',{headers:{'X-Chat-ID':chatId}})
  .then(function(r){return r.json();}).then(function(d){
    var msgs=d.messages||[],el=document.getElementById('vs25-msgs');
    if(msgs.length&&el&&!el.children.length){msgs.slice(-20).forEach(function(m){addMsg(m.role==='user'?'u':'b',m.content,true);});scrl();}
  }).catch(function(){});
}

function loadFaq(){
  fetch(API+'/api/widget/faq').then(function(r){return r.json();}).then(function(d){
    var bar=document.getElementById('vs25-fqg'); if(!bar) return; bar.innerHTML='';
    (d.faqs||[]).forEach(function(q){
      var btn=document.createElement('button'); btn.className='vs25-chip'; btn.textContent=q;
      btn.onclick=function(){openChat();document.getElementById('vs25-inp').value=q;hideFaq();sendMsg();};
      bar.appendChild(btn);
    });
  }).catch(function(){});
}

function hideFaq(){if(_faqUsed) return;_faqUsed=true;var el=document.getElementById('vs25-fq');if(el)el.style.display='none';}

function sendMsg(){
  if(isTyping||!chatId) return;
  var inp=document.getElementById('vs25-inp'),text=(inp.value||'').trim();
  if(!text) return;
  inp.value='';inp.style.height='auto';
  hideFaq();addMsg('u',text);showTyp(true);
  document.getElementById('vs25-snd').disabled=true;
  fetch(API+'/api/widget/message',{method:'POST',headers:{'Content-Type':'application/json','X-Chat-ID':chatId},body:JSON.stringify({message:text,chatId})})
  .then(function(r){return r.json();}).then(function(d){
    showTyp(false);document.getElementById('vs25-snd').disabled=false;
    if(d.reply) addMsg('b',d.reply);
  }).catch(function(){showTyp(false);document.getElementById('vs25-snd').disabled=false;addMsg('b','Bitte erneut versuchen.');});
}

function toggleKI(){
  var tog=document.getElementById('vs25-ki-toggle');
  var isKIon=tog.checked; // true = KI an, false = Mitarbeiter
  _handover=!isKIon;
  if(!chatId) return;

  fetch(API+'/api/widget/handover',{method:'POST',headers:{'Content-Type':'application/json','X-Chat-ID':chatId},
    body:JSON.stringify({chatId,request:_handover})}).catch(function(){});

  if(_handover){
    addMsg('b','👤 Ein Mitarbeiter wurde benachrichtigt und meldet sich bald. Die KI ist pausiert.');
    setStatusUI('manual');
  } else {
    addMsg('b','✅ KI-Support ist wieder aktiv.');
    setStatusUI('online');
  }
}

function setStatusUI(status){
  var dot=document.getElementById('vs25-status-dot');
  var avDot=document.getElementById('vs25-av-dot');
  var sub=document.getElementById('vs25-hdr-sub');
  var tog=document.getElementById('vs25-ki-toggle');

  if(dot){dot.className=status;}
  if(avDot){avDot.className='vs25-av-dot '+(status==='online'?'':''+status);}
  if(sub){
    sub.textContent=status==='online'?'KI Assistent · Online':status==='manual'?'Mitarbeiter angefordert':'KI Offline';
  }
  if(tog&&status!=='offline'){tog.checked=status==='online';}
}

function startStatusPoll(){
  if(_statusInt) clearInterval(_statusInt);
  _statusInt=setInterval(function(){
    if(!chatId) return;
    fetch(API+'/api/widget/status',{headers:{'X-Chat-ID':chatId}})
    .then(function(r){return r.json();}).then(function(d){setStatusUI(d.status||'online');}).catch(function(){});
  }, 15000);
}

function openChat(){
  if(isOpen) return;isOpen=true;hideInv();_proDone=true;clearTimeout(_proTimer);
  document.getElementById('vs25-pnl').classList.add('on');
  setTimeout(function(){document.getElementById('vs25-inp')?.focus();scrl();},80);
  trackPage();
}
function closeChat(){isOpen=false;document.getElementById('vs25-pnl').classList.remove('on');}
function showInv(){if(_proDone||isOpen) return;document.getElementById('vs25-inv').classList.add('on');_proDone=true;}
function hideInv(){document.getElementById('vs25-inv').classList.remove('on');}

function trackPage(){
  if(!chatId){setTimeout(trackPage,2000);return;}
  fetch(API+'/api/widget/activity',{method:'POST',headers:{'Content-Type':'application/json','X-Chat-ID':chatId},
    body:JSON.stringify({pageUrl:location.href,pageTitle:smartTitle(),chatId})}).catch(function(){});
}

function addMsg(role,text,noScroll){
  var el=document.getElementById('vs25-msgs'); if(!el) return;
  var d=document.createElement('div'); d.className='vs25-msg '+role;
  var t=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  d.innerHTML='<div class="vs25-bub">'+esc(text)+'<span class="vs25-ts">'+t+'</span></div>';
  el.appendChild(d); if(!noScroll) scrl();
}

function showTyp(show){
  isTyping=show;var ex=document.getElementById('vs25-typ');
  if(!show){if(ex)ex.remove();return;}if(ex) return;
  var d=document.createElement('div');d.id='vs25-typ';d.className='vs25-msg b vs25-typ';
  d.innerHTML='<div class="vs25-bub"><span></span><span></span><span></span></div>';
  document.getElementById('vs25-msgs').appendChild(d);scrl();
}

function scrl(){var e=document.getElementById('vs25-msgs');if(e)e.scrollTop=e.scrollHeight;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');}
function fp(){return btoa([navigator.userAgent,navigator.language,screen.width+'x'+screen.height,Intl.DateTimeFormat().resolvedOptions().timeZone].join('|')).substring(0,32);}

var _lastUrl=location.href;
setInterval(function(){
  if(location.href!==_lastUrl){
    _lastUrl=location.href;
    passiveTrack();        // Update session's last_page (never creates new session)
    if(chatId) trackPage(); // Log activity
    if(!isOpen){_proDone=false;clearTimeout(_proTimer);_proTimer=setTimeout(showInv,28000);}
  }
},1500);

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',build); else build();
})();
