const publicVapidKey = 'DEIN_VAPID_PUBLIC_KEY_HIER_EINTRAGEN';

async function subscribePush() {
    if ('serviceWorker' in navigator) {
        const register = await navigator.serviceWorker.register('/sw.js', {
            scope: '/'
        });

        const subscription = await register.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
        });

        await api.saveSubscription(subscription);
        alert('Push-Benachrichtigungen sind jetzt aktiv! 🚀');
    }
}

// Hilfsfunktion für den Key-Typ
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

document.getElementById('enable-push').addEventListener('click', subscribePush);
