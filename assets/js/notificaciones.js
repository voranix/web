// Campanita de notificaciones compartida por los 3 portales (admin, Portal
// Creadores, Portal Roster). Sin orderBy en la query a propósito: combinar
// where(paraUid==) con orderBy(createdAt) exige un índice compuesto que el
// workflow de deploy no publica (solo hosting/functions/firestore:rules/
// storage) — se ordena en el cliente en su lugar, alcanza de sobra para un
// puñado de notificaciones por cuenta.
import {
    collection,
    query,
    where,
    onSnapshot,
    doc,
    getDoc,
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import { app, db, escapeHtml } from "/assets/js/firebase-config.js";

// TODO: reemplazar por la VAPID key real una vez generada en Firebase
// Console → Configuración del proyecto → Cloud Messaging → Certificados
// push web → "Generar par de claves". Hasta entonces, activarPush() falla
// con un mensaje claro (la campanita in-app funciona igual sin esto).
const VAPID_KEY = "PENDIENTE_VAPID_KEY";

// Pide permiso de notificaciones, genera el token de este dispositivo y lo
// guarda en users/{uid}.fcmTokens (sin duplicar si ya estaba guardado).
export async function activarPush(uid) {
    if (VAPID_KEY.startsWith("PENDIENTE")) {
        throw new Error("Las notificaciones push todavía no están configuradas del lado de VORANIX.");
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        throw new Error("Este navegador no soporta notificaciones push.");
    }
    const permiso = await Notification.requestPermission();
    if (permiso !== "granted") {
        throw new Error("No diste permiso para las notificaciones.");
    }
    const registration = await navigator.serviceWorker.ready;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (!token) throw new Error("No se pudo generar el token de notificaciones.");

    const snap = await getDoc(doc(db, "users", uid));
    const actuales = (snap.exists() && Array.isArray(snap.data().fcmTokens)) ? snap.data().fcmTokens : [];
    const sinDuplicado = actuales.filter(t => t.token !== token);
    sinDuplicado.push({ token, userAgent: navigator.userAgent, updatedAt: new Date().toISOString() });
    await updateDoc(doc(db, "users", uid), { fcmTokens: sinDuplicado });
    return token;
}

// Emoji en vez de un ícono de librería: así el módulo no depende de que la
// página que lo use tenga Font Awesome cargado (admin.html no lo tiene).
const TIPO_ICONS = {
    actividad: "📅",
    acceso: "🎫",
    proyecto: "📁",
    tarea: "✅",
    "tarea-vencimiento": "⏰"
};

function tiempoRelativo(fecha) {
    if (!fecha) return "";
    const diffMs = Date.now() - fecha.getTime();
    const minutos = Math.floor(diffMs / 60000);
    if (minutos < 1) return "recién";
    if (minutos < 60) return `hace ${minutos} min`;
    const horas = Math.floor(minutos / 60);
    if (horas < 24) return `hace ${horas} h`;
    const dias = Math.floor(horas / 24);
    if (dias < 7) return `hace ${dias} d`;
    return fecha.toLocaleDateString("es-CL");
}

// elementos: { toggleBtn, badge, panel, listEl, activarBtn? }
// activarBtn es opcional: si se pasa, muestra "Activar notificaciones en
// este dispositivo" mientras el navegador no tenga permiso concedido.
// Devuelve { start(uid), stop() } — start() se llama al loguearse,
// stop() al cerrar sesión (corta la escucha en vivo).
export function initNotificationBell(elementos) {
    let unsub = null;
    let items = [];
    let panelAbierto = false;
    let currentUid = null;

    function actualizarActivarBtn() {
        if (!elementos.activarBtn) return;
        const soportado = "Notification" in window && "serviceWorker" in navigator;
        const yaActivado = soportado && Notification.permission === "granted";
        elementos.activarBtn.classList.toggle("hidden", !soportado || yaActivado);
    }

    if (elementos.activarBtn) {
        elementos.activarBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (!currentUid) return;
            const original = elementos.activarBtn.textContent;
            elementos.activarBtn.disabled = true;
            elementos.activarBtn.textContent = "Activando...";
            try {
                await activarPush(currentUid);
                elementos.activarBtn.textContent = "¡Notificaciones activadas!";
                setTimeout(actualizarActivarBtn, 1500);
            } catch (error) {
                console.error(error);
                alert(error.message || "No se pudo activar las notificaciones.");
                elementos.activarBtn.textContent = original;
            }
            elementos.activarBtn.disabled = false;
        });
    }

    function render() {
        const noLeidas = items.filter(n => !n.leido).length;
        elementos.badge.textContent = noLeidas > 9 ? "9+" : String(noLeidas);
        elementos.badge.classList.toggle("hidden", noLeidas === 0);

        elementos.listEl.innerHTML = items.length ? items.slice(0, 20).map(n => `
<div class="notif-item${n.leido ? "" : " is-unread"}" data-notif-id="${n.id}" data-notif-link="${escapeHtml(n.link || "")}">
    <span class="notif-item-icon">${TIPO_ICONS[n.tipo] || "🔔"}</span>
    <div class="notif-item-text">
        <p class="notif-item-title">${escapeHtml(n.titulo || "")}</p>
        ${n.cuerpo ? `<p class="notif-item-body">${escapeHtml(n.cuerpo)}</p>` : ""}
        <p class="notif-item-time">${tiempoRelativo(n.createdAt?.toDate?.())}</p>
    </div>
</div>`).join("") : `<p class="notif-empty">No tenés notificaciones todavía.</p>`;
    }

    function togglePanel(forzar) {
        panelAbierto = typeof forzar === "boolean" ? forzar : !panelAbierto;
        elementos.panel.classList.toggle("hidden", !panelAbierto);
    }

    elementos.toggleBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePanel();
    });

    elementos.listEl.addEventListener("click", (event) => {
        const item = event.target.closest("[data-notif-id]");
        if (!item) return;
        const id = item.dataset.notifId;
        const link = item.dataset.notifLink;
        const notif = items.find(n => n.id === id);
        if (notif && !notif.leido) {
            updateDoc(doc(db, "notificaciones", id), { leido: true }).catch(err => console.error(err));
        }
        if (link) location.href = link;
    });

    document.addEventListener("click", (event) => {
        if (panelAbierto && !elementos.panel.contains(event.target) && !elementos.toggleBtn.contains(event.target)) {
            togglePanel(false);
        }
    });

    function start(uid) {
        stop();
        currentUid = uid;
        actualizarActivarBtn();
        const q = query(collection(db, "notificaciones"), where("paraUid", "==", uid));
        unsub = onSnapshot(q, (snapshot) => {
            items = snapshot.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
            render();
        }, (error) => console.error("notificaciones", error));
    }

    function stop() {
        if (unsub) unsub();
        unsub = null;
        currentUid = null;
        items = [];
        togglePanel(false);
        render();
    }

    return { start, stop };
}
