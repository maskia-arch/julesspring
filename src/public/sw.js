// sw.js – Service Worker für Web Push Notifications
// Wird von Chrome/Android automatisch im Hintergrund ausgeführt

const CACHE_NAME = 'ai-admin-v2';   // bei jedem SW-Update hochzählen damit Browser den neuen lädt

// ── Install: skipWaiting damit Updates SOFORT aktiv werden ─────────────────
// Vorher: User musste alle Tabs schließen damit neuer SW aktiv wurde.
// Folge bei Bugfixes: Bugs blieben tagelang im alten SW hängen.
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

// ── Activate: Kontrolle über alle Clients sofort übernehmen ────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

// ── Push: Notification anzeigen ────────────────────────────────────────────
self.addEventListener('push', function(event) {
  let data = { title: '💬 Neue Nachricht', body: 'Ein Kunde hat eine Nachricht gesendet.' };

  if (event.data) {
    try { data = event.data.json(); }
    catch(_) {
      try { data.body = event.data.text(); } catch(__) {}
    }
  }

  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/icon-192.png',
    badge:   '/icon-72.png',
    tag:     data.tag     || 'ai-chat-notification',
    renotify: true,                    // Neue Notification auch wenn Tag gleich
    requireInteraction: false,         // Verschwindet nach kurzer Zeit automatisch
    silent:  false,
    vibrate: [200, 100, 200],
    timestamp: Date.now(),
    data: {
      url:    data.url    || '/admin',
      chatId: data.chatId || null
    },
    actions: [
      { action: 'open',    title: '📋 Dashboard öffnen' },
      { action: 'dismiss', title: 'Schließen' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
      .catch(function(err) {
        console.error('[SW] showNotification failed:', err);
      })
  );
});

// ── Notification angeklickt → Dashboard öffnen ─────────────────────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'dismiss') return;

  var targetUrl = (event.notification.data && event.notification.data.url) || '/admin';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.indexOf('/admin') !== -1 && 'focus' in client) {
          if ('navigate' in client && targetUrl !== '/admin' && client.url.indexOf(targetUrl) === -1) {
            return client.navigate(targetUrl).then(function() { return client.focus(); });
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ── pushsubscriptionchange: Token automatisch erneuern ─────────────────────
// Browser erneuert den Push-Endpoint gelegentlich (alle paar Wochen). Ohne
// dieses Event verstummt die Subscription weil das Backend mit alter Sub
// weiter sendet — Push kommt nie an.
self.addEventListener('pushsubscriptionchange', function(event) {
  event.waitUntil((async function() {
    try {
      var vapidRes = await fetch('/api/admin/push/vapid-key', { credentials: 'include' });
      if (!vapidRes.ok) {
        console.warn('[SW] pushsubscriptionchange: VAPID-Key Fetch fehlgeschlagen', vapidRes.status);
        return;
      }
      var vapidData = await vapidRes.json();
      if (!vapidData.publicKey) return;

      var keyBytes = _urlBase64ToUint8Array(vapidData.publicKey);
      var newSub   = await self.registration.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: keyBytes
      });

      await fetch('/api/admin/push-subscription', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: newSub.toJSON() })
      });
      console.log('[SW] pushsubscriptionchange: erfolgreich erneuert');
    } catch (err) {
      console.error('[SW] pushsubscriptionchange fehlgeschlagen:', err);
    }
  })());
});

function _urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw     = self.atob(base64);
  var out     = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}
