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

// limpiarReportesAntiguos: mismo criterio que limpiarMensajesAntiguos, para
// no acumular indefinidamente reportes de bug (mensaje + a veces una
// captura) — minimización de datos.
exports.limpiarReportesAntiguos = onSchedule(
    { schedule: "every day 03:00", timeZone: "America/Santiago" },
    async () => {
        const limite = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const snapshot = await admin.firestore()
            .collection("reportes")
            .where("createdAt", "<=", limite)
            .get();

        if (snapshot.empty) {
            logger.info("limpiarReportesAntiguos: nada que borrar");
            return;
        }

        const db = admin.firestore();
        const docs = snapshot.docs;
        for (let i = 0; i < docs.length; i += 400) {
            const batch = db.batch();
            docs.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }
        logger.info(`limpiarReportesAntiguos: se borraron ${docs.length} reporte(s)`);
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

// YouTube y Kick: mismo patrón que el "canal" de Twitch (más abajo) — el
// creador conecta su propia cuenta desde el Portal Creadores, queda
// verificada, y de ahí se lee su conteo de seguidores/suscriptores. Van
// declarados acá arriba (no junto a sus funciones de conexión, más abajo en
// el archivo) porque actualizarEnVivo los necesita y los `const` de nivel de
// módulo no se pueden usar antes de su declaración en el archivo.
const YOUTUBE_CLIENT_ID = defineSecret("YOUTUBE_CLIENT_ID");
const YOUTUBE_CLIENT_SECRET = defineSecret("YOUTUBE_CLIENT_SECRET");
const YOUTUBE_REDIRECT_URI = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/youtubeAuthCallback";

const KICK_CLIENT_ID = defineSecret("KICK_CLIENT_ID");
const KICK_CLIENT_SECRET = defineSecret("KICK_CLIENT_SECRET");
const KICK_REDIRECT_URI = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/kickAuthCallback";

const TIKTOK_CLIENT_ID = defineSecret("TIKTOK_CLIENT_ID");
const TIKTOK_CLIENT_SECRET = defineSecret("TIKTOK_CLIENT_SECRET");
const TIKTOK_REDIRECT_URI = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/tiktokAuthCallback";

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

// Devuelve un Map user_login (en minúscula) -> { viewerCount, gameName } de
// quienes están en vivo ahora mismo. Ambos datos ya vienen en la misma
// respuesta de /helix/streams, no hace falta una consulta ni un scope de
// OAuth aparte (game_name es el juego que Twitch le atribuye al stream).
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
        (data.data || []).forEach(s => enVivo.set(String(s.user_login).toLowerCase(), {
            viewerCount: Number(s.viewer_count) || 0,
            gameName: String(s.game_name || "").trim()
        }));
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

// Seguidores de Twitch: a diferencia de viewers/en vivo, este endpoint exige
// un token de usuario (del propio streamer, moderator:read:followers) — no
// alcanza con el token de la app. Si el streamer todavía no reconectó con el
// scope nuevo (no hay token guardado), devuelve null y actualizarEnVivo
// simplemente no toca el campo de seguidores para ese streamer.
async function obtenerSeguidoresTwitch(login, broadcasterId, clientId, clientSecret) {
    const tokenRef = admin.firestore().doc(`twitchBotAuth/${login}/privado/tokens`);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) {
        logger.warn(`obtenerSeguidoresTwitch[${login}]: no hay token guardado en twitchBotAuth/${login}/privado/tokens`);
        return null;
    }
    let { accessToken, refreshToken } = tokenSnap.data();
    if (!accessToken) {
        logger.warn(`obtenerSeguidoresTwitch[${login}]: el doc de tokens existe pero no tiene accessToken`);
        return null;
    }
    if (!broadcasterId) {
        logger.warn(`obtenerSeguidoresTwitch[${login}]: falta broadcasterId en twitchBotAuth/${login}`);
        return null;
    }

    const pedir = (token) => fetch(
        `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`,
        { headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` } }
    );

    try {
        let res = await pedir(accessToken);
        if (res.status === 401 && refreshToken) {
            const params = new URLSearchParams({
                client_id: clientId, client_secret: clientSecret,
                grant_type: "refresh_token", refresh_token: refreshToken
            });
            const refreshRes = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: "POST" });
            const refreshData = await refreshRes.json();
            if (!refreshData.access_token) {
                logger.warn(`obtenerSeguidoresTwitch[${login}]: no se pudo refrescar el token`, JSON.stringify(refreshData));
                return null;
            }
            accessToken = refreshData.access_token;
            refreshToken = refreshData.refresh_token || refreshToken;
            await tokenRef.set({
                accessToken, refreshToken, updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            res = await pedir(accessToken);
        }
        const bodyText = await res.text();
        if (!res.ok) {
            logger.warn(`obtenerSeguidoresTwitch[${login}]: la API respondió ${res.status}`, bodyText.slice(0, 2000));
            return null;
        }
        const data = JSON.parse(bodyText);
        if (!Number.isFinite(data.total)) {
            logger.warn(`obtenerSeguidoresTwitch[${login}]: respuesta 200 pero sin "total" utilizable. Claves: ${JSON.stringify(Object.keys(data))}`);
            return null;
        }
        return data.total;
    } catch (err) {
        logger.warn(`obtenerSeguidoresTwitch[${login}]: fallo`, err.message);
        return null;
    }
}

// Suscriptores de YouTube, con el token del propio dueño del canal. Si el
// canal tiene el conteo oculto (hiddenSubscriberCount), la API igual
// responde 200 pero con el número en 0 — en ese caso se devuelve null a
// propósito, para no mostrar un "0 suscriptores" que sería falso y además
// el creador explícitamente eligió ocultarlo.
async function obtenerSuscriptoresYoutube(channelId, clientId, clientSecret) {
    const tokenRef = admin.firestore().doc(`youtubeAuth/${channelId}/privado/tokens`);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) return null;
    let { accessToken, refreshToken } = tokenSnap.data();
    if (!accessToken) return null;

    const pedir = (token) => fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(channelId)}`,
        { headers: { "Authorization": `Bearer ${token}` } }
    );

    try {
        let res = await pedir(accessToken);
        if (res.status === 401 && refreshToken) {
            const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret,
                    grant_type: "refresh_token", refresh_token: refreshToken
                })
            });
            const refreshData = await refreshRes.json();
            if (!refreshData.access_token) return null;
            accessToken = refreshData.access_token;
            await tokenRef.set({
                accessToken, updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            res = await pedir(accessToken);
        }
        if (!res.ok) return null;
        const data = await res.json();
        const stats = data.items?.[0]?.statistics;
        if (!stats || stats.hiddenSubscriberCount) return null;
        const count = Number(stats.subscriberCount);
        return Number.isFinite(count) ? count : null;
    } catch (err) {
        logger.warn(`obtenerSuscriptoresYoutube: fallo para ${channelId}`, err.message);
        return null;
    }
}

// Seguidores de Kick, con el token del propio dueño del canal.
//
// DIAGNÓSTICO TEMPORAL: no tenía forma de probar esto contra la API real de
// Kick desde el entorno de desarrollo, así que hasta ahora los casos donde
// Kick responde algo inesperado (no un error de red, sino un 4xx/200-vacío/
// campo con otro nombre) volvían null en silencio, sin dejar rastro en los
// logs. Se agrega logger.warn en cada uno de esos casos para poder ver
// exactamente qué está devolviendo la API real y ajustar el parseo.
async function obtenerSeguidoresKick(slug, clientId, clientSecret) {
    const tokenRef = admin.firestore().doc(`kickAuth/${slug}/privado/tokens`);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) {
        logger.warn(`obtenerSeguidoresKick[${slug}]: no hay token guardado en kickAuth/${slug}/privado/tokens`);
        return null;
    }
    let { accessToken, refreshToken } = tokenSnap.data();
    if (!accessToken) {
        logger.warn(`obtenerSeguidoresKick[${slug}]: el doc de tokens existe pero no tiene accessToken`);
        return null;
    }

    const pedir = (token) => fetch("https://api.kick.com/public/v1/channels", {
        headers: { "Authorization": `Bearer ${token}` }
    });

    try {
        let res = await pedir(accessToken);
        if (res.status === 401 && refreshToken) {
            const refreshRes = await fetch(`${KICK_AUTH_BASE}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret,
                    grant_type: "refresh_token", refresh_token: refreshToken
                })
            });
            const refreshData = await refreshRes.json();
            if (!refreshData.access_token) {
                logger.warn(`obtenerSeguidoresKick[${slug}]: no se pudo refrescar el token`, JSON.stringify(refreshData));
                return null;
            }
            accessToken = refreshData.access_token;
            refreshToken = refreshData.refresh_token || refreshToken;
            await tokenRef.set({
                accessToken, refreshToken, updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            res = await pedir(accessToken);
        }
        const bodyText = await res.text();
        if (!res.ok) {
            logger.warn(`obtenerSeguidoresKick[${slug}]: la API respondió ${res.status}`, bodyText.slice(0, 2000));
            return null;
        }
        const data = JSON.parse(bodyText);
        const canal = data.data?.[0] || {};
        const count = Number(canal.followers_count);
        if (Number.isFinite(count)) return count;

        // La API pública oficial de Kick (/public/v1/channels) confirmado que
        // no trae followers_count. Se usa como respaldo el mismo endpoint no
        // oficial que ya usa chequearKickEnVivo para el estado en vivo
        // (kick.com/api/v2/channels/{slug}), que sí expone el conteo de
        // seguidores. Igual que el chequeo en vivo: si Kick cambia esto, deja
        // de traer el dato en vez de romper el resto del sistema.
        const fallbackRes = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!fallbackRes.ok) {
            logger.warn(`obtenerSeguidoresKick[${slug}]: sin followers_count en la API oficial, y el respaldo no oficial respondió ${fallbackRes.status}`);
            return null;
        }
        const fallbackData = await fallbackRes.json();
        const fallbackCount = Number(fallbackData.followersCount ?? fallbackData.followers_count);
        if (!Number.isFinite(fallbackCount)) {
            logger.warn(`obtenerSeguidoresKick[${slug}]: sin followers_count en ninguna de las dos APIs. Claves de nivel superior del respaldo: ${JSON.stringify(Object.keys(fallbackData))}`);
            return null;
        }
        return fallbackCount;
    } catch (err) {
        logger.warn(`obtenerSeguidoresKick[${slug}]: fallo`, err.message);
        return null;
    }
}

// Seguidores de TikTok, con el token del propio dueño de la cuenta.
async function obtenerSeguidoresTiktok(openId, clientId, clientSecret) {
    const tokenRef = admin.firestore().doc(`tiktokAuth/${openId}/privado/tokens`);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) return null;
    let { accessToken, refreshToken } = tokenSnap.data();
    if (!accessToken) return null;

    const pedir = (token) => fetch("https://open.tiktokapis.com/v2/user/info/?fields=follower_count", {
        headers: { "Authorization": `Bearer ${token}` }
    });

    try {
        let res = await pedir(accessToken);
        if (res.status === 401 && refreshToken) {
            const refreshRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_key: clientId, client_secret: clientSecret,
                    grant_type: "refresh_token", refresh_token: refreshToken
                })
            });
            const refreshData = await refreshRes.json();
            if (!refreshData.access_token) return null;
            accessToken = refreshData.access_token;
            refreshToken = refreshData.refresh_token || refreshToken;
            await tokenRef.set({
                accessToken, refreshToken, updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            res = await pedir(accessToken);
        }
        if (!res.ok) return null;
        const data = await res.json();
        const count = Number(data.data?.user?.follower_count);
        return Number.isFinite(count) ? count : null;
    } catch (err) {
        logger.warn(`obtenerSeguidoresTiktok: fallo para ${openId}`, err.message);
        return null;
    }
}

exports.actualizarEnVivo = onSchedule(
    {
        schedule: "every 5 minutes",
        secrets: [
            TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET,
            KICK_CLIENT_ID, KICK_CLIENT_SECRET, TIKTOK_CLIENT_ID, TIKTOK_CLIENT_SECRET
        ]
    },
    async () => {
        const db = admin.firestore();
        const clientId = TWITCH_CLIENT_ID.value();
        const clientSecret = TWITCH_CLIENT_SECRET.value();
        const youtubeClientId = YOUTUBE_CLIENT_ID.value();
        const youtubeClientSecret = YOUTUBE_CLIENT_SECRET.value();
        const kickClientId = KICK_CLIENT_ID.value();
        const kickClientSecret = KICK_CLIENT_SECRET.value();
        const tiktokClientId = TIKTOK_CLIENT_ID.value();
        const tiktokClientSecret = TIKTOK_CLIENT_SECRET.value();

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
                let juegoActual = "";

                const twitchHandle = item.twitch ? handleFromUrl(item.twitch).toLowerCase() : "";
                const twitchInfo = twitchHandle ? twitchEnVivo.get(twitchHandle) : null;
                if (twitchInfo) {
                    enVivo = true; plataforma = "twitch"; url = item.twitch;
                    viewerActual = twitchInfo.viewerCount || 0;
                    juegoActual = twitchInfo.gameName || "";
                } else {
                    const kickViewers = item.kick ? await chequearKickEnVivo(handleFromUrl(item.kick)) : null;
                    if (kickViewers !== null) {
                        enVivo = true; plataforma = "kick"; url = item.kick; viewerActual = kickViewers;
                    } else if (item.tiktok && await chequearTiktokEnVivo(handleFromUrl(item.tiktok))) {
                        enVivo = true; plataforma = "tiktok"; url = item.tiktok;
                    }
                }

                // "juegos frecuentes" (solo streamers, no influencers): cada vez que
                // este chequeo lo encuentra en vivo en Twitch jugando algo, le suma
                // 5 minutos (el intervalo del scheduler) al juego correspondiente.
                // Es una aproximación, no un cronómetro exacto, pero alcanza para
                // mostrar "a qué juega más seguido" sin pedirle nada al streamer.
                const debeActualizarJuegos = coleccion === "streamers" && plataforma === "twitch" && !!juegoActual;

                // Seguidores de Twitch (solo streamers): independiente de si está en
                // vivo ahora mismo. Solo lo intenta si el creador ya reconectó con el
                // scope moderator:read:followers (seguidoresActivos en su doc de
                // twitchBotAuth) — si no, sigue null y no se toca nada.
                let seguidoresTwitch = null;
                if (coleccion === "streamers" && twitchHandle && clientId && clientSecret) {
                    try {
                        const authSnap = await db.collection("twitchBotAuth").doc(twitchHandle).get();
                        if (authSnap.exists && authSnap.data().seguidoresActivos) {
                            seguidoresTwitch = await obtenerSeguidoresTwitch(twitchHandle, authSnap.data().broadcasterId, clientId, clientSecret);
                        }
                    } catch (err) {
                        logger.warn(`actualizarEnVivo: fallo consultando seguidores de ${twitchHandle}`, err.message);
                    }
                }
                const debeActualizarSeguidores = seguidoresTwitch !== null && seguidoresTwitch !== (item.seguidoresTwitch ?? null);

                // Suscriptores de YouTube y seguidores de Kick (solo streamers): a
                // diferencia de Twitch, acá no hay forma confiable de derivar el
                // canal desde una URL tipeada a mano, así que se resuelve por la
                // cuenta VORANIX vinculada (item.uid -> users/{uid}.youtubeChannelId
                // / kickSlug), que es donde queda el dato verificado por OAuth.
                let suscriptoresYoutube = null;
                let seguidoresKick = null;
                let seguidoresTiktok = null;
                if (coleccion === "streamers" && item.uid) {
                    try {
                        const userSnap = await db.collection("users").doc(item.uid).get();
                        const userData = userSnap.exists ? userSnap.data() : null;
                        if (userData?.youtubeChannelId && youtubeClientId && youtubeClientSecret) {
                            suscriptoresYoutube = await obtenerSuscriptoresYoutube(userData.youtubeChannelId, youtubeClientId, youtubeClientSecret);
                        }
                        if (userData?.kickSlug && kickClientId && kickClientSecret) {
                            seguidoresKick = await obtenerSeguidoresKick(userData.kickSlug, kickClientId, kickClientSecret);
                        }
                        if (userData?.tiktokOpenId && tiktokClientId && tiktokClientSecret) {
                            seguidoresTiktok = await obtenerSeguidoresTiktok(userData.tiktokOpenId, tiktokClientId, tiktokClientSecret);
                        }
                    } catch (err) {
                        logger.warn(`actualizarEnVivo: fallo consultando suscriptores/seguidores de ${item.uid}`, err.message);
                    }
                }
                const debeActualizarYoutube = suscriptoresYoutube !== null && suscriptoresYoutube !== (item.suscriptoresYoutube ?? null);
                const debeActualizarKick = seguidoresKick !== null && seguidoresKick !== (item.seguidoresKick ?? null);
                const debeActualizarTiktok = seguidoresTiktok !== null && seguidoresTiktok !== (item.seguidoresTiktok ?? null);

                if (item.enVivo !== enVivo || item.enVivoPlataforma !== plataforma || (item.viewerActual || 0) !== viewerActual || debeActualizarJuegos || debeActualizarSeguidores || debeActualizarYoutube || debeActualizarKick || debeActualizarTiktok) {
                    const updateData = { enVivo, enVivoPlataforma: plataforma, enVivoUrl: url, viewerActual };
                    if (debeActualizarJuegos) {
                        const juegosVistos = Array.isArray(item.juegosVistos) ? item.juegosVistos.map(j => ({ ...j })) : [];
                        const idx = juegosVistos.findIndex(j => j.nombre === juegoActual);
                        if (idx >= 0) juegosVistos[idx].minutos = (juegosVistos[idx].minutos || 0) + 5;
                        else juegosVistos.push({ nombre: juegoActual, minutos: 5 });
                        juegosVistos.sort((a, b) => (b.minutos || 0) - (a.minutos || 0));
                        updateData.juegosVistos = juegosVistos.slice(0, 8);
                    }
                    if (debeActualizarSeguidores) {
                        updateData.seguidoresTwitch = seguidoresTwitch;
                    }
                    if (debeActualizarYoutube) {
                        updateData.suscriptoresYoutube = suscriptoresYoutube;
                    }
                    if (debeActualizarKick) {
                        updateData.seguidoresKick = seguidoresKick;
                    }
                    if (debeActualizarTiktok) {
                        updateData.seguidoresTiktok = seguidoresTiktok;
                    }
                    batch.update(db.collection(coleccion).doc(item.id), updateData);
                    cambios++;
                }
            }
            if (cambios) await batch.commit();
        }
        logger.info("actualizarEnVivo: chequeo completado");
    }
);

// ---------------------------------------------------------------------
// EventSub de Twitch por webhook, no un bot IRC clásico -así sigue todo
// serverless, sin un proceso corriendo 24/7-. twitchEventSubWebhook recibe
// los eventos; sincronizarRaidWebhooks (el nombre quedó del raid, pero ahora
// sincroniza 3 tipos) se encarga de que cada streamer afiliado tenga sus
// suscripciones "channel.raid" + "stream.online" + "stream.offline" activas
// (corre sola, no hace falta tocar nada al sumar un streamer nuevo). Estas
// dos últimas alimentan streamers/influencers/{id}/transmisiones, el
// historial de encendidos/apagados que usa el panel de métricas del admin.
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
            try {
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
                } else if (subscription?.type === "stream.online" && event) {
                    await registrarInicioTransmision(event);
                } else if (subscription?.type === "stream.offline" && event) {
                    await registrarFinTransmision(event);
                }
            } catch (err) {
                // Nunca devolver error acá: Twitch reintenta agresivamente los
                // webhooks que fallan, y un evento de transmision perdido no
                // amerita eso (se loguea y listo, el conteo semanal es
                // aproximado por naturaleza).
                logger.error("twitchEventSubWebhook: fallo procesando notification", err);
            }
            res.status(200).send("ok");
            return;
        }

        // revocation u otro tipo: solo confirmar recepción, no hace falta hacer nada.
        res.status(200).send("ok");
    }
);

async function crearSuscripcionEventSub(type, condition, clientId, token, secret) {
    const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: {
            "Client-Id": clientId,
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            type,
            version: "1",
            condition,
            transport: { method: "webhook", callback: TWITCH_EVENTSUB_CALLBACK, secret }
        })
    });
    if (res.status === 202 || res.status === 200) return "creada";
    if (res.status === 409) return "ya existía"; // ya hay una suscripción igual, no es un error real
    const data = await res.json().catch(() => ({}));
    throw new Error(`Twitch respondió ${res.status}: ${JSON.stringify(data)}`);
}

// Busca en streamers/influencers el documento cuyo campo "twitch" coincide
// con el login que mandó el evento. Se hace acá (no con una query directa
// por handle) porque el campo guarda la URL completa, no el handle solo.
async function buscarStreamerPorTwitchLogin(login) {
    const loginLower = String(login || "").toLowerCase();
    if (!loginLower) return null;
    const db = admin.firestore();
    for (const coleccion of ["streamers", "influencers"]) {
        const snapshot = await db.collection(coleccion).get();
        const match = snapshot.docs.find(d => handleFromUrl(d.data().twitch || "").toLowerCase() === loginLower);
        if (match) return { coleccion, id: match.id };
    }
    return null;
}

// Registro de transmisiones (streamers/influencers/{id}/transmisiones): para
// que el admin pueda ver, sin quedarse despierto hasta las 5am esperando,
// cuántas veces y cuándo prendió cada creador — el contrato pide un mínimo
// semanal. stream.offline no trae la hora de fin, así que se usa la hora de
// recepción del webhook (llega casi en tiempo real, alcanza de sobra para
// un conteo semanal/mensual, no hace falta precisión al segundo).
async function registrarInicioTransmision(event) {
    const encontrado = await buscarStreamerPorTwitchLogin(event.broadcaster_user_login);
    if (!encontrado) return;
    const coleccionRef = admin.firestore().collection(encontrado.coleccion).doc(encontrado.id).collection("transmisiones");
    // Evita duplicar si Twitch reintenta la notificación de stream.online.
    const abiertaSnap = await coleccionRef.where("fin", "==", null).limit(1).get();
    if (!abiertaSnap.empty) return;
    await coleccionRef.add({
        plataforma: "twitch",
        inicio: admin.firestore.FieldValue.serverTimestamp(),
        fin: null,
        duracionMinutos: null
    });
    logger.info(`registrarInicioTransmision: nueva transmision para ${event.broadcaster_user_login}`);
}

async function registrarFinTransmision(event) {
    const encontrado = await buscarStreamerPorTwitchLogin(event.broadcaster_user_login);
    if (!encontrado) return;
    const coleccionRef = admin.firestore().collection(encontrado.coleccion).doc(encontrado.id).collection("transmisiones");
    const abiertaSnap = await coleccionRef.where("fin", "==", null).get();
    if (abiertaSnap.empty) return;
    // Sin orderBy a propósito (mismo motivo que en otras queries de este
    // archivo): combinar where(fin==) con orderBy(inicio) exige un índice
    // compuesto que el workflow de deploy no publica. Se ordena acá, en
    // memoria — nunca son más de un puñado de documentos "abiertos".
    const docs = abiertaSnap.docs.sort((a, b) => (b.data().inicio?.toMillis() || 0) - (a.data().inicio?.toMillis() || 0));
    const masReciente = docs[0];
    const inicio = masReciente.data().inicio;
    const fin = admin.firestore.Timestamp.now();
    const duracionMinutos = inicio ? Math.round((fin.toMillis() - inicio.toMillis()) / 60000) : null;
    await masReciente.ref.update({ fin, duracionMinutos });
    logger.info(`registrarFinTransmision: transmision cerrada para ${event.broadcaster_user_login}`);
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

        // Además del raid, se suscribe stream.online/stream.offline (mismo
        // token de app, mismo callback) para llevar el registro de cuándo
        // prende y apaga cada streamer — ver registrarInicioTransmision.
        const SUSCRIPCIONES = [
            { type: "channel.raid", condition: (userId) => ({ to_broadcaster_user_id: userId }) },
            { type: "stream.online", condition: (userId) => ({ broadcaster_user_id: userId }) },
            { type: "stream.offline", condition: (userId) => ({ broadcaster_user_id: userId }) }
        ];

        let creadas = 0, existentes = 0, fallidas = 0;
        for (const userId of userIds) {
            for (const sub of SUSCRIPCIONES) {
                try {
                    const resultado = await crearSuscripcionEventSub(sub.type, sub.condition(userId), clientId, token, eventSubSecret);
                    if (resultado === "creada") creadas++; else existentes++;
                } catch (err) {
                    fallidas++;
                    logger.error(`sincronizarRaidWebhooks: fallo con ${sub.type} para user_id ${userId}`, err.message);
                }
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

// Mismo mecanismo que generarEstadoTwitchCanal de acá arriba, reutilizando la
// misma clave de firma (TWITCH_CLIENT_SECRET): es solo una clave HMAC, no
// tiene nada de "Twitch" en sí, y ya está desplegada — no hace falta un
// secreto nuevo solo para firmar un uid.
exports.generarEstadoYoutubeCanal = onCall(
    { secrets: [TWITCH_CLIENT_SECRET] },
    (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores para conectar tu canal de YouTube.");
        }
        const firma = firmarEstadoCanal(request.auth.uid, TWITCH_CLIENT_SECRET.value());
        return { state: `youtube:${request.auth.uid}:${firma}` };
    }
);

exports.generarEstadoKickCanal = onCall(
    { secrets: [TWITCH_CLIENT_SECRET] },
    (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores para conectar tu canal de Kick.");
        }
        const firma = firmarEstadoCanal(request.auth.uid, TWITCH_CLIENT_SECRET.value());
        return { state: `kick:${request.auth.uid}:${firma}` };
    }
);

exports.generarEstadoTiktokCanal = onCall(
    { secrets: [TWITCH_CLIENT_SECRET] },
    (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores para conectar tu cuenta de TikTok.");
        }
        const firma = firmarEstadoCanal(request.auth.uid, TWITCH_CLIENT_SECRET.value());
        return { state: `tiktok:${request.auth.uid}:${firma}` };
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
        // moderator:read:followers habilita mostrar el conteo de seguidores en
        // la tarjeta pública. Se agregó después de channel:bot, así que todo
        // streamer que ya se había conectado antes tiene que reconectar una
        // vez (el token viejo no tiene este permiso, Twitch no lo amplía solo).
        const scope = tipo === "bot" ? "user:bot user:read:chat user:write:chat" : "channel:bot moderator:read:followers";
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
                    authorizedAt: admin.firestore.FieldValue.serverTimestamp(),
                    seguidoresActivos: true
                });
                // El access/refresh token del propio streamer (a diferencia del resto
                // de este doc, que es público) sólo sirve para leer sus seguidores vía
                // moderator:read:followers — se guarda aparte, en una subcolección que
                // firestore.rules bloquea por completo (ni el propio dueño la puede
                // leer desde el cliente, solo el Admin SDK de estas Cloud Functions).
                await admin.firestore().doc(`twitchBotAuth/${loginVerificado}/privado/tokens`).set({
                    accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                // twitchLogin queda seteado acá, por el SDK de Admin (no por el
                // cliente): así queda verificado contra la cuenta real de Twitch,
                // no un texto que el creador podría escribir a mano.
                await admin.firestore().doc(`users/${uid}`).set({
                    twitchLogin: loginVerificado
                }, { merge: true });
                res.send(`<h2>¡Listo!</h2><p>Conectaste el canal <b>${usuario.login}</b> al bot de VORANIX. Los comandos van a funcionar en tu chat a partir de mañana (la sincronización corre una vez por día) y tus seguidores van a empezar a aparecer en tu tarjeta pública en un rato. Podés cerrar esta pestaña y volver al Portal Creadores.</p>`);
            }
        } catch (err) {
            logger.error("twitchBotAuthCallback: fallo", err);
            res.status(500).send("Hubo un error autorizando. Intentá de nuevo o avisale al equipo de VORANIX.");
        }
    }
);

// ---------------------------------------------------------------------
// Conexión de cuenta de YouTube (solo lectura, sin bot de chat): mismo
// patrón que el "canal" de Twitch — el creador se autentica una vez con
// Google, queda verificado su canal, y de ahí se lee el conteo de
// suscriptores cada 5 minutos. El token queda guardado en Firestore
// (youtubeAuth/{channelId}/privado/tokens) bloqueado a cualquier cliente.
// ---------------------------------------------------------------------

exports.youtubeAuthStart = onRequest(
    { secrets: [YOUTUBE_CLIENT_ID] },
    (req, res) => {
        const state = String(req.query.state || "").trim();
        if (!state.startsWith("youtube:")) {
            res.status(400).send("Este link para conectar tu canal es inválido o venció. Volvé al Portal Creadores y generalo de nuevo.");
            return;
        }
        const params = new URLSearchParams({
            client_id: YOUTUBE_CLIENT_ID.value(),
            redirect_uri: YOUTUBE_REDIRECT_URI,
            response_type: "code",
            access_type: "offline",
            prompt: "consent",
            scope: "https://www.googleapis.com/auth/youtube.readonly",
            state
        });
        res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }
);

exports.youtubeAuthCallback = onRequest(
    { secrets: [YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const { code, state, error, error_description: errorDescription } = req.query;
        if (error) {
            res.status(400).send(`No se pudo autorizar: ${errorDescription || error}`);
            return;
        }
        try {
            const clientId = YOUTUBE_CLIENT_ID.value();
            const clientSecret = YOUTUBE_CLIENT_SECRET.value();

            const partes = String(state || "").split(":");
            if (partes.length !== 3 || partes[0] !== "youtube" || firmarEstadoCanal(partes[1], TWITCH_CLIENT_SECRET.value()) !== partes[2]) {
                res.status(400).send("El link para conectar tu canal venció o no es válido. Volvé al Portal Creadores y generalo de nuevo.");
                return;
            }
            const uid = partes[1];

            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret, code,
                    grant_type: "authorization_code", redirect_uri: YOUTUBE_REDIRECT_URI
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error(JSON.stringify(tokenData));

            const channelRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` }
            });
            const channelData = await channelRes.json();
            const canal = channelData.items?.[0];
            if (!canal) throw new Error("No se pudo identificar el canal de YouTube (¿la cuenta tiene un canal creado?)");

            // Evita que dos cuentas VORANIX terminen apuntando al mismo canal.
            const duplicados = await admin.firestore().collection("users")
                .where("youtubeChannelId", "==", canal.id).get();
            const deOtraCuenta = duplicados.docs.find(docSnap => docSnap.id !== uid);
            if (deOtraCuenta) {
                res.status(409).send(`El canal de YouTube <b>${canal.snippet?.title || canal.id}</b> ya está conectado a otra cuenta de VORANIX. Si esto es un error, avisale al equipo.`);
                return;
            }

            await admin.firestore().doc(`youtubeAuth/${canal.id}`).set({
                channelId: canal.id, title: canal.snippet?.title || "",
                authorizedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`youtubeAuth/${canal.id}/privado/tokens`).set({
                accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`users/${uid}`).set({
                youtubeChannelId: canal.id
            }, { merge: true });

            res.send(`<h2>¡Listo!</h2><p>Conectaste el canal <b>${canal.snippet?.title || canal.id}</b>. Tus suscriptores van a empezar a aparecer en tu tarjeta pública en un rato (si no los tenés ocultos en la configuración de YouTube). Podés cerrar esta pestaña y volver al Portal Creadores.</p>`);
        } catch (err) {
            logger.error("youtubeAuthCallback: fallo", err);
            res.status(500).send("Hubo un error autorizando. Intentá de nuevo o avisale al equipo de VORANIX.");
        }
    }
);

// ---------------------------------------------------------------------
// Conexión de cuenta de Kick: mismo patrón. Scopes pedidos en la app de
// Kick: solo lectura de usuario y de canal (lo mínimo necesario acá).
// ---------------------------------------------------------------------

const KICK_AUTH_BASE = "https://id.kick.com/oauth";

// Kick usa OAuth 2.1 con PKCE obligatorio (a diferencia de Twitch/Google):
// el code_verifier tiene que sobrevivir entre el paso 1 (redirect) y el 2
// (callback), así que se guarda temporalmente atado al propio state firmado
// -nadie más puede leerlo sin la firma, así que no hace falta un secreto
// aparte para protegerlo-.
function generarPkce() {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

exports.kickAuthStart = onRequest(
    { secrets: [KICK_CLIENT_ID, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const state = String(req.query.state || "").trim();
        if (!state.startsWith("kick:")) {
            res.status(400).send("Este link para conectar tu canal es inválido o venció. Volvé al Portal Creadores y generalo de nuevo.");
            return;
        }
        const { verifier, challenge } = generarPkce();
        await admin.firestore().doc(`kickPkce/${state}`).set({
            verifier, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const params = new URLSearchParams({
            client_id: KICK_CLIENT_ID.value(),
            redirect_uri: KICK_REDIRECT_URI,
            response_type: "code",
            scope: "user:read channel:read",
            state,
            code_challenge: challenge,
            code_challenge_method: "S256"
        });
        res.redirect(`${KICK_AUTH_BASE}/authorize?${params}`);
    }
);

exports.kickAuthCallback = onRequest(
    { secrets: [KICK_CLIENT_ID, KICK_CLIENT_SECRET, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const { code, state, error, error_description: errorDescription } = req.query;
        if (error) {
            res.status(400).send(`No se pudo autorizar: ${errorDescription || error}`);
            return;
        }
        try {
            const clientId = KICK_CLIENT_ID.value();
            const clientSecret = KICK_CLIENT_SECRET.value();

            const partes = String(state || "").split(":");
            if (partes.length !== 3 || partes[0] !== "kick" || firmarEstadoCanal(partes[1], TWITCH_CLIENT_SECRET.value()) !== partes[2]) {
                res.status(400).send("El link para conectar tu canal venció o no es válido. Volvé al Portal Creadores y generalo de nuevo.");
                return;
            }
            const uid = partes[1];

            const pkceRef = admin.firestore().doc(`kickPkce/${state}`);
            const pkceSnap = await pkceRef.get();
            if (!pkceSnap.exists) throw new Error("Venció el intento de conexión (PKCE), volvé a intentar.");
            const { verifier } = pkceSnap.data();
            await pkceRef.delete();

            const tokenRes = await fetch(`${KICK_AUTH_BASE}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret, code,
                    grant_type: "authorization_code", redirect_uri: KICK_REDIRECT_URI,
                    code_verifier: verifier
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error(JSON.stringify(tokenData));

            const userRes = await fetch("https://api.kick.com/public/v1/users", {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` }
            });
            const userData = await userRes.json();
            const usuario = userData.data?.[0];
            if (!usuario) throw new Error("No se pudo identificar la cuenta de Kick");

            const channelRes = await fetch("https://api.kick.com/public/v1/channels", {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` }
            });
            const channelData = await channelRes.json();
            const canal = channelData.data?.[0];
            if (!canal) throw new Error("No se pudo identificar el canal de Kick");

            const slug = String(canal.slug || usuario.name || "").toLowerCase();
            if (!slug) throw new Error("Kick no devolvió el slug del canal");

            const duplicados = await admin.firestore().collection("users")
                .where("kickSlug", "==", slug).get();
            const deOtraCuenta = duplicados.docs.find(docSnap => docSnap.id !== uid);
            if (deOtraCuenta) {
                res.status(409).send(`El canal de Kick <b>${slug}</b> ya está conectado a otra cuenta de VORANIX. Si esto es un error, avisale al equipo.`);
                return;
            }

            await admin.firestore().doc(`kickAuth/${slug}`).set({
                slug, broadcasterUserId: usuario.user_id || canal.broadcaster_user_id || null,
                authorizedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`kickAuth/${slug}/privado/tokens`).set({
                accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`users/${uid}`).set({
                kickSlug: slug
            }, { merge: true });

            res.send(`<h2>¡Listo!</h2><p>Conectaste el canal <b>${slug}</b> de Kick. Tus seguidores van a empezar a aparecer en tu tarjeta pública en un rato. Podés cerrar esta pestaña y volver al Portal Creadores.</p>`);
        } catch (err) {
            logger.error("kickAuthCallback: fallo", err);
            res.status(500).send("Hubo un error autorizando. Intentá de nuevo o avisale al equipo de VORANIX.");
        }
    }
);

// ---------------------------------------------------------------------
// Conexión de cuenta de TikTok (Login Kit): mismo patrón OAuth 2.1 + PKCE
// que Kick de acá arriba. TikTok usa "client_key" en vez de "client_id" en
// sus parámetros — no es un typo, es como lo pide su API.
//
// Mientras la app de Producción sigue pendiente de aprobación de TikTok,
// TIKTOK_CLIENT_ID/TIKTOK_CLIENT_SECRET apuntan a las credenciales del
// Sandbox (probar el flujo real requiere eso). Cuando aprueben la app,
// hay que volver a guardar esos mismos secretos con los valores de
// Producción — el código no cambia, solo el valor del secreto.
// ---------------------------------------------------------------------

const TIKTOK_AUTH_BASE = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

exports.tiktokAuthStart = onRequest(
    { secrets: [TIKTOK_CLIENT_ID, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const state = String(req.query.state || "").trim();
        if (!state.startsWith("tiktok:")) {
            res.status(400).send("Este link para conectar tu cuenta es inválido o venció. Volvé al Portal Creadores y generalo de nuevo.");
            return;
        }
        const { verifier, challenge } = generarPkce();
        await admin.firestore().doc(`tiktokPkce/${state}`).set({
            verifier, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const params = new URLSearchParams({
            client_key: TIKTOK_CLIENT_ID.value(),
            redirect_uri: TIKTOK_REDIRECT_URI,
            response_type: "code",
            scope: "user.info.basic,user.info.stats",
            state,
            code_challenge: challenge,
            code_challenge_method: "S256"
        });
        res.redirect(`${TIKTOK_AUTH_BASE}?${params}`);
    }
);

exports.tiktokAuthCallback = onRequest(
    { secrets: [TIKTOK_CLIENT_ID, TIKTOK_CLIENT_SECRET, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const { code, state, error, error_description: errorDescription } = req.query;
        if (error) {
            res.status(400).send(`No se pudo autorizar: ${errorDescription || error}`);
            return;
        }
        try {
            const clientId = TIKTOK_CLIENT_ID.value();
            const clientSecret = TIKTOK_CLIENT_SECRET.value();

            const partes = String(state || "").split(":");
            if (partes.length !== 3 || partes[0] !== "tiktok" || firmarEstadoCanal(partes[1], TWITCH_CLIENT_SECRET.value()) !== partes[2]) {
                res.status(400).send("El link para conectar tu cuenta venció o no es válido. Volvé al Portal Creadores y generalo de nuevo.");
                return;
            }
            const uid = partes[1];

            const pkceRef = admin.firestore().doc(`tiktokPkce/${state}`);
            const pkceSnap = await pkceRef.get();
            if (!pkceSnap.exists) throw new Error("Venció el intento de conexión (PKCE), volvé a intentar.");
            const { verifier } = pkceSnap.data();
            await pkceRef.delete();

            const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_key: clientId, client_secret: clientSecret, code,
                    grant_type: "authorization_code", redirect_uri: TIKTOK_REDIRECT_URI,
                    code_verifier: verifier
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token || !tokenData.open_id) throw new Error(JSON.stringify(tokenData));

            const userRes = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=display_name", {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` }
            });
            const userData = await userRes.json();
            const displayName = userData.data?.user?.display_name || "";

            const openId = tokenData.open_id;

            const duplicados = await admin.firestore().collection("users")
                .where("tiktokOpenId", "==", openId).get();
            const deOtraCuenta = duplicados.docs.find(docSnap => docSnap.id !== uid);
            if (deOtraCuenta) {
                res.status(409).send(`Esta cuenta de TikTok ya está conectada a otra cuenta de VORANIX. Si esto es un error, avisale al equipo.`);
                return;
            }

            await admin.firestore().doc(`tiktokAuth/${openId}`).set({
                openId, displayName,
                authorizedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`tiktokAuth/${openId}/privado/tokens`).set({
                accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`users/${uid}`).set({
                tiktokOpenId: openId
            }, { merge: true });

            res.send(`<h2>¡Listo!</h2><p>Conectaste tu cuenta <b>${escapeHtml(displayName) || "de TikTok"}</b>. Tus seguidores van a empezar a aparecer en tu tarjeta pública en un rato. Podés cerrar esta pestaña y volver al Portal Creadores.</p>`);
        } catch (err) {
            logger.error("tiktokAuthCallback: fallo", err);
            res.status(500).send("Hubo un error autorizando. Intentá de nuevo o avisale al equipo de VORANIX.");
        }
    }
);

// Desconectar YouTube/Kick/TikTok: le saca al propio uid el campo de cuenta
// vinculada y borra el doc de autorización + sus tokens guardados (no revoca
// el token en la plataforma en sí, pero deja de leerlo y de guardar una
// copia acá). Deliberadamente NO incluye Twitch: twitchLogin alimenta mucho
// más (bot de chat, overlay, comandos), desconectarlo tiene un radio de
// impacto que no se pensó todavía — se puede agregar más adelante si hace
// falta, con más cuidado.
const CUENTAS_DESCONECTABLES = {
    youtube: { campo: "youtubeChannelId", coleccion: "youtubeAuth" },
    kick: { campo: "kickSlug", coleccion: "kickAuth" },
    tiktok: { campo: "tiktokOpenId", coleccion: "tiktokAuth" }
};

exports.desconectarCuenta = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores para desconectar una cuenta.");
    }
    const config = CUENTAS_DESCONECTABLES[String(request.data?.plataforma || "")];
    if (!config) {
        throw new HttpsError("invalid-argument", "Plataforma no reconocida.");
    }

    const uid = request.auth.uid;
    const db = admin.firestore();
    const userSnap = await db.doc(`users/${uid}`).get();
    const valor = userSnap.exists ? userSnap.data()[config.campo] : null;

    await db.doc(`users/${uid}`).update({
        [config.campo]: admin.firestore.FieldValue.delete()
    });

    if (valor) {
        await db.doc(`${config.coleccion}/${valor}/privado/tokens`).delete().catch(() => {});
        await db.doc(`${config.coleccion}/${valor}`).delete().catch(() => {});
    }

    return { ok: true };
});

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
