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

// Nombres _V2 porque Secret Manager tardó en liberar los nombres viejos
// (TIKTOK_CLIENT_ID/TIKTOK_CLIENT_SECRET) después de borrarlos para cargar
// las credenciales de la nueva app de TikTok (organización) — nada más que
// eso, no hay una v1 real conviviendo.
const TIKTOK_CLIENT_ID = defineSecret("TIKTOK_CLIENT_ID_V2");
const TIKTOK_CLIENT_SECRET = defineSecret("TIKTOK_CLIENT_SECRET_V2");
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

// Un user_login de Twitch nunca lleva puntos ni otros símbolos — si el campo
// twitch de un perfil quedó apuntando por error a algo que no es un canal
// (ej. una página de link-in-bio), un solo handle inválido en una consulta
// agrupada a la API de Twitch hace que TODO el lote responda 400, no solo
// esa cuenta (confirmado en logs reales, ver actualizarEnVivo/
// sincronizarSuscripcionesEventSub, que filtran con esto antes de consultar).
const TWITCH_HANDLE_RE = /^[a-zA-Z0-9_]+$/;

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
        if (!res.ok) {
            // Antes esto seguía de largo silenciosamente (res.json() sobre una
            // respuesta de error da {} y el batch entero queda como "nadie en
            // vivo"), sin dejar rastro de que la API de Twitch falló.
            logger.error(`chequearTwitchEnVivo: la API respondió ${res.status} para el lote [${lote.join(", ")}]`, await res.text());
            continue;
        }
        const data = await res.json();
        (data.data || []).forEach(s => enVivo.set(String(s.user_login).toLowerCase(), {
            viewerCount: Number(s.viewer_count) || 0,
            gameName: String(s.game_name || "").trim()
        }));
    }
    return enVivo;
}

// Últimos VODs de Twitch, con el token de app (dato público, no hace falta
// que el streamer haya conectado nada aparte del canal en sí).
async function obtenerVideosTwitch(broadcasterId, clientId, clientSecret) {
    if (!broadcasterId) return [];
    try {
        const token = await getTwitchToken(clientId, clientSecret);
        const res = await fetch(
            `https://api.twitch.tv/helix/videos?user_id=${encodeURIComponent(broadcasterId)}&type=archive&first=8`,
            { headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` } }
        );
        if (!res.ok) {
            logger.warn(`obtenerVideosTwitch[${broadcasterId}]: la API respondió ${res.status}`);
            return [];
        }
        const data = await res.json();
        return (data.data || []).map(v => ({
            id: v.id, titulo: v.title, url: v.url,
            miniatura: String(v.thumbnail_url || "").replace("%{width}", "320").replace("%{height}", "180"),
            fecha: v.created_at,
            vistas: Number.isFinite(Number(v.view_count)) ? Number(v.view_count) : null
        }));
    } catch (err) {
        logger.warn(`obtenerVideosTwitch[${broadcasterId}]: fallo`, err.message);
        return [];
    }
}

// Box art de una categoría de Twitch por nombre exacto (el que ya viene en
// game_name de /helix/streams). Se usa solo la primera vez que una categoría
// nueva aparece en juegosVistos, para no pedirle esto a Twitch cada 5 min.
async function obtenerJuegoTwitch(nombre, clientId, clientSecret) {
    if (!nombre) return null;
    try {
        const token = await getTwitchToken(clientId, clientSecret);
        const res = await fetch(`https://api.twitch.tv/helix/games?name=${encodeURIComponent(nombre)}`, {
            headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const juego = (data.data || [])[0];
        if (!juego) return null;
        return {
            id: juego.id,
            boxArtUrl: String(juego.box_art_url || "").replace("{width}", "188").replace("{height}", "250")
        };
    } catch (err) {
        logger.warn(`obtenerJuegoTwitch[${nombre}]: fallo`, err.message);
        return null;
    }
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

// Últimos VODs de Kick. No hay endpoint oficial para esto (la API pública
// solo cubre canal/en vivo/moderación) — se usa el mismo endpoint no oficial
// que ya acompaña a chequearKickEnVivo y al respaldo de seguidores. Parseo
// defensivo: si Kick cambia la forma de la respuesta, se loguean las claves
// disponibles y se devuelve lista vacía en vez de romper el resto de la
// página (misma política que el resto de las integraciones no oficiales).
async function obtenerVideosKick(slug) {
    if (!slug) return [];
    try {
        const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!res.ok) {
            logger.warn(`obtenerVideosKick[${slug}]: la API respondió ${res.status}`);
            return [];
        }
        const data = await res.json();
        const lista = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!lista) {
            logger.warn(`obtenerVideosKick[${slug}]: forma de respuesta inesperada. Claves de nivel superior: ${JSON.stringify(Object.keys(data || {}))}`);
            return [];
        }
        return lista.slice(0, 8).map(v => {
            const video = v.video || v;
            const uuid = video.uuid || video.uuid_video || v.uuid;
            return {
                id: uuid,
                titulo: v.session_title || video.session_title || video.livestream?.session_title || "",
                url: uuid ? `https://kick.com/${encodeURIComponent(slug)}/videos/${encodeURIComponent(uuid)}` : "",
                miniatura: video.thumbnail?.src || video.thumbnail?.srcset || v.thumbnail?.src || "",
                fecha: v.created_at || video.created_at || "",
                vistas: Number.isFinite(Number(video.views ?? v.views)) ? Number(video.views ?? v.views) : null
            };
        }).filter(v => v.id && v.url);
    } catch (err) {
        logger.warn(`obtenerVideosKick[${slug}]: fallo`, err.message);
        return [];
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

// Foto de perfil + banner + tipo de cuenta desde Twitch, con el token de la
// app (dato público, no hace falta que el streamer haya conectado nada).
// Twitch no tiene un "banner de perfil" separado como Kick/YouTube — usa
// offline_image_url (la imagen que se muestra cuando el canal no está en
// vivo) como el campo más parecido, así que es lo que se usa acá.
async function obtenerPerfilTwitch(login, clientId, clientSecret) {
    try {
        const token = await getTwitchToken(clientId, clientSecret);
        const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
            headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const user = data.data?.[0];
        if (!user) return null;
        return {
            avatar: user.profile_image_url || null,
            banner: user.offline_image_url || null,
            broadcasterType: user.broadcaster_type || ""
        };
    } catch (err) {
        logger.warn(`obtenerPerfilTwitch[${login}]: fallo`, err.message);
        return null;
    }
}

// Mismo endpoint no oficial que ya se usa para el respaldo de seguidores y
// el chequeo en vivo de Kick. La forma exacta de dónde vienen el avatar y el
// banner no está confirmada (documentación no oficial), así que se prueban
// las variantes más probables y se loguean las claves si ninguna calza, en
// vez de asumir un campo que podría no existir.
async function obtenerPerfilKick(slug) {
    try {
        const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const avatar = data.user?.profile_pic || data.profile_pic || data.user?.profilepic || null;
        const bannerRaw = data.banner_picture;
        const banner = (bannerRaw && typeof bannerRaw === "object" ? bannerRaw.url : bannerRaw) || null;
        if (!avatar && !banner) {
            logger.warn(`obtenerPerfilKick[${slug}]: sin avatar/banner reconocibles. Claves: ${JSON.stringify(Object.keys(data))}, claves de user: ${JSON.stringify(Object.keys(data.user || {}))}`);
            return null;
        }
        return { avatar, banner };
    } catch (err) {
        logger.warn(`obtenerPerfilKick[${slug}]: fallo`, err.message);
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

// Últimos videos subidos al canal de YouTube, con el token del propio dueño
// (mismo doc de tokens que obtenerSuscriptoresYoutube). Primero hay que
// resolver la playlist de "subidos" del canal (contentDetails), y recién ahí
// se puede listar sus videos.
async function obtenerVideosYoutube(channelId, clientId, clientSecret) {
    const tokenRef = admin.firestore().doc(`youtubeAuth/${channelId}/privado/tokens`);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) return [];
    let { accessToken, refreshToken } = tokenSnap.data();
    if (!accessToken) return [];

    const pedir = (url, token) => fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    const refrescar = async () => {
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
        await tokenRef.set({ accessToken, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return accessToken;
    };

    try {
        let res = await pedir(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}`, accessToken);
        if (res.status === 401 && refreshToken) {
            if (!(await refrescar())) return [];
            res = await pedir(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}`, accessToken);
        }
        if (!res.ok) {
            logger.warn(`obtenerVideosYoutube[${channelId}]: fallo consultando el canal (${res.status})`);
            return [];
        }
        const canalData = await res.json();
        const uploadsId = canalData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsId) return [];

        const playlistRes = await pedir(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=8&playlistId=${encodeURIComponent(uploadsId)}`, accessToken);
        if (!playlistRes.ok) {
            logger.warn(`obtenerVideosYoutube[${channelId}]: fallo listando la playlist de subidos (${playlistRes.status})`);
            return [];
        }
        const playlistData = await playlistRes.json();
        const videos = (playlistData.items || [])
            .map(v => ({
                id: v.snippet?.resourceId?.videoId,
                titulo: v.snippet?.title || "",
                url: v.snippet?.resourceId?.videoId ? `https://www.youtube.com/watch?v=${v.snippet.resourceId.videoId}` : "",
                miniatura: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || "",
                fecha: v.snippet?.publishedAt || "",
                vistas: null
            }))
            .filter(v => v.id);
        if (!videos.length) return videos;

        // part=snippet no trae vistas — hace falta una consulta aparte a
        // videos.list?part=statistics. Si falla, no es grave: los videos ya
        // se resolvieron, solo quedan sin el dato de vistas.
        try {
            const statsRes = await pedir(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videos.map(v => v.id).join(",")}`, accessToken);
            if (statsRes.ok) {
                const statsData = await statsRes.json();
                const vistasPorId = new Map((statsData.items || []).map(i => [i.id, Number(i.statistics?.viewCount)]));
                videos.forEach(v => {
                    const n = vistasPorId.get(v.id);
                    if (Number.isFinite(n)) v.vistas = n;
                });
            }
        } catch (err) {
            logger.warn(`obtenerVideosYoutube[${channelId}]: fallo consultando vistas`, err.message);
        }
        return videos;
    } catch (err) {
        logger.warn(`obtenerVideosYoutube[${channelId}]: fallo`, err.message);
        return [];
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

// Últimos videos de TikTok (video.list, scope agregado después de que ya
// había gente conectada con solo user.info.basic/stats — por eso el gate
// por contenidoActivo antes de llamar a esto, ver obtenerContenidoCreador).
//
// No hay forma de probar esto contra la API real desde este entorno, así
// que igual que se hizo con Kick: si la forma de la respuesta no es la
// documentada, se loguean las claves en vez de asumir un campo que podría
// no existir y fallar en silencio.
async function obtenerVideosTiktok(openId, clientId, clientSecret) {
    const tokenRef = admin.firestore().doc(`tiktokAuth/${openId}/privado/tokens`);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) return [];
    let { accessToken, refreshToken } = tokenSnap.data();
    if (!accessToken) return [];

    const campos = "id,cover_image_url,share_url,video_description,title,create_time,view_count";
    const pedir = (token) => fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${campos}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ max_count: 8 })
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
            if (!refreshData.access_token) {
                logger.warn(`obtenerVideosTiktok[${openId}]: no se pudo refrescar el token`, JSON.stringify(refreshData));
                return [];
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
            logger.warn(`obtenerVideosTiktok[${openId}]: la API respondió ${res.status}`, bodyText.slice(0, 2000));
            return [];
        }
        const data = JSON.parse(bodyText);
        const videos = data.data?.videos;
        if (!Array.isArray(videos)) {
            logger.warn(`obtenerVideosTiktok[${openId}]: forma de respuesta inesperada. Claves de nivel superior: ${JSON.stringify(Object.keys(data || {}))}`);
            return [];
        }
        return videos.map(v => ({
            id: v.id,
            titulo: v.title || v.video_description || "",
            url: v.share_url || "",
            miniatura: v.cover_image_url || "",
            fecha: v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : "",
            vistas: Number.isFinite(Number(v.view_count)) ? Number(v.view_count) : null
        })).filter(v => v.id && v.url);
    } catch (err) {
        logger.warn(`obtenerVideosTiktok[${openId}]: fallo`, err.message);
        return [];
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
            // handleFromUrl(d.twitch) puede devolver "" (URL sin nombre al
            // final, ej. "https://twitch.tv/") o un valor con caracteres que
            // Twitch no permite en un user_login (ej. "fulano.carrd.co" si el
            // campo twitch quedó apuntando por error a una página de
            // link-in-bio en vez de al canal). Un solo user_login inválido en
            // la consulta agrupada hace que Twitch responda 400 para TODO el
            // lote, dejando a todos los streamers sin detectar como en vivo,
            // no solo al del dato malo — confirmado en logs reales
            // ("Malformed query params").
            const docsConTwitchInvalido = docs.filter(d => d.twitch && !TWITCH_HANDLE_RE.test(handleFromUrl(d.twitch)));
            if (docsConTwitchInvalido.length) {
                logger.warn(`actualizarEnVivo: ${coleccion} con campo twitch inválido (se ignoran en el chequeo de en vivo): ` +
                    docsConTwitchInvalido.map(d => `${d.id}="${d.twitch}"`).join(", "));
            }
            const twitchHandles = [...new Set(docs.filter(d => d.twitch && TWITCH_HANDLE_RE.test(handleFromUrl(d.twitch))).map(d => handleFromUrl(d.twitch)))];
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

                // Foto/banner/tipo de cuenta auto-detectados (solo streamers): Twitch
                // primero (dato público, no requiere que el streamer haya conectado
                // nada), Kick como respaldo si no tiene Twitch. Es independiente de
                // avatarOverride/bannerOverride, que el propio streamer puede cargar
                // desde Mi Tarjeta para reemplazar lo auto-detectado — la página
                // pública decide la prioridad entre ambos, esto solo mantiene el dato
                // auto-detectado al día.
                let perfilAuto = null;
                if (coleccion === "streamers") {
                    try {
                        if (twitchHandle && clientId && clientSecret) {
                            perfilAuto = await obtenerPerfilTwitch(twitchHandle, clientId, clientSecret);
                        } else if (item.kick) {
                            perfilAuto = await obtenerPerfilKick(handleFromUrl(item.kick));
                        }
                    } catch (err) {
                        logger.warn(`actualizarEnVivo: fallo consultando perfil auto de ${item.id}`, err.message);
                    }
                }
                const debeActualizarPerfilAuto = perfilAuto && (
                    perfilAuto.avatar !== (item.avatarAuto ?? null) ||
                    perfilAuto.banner !== (item.bannerAuto ?? null) ||
                    (perfilAuto.broadcasterType ?? "") !== (item.twitchBroadcasterType ?? "")
                );

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

                // Peak/promedio de viewers por sesión (solo streamers, mientras
                // está en vivo): se acumula en el doc de transmisión abierto en
                // cada chequeo — registrarFinTransmision calcula el promedio
                // final con sumaViewers/muestras cuando la sesión cierra.
                if (coleccion === "streamers" && enVivo) {
                    try {
                        const transmisionesRef = db.collection(coleccion).doc(item.id).collection("transmisiones");
                        const abiertaSnap = await transmisionesRef.where("fin", "==", null).limit(1).get();
                        if (!abiertaSnap.empty) {
                            const abierta = abiertaSnap.docs[0];
                            const peakActual = abierta.data().peakViewers || 0;
                            batch.update(abierta.ref, {
                                peakViewers: Math.max(peakActual, viewerActual),
                                sumaViewers: admin.firestore.FieldValue.increment(viewerActual),
                                muestras: admin.firestore.FieldValue.increment(1)
                            });
                            cambios++;
                        }
                    } catch (err) {
                        logger.warn(`actualizarEnVivo: fallo actualizando peak/promedio de viewers de ${item.id}`, err.message);
                    }
                }

                if (item.enVivo !== enVivo || item.enVivoPlataforma !== plataforma || (item.viewerActual || 0) !== viewerActual || debeActualizarJuegos || debeActualizarSeguidores || debeActualizarPerfilAuto || debeActualizarYoutube || debeActualizarKick || debeActualizarTiktok) {
                    const updateData = { enVivo, enVivoPlataforma: plataforma, enVivoUrl: url, viewerActual };
                    // Se guarda en la transición vivo->offline (no en cada
                    // chequeo) para poder ordenar streamers.html por "quién
                    // prendió stream hace menos" sin tener que leer la
                    // subcolección transmisiones de cada uno.
                    if (coleccion === "streamers" && item.enVivo && !enVivo) {
                        updateData.ultimaVezEnVivo = admin.firestore.FieldValue.serverTimestamp();
                    }
                    if (debeActualizarJuegos) {
                        const juegosVistos = Array.isArray(item.juegosVistos) ? item.juegosVistos.map(j => ({ ...j })) : [];
                        const idx = juegosVistos.findIndex(j => j.nombre === juegoActual);
                        if (idx >= 0) {
                            juegosVistos[idx].minutos = (juegosVistos[idx].minutos || 0) + 5;
                        } else {
                            const juegoInfo = await obtenerJuegoTwitch(juegoActual, clientId, clientSecret);
                            juegosVistos.push({
                                nombre: juegoActual, minutos: 5,
                                twitchId: juegoInfo?.id || null, boxArtUrl: juegoInfo?.boxArtUrl || null
                            });
                        }
                        juegosVistos.sort((a, b) => (b.minutos || 0) - (a.minutos || 0));
                        updateData.juegosVistos = juegosVistos.slice(0, 8);
                    }
                    if (debeActualizarSeguidores) {
                        updateData.seguidoresTwitch = seguidoresTwitch;
                    }
                    if (debeActualizarPerfilAuto) {
                        updateData.avatarAuto = perfilAuto.avatar ?? null;
                        updateData.bannerAuto = perfilAuto.banner ?? null;
                        updateData.twitchBroadcasterType = perfilAuto.broadcasterType ?? "";
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
                        // Para el Sello de Audiencia Real: si hay una sesión medida
                        // abierta ahora mismo, se marca cuándo fue el último raid —
                        // así se puede excluir a quienes llegan en la oleada del
                        // "primera vez que aparece" de esa sesión (ver
                        // registrarChatterEnSesion). No es una prueba aparte, solo
                        // evita contar como "audiencia nueva" a gente que llegó
                        // porque otro streamer los mandó, no porque los buscó.
                        const encontradoRaid = await buscarStreamerPorTwitchLogin(canal);
                        if (encontradoRaid) {
                            const transmisionesRef = admin.firestore()
                                .collection(encontradoRaid.coleccion).doc(encontradoRaid.id).collection("transmisiones");
                            const abiertaSnap = await transmisionesRef.where("fin", "==", null).limit(1).get();
                            if (!abiertaSnap.empty) {
                                await abiertaSnap.docs[0].ref.update({ ultimoRaidEn: admin.firestore.FieldValue.serverTimestamp() });
                            }
                            // Para el logro "La comunidad llega" (raids recibidos) en
                            // el Portal Creadores — un conteo total, no algo que se
                            // pueda inflar desde el cliente (solo lo escribe este
                            // webhook con el Admin SDK).
                            await admin.firestore().collection(encontradoRaid.coleccion).doc(encontradoRaid.id).update({
                                raidsRecibidos: admin.firestore.FieldValue.increment(1)
                            });
                        }
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
    if (!encontrado) {
        logger.warn(`registrarInicioTransmision: no se encontró streamer/influencer con twitch="${event.broadcaster_user_login}" — revisar que el campo "twitch" del perfil coincida y que ya haya suscripción EventSub sincronizada.`);
        return;
    }
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
    if (!encontrado) {
        logger.warn(`registrarFinTransmision: no se encontró streamer/influencer con twitch="${event.broadcaster_user_login}" — revisar que el campo "twitch" del perfil coincida y que ya haya suscripción EventSub sincronizada.`);
        return;
    }
    const coleccionRef = admin.firestore().collection(encontrado.coleccion).doc(encontrado.id).collection("transmisiones");
    const abiertaSnap = await coleccionRef.where("fin", "==", null).get();
    if (abiertaSnap.empty) return;
    // Sin orderBy a propósito (mismo motivo que en otras queries de este
    // archivo): combinar where(fin==) con orderBy(inicio) exige un índice
    // compuesto que el workflow de deploy no publica. Se ordena acá, en
    // memoria — nunca son más de un puñado de documentos "abiertos".
    const docs = abiertaSnap.docs.sort((a, b) => (b.data().inicio?.toMillis() || 0) - (a.data().inicio?.toMillis() || 0));
    const masReciente = docs[0];
    const data = masReciente.data();
    const inicio = data.inicio;
    const fin = admin.firestore.Timestamp.now();
    const duracionMinutos = inicio ? Math.round((fin.toMillis() - inicio.toMillis()) / 60000) : null;
    const promedioViewers = data.muestras ? Math.round((data.sumaViewers || 0) / data.muestras) : null;
    await masReciente.ref.update({ fin, duracionMinutos, promedioViewers });
    logger.info(`registrarFinTransmision: transmision cerrada para ${event.broadcaster_user_login}`);
}

// ---------------------------------------------------------------------
// Sello de Audiencia Real — fase 1, solo Twitch.
//
// Se cuenta, por sesión medida (transmisiones/{id}), cuántos mensajes
// mandó cada persona y cuándo fue la primera y la última vez — NUNCA el
// texto de lo que escribió. Alcanza para las pruebas de retorno y de
// cruce entre canales sin guardar contenido de nadie. Corre desde que se
// activó esto (ver SELLO_AUDIENCIA_DESDE en calcularSellosAudiencia),
// no hay forma de reconstruir chat de antes.
// ---------------------------------------------------------------------

// Antigüedad de cuenta (una de las 4 pruebas, solo disponible en Twitch):
// se consulta una sola vez por persona (no en cada mensaje) y se cachea
// para siempre — la fecha de creación de una cuenta no cambia.
async function cachearCreacionCuentaTwitch(db, chatterId) {
    const ref = db.doc(`twitchUsuariosCache/${chatterId}`);
    const snap = await ref.get();
    if (snap.exists) return;
    try {
        const clientId = TWITCH_CLIENT_ID.value();
        const clientSecret = TWITCH_CLIENT_SECRET.value();
        const token = await getTwitchToken(clientId, clientSecret);
        const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(chatterId)}`, {
            headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const creadoEl = data.data?.[0]?.created_at;
        if (!creadoEl) return;
        await ref.set({ creadoEl, cacheadoEl: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        logger.warn(`cachearCreacionCuentaTwitch[${chatterId}]: fallo`, err.message);
    }
}

// Ranking público de "Fans más activos" (perfil público del streamer): a
// diferencia de chatters (privado, staff + dueño de la cuenta, vive por
// sesión), esto es un agregado de por vida por persona — solo login +
// total de mensajes, nada de horarios ni datos de sesión puntual. Se pisa
// en cada mensaje (no hace falta recorrer todas las sesiones para mostrar
// el ranking). Lo que ya era público de por sí: quién escribe en un chat
// de Twitch lo ve cualquiera ahí mismo, esto solo lo agrega en un ranking.
async function registrarFanActivo(db, encontrado, chatterId, chatterLogin) {
    const fanRef = db.collection(encontrado.coleccion).doc(encontrado.id).collection("fansActivos").doc(chatterId);
    const data = {
        totalMensajes: admin.firestore.FieldValue.increment(1),
        ultimaVez: admin.firestore.FieldValue.serverTimestamp()
    };
    if (chatterLogin) data.login = chatterLogin;
    await fanRef.set(data, { merge: true });
}

// Se llama en CADA mensaje de chat (no solo los que disparan un comando).
// Si no hay una sesión medida abierta para ese streamer (no está en vivo,
// o no es un streamer del directorio), no hace nada.
async function registrarChatterEnSesion(db, encontrado, chatterId, chatterLogin) {
    if (!encontrado || !chatterId) return;
    const transmisionesRef = db.collection(encontrado.coleccion).doc(encontrado.id).collection("transmisiones");
    const abiertaSnap = await transmisionesRef.where("fin", "==", null).limit(1).get();
    if (abiertaSnap.empty) return;
    const sesionDoc = abiertaSnap.docs[0];
    const chatterRef = sesionDoc.ref.collection("chatters").doc(chatterId);
    const chatterSnap = await chatterRef.get();
    const ahora = admin.firestore.FieldValue.serverTimestamp();

    await registrarFanActivo(db, encontrado, chatterId, chatterLogin);

    if (chatterSnap.exists) {
        await chatterRef.update({ mensajes: admin.firestore.FieldValue.increment(1), ultimaVez: ahora });
        return;
    }

    // Primera vez que esta persona escribe en ESTA sesión: si fue justo
    // después de un raid, se marca (no cuenta como "apareció" para el piso
    // de evidencia de esta sesión puntual — pero si vuelve en otra sesión,
    // ahí sí cuenta, que es lo justo).
    const ultimoRaid = sesionDoc.data().ultimoRaidEn?.toMillis?.() || 0;
    const llegoPorRaid = ultimoRaid > 0 && (Date.now() - ultimoRaid) < 5 * 60 * 1000;
    await chatterRef.set({
        login: chatterLogin || "", mensajes: 1,
        primeraVez: ahora, ultimaVez: ahora, llegoPorRaid
    });

    // Índice invertido para la prueba de "también anda en otros canales":
    // guardar en qué streamers del directorio se vio a esta persona, sin
    // tener que escanear las sesiones de todos los demás streamers cada
    // vez que se calcula un sello.
    await db.doc(`chatterCanales/${chatterId}`).set({
        canales: admin.firestore.FieldValue.arrayUnion(encontrado.id)
    }, { merge: true });

    // Va después de responderle a Twitch (el webhook ya mandó su 200 antes
    // de llegar acá), así que no hay apuro, pero si no se espera acá la
    // función puede cortarse antes de que termine de escribir el caché.
    await cachearCreacionCuentaTwitch(db, chatterId);
}

// Lógica compartida entre el schedule diario (sincronizarRaidWebhooks) y el
// botón "Sincronizar ahora" del admin (sincronizarWebhooksTwitch): recorre
// todos los canales de Twitch activos y (re)crea sus 3 suscripciones
// EventSub (raid + online/offline). Se separó del schedule para que un
// streamer que recién conecta o corrige su canal de Twitch no tenga que
// esperar hasta las 4am para que sus transmisiones empiecen a registrarse.
async function sincronizarSuscripcionesEventSub() {
    const clientId = TWITCH_CLIENT_ID.value();
    const clientSecret = TWITCH_CLIENT_SECRET.value();
    const eventSubSecret = TWITCH_EVENTSUB_SECRET.value();
    if (!clientId || !clientSecret) {
        logger.warn("sincronizarSuscripcionesEventSub: faltan credenciales de Twitch");
        return { creadas: 0, existentes: 0, fallidas: 0, canales: 0, revisados: 0, conTwitch: 0, error: "faltan-credenciales" };
    }

    const db = admin.firestore();
    const handles = new Set();
    let revisados = 0;
    for (const coleccion of ["streamers", "influencers"]) {
        const snapshot = await db.collection(coleccion).get();
        snapshot.docs.forEach(d => {
            const data = d.data();
            revisados++;
            if (data.activo !== false && data.twitch) handles.add(handleFromUrl(data.twitch).toLowerCase());
        });
    }
    // Diagnóstico para el botón "Sincronizar ahora" del admin: sin esto, un
    // resultado en cero (por faltar el campo streamers/{id}.twitch en vez de
    // por un problema real) se ve idéntico a que todo salió bien, y no hay
    // forma de distinguirlo desde el cliente sin entrar a los logs de Cloud
    // Functions (a los que el equipo no tiene acceso directo).
    if (handles.size === 0) {
        logger.info("sincronizarSuscripcionesEventSub: no hay canales de Twitch cargados");
        return { creadas: 0, existentes: 0, fallidas: 0, canales: 0, revisados, conTwitch: 0 };
    }
    const token = await getTwitchToken(clientId, clientSecret);

    // Mismo problema que en actualizarEnVivo: un solo handle inválido (ej.
    // un link que no es de Twitch) tumba con 400 la consulta agrupada
    // ENTERA a la API de Twitch, no solo esa cuenta — así que se filtran
    // antes, en vez de mandarlos igual y perder el lote completo en
    // silencio.
    const logins = Array.from(handles).filter(h => h && TWITCH_HANDLE_RE.test(h));
    const loginsInvalidos = Array.from(handles).filter(h => !logins.includes(h));
    if (loginsInvalidos.length) {
        logger.warn(`sincronizarSuscripcionesEventSub: handles de Twitch inválidos (se ignoran): ${loginsInvalidos.join(", ")}`);
    }
    if (logins.length === 0) {
        return { creadas: 0, existentes: 0, fallidas: 0, canales: 0, revisados, conTwitch: handles.size, error: "handles-invalidos" };
    }

    // Resolver login de Twitch -> user_id (channel.raid necesita el id, no el login).
    const userIds = [];
    let erroresHelix = 0;
    for (let i = 0; i < logins.length; i += 100) {
        const lote = logins.slice(i, i + 100);
        const params = lote.map(h => `login=${encodeURIComponent(h)}`).join("&");
        const res = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
            headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) {
            erroresHelix++;
            logger.error(`sincronizarSuscripcionesEventSub: /helix/users respondió ${res.status} para el lote [${lote.join(", ")}]`, await res.text());
            continue;
        }
        const data = await res.json();
        (data.data || []).forEach(u => userIds.push(u.id));
    }
    if (erroresHelix && userIds.length === 0) {
        return { creadas: 0, existentes: 0, fallidas: 0, canales: 0, revisados, conTwitch: handles.size, error: "error-twitch-api" };
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
                logger.error(`sincronizarSuscripcionesEventSub: fallo con ${sub.type} para user_id ${userId}`, err.message);
            }
        }
    }
    logger.info(`sincronizarSuscripcionesEventSub: ${creadas} creadas, ${existentes} ya existían, ${fallidas} fallidas`);
    return { creadas, existentes, fallidas, canales: userIds.length, revisados, conTwitch: handles.size };
}

exports.sincronizarRaidWebhooks = onSchedule(
    {
        schedule: "every day 04:00",
        timeZone: "America/Santiago",
        secrets: [TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_SECRET]
    },
    async () => { await sincronizarSuscripcionesEventSub(); }
);

// sincronizarWebhooksTwitch: versión "a demanda" de lo anterior, para el
// botón "Sincronizar ahora" en Métricas Streamers del admin. Sin esto, un
// streamer que conecta/corrige su canal de Twitch queda sin suscripción
// EventSub (y por lo tanto sin ninguna métrica registrada, aunque el
// detector de "en vivo" —que es otro sistema, actualizarEnVivo— sí lo vea)
// hasta el próximo 4am. Restringido a admin, mismo criterio que las demás
// acciones sensibles de este archivo.
exports.sincronizarWebhooksTwitch = onCall(
    { secrets: [TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_SECRET] },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
        const callerSnap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
        const callerProfile = callerSnap.exists ? callerSnap.data() : null;
        if (!callerProfile || !profileRoles(callerProfile).includes("admin")) {
            throw new HttpsError("permission-denied", "Solo un admin puede sincronizar los webhooks de Twitch.");
        }
        return await sincronizarSuscripcionesEventSub();
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

// Llamada pública (sin auth: la ve cualquier visitante de la tarjeta del
// streamer) que arma la sección "Contenido" con lo último de cada plataforma
// que el streamer tenga conectada. Se resuelve al momento en vez de guardarse
// en el doc del streamer porque no necesita estar al día cada 5 minutos como
// los contadores de seguidores, y así se evita otra ronda de escrituras en
// actualizarEnVivo. TikTok se pide solo para quienes ya reconectaron con el
// scope video.list (tiktokAuth/{openId}.contenidoActivo) — cuentas
// conectadas antes de agregar ese scope no lo tienen y se saltean, en vez
// de gastar una llamada a la API que sabemos que va a fallar por permisos.
exports.obtenerContenidoCreador = onCall(
    {
        secrets: [
            TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET,
            TIKTOK_CLIENT_ID, TIKTOK_CLIENT_SECRET
        ]
    },
    async (request) => {
        const streamerId = String(request.data?.streamerId || "");
        // Reusado por influencers (solo tienen TikTok/Instagram, sin canal de
        // Twitch/YouTube/Kick) — mismo doc.uid -> users/{uid} para resolver
        // qué cuentas conectó, ver comentario en la colección coleccion abajo.
        const coleccion = request.data?.coleccion === "influencers" ? "influencers" : "streamers";
        if (!streamerId) throw new HttpsError("invalid-argument", "Falta streamerId.");

        const db = admin.firestore();
        const streamerSnap = await db.doc(`${coleccion}/${streamerId}`).get();
        if (!streamerSnap.exists) throw new HttpsError("not-found", "No encontrado.");
        const streamer = streamerSnap.data();

        let youtubeChannelId = null;
        let kickSlug = null;
        let tiktokOpenId = null;
        if (streamer.uid) {
            const userSnap = await db.doc(`users/${streamer.uid}`).get();
            const userData = userSnap.exists ? userSnap.data() : null;
            youtubeChannelId = userData?.youtubeChannelId || null;
            kickSlug = userData?.kickSlug || null;
            tiktokOpenId = userData?.tiktokOpenId || null;
        }
        if (tiktokOpenId) {
            const tiktokAuthSnap = await db.doc(`tiktokAuth/${tiktokOpenId}`).get();
            if (!tiktokAuthSnap.exists || !tiktokAuthSnap.data().contenidoActivo) tiktokOpenId = null;
        }

        const twitchHandle = streamer.twitch ? handleFromUrl(streamer.twitch).toLowerCase() : "";
        let broadcasterId = null;
        if (twitchHandle) {
            const authSnap = await db.doc(`twitchBotAuth/${twitchHandle}`).get();
            broadcasterId = authSnap.exists ? (authSnap.data().broadcasterId || null) : null;
        }

        const [twitch, youtube, kick, tiktok] = await Promise.all([
            broadcasterId ? obtenerVideosTwitch(broadcasterId, TWITCH_CLIENT_ID.value(), TWITCH_CLIENT_SECRET.value()) : [],
            youtubeChannelId ? obtenerVideosYoutube(youtubeChannelId, YOUTUBE_CLIENT_ID.value(), YOUTUBE_CLIENT_SECRET.value()) : [],
            kickSlug ? obtenerVideosKick(kickSlug) : [],
            tiktokOpenId ? obtenerVideosTiktok(tiktokOpenId, TIKTOK_CLIENT_ID.value(), TIKTOK_CLIENT_SECRET.value()) : []
        ]);

        return { twitch, youtube, kick, tiktok };
    }
);

// Búsqueda de categorías de Twitch para que el creador elija "a qué juega"
// desde una lista real (con su box art) en vez de escribir texto libre.
// Requiere sesión (no hace falta que sea del propio streamer: es solo un
// proxy de búsqueda pública de Twitch, protegido con auth para no dejarlo
// abierto a cualquiera que quiera pegarle a la API desde afuera).
exports.buscarCategoriasTwitch = onCall(
    { secrets: [TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET] },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión para buscar categorías.");
        const query = String(request.data?.query || "").trim();
        if (!query) return { categorias: [] };

        const clientId = TWITCH_CLIENT_ID.value();
        const clientSecret = TWITCH_CLIENT_SECRET.value();
        const token = await getTwitchToken(clientId, clientSecret);
        const res = await fetch(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(query)}&first=10`, {
            headers: { "Client-Id": clientId, "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) throw new HttpsError("unavailable", "Twitch no respondió la búsqueda. Probá de nuevo.");
        const data = await res.json();
        const categorias = (data.data || []).map(c => ({
            id: c.id, nombre: c.name,
            boxArtUrl: String(c.box_art_url || "").replace("{width}", "188").replace("{height}", "250")
        }));
        return { categorias };
    }
);

// Visitas al perfil público: un conteo por día, sin nada identificable del
// visitante (nunca IP, nunca user-agent, nada). El cliente decide una sola
// vez por navegador por día si corresponde llamar esto (localStorage, ver
// streamer.html), así que el número es "navegadores distintos que pasaron
// hoy" — no un contador de clicks ni de recargas de página.
exports.registrarVisitaPerfil = onCall(async (request) => {
    const streamerId = String(request.data?.streamerId || "");
    if (!streamerId) throw new HttpsError("invalid-argument", "Falta streamerId.");

    const db = admin.firestore();
    const streamerSnap = await db.doc(`streamers/${streamerId}`).get();
    if (!streamerSnap.exists) throw new HttpsError("not-found", "Streamer no encontrado.");

    const hoy = new Date().toISOString().slice(0, 10);
    await db.doc(`streamers/${streamerId}/visitas/${hoy}`).set({
        total: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    return { ok: true };
});

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
        // la tarjeta pública, moderator:manage:chat_messages/channel:manage:moderators
        // habilitan la moderación automática (borrar mensajes) — se agregaron
        // después de channel:bot/user:bot, así que toda cuenta que ya se
        // había conectado antes tiene que reconectar una vez (el token viejo
        // no tiene estos permisos, Twitch no los amplía solo).
        const scope = tipo === "bot"
            ? "user:bot user:read:chat user:write:chat moderator:manage:chat_messages"
            : "channel:bot moderator:read:followers channel:manage:moderators";
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

                // Para que la moderación automática (borrar mensajes) funcione,
                // el bot tiene que ser moderador del canal — Twitch exige que
                // moderator_id sea el propio streamer o alguien con status de
                // moderador ahí. Se agrega solo, con el token recién obtenido
                // (channel:manage:moderators); si falla (ej. token viejo sin
                // este scope todavía, streamer ya lo agregó a mano, etc.) no
                // rompe la conexión — queda como fallback /mod voranixstudio.
                let botAgregadoComoMod = false;
                try {
                    const botSnap = await admin.firestore().doc("twitchBotAuth/_bot").get();
                    const bot = botSnap.exists ? botSnap.data() : null;
                    if (bot?.userId) {
                        const modRes = await fetch(`https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${usuario.id}&user_id=${bot.userId}`, {
                            method: "POST",
                            headers: { "Client-Id": clientId, "Authorization": `Bearer ${tokenData.access_token}` }
                        });
                        botAgregadoComoMod = modRes.status === 204 || modRes.status === 400; // 400 = ya lo era
                        if (!botAgregadoComoMod) {
                            logger.warn(`twitchBotAuthCallback: no se pudo agregar al bot como moderador de ${loginVerificado}`, modRes.status, await modRes.text());
                        }
                    }
                } catch (err) {
                    logger.warn(`twitchBotAuthCallback: fallo agregando al bot como moderador de ${loginVerificado}`, err.message);
                }

                res.send(`<h2>¡Listo!</h2><p>Conectaste el canal <b>${usuario.login}</b> al bot de VORANIX. Los comandos van a funcionar en tu chat a partir de mañana (la sincronización corre una vez por día) y tus seguidores van a empezar a aparecer en tu tarjeta pública en un rato.</p>${botAgregadoComoMod ? "<p>El bot ya quedó como moderador de tu canal, así que la moderación automática (si la activás en tu Portal) va a poder borrar mensajes.</p>" : `<p>Si activás la moderación automática en tu Portal y no borra mensajes, escribí <b>/mod ${TWITCH_BOT_LOGIN_OFICIAL}</b> en tu propio chat una vez.</p>`}<p>Podés cerrar esta pestaña y volver al Portal Creadores.</p>`);
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
            scope: "user.info.basic,user.info.stats,video.list",
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
                authorizedAt: admin.firestore.FieldValue.serverTimestamp(),
                contenidoActivo: true
            });
            await admin.firestore().doc(`tiktokAuth/${openId}/privado/tokens`).set({
                accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`users/${uid}`).set({
                tiktokOpenId: openId
            }, { merge: true });

            res.send(`<h2>¡Listo!</h2><p>Conectaste tu cuenta <b>${escapeHtml(displayName) || "de TikTok"}</b>. Tus seguidores y tus últimos videos van a empezar a aparecer en tu tarjeta pública en un rato. Podés cerrar esta pestaña y volver a la pestaña anterior.</p>`);
        } catch (err) {
            logger.error("tiktokAuthCallback: fallo", err);
            res.status(500).send("Hubo un error autorizando. Intentá de nuevo o avisale al equipo de VORANIX.");
        }
    }
);

// Desconectar YouTube/Kick/TikTok: le saca al propio uid el campo de cuenta
// vinculada y borra el doc de autorización + sus tokens guardados (no revoca
// el token en la plataforma en sí, pero deja de leerlo y de guardar una
// copia acá). Twitch entra en el mismo mapa genérico — el radio de impacto
// (bot de chat, overlay, comandos, EventSub) es mayor que en las demás, así
// que el cliente muestra una advertencia más específica antes de confirmar
// (ver desconectarCuenta del lado del cliente en creadores.html), pero el
// borrado en sí es idéntico: se limpia el link verificado y se borra el doc
// de autorización + sus tokens. No cancela la suscripción a EventSub en
// Twitch ni borra el historial de transmisiones — si el creador reconecta
// más adelante, retoma desde ahí.
const CUENTAS_DESCONECTABLES = {
    youtube: { campo: "youtubeChannelId", coleccion: "youtubeAuth" },
    kick: { campo: "kickSlug", coleccion: "kickAuth" },
    tiktok: { campo: "tiktokOpenId", coleccion: "tiktokAuth" },
    discord: { campo: "discordUserId", coleccion: "discordAuth" },
    twitch: { campo: "twitchLogin", coleccion: "twitchBotAuth" }
};

exports.desconectarCuenta = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores para desconectar una cuenta.");
    }
    const plataforma = String(request.data?.plataforma || "");
    const config = CUENTAS_DESCONECTABLES[plataforma];
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

    // Desconectar Discord también borra la elección de servidor/rol del
    // streamer: sin la cuenta OAuth conectada no hay forma de re-validarla
    // contra Discord la próxima vez, así que no tiene sentido dejarla viva.
    if (plataforma === "discord") {
        const streamerSnap = await db.collection("streamers").where("uid", "==", uid).limit(1).get();
        if (!streamerSnap.empty) {
            await streamerSnap.docs[0].ref.update({
                discordGuildId: admin.firestore.FieldValue.delete(),
                discordGuildNombre: admin.firestore.FieldValue.delete(),
                discordRoleId: admin.firestore.FieldValue.delete(),
                discordRoleNombre: admin.firestore.FieldValue.delete()
            }).catch(() => {});
        }
    }

    return { ok: true };
});

// ---------------------------------------------------------------------
// Conexión de cuenta de Discord: mismo patrón OAuth que YouTube/Kick/TikTok
// para que el creador vincule SU cuenta (scope identify+guilds). A
// diferencia de esas, acá no alcanza con "leer datos públicos" — hacen
// falta dos funciones más:
//
// 1) obtenerServidoresDiscord: cruza los servidores donde el creador es
//    dueño/admin (con SU token OAuth) contra los servidores donde el bot
//    de VORANIX ya está agregado (con el token del bot) — solo puede
//    elegir un servidor donde se cumplen ambas cosas, y de ahí lista los
//    roles asignables (sin @everyone ni roles administrados por otra
//    integración) usando el token del bot.
// 2) guardarDiscordConfig: guarda la elección (guildId + rol opcional) en
//    el doc del streamer, re-validando todo contra la API de Discord del
//    lado del servidor — nunca confía en lo que mande el cliente sin
//    chequearlo.
//
// El "unirse al Discord" del visitante (discordJoinStart/Callback, más
// abajo) es la pieza que realmente agrega a alguien al servidor con el rol
// puesto: un solo llamado on-demand a la API (PUT .../members/{id} con el
// access_token de guilds.join), no hace falta mantener el bot conectado
// por Gateway escuchando quién entra — encaja con el resto de la
// arquitectura serverless/on-demand del proyecto.
// ---------------------------------------------------------------------

const DISCORD_CLIENT_ID = defineSecret("DISCORD_CLIENT_ID");
const DISCORD_CLIENT_SECRET = defineSecret("DISCORD_CLIENT_SECRET");
const DISCORD_BOT_TOKEN = defineSecret("DISCORD_BOT_TOKEN");
const DISCORD_REDIRECT_URI = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/discordAuthCallback";
const DISCORD_JOIN_REDIRECT_URI = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/discordJoinCallback";
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_ADMINISTRATOR = 0x8n;

function discordBotInviteUrl(clientId) {
    // permissions=268435456 = MANAGE_ROLES, lo mínimo para poder asignar un
    // rol al agregar gente. El creador tiene que invitar al bot UNA vez a
    // su propio servidor antes de que aparezca en la lista de "en común".
    return `${DISCORD_API}/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=268435456`;
}

exports.generarEstadoDiscordCanal = onCall(
    { secrets: [TWITCH_CLIENT_SECRET] },
    (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores para conectar tu cuenta de Discord.");
        }
        const firma = firmarEstadoCanal(request.auth.uid, TWITCH_CLIENT_SECRET.value());
        return { state: `discord:${request.auth.uid}:${firma}` };
    }
);

exports.discordAuthStart = onRequest(
    { secrets: [DISCORD_CLIENT_ID] },
    (req, res) => {
        const state = String(req.query.state || "").trim();
        if (!state.startsWith("discord:")) {
            res.status(400).send("Este link para conectar tu cuenta es inválido o venció. Volvé al Portal Creadores y generalo de nuevo.");
            return;
        }
        const params = new URLSearchParams({
            client_id: DISCORD_CLIENT_ID.value(),
            redirect_uri: DISCORD_REDIRECT_URI,
            response_type: "code",
            scope: "identify guilds",
            state,
            prompt: "consent"
        });
        res.redirect(`${DISCORD_API}/oauth2/authorize?${params}`);
    }
);

exports.discordAuthCallback = onRequest(
    { secrets: [DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const { code, state, error, error_description: errorDescription } = req.query;
        if (error) {
            res.status(400).send(`No se pudo autorizar: ${errorDescription || error}`);
            return;
        }
        try {
            const clientId = DISCORD_CLIENT_ID.value();
            const clientSecret = DISCORD_CLIENT_SECRET.value();

            const partes = String(state || "").split(":");
            if (partes.length !== 3 || partes[0] !== "discord" || firmarEstadoCanal(partes[1], TWITCH_CLIENT_SECRET.value()) !== partes[2]) {
                res.status(400).send("El link para conectar tu cuenta venció o no es válido. Volvé al Portal Creadores y generalo de nuevo.");
                return;
            }
            const uid = partes[1];

            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret, code,
                    grant_type: "authorization_code", redirect_uri: DISCORD_REDIRECT_URI
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error(JSON.stringify(tokenData));

            const userRes = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` }
            });
            const userData = await userRes.json();
            if (!userData.id) throw new Error("No se pudo identificar la cuenta de Discord.");

            const duplicados = await admin.firestore().collection("users")
                .where("discordUserId", "==", userData.id).get();
            const deOtraCuenta = duplicados.docs.find(docSnap => docSnap.id !== uid);
            if (deOtraCuenta) {
                res.status(409).send("Esta cuenta de Discord ya está conectada a otra cuenta de VORANIX. Si esto es un error, avisale al equipo.");
                return;
            }

            const username = userData.global_name || userData.username || userData.id;
            await admin.firestore().doc(`discordAuth/${userData.id}`).set({
                discordUserId: userData.id, username,
                authorizedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`discordAuth/${userData.id}/privado/tokens`).set({
                accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await admin.firestore().doc(`users/${uid}`).set({
                discordUserId: userData.id
            }, { merge: true });

            res.send(`<h2>¡Listo!</h2><p>Conectaste tu cuenta <b>${escapeHtml(username)}</b> de Discord. Volvé al Portal Creadores para elegir a qué servidor invitar a tu comunidad.</p>`);
        } catch (err) {
            logger.error("discordAuthCallback: fallo", err);
            res.status(500).send("Hubo un error autorizando. Intentá de nuevo o avisale al equipo de VORANIX.");
        }
    }
);

async function refrescarTokenDiscord(discordUserId, clientId, clientSecret) {
    const tokensSnap = await admin.firestore().doc(`discordAuth/${discordUserId}/privado/tokens`).get();
    if (!tokensSnap.exists) throw new Error("No hay una cuenta de Discord conectada.");
    const tokens = tokensSnap.data();
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            grant_type: "refresh_token", refresh_token: tokens.refreshToken
        })
    });
    const data = await res.json();
    if (!data.access_token) throw new Error("No se pudo refrescar el token de Discord.");
    await admin.firestore().doc(`discordAuth/${discordUserId}/privado/tokens`).set({
        accessToken: data.access_token, refreshToken: data.refresh_token || tokens.refreshToken,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return data.access_token;
}

exports.obtenerServidoresDiscord = onCall(
    { secrets: [DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN] },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores.");
        const db = admin.firestore();
        const userSnap = await db.doc(`users/${request.auth.uid}`).get();
        const discordUserId = userSnap.exists ? userSnap.data().discordUserId : null;
        if (!discordUserId) throw new HttpsError("failed-precondition", "Conectá tu cuenta de Discord primero.");

        const clientId = DISCORD_CLIENT_ID.value();
        const clientSecret = DISCORD_CLIENT_SECRET.value();
        const botToken = DISCORD_BOT_TOKEN.value();

        const tokensSnap = await db.doc(`discordAuth/${discordUserId}/privado/tokens`).get();
        if (!tokensSnap.exists) throw new HttpsError("failed-precondition", "Conectá tu cuenta de Discord primero.");
        let accessToken = tokensSnap.data().accessToken;

        async function pedirMisServidores(token) {
            return fetch(`${DISCORD_API}/users/@me/guilds`, { headers: { "Authorization": `Bearer ${token}` } });
        }
        let misGuildsRes = await pedirMisServidores(accessToken);
        if (misGuildsRes.status === 401) {
            accessToken = await refrescarTokenDiscord(discordUserId, clientId, clientSecret);
            misGuildsRes = await pedirMisServidores(accessToken);
        }
        if (!misGuildsRes.ok) throw new HttpsError("unavailable", "Discord no respondió tu lista de servidores. Probá de nuevo.");
        const misGuilds = await misGuildsRes.json();

        const misAdmin = misGuilds.filter(g => g.owner || (BigInt(g.permissions || 0) & DISCORD_ADMINISTRATOR) === DISCORD_ADMINISTRATOR);
        if (!misAdmin.length) return { guilds: [], botInviteUrl: discordBotInviteUrl(clientId) };

        const botGuildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, { headers: { "Authorization": `Bot ${botToken}` } });
        if (!botGuildsRes.ok) throw new HttpsError("unavailable", "No se pudo consultar los servidores del bot de VORANIX.");
        const botGuilds = await botGuildsRes.json();
        const botGuildIds = new Set(botGuilds.map(g => g.id));

        const enComun = misAdmin.filter(g => botGuildIds.has(g.id));

        const guilds = [];
        for (const g of enComun) {
            const rolesRes = await fetch(`${DISCORD_API}/guilds/${g.id}/roles`, { headers: { "Authorization": `Bot ${botToken}` } });
            const roles = rolesRes.ok ? await rolesRes.json() : [];
            guilds.push({
                id: g.id, nombre: g.name,
                icono: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
                roles: roles
                    .filter(r => r.id !== g.id && !r.managed)
                    .sort((a, b) => b.position - a.position)
                    .map(r => ({ id: r.id, nombre: r.name }))
            });
        }

        return { guilds, botInviteUrl: discordBotInviteUrl(clientId) };
    }
);

exports.guardarDiscordConfig = onCall(
    { secrets: [DISCORD_BOT_TOKEN] },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Iniciá sesión en el Portal Creadores.");
        const guildId = String(request.data?.guildId || "").trim();
        const roleId = String(request.data?.roleId || "").trim();
        if (!guildId) throw new HttpsError("invalid-argument", "Falta elegir un servidor.");

        const botToken = DISCORD_BOT_TOKEN.value();
        const guildRes = await fetch(`${DISCORD_API}/guilds/${guildId}`, { headers: { "Authorization": `Bot ${botToken}` } });
        if (!guildRes.ok) throw new HttpsError("failed-precondition", "El bot de VORANIX no está en ese servidor.");
        const guild = await guildRes.json();

        let roleNombre = null;
        if (roleId) {
            const rolesRes = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers: { "Authorization": `Bot ${botToken}` } });
            const roles = rolesRes.ok ? await rolesRes.json() : [];
            const rol = roles.find(r => r.id === roleId);
            if (!rol) throw new HttpsError("invalid-argument", "Ese rol ya no existe en el servidor.");
            roleNombre = rol.name;
        }

        const db = admin.firestore();
        const streamerSnap = await db.collection("streamers").where("uid", "==", request.auth.uid).limit(1).get();
        if (streamerSnap.empty) throw new HttpsError("failed-precondition", "Todavía no tenés una tarjeta de streamer vinculada.");

        await streamerSnap.docs[0].ref.update({
            discordGuildId: guildId, discordGuildNombre: guild.name || "",
            discordRoleId: roleId || admin.firestore.FieldValue.delete(),
            discordRoleNombre: roleNombre || admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return { ok: true, guildNombre: guild.name, roleNombre };
    }
);

// "Unirse al Discord" desde el perfil público: el visitante autoriza con
// el scope guilds.join y en el callback lo agregamos directo al servidor
// (con el rol configurado, si el creador eligió uno) con el mismo llamado
// PUT descrito arriba.
exports.discordJoinStart = onRequest(
    { secrets: [DISCORD_CLIENT_ID, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const streamerId = String(req.query.streamerId || "").trim();
        if (!streamerId) { res.status(400).send("Falta el streamer."); return; }
        const streamerSnap = await admin.firestore().doc(`streamers/${streamerId}`).get();
        if (!streamerSnap.exists || !streamerSnap.data().discordGuildId) {
            res.status(400).send("Este streamer todavía no configuró su Discord.");
            return;
        }
        const firma = firmarEstadoCanal(streamerId, TWITCH_CLIENT_SECRET.value());
        const params = new URLSearchParams({
            client_id: DISCORD_CLIENT_ID.value(),
            redirect_uri: DISCORD_JOIN_REDIRECT_URI,
            response_type: "code",
            scope: "identify guilds.join",
            state: `join:${streamerId}:${firma}`
        });
        res.redirect(`${DISCORD_API}/oauth2/authorize?${params}`);
    }
);

exports.discordJoinCallback = onRequest(
    { secrets: [DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, TWITCH_CLIENT_SECRET] },
    async (req, res) => {
        const { code, state, error, error_description: errorDescription } = req.query;
        if (error) { res.status(400).send(`No se pudo autorizar: ${errorDescription || error}`); return; }
        try {
            const partes = String(state || "").split(":");
            if (partes.length !== 3 || partes[0] !== "join" || firmarEstadoCanal(partes[1], TWITCH_CLIENT_SECRET.value()) !== partes[2]) {
                res.status(400).send("Este link venció o no es válido. Volvé al perfil del streamer e intentá de nuevo.");
                return;
            }
            const streamerId = partes[1];
            const streamerSnap = await admin.firestore().doc(`streamers/${streamerId}`).get();
            const streamer = streamerSnap.exists ? streamerSnap.data() : null;
            if (!streamer?.discordGuildId) throw new Error("El streamer ya no tiene un servidor de Discord configurado.");

            const clientId = DISCORD_CLIENT_ID.value();
            const clientSecret = DISCORD_CLIENT_SECRET.value();
            const botToken = DISCORD_BOT_TOKEN.value();

            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret, code,
                    grant_type: "authorization_code", redirect_uri: DISCORD_JOIN_REDIRECT_URI
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error(JSON.stringify(tokenData));

            const userRes = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { "Authorization": `Bearer ${tokenData.access_token}` }
            });
            const userData = await userRes.json();
            if (!userData.id) throw new Error("No se pudo identificar tu cuenta de Discord.");

            const addRes = await fetch(`${DISCORD_API}/guilds/${streamer.discordGuildId}/members/${userData.id}`, {
                method: "PUT",
                headers: { "Authorization": `Bot ${botToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    access_token: tokenData.access_token,
                    ...(streamer.discordRoleId ? { roles: [streamer.discordRoleId] } : {})
                })
            });

            if (![200, 201, 204].includes(addRes.status)) {
                const detalle = await addRes.text().catch(() => "");
                logger.error(`discordJoinCallback: Discord respondió ${addRes.status} agregando a ${userData.id} al server ${streamer.discordGuildId}`, detalle);
                throw new Error("Discord no permitió agregarte al servidor. Puede que el bot haya perdido permisos.");
            }

            res.send(`<h2>¡Listo!</h2><p>Te uniste al Discord de <b>${escapeHtml(streamer.nombre || "este streamer")}</b>${streamer.discordRoleNombre ? ` con el rol <b>${escapeHtml(streamer.discordRoleNombre)}</b>` : ""}. Podés cerrar esta pestaña.</p>`);
        } catch (err) {
            logger.error("discordJoinCallback: fallo", err);
            res.status(500).send("Hubo un error uniéndote al Discord. Intentá de nuevo o avisale al streamer.");
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

// Moderación automática (streamers/influencers/{id}.moderacion, editable por
// el propio dueño desde su Portal): dos reglas simples, opt-in por canal —
// mensajes en mayúsculas y palabras prohibidas. Devuelve true si borró el
// mensaje (para que el caller no siga procesando comandos sobre algo que ya
// no existe en el chat).
function textoDisparaModeracion(config, textoOriginal) {
    if (config.mayusculasActivo) {
        const letras = textoOriginal.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ]/g, "");
        const mayus = textoOriginal.replace(/[^A-ZÁÉÍÓÚÑ]/g, "");
        const largoMinimo = Number(config.mayusculasLargoMinimo) || 10;
        const umbralPct = Number(config.mayusculasUmbralPct) || 70;
        if (letras.length >= largoMinimo && (mayus.length / letras.length) * 100 >= umbralPct) {
            return "mensaje en mayúsculas";
        }
    }
    if (config.palabrasActivo && Array.isArray(config.palabras) && config.palabras.length) {
        const textoLower = textoOriginal.toLowerCase();
        const palabraEncontrada = config.palabras.find(p => p && textoLower.includes(String(p).toLowerCase()));
        if (palabraEncontrada) return `palabra prohibida ("${palabraEncontrada}")`;
    }
    return null;
}

async function evaluarModeracion(db, encontrado, event) {
    if (!encontrado || !event?.message_id) return false;
    const streamerSnap = await db.collection(encontrado.coleccion).doc(encontrado.id).get();
    const config = streamerSnap.exists ? streamerSnap.data().moderacion : null;
    if (!config) return false;

    const textoOriginal = String(event?.message?.text || "");
    const motivo = textoDisparaModeracion(config, textoOriginal);
    if (!motivo) return false;

    // Borrar exige moderator_id con status de moderador en ESE canal (ver
    // twitchBotAuthCallback, que intenta agregar al bot como moderador solo
    // al conectar) y el token del bot con scope moderator:manage:chat_messages.
    const botSnap = await db.doc("twitchBotAuth/_bot").get();
    const bot = botSnap.exists ? botSnap.data() : null;
    if (!bot) {
        logger.warn("evaluarModeracion: el bot todavía no está autorizado, no se puede borrar");
        return false;
    }

    const clientId = TWITCH_CLIENT_ID.value();
    const params = new URLSearchParams({
        broadcaster_id: event.broadcaster_user_id,
        moderator_id: bot.userId,
        message_id: event.message_id
    });
    let respuestaHttp = await fetch(`https://api.twitch.tv/helix/moderation/chat?${params}`, {
        method: "DELETE",
        headers: { "Client-Id": clientId, "Authorization": `Bearer ${bot.accessToken}` }
    });
    if (respuestaHttp.status === 401) {
        const nuevoToken = await refrescarTokenBot(clientId, TWITCH_CLIENT_SECRET.value());
        respuestaHttp = await fetch(`https://api.twitch.tv/helix/moderation/chat?${params}`, {
            method: "DELETE",
            headers: { "Client-Id": clientId, "Authorization": `Bearer ${nuevoToken}` }
        });
    }
    if (!respuestaHttp.ok) {
        // 403 típico cuando el bot todavía no es moderador del canal (ver
        // fallback /mod voranixstudio que se explica al conectar el canal).
        logger.error(`evaluarModeracion: no se pudo borrar el mensaje en ${event.broadcaster_user_login} (${motivo}), status ${respuestaHttp.status}`, await respuestaHttp.text());
        return false;
    }
    logger.info(`evaluarModeracion: mensaje borrado en ${event.broadcaster_user_login} (${motivo})`);
    return true;
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
            const encontrado = canal ? await buscarStreamerPorTwitchLogin(canal) : null;

            // Sello de Audiencia Real: corre en TODOS los mensajes, no solo
            // los que disparan un comando — aparte del resto de esta función,
            // si falla acá nunca debe frenar ni afectar la respuesta del bot.
            try {
                const chatterId = String(event?.chatter_user_id || "");
                const chatterLogin = String(event?.chatter_user_login || "");
                if (chatterId && canal) {
                    await registrarChatterEnSesion(db, encontrado, chatterId, chatterLogin);
                }
            } catch (err) {
                logger.warn("twitchChatWebhook: fallo registrando chatter para el sello de audiencia", err.message);
            }

            // Moderación automática (opt-in por canal, ver Portal Creadores):
            // corre en TODOS los mensajes, antes de buscar comando — si el
            // mensaje se borra no tiene sentido además contestarle un comando.
            try {
                if (await evaluarModeracion(db, encontrado, event)) return;
            } catch (err) {
                logger.warn("twitchChatWebhook: fallo evaluando moderación automática", err.message);
            }

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

// Desde cuándo hay historial de chat medido (ver el comentario grande más
// arriba, junto a registrarChatterEnSesion) — ninguna sesión de antes de
// esta fecha tiene su subcolección "chatters" poblada, así que no deben
// contar para el piso de evidencia ni para ninguna de las pruebas.
const SELLO_AUDIENCIA_DESDE = Date.parse("2026-08-25T00:00:00Z");
const SELLO_PISO_TRANSMISIONES = 5;
const SELLO_PISO_HORAS = 10;
const SELLO_PISO_PERSONAS = 20;
const SELLO_UMBRAL_RETORNO = 0.15;
const SELLO_UMBRAL_CUENTAS_NUEVAS = 0.10;
const SELLO_UMBRAL_OTROS_CANALES = 0.05;
const SELLO_MINIMO_CUENTAS_CON_FECHA = 25;
const SELLO_DURACION_MS = 90 * 24 * 60 * 60 * 1000;

async function evaluarSelloStreamer(db, coleccion, streamer) {
    const transmisionesRef = db.collection(coleccion).doc(streamer.id).collection("transmisiones");
    // Sin where(inicio>=) a propósito (mismo motivo que el resto de este
    // archivo): combinarlo con fin!=null pediría un índice compuesto. Se
    // filtra en memoria, nunca son muchas transmisiones por streamer.
    const cerradasSnap = await transmisionesRef.where("fin", "!=", null).get();
    const sesiones = cerradasSnap.docs.filter(d => (d.data().inicio?.toMillis?.() || 0) >= SELLO_AUDIENCIA_DESDE);

    let horasTotales = 0;
    const aparicionesPorChatter = new Map(); // chatterId -> cantidad de sesiones en las que apareció (sin contar llegadas por raid)
    let sesionesConDatos = 0;

    for (const sesionDoc of sesiones) {
        const chattersSnap = await sesionDoc.ref.collection("chatters").get();
        if (chattersSnap.empty) continue; // sesión sin chat medido (previa a esta función, o sin nadie escribiendo)
        sesionesConDatos++;
        horasTotales += (sesionDoc.data().duracionMinutos || 0) / 60;
        chattersSnap.docs.forEach(cDoc => {
            if (cDoc.data().llegoPorRaid) return;
            aparicionesPorChatter.set(cDoc.id, (aparicionesPorChatter.get(cDoc.id) || 0) + 1);
        });
    }

    const personasDistintas = aparicionesPorChatter.size;
    if (sesionesConDatos < SELLO_PISO_TRANSMISIONES || horasTotales < SELLO_PISO_HORAS || personasDistintas < SELLO_PISO_PERSONAS) {
        return; // no llega al piso de evidencia — ni se calculan las pruebas
    }

    // Prueba 1: gente que vuelve (≥15%, apareció en 3+ sesiones distintas).
    const conRetorno = [...aparicionesPorChatter.values()].filter(n => n >= 3).length;
    const pctRetorno = conRetorno / personasDistintas;
    if (pctRetorno < SELLO_UMBRAL_RETORNO) return;

    // Prueba 2: cuentas recién creadas (≤10%, solo Twitch, y solo si hay al
    // menos 25 cuentas con fecha conocida en el caché — si no, esta prueba
    // simplemente no se rinde, no cuenta en contra).
    let pctCuentasNuevas = null;
    const idsConFecha = [];
    for (const chatterId of aparicionesPorChatter.keys()) {
        const cacheSnap = await db.doc(`twitchUsuariosCache/${chatterId}`).get();
        if (cacheSnap.exists && cacheSnap.data().creadoEl) idsConFecha.push(cacheSnap.data().creadoEl);
    }
    if (idsConFecha.length >= SELLO_MINIMO_CUENTAS_CON_FECHA) {
        const hace30dias = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const nuevas = idsConFecha.filter(fecha => Date.parse(fecha) > hace30dias).length;
        pctCuentasNuevas = nuevas / idsConFecha.length;
        if (pctCuentasNuevas > SELLO_UMBRAL_CUENTAS_NUEVAS) return;
    }

    // Prueba 3: también andan en otros canales del directorio (≥5%) — sale
    // del índice invertido chatterCanales/{id}, no hace falta escanear las
    // sesiones de todos los demás streamers acá.
    let enOtroCanal = 0;
    for (const chatterId of aparicionesPorChatter.keys()) {
        const canalesSnap = await db.doc(`chatterCanales/${chatterId}`).get();
        const canales = canalesSnap.exists ? (canalesSnap.data().canales || []) : [];
        if (canales.some(id => id !== streamer.id)) enOtroCanal++;
    }
    const pctOtrosCanales = enOtroCanal / personasDistintas;
    if (pctOtrosCanales < SELLO_UMBRAL_OTROS_CANALES) return;

    // Pasó las cuatro pruebas (o las que le aplican): se congela el sello.
    // No se recalcula nunca — si mañana cambian los cortes, el sello de hoy
    // sigue diciendo con qué regla se dio (reglas: "v1").
    const ahora = Date.now();
    await db.doc(`sellos/${streamer.id}`).set({
        coleccion,
        otorgadoEl: admin.firestore.Timestamp.fromMillis(ahora),
        expiraEl: admin.firestore.Timestamp.fromMillis(ahora + SELLO_DURACION_MS),
        reglas: "v1",
        numeros: {
            retorno: Math.round(pctRetorno * 1000) / 1000,
            cuentasNuevas: pctCuentasNuevas === null ? null : Math.round(pctCuentasNuevas * 1000) / 1000,
            otrosCanales: Math.round(pctOtrosCanales * 1000) / 1000,
            evidencia: {
                transmisiones: sesionesConDatos,
                horas: Math.round(horasTotales * 10) / 10,
                personas: personasDistintas
            }
        }
    });
    logger.info(`evaluarSelloStreamer: sello otorgado a ${coleccion}/${streamer.id}`);
}

// Corre una vez por día: recalcula para cada streamer con Twitch conectado
// si corresponde otorgar (o renovar) el Sello de Audiencia Real. No hay
// intervención de staff acá a propósito — nadie de VORANIX decide quién lo
// tiene, sale solo de la fórmula.
exports.calcularSellosAudiencia = onSchedule(
    { schedule: "every day 06:00", timeZone: "America/Santiago" },
    async () => {
        const db = admin.firestore();
        for (const coleccion of ["streamers", "influencers"]) {
            const snapshot = await db.collection(coleccion).get();
            const streamers = snapshot.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(s => s.activo !== false && s.twitch);
            for (const streamer of streamers) {
                try {
                    await evaluarSelloStreamer(db, coleccion, streamer);
                } catch (err) {
                    logger.error(`calcularSellosAudiencia: fallo con ${coleccion}/${streamer.id}`, err);
                }
            }
        }
    }
);

// ---------------------------------------------------------------------
// crearUsuarioStaff: crea la cuenta de Firebase Auth + su perfil en
// users/{uid} en un solo paso, sin que quien lo hace necesite entrar a la
// consola de Firebase (Authentication) a mano — hasta ahora había que
// crear el login ahí, copiar el UID y recién después cargar el perfil acá.
// Restringido a admin (mismo criterio que enviarAccesoCreador: crear/tocar
// cuentas de Auth es una acción sensible, no algo que un editor deba poder
// hacer). Se crea sin contraseña — la persona la configura sola con el
// link que manda enviarAccesoCreador después, nunca queda una contraseña
// provisoria dando vueltas.
// ---------------------------------------------------------------------

exports.crearUsuarioStaff = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const callerSnap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
    const callerProfile = callerSnap.exists ? callerSnap.data() : null;
    if (!callerProfile || !profileRoles(callerProfile).includes("admin")) {
        throw new HttpsError("permission-denied", "Solo un admin puede crear cuentas.");
    }

    const email = String(request.data?.email || "").trim().toLowerCase();
    const displayName = String(request.data?.displayName || "").trim();
    const roles = Array.isArray(request.data?.roles) ? request.data.roles.filter(Boolean) : [];
    const equipoJuego = String(request.data?.equipoJuego || "");
    const active = request.data?.active !== false;

    if (!email) throw new HttpsError("invalid-argument", "Falta el email.");
    if (!roles.length) throw new HttpsError("invalid-argument", "Elegí al menos un rol.");

    let userRecord;
    try {
        userRecord = await admin.auth().createUser({ email, displayName: displayName || undefined });
    } catch (err) {
        if (err.code === "auth/email-already-exists") {
            throw new HttpsError("already-exists", "Ya existe una cuenta con ese email.");
        }
        if (err.code === "auth/invalid-email") {
            throw new HttpsError("invalid-argument", "Ese email no es válido.");
        }
        logger.error("crearUsuarioStaff: fallo creando la cuenta de Auth", err);
        throw new HttpsError("internal", "No se pudo crear la cuenta.");
    }

    await admin.firestore().doc(`users/${userRecord.uid}`).set({
        email, displayName, roles, equipoJuego, active,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { uid: userRecord.uid };
});

// ---------------------------------------------------------------------
// enviarAccesoCreador: envía el link de "configurar/restablecer contraseña"
// + un correo explicando dónde entrar, a cualquier cuenta de Usuarios (el
// nombre de la función quedó de cuando era solo para creadores, pero ahora
// cubre todos los roles para no tener que crear una función nueva -y volver
// a pelear con el permiso de invocador de Cloud Run cada vez-).
// ---------------------------------------------------------------------

const PORTAL_INFO = {
    creador: { url: "https://voranix.web.app/pages/creadores.html", nombre: "Portal Creadores" },
    influencer: { url: "https://voranix.web.app/pages/influencer-portal.html", nombre: "Portal Influencers" },
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

