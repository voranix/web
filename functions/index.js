// Cloud Functions para VORANIX
// -----------------------------------------------------------------------
// Se dispara automáticamente cada vez que se crea un documento nuevo en la
// colección "mensajes" de Firestore (es decir, cada vez que alguien envía
// el formulario de contacto). Hace dos cosas:
//   1) Envía un correo automático (a ti y opcionalmente de confirmación
//      a quien escribió).
//   2) Publica el mensaje en tu canal de Discord vía webhook.
//
// Requiere plan Blaze (cualquier Cloud Function lo requiere).
// -----------------------------------------------------------------------

const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();

// Misma región que Firestore (ver firebase.json -> firestore.location).
setGlobalOptions({ region: "southamerica-east1" });

// --- Secretos (se configuran una sola vez con `firebase functions:secrets:set NOMBRE`) ---
const SMTP_USER = defineSecret("SMTP_USER");           // ej: notificaciones@gmail.com
const SMTP_PASS = defineSecret("SMTP_PASS");           // contraseña de aplicación (no la normal)
const NOTIFY_EMAIL = defineSecret("NOTIFY_EMAIL");     // a quién le llega el aviso (puede ser el mismo SMTP_USER)
const DISCORD_WEBHOOK_URL = defineSecret("DISCORD_WEBHOOK_URL");

const ASUNTOS = {
    roster: "Postulación a roster",
    streamer: "Afiliación de streamer",
    colaboracion: "Colaboración",
    torneo: "Participación en torneo",
    general: "Consulta general"
};

// Mismo criterio que assets/js/firebase-config.js: escapar los campos que
// vienen del usuario antes de interpolarlos en HTML de correo (los formularios
// públicos no validan que "nombre", "mensaje", etc. no traigan HTML/links).
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

function construirCorreoHtml(data) {
    const asuntoLabel = escapeHtml(ASUNTOS[data.asunto] || data.asunto || "Sin especificar");
    const extra = [];
    if (data.juego) extra.push(`<li><strong>Juego:</strong> ${escapeHtml(data.juego)}</li>`);
    if (data.nivel) extra.push(`<li><strong>Nivel/Rango:</strong> ${escapeHtml(data.nivel)}</li>`);
    if (data.id_juego) extra.push(`<li><strong>ID juego:</strong> ${escapeHtml(data.id_juego)}</li>`);
    if (data.redes) extra.push(`<li><strong>Redes:</strong> ${escapeHtml(data.redes)}</li>`);
    if (data.descripcion) extra.push(`<li><strong>Descripción:</strong> ${escapeHtml(data.descripcion)}</li>`);
    if (data.equipo) extra.push(`<li><strong>Equipo:</strong> ${escapeHtml(data.equipo)}</li>`);
    if (data.juego_torneo) extra.push(`<li><strong>Juego (torneo):</strong> ${escapeHtml(data.juego_torneo)}</li>`);

    return `
        <h2>Nuevo mensaje de contacto - VORANIX</h2>
        <p><strong>Nombre:</strong> ${escapeHtml(data.nombre)}</p>
        <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
        <p><strong>Motivo:</strong> ${asuntoLabel}</p>
        ${extra.length ? `<ul>${extra.join("")}</ul>` : ""}
        <p><strong>Mensaje:</strong></p>
        <p>${escapeHtml(data.mensaje || "").replace(/\n/g, "<br>")}</p>
    `;
}

function construirCorreoConfirmacionHtml(data) {
    const asuntoLabel = escapeHtml(ASUNTOS[data.asunto] || data.asunto || "tu consulta");
    return `
<div style="background:#06060e;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#0d0d1e;border-radius:12px;overflow:hidden;border:1px solid #2a2a40;">
    <img src="https://voranix.web.app/imagenes/header-email.jpg" alt="VORANIX" style="width:100%;display:block;">
    <div style="padding:32px 28px;text-align:center;">
      <img src="https://voranix.web.app/imagenes/logopng.png" alt="VORANIX" width="64" height="64" style="width:64px;height:64px;margin:0 auto 16px;display:block;">
      <h1 style="color:#ffffff;font-size:22px;margin:0 0 12px;">¡Gracias por escribirnos, ${escapeHtml(data.nombre)}!</h1>
      <p style="color:#b8b8d0;font-size:14px;line-height:1.7;margin:0 0 8px;">
        Recibimos tu mensaje sobre <strong style="color:#ffffff;">${asuntoLabel}</strong>.
      </p>
      <p style="color:#b8b8d0;font-size:14px;line-height:1.7;margin:0 0 24px;">
        Nuestro staff se comunicará contigo lo antes posible. Mientras tanto, te invitamos a sumarte a nuestra comunidad en Discord.
      </p>
      <a href="https://discord.gg/jZq9gPSW5T" style="display:inline-block;background:#7b2cff;background:linear-gradient(135deg,#7b2cff,#ff6a00);color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:bold;font-size:13px;">Unirme al Discord</a>
    </div>
    <div style="border-top:1px solid #2a2a40;padding:20px 28px;text-align:center;">
      <p style="color:#9090b0;font-size:12px;margin:0 0 4px;">— El equipo de VORANIX</p>
      <p style="color:#55556a;font-size:11px;margin:0;">Este es un mensaje automático, no hace falta que lo respondas.</p>
    </div>
  </div>
</div>`;
}

function construirDiscordEmbed(data) {
    const asuntoLabel = ASUNTOS[data.asunto] || data.asunto || "Sin especificar";
    const campos = [
        { name: "Nombre", value: data.nombre || "-", inline: true },
        { name: "Email", value: data.email || "-", inline: true },
        { name: "Motivo", value: asuntoLabel, inline: true }
    ];

    if (data.juego) campos.push({ name: "Juego", value: data.juego, inline: true });
    if (data.nivel) campos.push({ name: "Nivel/Rango", value: data.nivel, inline: true });
    if (data.id_juego) campos.push({ name: "ID juego", value: data.id_juego, inline: true });
    if (data.redes) campos.push({ name: "Redes", value: data.redes, inline: false });
    if (data.equipo) campos.push({ name: "Equipo", value: data.equipo, inline: true });

    campos.push({
        name: "Mensaje",
        value: (data.mensaje || "-").slice(0, 1000)
    });

    return {
        embeds: [{
            title: "📩 Nuevo mensaje de contacto",
            color: 0x7b2cff,
            fields: campos,
            timestamp: new Date().toISOString()
        }]
    };
}

exports.onNuevoMensaje = onDocumentCreated(
    {
        document: "mensajes/{mensajeId}",
        secrets: [SMTP_USER, SMTP_PASS, NOTIFY_EMAIL, DISCORD_WEBHOOK_URL]
    },
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) {
            logger.warn("onNuevoMensaje: sin datos en el evento");
            return;
        }
        const data = snapshot.data();

        // --- 1) Notificación a Discord ---
        try {
            const webhookUrl = DISCORD_WEBHOOK_URL.value();
            if (webhookUrl) {
                const res = await fetch(webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(construirDiscordEmbed(data))
                });
                if (!res.ok) {
                    logger.error("Discord webhook respondió con error", res.status, await res.text());
                }
            } else {
                logger.warn("DISCORD_WEBHOOK_URL no configurado, se omite notificación a Discord");
            }
        } catch (err) {
            logger.error("Error enviando notificación a Discord", err);
        }

        // --- 2) Correo automático ---
        try {
            const smtpUser = SMTP_USER.value();
            const smtpPass = SMTP_PASS.value();
            const notifyEmail = NOTIFY_EMAIL.value() || smtpUser;

            if (smtpUser && smtpPass) {
                const transporter = nodemailer.createTransport({
                    service: "gmail",
                    auth: { user: smtpUser, pass: smtpPass }
                });

                await transporter.sendMail({
                    from: `VORANIX Web <${smtpUser}>`,
                    to: notifyEmail,
                    replyTo: data.email,
                    subject: `Nuevo mensaje de contacto: ${data.nombre}`,
                    html: construirCorreoHtml(data)
                });

                if (data.email && data.email.includes("@")) {
                    await transporter.sendMail({
                        from: `VORANIX <${smtpUser}>`,
                        to: data.email,
                        subject: "Recibimos tu mensaje - VORANIX",
                        html: construirCorreoConfirmacionHtml(data)
                    });
                }
            } else {
                logger.warn("SMTP_USER/SMTP_PASS no configurados, se omite el envío de correo");
            }
        } catch (err) {
            logger.error("Error enviando correo de notificación", err);
        }

        // --- 3) Marcar como procesado (para debug/orden en el panel admin) ---
        try {
            await snapshot.ref.update({ notificado: true });
        } catch (err) {
            logger.error("Error marcando mensaje como notificado", err);
        }
    }
);

// ---------------------------------------------------------------------
// limpiarMensajesAntiguos: corre todos los días y borra los mensajes de
// contacto con más de 30 días, para que la bandeja no se llene. Los que
// el staff marcó como "importante" desde el admin nunca se borran.
// ---------------------------------------------------------------------

exports.limpiarMensajesAntiguos = onSchedule(
    { schedule: "every day 03:00", timeZone: "America/Santiago" },
    async () => {
        const limite = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const snapshot = await admin.firestore()
            .collection("mensajes")
            .where("createdAt", "<=", limite)
            .get();

        const aBorrar = snapshot.docs.filter(doc => doc.data().importante !== true);
        if (!aBorrar.length) {
            logger.info("limpiarMensajesAntiguos: nada que borrar");
            return;
        }

        // Los batch de Firestore admiten hasta 500 operaciones.
        const db = admin.firestore();
        for (let i = 0; i < aBorrar.length; i += 400) {
            const batch = db.batch();
            aBorrar.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }
        logger.info(`limpiarMensajesAntiguos: se borraron ${aBorrar.length} mensaje(s)`);
    }
);

// ---------------------------------------------------------------------
// actualizarEnVivo: corre cada 5 minutos y marca en streamers/influencers
// quién está transmitiendo ahora mismo (Twitch/Kick/TikTok). Escribe directo
// con el Admin SDK, no pasa por firestore.rules.
//
// Twitch usa la API oficial (Helix) - confiable, necesita TWITCH_CLIENT_ID
// y TWITCH_CLIENT_SECRET (app gratis en dev.twitch.tv).
// Kick usa un endpoint público no documentado - funciona, pero Kick podría
// cambiarlo sin aviso (por eso va en su propio try/catch, canal por canal).
// TikTok NO tiene forma oficial de chequear esto sin acceso empresarial
// aprobado por TikTok: es "best effort" leyendo el HTML público del perfil,
// puede fallar en cualquier momento sin que eso rompa nada más.
// ---------------------------------------------------------------------

const TWITCH_CLIENT_ID = defineSecret("TWITCH_CLIENT_ID");
const TWITCH_CLIENT_SECRET = defineSecret("TWITCH_CLIENT_SECRET");

// Cache en memoria del token de Twitch entre invocaciones (dura ~60 días,
// no hace falta pedirlo cada 5 minutos).
let twitchTokenCache = { token: null, expiresAt: 0 };

function handleFromUrl(url) {
    if (!url) return "";
    const clean = String(url).trim().replace(/\/+$/, "");
    const last = clean.split("/").pop() || "";
    return last.replace(/^@/, "");
}

async function getTwitchToken(clientId, clientSecret) {
    if (twitchTokenCache.token && Date.now() < twitchTokenCache.expiresAt) {
        return twitchTokenCache.token;
    }
    const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
    const res = await fetch(url, { method: "POST" });
    const data = await res.json();
    if (!data.access_token) throw new Error("Twitch no devolvió access_token");
    twitchTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
    return twitchTokenCache.token;
}

// Devuelve un Map user_login (en minúscula) -> viewer_count de quienes están
// en vivo ahora mismo. viewer_count ya viene en la misma respuesta de
// /helix/streams, no hace falta una consulta ni un scope de OAuth aparte.
async function chequearTwitchEnVivo(handles, clientId, clientSecret) {
    const enVivo = new Map();
    if (!handles.length) return enVivo;
    const token = await getTwitchToken(clientId, clientSecret);
    for (let i = 0; i < handles.length; i += 100) {
        const lote = handles.slice(i, i + 100);
        const params = lote.map(h => `user_login=${encodeURIComponent(h.toLowerCase())}`).join("&");
        const res = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
            headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` }
        });
        const data = await res.json();
        (data.data || []).forEach(s => enVivo.set(String(s.user_login).toLowerCase(), Number(s.viewer_count) || 0));
    }
    return enVivo;
}

// null = no está en vivo; si está en vivo, devuelve el viewer_count (puede ser 0).
async function chequearKickEnVivo(handle) {
    try {
        const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(handle)}`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.livestream ? (Number(data.livestream.viewer_count) || 0) : null;
    } catch (err) {
        logger.warn(`actualizarEnVivo: no se pudo chequear Kick de ${handle}`, err.message);
        return null;
    }
}

// Best effort: TikTok no tiene API pública para esto. Se lee el HTML del
// perfil buscando el marcador de sala en vivo embebido en el JSON de la
// página. Si TikTok cambia su estructura, esto simplemente deja de detectar
// "en vivo" (nunca rompe el resto del chequeo).
async function chequearTiktokEnVivo(handle) {
    try {
        const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}/live`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" }
        });
        if (!res.ok) return false;
        const html = await res.text();
        return html.includes('"liveRoomUserInfo"') && /"status":\s*2\b/.test(html);
    } catch (err) {
        logger.warn(`actualizarEnVivo: no se pudo chequear TikTok de ${handle}`, err.message);
        return false;
    }
}

exports.actualizarEnVivo = onSchedule(
    { schedule: "every 5 minutes", secrets: [TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET] },
    async () => {
        const db = admin.firestore();
        const clientId = TWITCH_CLIENT_ID.value();
        const clientSecret = TWITCH_CLIENT_SECRET.value();

        for (const coleccion of ["streamers", "influencers"]) {
            const snapshot = await db.collection(coleccion).get();
            const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

            let twitchEnVivo = new Map();
            const twitchHandles = docs.filter(d => d.twitch).map(d => handleFromUrl(d.twitch));
            if (clientId && clientSecret && twitchHandles.length) {
                try {
                    twitchEnVivo = await chequearTwitchEnVivo(twitchHandles, clientId, clientSecret);
                } catch (err) {
                    logger.error("actualizarEnVivo: fallo consultando Twitch", err);
                }
            }

            const batch = db.batch();
            let cambios = 0;
            for (const item of docs) {
                let enVivo = false;
                let plataforma = "";
                let url = "";
                let viewerActual = 0;

                const twitchHandle = item.twitch ? handleFromUrl(item.twitch).toLowerCase() : "";
                if (twitchHandle && twitchEnVivo.has(twitchHandle)) {
                    enVivo = true; plataforma = "twitch"; url = item.twitch;
                    viewerActual = twitchEnVivo.get(twitchHandle) || 0;
                } else {
                    const kickViewers = item.kick ? await chequearKickEnVivo(handleFromUrl(item.kick)) : null;
                    if (kickViewers !== null) {
                        enVivo = true; plataforma = "kick"; url = item.kick; viewerActual = kickViewers;
                    } else if (item.tiktok && await chequearTiktokEnVivo(handleFromUrl(item.tiktok))) {
                        enVivo = true; plataforma = "tiktok"; url = item.tiktok;
                    }
                }

                if (item.enVivo !== enVivo || item.enVivoPlataforma !== plataforma || (item.viewerActual || 0) !== viewerActual) {
                    batch.update(db.collection(coleccion).doc(item.id), { enVivo, enVivoPlataforma: plataforma, enVivoUrl: url, viewerActual });
                    cambios++;
                }
            }
            if (cambios) await batch.commit();
        }
        logger.info("actualizarEnVivo: chequeo completado");
    }
);

// ---------------------------------------------------------------------
// Bot de Twitch (banner de raid): vía EventSub por webhook, no un bot IRC
// clásico -así sigue todo serverless, sin un proceso corriendo 24/7-.
// twitchEventSubWebhook recibe los eventos; sincronizarRaidWebhooks se
// encarga de que cada streamer afiliado tenga su suscripción "channel.raid"
// activa (corre sola, no hace falta tocar nada al sumar un streamer nuevo).
// ---------------------------------------------------------------------

const TWITCH_EVENTSUB_SECRET = defineSecret("TWITCH_EVENTSUB_SECRET");
const TWITCH_EVENTSUB_CALLBACK = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/twitchEventSubWebhook";

// Twitch firma cada request con HMAC-SHA256(id + timestamp + body crudo).
// Hay que verificarla antes de confiar en cualquier notificación.
function verificarFirmaTwitch(req, secret) {
    const messageId = req.get("Twitch-Eventsub-Message-Id") || "";
    const timestamp = req.get("Twitch-Eventsub-Message-Timestamp") || "";
    const signature = req.get("Twitch-Eventsub-Message-Signature") || "";
    const hmac = crypto.createHmac("sha256", secret)
        .update(messageId + timestamp + req.rawBody)
        .digest("hex");
    const esperado = `sha256=${hmac}`;
    if (signature.length !== esperado.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(esperado));
}

exports.twitchEventSubWebhook = onRequest(
    { secrets: [TWITCH_EVENTSUB_SECRET] },
    async (req, res) => {
        const tipoMensaje = req.get("Twitch-Eventsub-Message-Type");

        if (!verificarFirmaTwitch(req, TWITCH_EVENTSUB_SECRET.value())) {
            logger.warn("twitchEventSubWebhook: firma inválida");
            res.status(403).send("firma inválida");
            return;
        }

        if (tipoMensaje === "webhook_callback_verification") {
            res.status(200).type("text/plain").send(req.body.challenge);
            return;
        }

        if (tipoMensaje === "notification") {
            const { subscription, event } = req.body || {};
            if (subscription?.type === "channel.raid" && event) {
                const canal = String(event.to_broadcaster_user_login || "").toLowerCase();
                if (canal) {
                    await admin.firestore().doc(`raidAlerts/${canal}`).set({
                        fromBroadcaster: event.from_broadcaster_user_name || event.from_broadcaster_user_login || "alguien",
                        viewers: Number(event.viewers) || 0,
                        receivedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    logger.info(`twitchEventSubWebhook: raid registrado para ${canal}`);
                }
            }
            res.status(200).send("ok");
            return;
        }

        // revocation u otro tipo: solo confirmar recepción, no hace falta hacer nada.
        res.status(200).send("ok");
    }
);

async function crearSuscripcionRaid(userId, clientId, token, secret) {
    const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: {
            "Client-Id": clientId,
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            type: "channel.raid",
            version: "1",
            condition: { to_broadcaster_user_id: userId },
            transport: { method: "webhook", callback: TWITCH_EVENTSUB_CALLBACK, secret }
        })
    });
    if (res.status === 202 || res.status === 200) return "creada";
    if (res.status === 409) return "ya existía"; // ya hay una suscripción igual, no es un error real
    const data = await res.json().catch(() => ({}));
    throw new Error(`Twitch respondió ${res.status}: ${JSON.stringify(data)}`);
}

exports.sincronizarRaidWebhooks = onSchedule(
    {
        schedule: "every day 04:00",
        timeZone: "America/Santiago",
        secrets: [TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_SECRET]
    },
    async () => {
        const clientId = TWITCH_CLIENT_ID.value();
        const clientSecret = TWITCH_CLIENT_SECRET.value();
        const eventSubSecret = TWITCH_EVENTSUB_SECRET.value();
        if (!clientId || !clientSecret) {
            logger.warn("sincronizarRaidWebhooks: faltan credenciales de Twitch");
            return;
        }
        const token = await getTwitchToken(clientId, clientSecret);

        const db = admin.firestore();
        const handles = new Set();
        for (const coleccion of ["streamers", "influencers"]) {
            const snapshot = await db.collection(coleccion).get();
            snapshot.docs.forEach(d => {
                const data = d.data();
                if (data.activo !== false && data.twitch) handles.add(handleFromUrl(data.twitch).toLowerCase());
            });
        }
        if (handles.size === 0) {
            logger.info("sincronizarRaidWebhooks: no hay canales de Twitch cargados");
            return;
        }

        // Resolver login de Twitch -> user_id (channel.raid necesita el id, no el login).
        const logins = Array.from(handles).filter(Boolean);
        const userIds = [];
        for (let i = 0; i < logins.length; i += 100) {
            const lote = logins.slice(i, i + 100);
            const params = lote.map(h => `login=${encodeURIComponent(h)}`).join("&");
            const res = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
                headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` }
            });
            const data = await res.json();
            (data.data || []).forEach(u => userIds.push(u.id));
        }

        let creadas = 0, existentes = 0, fallidas = 0;
        for (const userId of userIds) {
            try {
                const resultado = await crearSuscripcionRaid(userId, clientId, token, eventSubSecret);
                if (resultado === "creada") creadas++; else existentes++;
            } catch (err) {
                fallidas++;
                logger.error(`sincronizarRaidWebhooks: fallo con user_id ${userId}`, err.message);
            }
        }
        logger.info(`sincronizarRaidWebhooks: ${creadas} creadas, ${existentes} ya existían, ${fallidas} fallidas`);
    }
);

// ---------------------------------------------------------------------
// Comandos de chat (!vrx / !voranix / los que cargue cada uno): a diferencia
// del raid, Twitch exige autorización explícita para leer chat ajeno. Dos
// logins únicos:
//   1) La cuenta oficial de VORANIX (voranixstudio) autoriza una vez como
//      "el bot", con scope user:read:chat + user:write:chat + user:bot
//      (link: twitchBotAuthStart?tipo=bot).
//   2) Cada streamer afiliado autoriza una vez con scope channel:bot,
//      dándole permiso al bot para leer/responder en SU canal
//      (link: twitchBotAuthStart?tipo=canal, se comparte con cada uno).
// Los comandos (varios, cada uno con su tipo chat/pantalla/ambos/codigo y su
// propio cooldown) se administran en Admin -> Sistema -> Overlay -> Comandos,
// colección overlayComandos.
// ---------------------------------------------------------------------

const TWITCH_BOT_LOGIN_OFICIAL = "voranixstudio";
const TWITCH_REDIRECT_URI = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/twitchBotAuthCallback";
const TWITCH_CHAT_CALLBACK = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/twitchChatWebhook";

async function intercambiarCodigoTwitch(code, clientId, clientSecret) {
    const params = new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, code,
        grant_type: "authorization_code", redirect_uri: TWITCH_REDIRECT_URI
    });
    const res = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: "POST" });
    return res.json();
}

// El state de OAuth para tipo=canal viaja con el uid de Firebase del creador
// que inició la conexión, firmado con HMAC (reutilizando TWITCH_CLIENT_SECRET
// como clave) para que nadie pueda armar un link con el uid de otra persona
// y quedarse con su canal de Twitch en el callback.
function firmarEstadoCanal(uid, secret) {
    return crypto.createHmac("sha256", secret).update(uid).digest("hex").slice(0, 32);
}

async function refrescarTokenBot(clientId, clientSecret) {
    const botSnap = await admin.firestore().doc("twitchBotAuth/_bot").get();
    const bot = botSnap.exists ? botSnap.data() : null;
    if (!bot?.refreshToken) throw new Error("El bot todavía no está autorizado (falta el login único de voranixstudio).");

    const params = new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        grant_type: "refresh_token", refresh_token: bot.refreshToken
    });
    const res = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: "POST" });
    const data = await res.json();
    if (!data.access_token) throw new Error("No se pudo refrescar el token del bot");

    await admin.firestore().doc("twitchBotAuth/_bot").set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token || bot.refreshToken,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return data.access_token;
}

// El Portal Creadores llama esto (onCall, autenticado) ANTES de mandar al
// creador a Twitch: firma el state acá, con el uid que la propia Cloud
// Function verificó a partir del token de Firebase Auth de la request (no
// un valor que el cliente pueda inventar). twitchBotAuthStart de abajo
// nunca firma un uid por su cuenta: solo reenvía este state ya firmado.
exports.generarEstadoTwitchCanal = onCall(
    { secrets: [TWITCH_CLIENT_SECRET] },
    (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores para conectar tu canal de Twitch.");
        }
        const firma = firmarEstadoCanal(request.auth.uid, TWITCH_CLIENT_SECRET.value());
        return { state: `canal:${request.auth.uid}:${firma}` };
    }
);

// Paso 1 de la autorización: redirige a Twitch. ?tipo=bot es exclusivo de la
// cuenta oficial (se valida en el callback); ?tipo=canal es el link que se
// comparte con cada streamer afiliado, con un ?state= ya firmado por
// generarEstadoTwitchCanal (esta función NO firma nada por su cuenta: si
// aceptara un uid crudo por query string, cualquiera podría pedir un state
// válido para el uid de otra persona sin haber iniciado sesión como ella).
exports.twitchBotAuthStart = onRequest(
    { secrets: [TWITCH_CLIENT_ID] },
    (req, res) => {
        const tipo = req.query.tipo === "bot" ? "bot" : "canal";
        const scope = tipo === "bot" ? "user:bot user:read:chat user:write:chat" : "channel:bot";
        let state = tipo;

        if (tipo === "canal") {
            state = String(req.query.state || "").trim();
            if (!state.startsWith("canal:")) {
                res.status(400).send("Este link para conectar tu canal es inválido o venció. Volvé al Portal Creadores y generalo de nuevo.");
                return;
            }
        }

        const params = new URLSearchParams({
            client_id: TWITCH_CLIENT_ID.value(),
            redirect_uri: TWITCH_REDIRECT_URI,
            response_type: "code",
            scope,
            state
        });
        res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
    }
);

// Paso 2: Twitch vuelve acá con el código, lo cambiamos por tokens.
exports.twitchBotAuthCallback = onRequest(
    { secrets: [TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const { code, state, error, error_description: errorDescription } = req.query;
        if (error) {
            res.status(400).send(`No se pudo autorizar: ${errorDescription || error}`);
            return;
        }
        try {
            const clientId = TWITCH_CLIENT_ID.value();
            const clientSecret = TWITCH_CLIENT_SECRET.value();

            const estado = String(state || "");
            let uid = "";
            if (estado !== "bot") {
                const partes = estado.split(":");
                if (partes.length !== 3 || partes[0] !== "canal" || firmarEstadoCanal(partes[1], clientSecret) !== partes[2]) {
                    res.status(400).send("El link para conectar tu canal venció o no es válido. Volvé al Portal Creadores y generalo de nuevo.");
                    return;
                }
                uid = partes[1];
            }

            const tokenData = await intercambiarCodigoTwitch(String(code || ""), clientId, clientSecret);
            if (!tokenData.access_token) throw new Error(JSON.stringify(tokenData));

            const userRes = await fetch("https://api.twitch.tv/helix/users", {
                headers: { "Client-Id": clientId, "Authorization": `Bearer ${tokenData.access_token}` }
            });
            const userData = await userRes.json();
            const usuario = userData.data?.[0];
            if (!usuario) throw new Error("No se pudo identificar la cuenta de Twitch");

            if (estado === "bot") {
                if (usuario.login.toLowerCase() !== TWITCH_BOT_LOGIN_OFICIAL) {
                    res.status(403).send(`Esta cuenta (${usuario.login}) no es la oficial de VORANIX (${TWITCH_BOT_LOGIN_OFICIAL}). Iniciá sesión en Twitch con esa cuenta e intentá de nuevo.`);
                    return;
                }
                await admin.firestore().doc("twitchBotAuth/_bot").set({
                    userId: usuario.id, login: usuario.login,
                    accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                res.send("<h2>Listo</h2><p>La cuenta oficial de VORANIX quedó conectada como bot de chat.</p>");
            } else {
                const loginVerificado = usuario.login.toLowerCase();

                // Evita que dos cuentas VORANIX terminen apuntando al mismo canal de
                // Twitch (si no, sus overlays y comandos personalizados se mezclarían).
                const duplicados = await admin.firestore().collection("users")
                    .where("twitchLogin", "==", loginVerificado).get();
                const deOtraCuenta = duplicados.docs.find(docSnap => docSnap.id !== uid);
                if (deOtraCuenta) {
                    res.status(409).send(`El canal de Twitch <b>${usuario.login}</b> ya está conectado a otra cuenta de VORANIX. Si esto es un error, avisale al equipo.`);
                    return;
                }

                await admin.firestore().doc(`twitchBotAuth/${loginVerificado}`).set({
                    broadcasterId: usuario.id, broadcasterLogin: loginVerificado,
                    authorizedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                // twitchLogin queda seteado acá, por el SDK de Admin (no por el
                // cliente): así queda verificado contra la cuenta real de Twitch,
                // no un texto que el creador podría escribir a mano.
                await admin.firestore().doc(`users/${uid}`).set({
                    twitchLogin: loginVerificado
                }, { merge: true });
                res.send(`<h2>¡Listo!</h2><p>Conectaste el canal <b>${usuario.login}</b> al bot de VORANIX. Los comandos van a funcionar en tu chat a partir de mañana (la sincronización corre una vez por día). Podés cerrar esta pestaña y volver al Portal Creadores.</p>`);
            }
        } catch (err) {
            logger.error("twitchBotAuthCallback: fallo", err);
            res.status(500).send("Hubo un error autorizando. Intentá de nuevo o avisale al equipo de VORANIX.");
        }
    }
);

async function enviarMensajeChat(broadcasterId, botUserId, botToken, clientId, mensaje) {
    return fetch("https://api.twitch.tv/helix/chat/messages", {
        method: "POST",
        headers: { "Client-Id": clientId, "Authorization": `Bearer ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: botUserId, message: mensaje })
    });
}

// Busca, entre los comandos activos, el primero cuyo/s trigger/s (separados
// por coma o espacio, igual que antes) coincidan con el texto del chat.
// Los comandos con "canal" (los que carga cada creador desde su propio
// portal) son exclusivos de ESE canal y ganan sobre uno general con el
// mismo trigger; los comandos sin "canal" (los que carga el staff desde
// Admin) siguen siendo generales, para todos los canales afiliados.
async function buscarComandoCoincidente(db, texto, canal) {
    const snapshot = await db.collection("overlayComandos").get();
    let coincidenciaGeneral = null;
    for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        if (data.activo === false) continue;
        const triggers = String(data.trigger || "")
            .split(/[,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
        if (!triggers.some(t => texto === t || texto.startsWith(`${t} `))) continue;

        if (data.canal) {
            if (data.canal === canal) return { ref: docSnap.ref, ...data };
        } else if (!coincidenciaGeneral) {
            coincidenciaGeneral = { ref: docSnap.ref, ...data };
        }
    }
    return coincidenciaGeneral;
}

// tipo "codigo": toma el primer código de descuento activo (mismo orden en
// que rotan en el overlay) para contestarlo/mostrarlo sin tener que estar
// editando el comando cada vez que cambia el código vigente.
async function obtenerCodigoActivo(db) {
    const snapshot = await db.collection("overlayCodigos").get();
    const activo = snapshot.docs.find(d => d.data().activo !== false);
    return activo ? activo.data() : null;
}

exports.twitchChatWebhook = onRequest(
    { secrets: [TWITCH_EVENTSUB_SECRET, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const tipoMensaje = req.get("Twitch-Eventsub-Message-Type");
        if (!verificarFirmaTwitch(req, TWITCH_EVENTSUB_SECRET.value())) {
            logger.warn("twitchChatWebhook: firma inválida");
            res.status(403).send("firma inválida");
            return;
        }
        if (tipoMensaje === "webhook_callback_verification") {
            res.status(200).type("text/plain").send(req.body.challenge);
            return;
        }
        if (tipoMensaje !== "notification") {
            res.status(200).send("ok");
            return;
        }

        res.status(200).send("ok"); // confirmar recepción ya; el resto sigue en segundo plano

        try {
            const { event } = req.body || {};
            const texto = String(event?.message?.text || "").trim().toLowerCase();
            if (!texto) return;

            // Cada canal tiene su propio cooldown y su propio banner de
            // pantalla: un comando usado en el stream de un creador no debe
            // interrumpir ni bloquear el de los demás.
            const canal = String(event?.broadcaster_user_login || "").toLowerCase();

            const db = admin.firestore();
            const comando = await buscarComandoCoincidente(db, texto, canal);
            if (!comando) return;

            // Cooldown: mientras no pasó el tiempo configurado desde el último
            // disparo EN ESE CANAL, se ignora en silencio (no contesta, no
            // toca el overlay) para no spamear ni interferir con el stream.
            const cooldownMs = (Number(comando.cooldownSegundos) || 0) * 1000;
            const ultimoDisparo = comando.ultimoDisparoPorCanal?.[canal]?.toMillis?.() || 0;
            if (cooldownMs > 0 && Date.now() - ultimoDisparo < cooldownMs) return;
            if (canal) {
                await comando.ref.update({ [`ultimoDisparoPorCanal.${canal}`]: admin.firestore.FieldValue.serverTimestamp() });
            }

            let respuestaChat = comando.respuestaChat || "";
            let pantalla = null;

            if (comando.tipo === "codigo") {
                const codigo = await obtenerCodigoActivo(db);
                if (codigo) {
                    respuestaChat = `Código: ${codigo.codigo}${codigo.descripcion ? ` — ${codigo.descripcion}` : ""}`;
                    pantalla = { titulo: codigo.codigo, detalle: codigo.descripcion || "", imagen: codigo.imagen || "", color: comando.color || "" };
                }
            } else if (comando.tipo === "pantalla" || comando.tipo === "ambos") {
                pantalla = { titulo: comando.tituloPantalla || "", detalle: comando.detallePantalla || "", imagen: comando.imagen || "", color: comando.color || "" };
            }

            const necesitaChat = ["chat", "ambos", "codigo"].includes(comando.tipo) && respuestaChat;
            const necesitaPantalla = canal && ["pantalla", "ambos", "codigo"].includes(comando.tipo) && pantalla && (pantalla.titulo || pantalla.detalle);

            if (necesitaPantalla) {
                await db.doc(`overlayEventoActual/${canal}`).set({
                    ...pantalla,
                    activadoAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            if (necesitaChat) {
                const clientId = TWITCH_CLIENT_ID.value();
                const clientSecret = TWITCH_CLIENT_SECRET.value();
                const botSnap = await db.doc("twitchBotAuth/_bot").get();
                const bot = botSnap.exists ? botSnap.data() : null;
                if (!bot) {
                    logger.warn("twitchChatWebhook: el bot todavía no está autorizado");
                    return;
                }

                let respuestaHttp = await enviarMensajeChat(event.broadcaster_user_id, bot.userId, bot.accessToken, clientId, respuestaChat);
                if (respuestaHttp.status === 401) {
                    const nuevoToken = await refrescarTokenBot(clientId, clientSecret);
                    respuestaHttp = await enviarMensajeChat(event.broadcaster_user_id, bot.userId, nuevoToken, clientId, respuestaChat);
                }
                if (!respuestaHttp.ok) {
                    logger.error("twitchChatWebhook: no se pudo enviar el mensaje", await respuestaHttp.text());
                }
            }
        } catch (err) {
            logger.error("twitchChatWebhook: fallo procesando comando", err);
        }
    }
);

exports.sincronizarChatWebhooks = onSchedule(
    {
        schedule: "every day 04:10",
        timeZone: "America/Santiago",
        secrets: [TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_SECRET]
    },
    async () => {
        const db = admin.firestore();
        const botSnap = await db.doc("twitchBotAuth/_bot").get();
        if (!botSnap.exists) {
            logger.warn("sincronizarChatWebhooks: el bot todavía no está autorizado, se omite");
            return;
        }
        const bot = botSnap.data();
        const clientId = TWITCH_CLIENT_ID.value();
        const clientSecret = TWITCH_CLIENT_SECRET.value();
        const eventSubSecret = TWITCH_EVENTSUB_SECRET.value();
        // channel.chat.message exige token de APP para crear la suscripción
        // (a diferencia de enviar el mensaje, que sí usa el token del bot).
        const appToken = await getTwitchToken(clientId, clientSecret);

        async function crearSuscripcionChat(canal) {
            return fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
                method: "POST",
                headers: { "Client-Id": clientId, "Authorization": `Bearer ${appToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "channel.chat.message",
                    version: "1",
                    condition: { broadcaster_user_id: canal.broadcasterId, user_id: bot.userId },
                    transport: { method: "webhook", callback: TWITCH_CHAT_CALLBACK, secret: eventSubSecret }
                })
            });
        }

        const canalesSnap = await db.collection("twitchBotAuth").get();
        let creadas = 0, existentes = 0, fallidas = 0;
        for (const docSnap of canalesSnap.docs) {
            if (docSnap.id === "_bot") continue;
            const canal = docSnap.data();
            try {
                const res = await crearSuscripcionChat(canal);
                if (res.status === 202 || res.status === 200) creadas++;
                else if (res.status === 409) existentes++;
                else throw new Error(`Twitch respondió ${res.status}: ${await res.text()}`);
            } catch (err) {
                fallidas++;
                logger.error(`sincronizarChatWebhooks: fallo con ${canal.broadcasterLogin}`, err.message);
            }
        }
        logger.info(`sincronizarChatWebhooks: ${creadas} creadas, ${existentes} ya existían, ${fallidas} fallidas`);
    }
);

// ---------------------------------------------------------------------
// enviarAccesoCreador: envía el link de "configurar/restablecer contraseña"
// + un correo explicando dónde entrar, a cualquier cuenta de Usuarios (el
// nombre de la función quedó de cuando era solo para creadores, pero ahora
// cubre todos los roles para no tener que crear una función nueva -y volver
// a pelear con el permiso de invocador de Cloud Run cada vez-).
// ---------------------------------------------------------------------

const PORTAL_INFO = {
    creador: { url: "https://voranix.web.app/pages/creadores.html", nombre: "Portal Creadores" },
    capitan: { url: "https://voranix.web.app/pages/roster-portal.html", nombre: "Portal Roster" },
    segundocapitan: { url: "https://voranix.web.app/pages/roster-portal.html", nombre: "Portal Roster" },
    jugador: { url: "https://voranix.web.app/pages/roster-portal.html", nombre: "Portal Roster" },
    admin: { url: "https://voranix.web.app/admin/admin.html", nombre: "Panel Admin" },
    editor: { url: "https://voranix.web.app/admin/admin.html", nombre: "Panel Admin" },
    viewer: { url: "https://voranix.web.app/admin/admin.html", nombre: "Panel Admin" }
};

// Cuenta sin ninguno de los roles conocidos (dato corrupto/incompleto): igual
// le mandamos el link de contraseña, pero apuntando al login del admin.
const PORTAL_FALLBACK = { url: "https://voranix.web.app/admin/admin.html", nombre: "VORANIX" };

// Una cuenta puede tener varios roles a la vez (ej. capitan + creador) y por
// lo tanto calificar para mas de un portal.
function profileRoles(profile) {
    if (!profile) return [];
    return Array.isArray(profile.roles) ? profile.roles : (profile.role ? [profile.role] : []);
}

function portalesDe(roles) {
    const vistos = new Set();
    const portales = [];
    for (const role of roles) {
        const info = PORTAL_INFO[role];
        if (info && !vistos.has(info.url)) {
            vistos.add(info.url);
            portales.push(info);
        }
    }
    return portales;
}

function construirCorreoAcceso({ displayName, email, resetLink, portales }) {
    const nombre = escapeHtml(displayName || "");
    const titulo = portales.length === 1 ? portales[0].nombre : "los portales";
    // portales[].url y resetLink los arma el propio backend (PORTAL_INFO /
    // admin.auth().generatePasswordResetLink), no vienen del usuario: no hace
    // falta escaparlos.
    const links = portales
        .map(p => `<a href="${p.url}">${p.nombre}: ${p.url}</a>`)
        .join("<br>");
    return `
        <h2>¡Bienvenido/a a ${titulo} VORANIX!</h2>
        <p>Hola ${nombre},</p>
        <p>Ahora tenés acceso a ${portales.length === 1 ? "un portal exclusivo" : "portales exclusivos"} de VORANIX.</p>
        <p><strong>Paso 1 — Configurá tu contraseña</strong><br>
        Hacé clic en este link (válido por tiempo limitado):<br>
        <a href="${resetLink}">${resetLink}</a></p>
        <p><strong>Paso 2 — Entrá al portal</strong><br>
        Una vez configurada tu contraseña, ingresá con tu email
        (<strong>${escapeHtml(email)}</strong>) en:<br>
        ${links}</p>
        <p>Cualquier duda, escribinos por Discord.</p>
        <p>— Equipo VORANIX</p>
    `;
}

exports.enviarAccesoCreador = onCall(
    { secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
        }

        // Solo admin puede disparar este envío (no editor: manda links de
        // acceso a cuentas, es una acción sensible).
        const callerSnap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
        const callerProfile = callerSnap.exists ? callerSnap.data() : null;
        if (!callerProfile || !profileRoles(callerProfile).includes("admin")) {
            throw new HttpsError("permission-denied", "Solo un admin puede enviar accesos.");
        }

        const uids = Array.isArray(request.data?.uids) ? request.data.uids : [];
        if (!uids.length) {
            throw new HttpsError("invalid-argument", "Debes indicar al menos un UID.");
        }

        const smtpUser = SMTP_USER.value();
        const smtpPass = SMTP_PASS.value();
        if (!smtpUser || !smtpPass) {
            throw new HttpsError("failed-precondition", "SMTP no configurado (SMTP_USER/SMTP_PASS).");
        }

        // Gmail SMTP corta la conexión con "421 Temporary System Problem" si le
        // llegan muchos correos casi en simultáneo desde una cuenta normal, asi
        // que se manda de a uno (pool de 1 conexión + limite de 1 mensaje/1.2s)
        // en vez de dispararlos todos en paralelo.
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: smtpUser, pass: smtpPass },
            pool: true,
            maxConnections: 1,
            rateDelta: 1200,
            rateLimit: 1
        });

        const detalle = [];
        for (const uid of uids) {
            try {
                const profileSnap = await admin.firestore().doc(`users/${uid}`).get();
                if (!profileSnap.exists) throw new Error(`Perfil ${uid} no existe en Firestore`);
                const profile = profileSnap.data();
                const roles = profileRoles(profile);

                // Blindaje: solo se manda a cuentas activas.
                if (profile.active === false) {
                    throw new Error(`${uid} está inactiva, se omite`);
                }

                const authUser = await admin.auth().getUser(uid);
                const email = authUser.email || profile.email;
                if (!email) throw new Error(`${uid} no tiene email`);

                const portalesEncontrados = portalesDe(roles);
                const portales = portalesEncontrados.length ? portalesEncontrados : [PORTAL_FALLBACK];
                const resetLink = await admin.auth().generatePasswordResetLink(email, { url: portales[0].url });

                await transporter.sendMail({
                    from: `VORANIX <${smtpUser}>`,
                    to: email,
                    subject: portales.length === 1 ? `Tu acceso al ${portales[0].nombre} VORANIX` : "Tu acceso a los portales VORANIX",
                    html: construirCorreoAcceso({ displayName: profile.displayName, email, resetLink, portales })
                });

                detalle.push({ uid, email, status: "enviado" });
            } catch (err) {
                logger.error(`enviarAccesoCreador: fallo con ${uid}`, err);
                detalle.push({ uid, status: "error", error: String(err?.message || err) });
            }
        }

        transporter.close();
        return { detalle };
    }
);

// ---------------------------------------------------------------------
// obtenerUltimoAcceso: devuelve, para cada UID pedido, cuándo se creó la
// cuenta y cuándo fue su último inicio de sesión (dato que solo vive en
// Firebase Auth, Firestore no lo sabe). Usado por la tabla de Usuarios
// del admin para mostrar "Último ingreso".
// ---------------------------------------------------------------------

exports.obtenerUltimoAcceso = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const callerSnap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
    const callerProfile = callerSnap.exists ? callerSnap.data() : null;
    if (!callerProfile || !profileRoles(callerProfile).includes("admin")) {
        throw new HttpsError("permission-denied", "Solo un admin puede ver esta información.");
    }

    const uids = Array.isArray(request.data?.uids) ? request.data.uids : [];
    if (!uids.length) return { estados: [] };

    // getUsers acepta maximo 100 identificadores por llamada.
    const estados = [];
    for (let i = 0; i < uids.length; i += 100) {
        const lote = uids.slice(i, i + 100).map(uid => ({ uid }));
        const { users, notFound } = await admin.auth().getUsers(lote);
        users.forEach(u => {
            estados.push({
                uid: u.uid,
                lastSignInTime: u.metadata.lastSignInTime || null,
                creationTime: u.metadata.creationTime || null
            });
        });
        notFound.forEach(n => estados.push({ uid: n.uid, lastSignInTime: null, creationTime: null, noEncontrado: true }));
    }

    return { estados };
});

// ---------------------------------------------------------------------
// enviarComunicado: manda un mismo correo (asunto + mensaje libre) a un
// grupo de cuentas (creadores, roster, capitanes, etc.). Pensado para
// avisos generales desde el admin, no para el flujo de "primer acceso".
// ---------------------------------------------------------------------

// mensajeHtml ya viene escapado por el caller (se escapa el mensaje crudo
// antes de partirlo en párrafos, ver enviarComunicado/enviarComunicadoContacto)
function construirCorreoComunicado({ displayName, asunto, mensajeHtml }) {
    const nombre = escapeHtml(displayName || "");
    return `
<div style="background:#06060e;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#0d0d1e;border-radius:12px;overflow:hidden;border:1px solid #2a2a40;">
    <div style="padding:28px 28px 8px;text-align:center;">
      <img src="https://voranix.web.app/imagenes/logopng.png" alt="VORANIX" width="56" height="56" style="width:56px;height:56px;margin:0 auto 14px;display:block;">
      <h1 style="color:#ffffff;font-size:20px;margin:0 0 4px;">${escapeHtml(asunto)}</h1>
    </div>
    <div style="padding:8px 28px 28px;">
      <p style="color:#b8b8d0;font-size:14px;line-height:1.7;margin:0 0 14px;">Hola ${nombre},</p>
      <div style="color:#dcdce8;font-size:14px;line-height:1.8;">${mensajeHtml}</div>
    </div>
    <div style="border-top:1px solid #2a2a40;padding:20px 28px;text-align:center;">
      <p style="color:#9090b0;font-size:12px;margin:0 0 4px;">— Equipo VORANIX</p>
      <p style="color:#55556a;font-size:11px;margin:0;">Este correo se envió a cuentas del staff/roster/creadores de VORANIX.</p>
    </div>
  </div>
</div>`;
}

exports.enviarComunicado = onCall(
    { secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
        }

        const callerSnap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
        const callerProfile = callerSnap.exists ? callerSnap.data() : null;
        const callerRoles = profileRoles(callerProfile);
        const callerIsStaff = callerRoles.some(r => ["admin", "editor"].includes(r));
        const callerIsCapitan = callerRoles.some(r => ["capitan", "segundocapitan"].includes(r));
        if (!callerProfile || (!callerIsStaff && !callerIsCapitan)) {
            throw new HttpsError("permission-denied", "No tienes permiso para enviar comunicados.");
        }

        const uids = Array.isArray(request.data?.uids) ? request.data.uids : [];
        const asunto = String(request.data?.asunto || "").trim();
        const mensaje = String(request.data?.mensaje || "").trim();
        if (!uids.length) throw new HttpsError("invalid-argument", "Debes indicar al menos un destinatario.");
        if (!asunto) throw new HttpsError("invalid-argument", "Debes indicar un asunto.");
        if (!mensaje) throw new HttpsError("invalid-argument", "Debes indicar un mensaje.");

        // Un capitán (sin ser staff) solo puede escribirle a su propio equipo
        // o a cuentas de staff/admin — nunca a otros equipos ni a creadores.
        if (!callerIsStaff) {
            const callerEquipo = callerProfile.equipoJuego || "";
            for (const uid of uids) {
                const targetSnap = await admin.firestore().doc(`users/${uid}`).get();
                const targetProfile = targetSnap.exists ? targetSnap.data() : null;
                const targetRoles = profileRoles(targetProfile);
                const targetIsStaff = targetRoles.some(r => ["admin", "editor"].includes(r));
                const targetIsSameTeam = !!targetProfile && targetProfile.equipoJuego === callerEquipo;
                if (!targetIsStaff && !targetIsSameTeam) {
                    throw new HttpsError("permission-denied", `No puedes enviar mensajes a cuentas fuera de tu equipo o de staff (${uid}).`);
                }
            }
        }

        const smtpUser = SMTP_USER.value();
        const smtpPass = SMTP_PASS.value();
        if (!smtpUser || !smtpPass) {
            throw new HttpsError("failed-precondition", "SMTP no configurado (SMTP_USER/SMTP_PASS).");
        }

        const mensajeHtml = escapeHtml(mensaje)
            .split(/\n{2,}/)
            .map(parrafo => `<p style="margin:0 0 12px;">${parrafo.replace(/\n/g, "<br>")}</p>`)
            .join("");

        // Mismo limite de 1 mensaje/1.2s que enviarAccesoCreador, por el mismo
        // motivo: Gmail corta la conexión si le llegan muchos correos juntos.
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: smtpUser, pass: smtpPass },
            pool: true,
            maxConnections: 1,
            rateDelta: 1200,
            rateLimit: 1
        });

        const detalle = [];
        for (const uid of uids) {
            try {
                const profileSnap = await admin.firestore().doc(`users/${uid}`).get();
                const profile = profileSnap.exists ? profileSnap.data() : {};
                const authUser = await admin.auth().getUser(uid);
                const email = authUser.email || profile.email;
                if (!email) throw new Error(`${uid} no tiene email`);

                await transporter.sendMail({
                    from: `VORANIX <${smtpUser}>`,
                    to: email,
                    subject: asunto,
                    html: construirCorreoComunicado({ displayName: profile.displayName, asunto, mensajeHtml })
                });

                detalle.push({ uid, email, status: "enviado" });
            } catch (err) {
                logger.error(`enviarComunicado: fallo con ${uid}`, err);
                detalle.push({ uid, status: "error", error: String(err?.message || err) });
            }
        }

        transporter.close();
        return { detalle };
    }
);

// ---------------------------------------------------------------------
// enviarComunicadoContacto: mismo tipo de correo que enviarComunicado, pero
// para destinatarios que NO tienen cuenta (streamers/influencers) — se
// manda directo a un email, sin pasar por Firebase Auth. Solo staff/admin,
// nunca capitanes (streamers/influencers no son "su equipo").
// ---------------------------------------------------------------------

exports.enviarComunicadoContacto = onCall(
    { secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
        }

        const callerSnap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
        const callerProfile = callerSnap.exists ? callerSnap.data() : null;
        if (!callerProfile || !profileRoles(callerProfile).some(r => ["admin", "editor"].includes(r))) {
            throw new HttpsError("permission-denied", "Solo staff/admin puede enviar comunicados a streamers o influencers.");
        }

        const contactos = Array.isArray(request.data?.contactos) ? request.data.contactos : [];
        const asunto = String(request.data?.asunto || "").trim();
        const mensaje = String(request.data?.mensaje || "").trim();
        if (!contactos.length) throw new HttpsError("invalid-argument", "Debes indicar al menos un destinatario.");
        if (!asunto) throw new HttpsError("invalid-argument", "Debes indicar un asunto.");
        if (!mensaje) throw new HttpsError("invalid-argument", "Debes indicar un mensaje.");

        const smtpUser = SMTP_USER.value();
        const smtpPass = SMTP_PASS.value();
        if (!smtpUser || !smtpPass) {
            throw new HttpsError("failed-precondition", "SMTP no configurado (SMTP_USER/SMTP_PASS).");
        }

        const mensajeHtml = escapeHtml(mensaje)
            .split(/\n{2,}/)
            .map(parrafo => `<p style="margin:0 0 12px;">${parrafo.replace(/\n/g, "<br>")}</p>`)
            .join("");

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: smtpUser, pass: smtpPass },
            pool: true,
            maxConnections: 1,
            rateDelta: 1200,
            rateLimit: 1
        });

        const detalle = [];
        for (const contacto of contactos) {
            const email = String(contacto?.email || "").trim();
            try {
                if (!email || !email.includes("@")) throw new Error("Email inválido");
                await transporter.sendMail({
                    from: `VORANIX <${smtpUser}>`,
                    to: email,
                    subject: asunto,
                    html: construirCorreoComunicado({ displayName: contacto?.nombre, asunto, mensajeHtml })
                });
                detalle.push({ uid: email, email, status: "enviado" });
            } catch (err) {
                logger.error(`enviarComunicadoContacto: fallo con ${email}`, err);
                detalle.push({ uid: email, status: "error", error: String(err?.message || err) });
            }
        }

        transporter.close();
        return { detalle };
    }
);


// ---------------------------------------------------------------------
// Notificaciones (campanita en los 3 portales + push a celular vía FCM).
// Un doc por destinatario en "notificaciones" (queda de historial, sirve
// aunque el push falle o el navegador no tenga permiso todavía), más el
// envío push a los tokens FCM guardados en users/{uid}.fcmTokens. Los
// tokens que Firebase reporta como inválidos/expirados se limpian solos.
// ---------------------------------------------------------------------

const ACTIVIDAD_TIPO_LABELS_NOTIF = { torneo: "torneo", scrim: "scrim", entrenamiento: "práctica", reunion: "reunión" };
const TAREA_ESTADO_LABELS_NOTIF = { pendiente: "Por Hacer", en_progreso: "En Progreso", revision: "En Revisión", hecho: "Hecho" };

async function enviarNotificacion(uids, { tipo, titulo, cuerpo, link }) {
    const db = admin.firestore();
    const uidsUnicos = [...new Set((uids || []).filter(Boolean))];
    if (!uidsUnicos.length) return;

    const batch = db.batch();
    for (const uid of uidsUnicos) {
        batch.set(db.collection("notificaciones").doc(), {
            paraUid: uid, tipo, titulo: titulo || "", cuerpo: cuerpo || "", link: link || "",
            leido: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    await batch.commit();

    try {
        const perfiles = await Promise.all(uidsUnicos.map(uid => db.doc(`users/${uid}`).get()));
        const tokensPorUid = new Map();
        for (const snap of perfiles) {
            const tokens = snap.exists ? snap.data().fcmTokens : null;
            if (Array.isArray(tokens) && tokens.length) {
                tokensPorUid.set(snap.id, tokens.map(t => t.token).filter(Boolean));
            }
        }
        const todosLosTokens = [...tokensPorUid.values()].flat();
        if (!todosLosTokens.length) return;

        const respuesta = await admin.messaging().sendEachForMulticast({
            tokens: todosLosTokens,
            notification: { title: titulo || "VORANIX", body: cuerpo || "" },
            webpush: {
                fcmOptions: { link: `https://voranix.web.app${link || "/"}` },
                notification: { icon: "https://voranix.web.app/imagenes/logopng.png" }
            }
        });

        const tokensInvalidos = new Set();
        respuesta.responses.forEach((r, i) => {
            const code = r.error?.code;
            if (!r.success && (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token")) {
                tokensInvalidos.add(todosLosTokens[i]);
            }
        });
        if (tokensInvalidos.size) {
            for (const [uid, tokens] of tokensPorUid.entries()) {
                if (!tokens.some(t => tokensInvalidos.has(t))) continue;
                const snap = await db.doc(`users/${uid}`).get();
                const actuales = snap.exists && Array.isArray(snap.data().fcmTokens) ? snap.data().fcmTokens : [];
                await db.doc(`users/${uid}`).update({
                    fcmTokens: actuales.filter(t => !tokensInvalidos.has(t.token))
                });
            }
        }
    } catch (err) {
        logger.error("enviarNotificacion: fallo al mandar push", err.message);
    }
}

async function usuariosConRol(role) {
    const snap = await admin.firestore().collection("users").get();
    return snap.docs.filter(d => profileRoles(d.data()).includes(role)).map(d => d.id);
}

// Reuniones/entrenamientos/scrims/torneos del equipo: avisa a jugadores y
// capitán de ESE juego apenas queda visible en el Portal Roster.
exports.onActividadEquipoNotificar = onDocumentWritten("equipoActividad/{actividadId}", async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after || after.visiblePortal !== true) return;

    const esNuevo = !before;
    const cambioRelevante = esNuevo || before.visiblePortal !== true ||
        before.titulo !== after.titulo || before.fechaInicio !== after.fechaInicio || before.hora !== after.hora;
    if (!cambioRelevante) return;

    const db = admin.firestore();
    const usersSnap = await db.collection("users").get();
    const destinatarios = usersSnap.docs
        .filter(d => {
            const data = d.data();
            const roles = profileRoles(data);
            return (roles.includes("jugador") || roles.includes("capitan") || roles.includes("segundocapitan")) && data.equipoJuego === after.juego;
        })
        .map(d => d.id);
    if (!destinatarios.length) return;

    const tipoLabel = ACTIVIDAD_TIPO_LABELS_NOTIF[after.tipo] || "actividad";
    await enviarNotificacion(destinatarios, {
        tipo: "actividad",
        titulo: `${esNuevo ? "Nueva" : "Se actualizó la"} ${tipoLabel}: ${after.titulo || ""}`,
        cuerpo: after.fechaInicio ? `${after.fechaInicio}${after.hora ? " · " + after.hora : ""}` : "",
        link: "/pages/roster-portal.html"
    });
});

// Accesos exclusivos y proyectos nuevos/actualizados: avisa a todos los
// creadores (es el contenido que el Portal Creadores les muestra).
exports.onAccesoNotificar = onDocumentWritten("accesos/{accesoId}", async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const esNuevo = !before;
    if (!esNuevo && before.titulo === after.titulo && before.descripcion === after.descripcion) return;

    const destinatarios = await usuariosConRol("creador");
    if (!destinatarios.length) return;
    await enviarNotificacion(destinatarios, {
        tipo: "acceso",
        titulo: `${esNuevo ? "Nuevo acceso" : "Se actualizó un acceso"}: ${after.titulo || ""}`,
        cuerpo: after.descripcion || "",
        link: "/pages/creadores.html"
    });
});

exports.onProyectoNotificar = onDocumentWritten("proyectos/{proyectoId}", async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const esNuevo = !before;
    if (!esNuevo && before.titulo === after.titulo && before.descripcion === after.descripcion) return;

    const destinatarios = await usuariosConRol("creador");
    if (!destinatarios.length) return;
    await enviarNotificacion(destinatarios, {
        tipo: "proyecto",
        titulo: `${esNuevo ? "Nuevo proyecto" : "Se actualizó un proyecto"}: ${after.titulo || ""}`,
        cuerpo: after.descripcion || "",
        link: "/pages/creadores.html"
    });
});

// Tareas del Tablero: avisa a cada responsable cuando se le asigna una
// tarea (nueva o agregado después) y, al resto de responsables que ya
// estaban, cuando cambia algo relevante del contenido/estado.
exports.onTareaNotificar = onDocumentWritten("tareas/{tareaId}", async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;

    const responsablesAntes = new Set((before?.responsables || []).map(r => r.uid));
    const responsablesAhora = (after.responsables || []).map(r => r.uid).filter(Boolean);
    const nuevos = responsablesAhora.filter(uid => !responsablesAntes.has(uid));

    if (!before) {
        if (responsablesAhora.length) {
            await enviarNotificacion(responsablesAhora, {
                tipo: "tarea",
                titulo: `Nueva tarea asignada: ${after.titulo || ""}`,
                cuerpo: after.descripcion || "",
                link: "/admin/admin.html#tablero"
            });
        }
        return;
    }

    if (nuevos.length) {
        await enviarNotificacion(nuevos, {
            tipo: "tarea",
            titulo: `Se te asignó la tarea: ${after.titulo || ""}`,
            cuerpo: after.descripcion || "",
            link: "/admin/admin.html#tablero"
        });
    }

    const yaEstaban = responsablesAhora.filter(uid => responsablesAntes.has(uid));
    const cambioContenido = before.titulo !== after.titulo || before.descripcion !== after.descripcion ||
        before.fechaLimite !== after.fechaLimite || before.estado !== after.estado;
    if (cambioContenido && yaEstaban.length) {
        await enviarNotificacion(yaEstaban, {
            tipo: "tarea",
            titulo: `Se actualizó la tarea: ${after.titulo || ""}`,
            cuerpo: after.estado ? `Estado: ${TAREA_ESTADO_LABELS_NOTIF[after.estado] || after.estado}` : "",
            link: "/admin/admin.html#tablero"
        });
    }
});

// Chequeo diario: tareas que vencen en 2 días y todavía no están "Hecho".
// Se dispara una sola vez por tarea (justo cuando fechaLimite cae 2 días
// adelante), no repite el aviso día a día.
exports.avisarTareasPorVencer = onSchedule(
    { schedule: "every day 08:00", timeZone: "America/Santiago" },
    async () => {
        const db = admin.firestore();
        const objetivo = new Date();
        objetivo.setDate(objetivo.getDate() + 2);
        const fechaObjetivo = objetivo.toISOString().slice(0, 10);

        const snap = await db.collection("tareas").where("fechaLimite", "==", fechaObjetivo).get();
        for (const docSnap of snap.docs) {
            const tarea = docSnap.data();
            if (tarea.estado === "hecho") continue;
            const uids = (tarea.responsables || []).map(r => r.uid).filter(Boolean);
            if (!uids.length) continue;
            await enviarNotificacion(uids, {
                tipo: "tarea-vencimiento",
                titulo: `Vence pronto: ${tarea.titulo || "una tarea"}`,
                cuerpo: `Fecha límite: ${tarea.fechaLimite}`,
                link: "/admin/admin.html#tablero"
            });
        }
    }
);
