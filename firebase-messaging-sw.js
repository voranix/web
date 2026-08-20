// Service worker compartido por los 3 portales instalables (Admin, Portal
// Creadores, Portal Roster). Dos trabajos:
//   1) Cumplir el requisito técnico de "instalable" (Add to Home Screen) —
//      Chrome exige un service worker con un listener de "fetch" registrado.
//   2) Recibir notificaciones push de Firebase Cloud Messaging en segundo
//      plano (con la app cerrada / en background) — ver initializeApp más
//      abajo, que se agrega cuando se activa el push real.
//
// A propósito NO cachea nada: toda la app depende de datos en vivo
// (Firestore) y de que cada carga traiga lo último. Cachear el HTML/JS acá
// arriesgaría mostrar contenido viejo — no vale la pena para lo que gana.

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

// Listener vacío a propósito: no intercepta nada (deja pasar todo a la red
// como si no hubiera service worker), pero su sola presencia ya cumple el
// criterio de instalabilidad de Chrome.
self.addEventListener("fetch", () => {});

// --- Firebase Cloud Messaging: recibir el push con la app cerrada/atrás ---
// Mismas credenciales públicas que assets/js/firebase-config.js (el apiKey
// de un web app de Firebase no es un secreto, el acceso real lo controlan
// firestore.rules/storage.rules).
//
// Todo esto queda en un try/catch a propósito: si estos dos scripts no
// cargan (red lenta, algún bloqueador, etc.), no puede tirar abajo el
// registro del service worker completo — eso rompería también la
// instalación como app (el fetch/install/activate de arriba), que no
// depende en nada de Firebase Messaging.
try {
    importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
    importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

    firebase.initializeApp({
        apiKey: "AIzaSyB8pMUHXHUY8JcGiZ8D5m0Xa2MkChKOXgI",
        authDomain: "voranix-2ecc9.firebaseapp.com",
        projectId: "voranix-2ecc9",
        storageBucket: "voranix-2ecc9.firebasestorage.app",
        messagingSenderId: "777966944040",
        appId: "1:777966944040:web:0221b235179951afeeda1d"
    });

    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
        const titulo = payload.notification?.title || "VORANIX";
        const link = payload.fcmOptions?.link || payload.data?.link || "/";
        self.registration.showNotification(titulo, {
            body: payload.notification?.body || "",
            icon: "/imagenes/icon-192.png",
            badge: "/imagenes/icon-192.png",
            data: { link }
        });
    });
} catch (err) {
    console.error("firebase-messaging-sw: no se pudo inicializar FCM", err);
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const link = event.notification.data?.link || "/";
    event.waitUntil(self.clients.openWindow(link));
});
