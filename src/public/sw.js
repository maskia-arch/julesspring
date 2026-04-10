// sw.js – Service Worker für Web Push Notifications
// Wird von Chrome/Android automatisch im Hintergrund ausgeführt

const CACHE_NAME = 'ai-admin-v1';

// Push-Nachricht empfangen → Notification anzeigen
self.addEventListener('push', function(event) {
  let data = { title: '💬 Neue Nachricht', body: 'Ein Kunde hat eine Nachricht gesendet.' };

  if (event.data) {
    try { data = event.data.json(); }
    catch(_) { data.body = event.data.text(); }
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
    data: {
      url:    data.url    || '/',
      chatId: data.chatId || null
    },
    actions: [
      { action: 'open',    title: '📋 Dashboard öffnen' },
      { action: 'dismiss', title: 'Schließen' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification angeklickt → Dashboard öffnen
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'dismiss') return;

  var targetUrl = event.notification.data?.url || '/admin';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      // Vorhandenes Fenster fokussieren wenn möglich
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.includes('/admin') && 'focus' in client) {
          return client.focus();
        }
      }
      // Neues Fenster öffnen
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// Service Worker aktivieren
self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});
