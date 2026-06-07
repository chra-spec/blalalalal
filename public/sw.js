self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data.json(); } catch(e) { data = { title: 'Balon Patlatmaca', body: event.data.text() }; }
    event.waitUntil(
        self.registration.showNotification(data.title || '💌 Gizli Mesaj', {
            body: data.body || 'Odaya birisi katıldı!',
            icon: '/icon-192.png',
            badge: '/badge.png',
            vibrate: [200, 100, 200],
            requireInteraction: true
        })
    );
});
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(clients.openWindow('/'));
});
