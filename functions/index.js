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

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

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

function construirCorreoHtml(data) {
    const asuntoLabel = ASUNTOS[data.asunto] || data.asunto || "Sin especificar";
    const extra = [];
    if (data.juego) extra.push(`<li><strong>Juego:</strong> ${data.juego}</li>`);
    if (data.nivel) extra.push(`<li><strong>Nivel/Rango:</strong> ${data.nivel}</li>`);
    if (data.id_juego) extra.push(`<li><strong>ID juego:</strong> ${data.id_juego}</li>`);
    if (data.redes) extra.push(`<li><strong>Redes:</strong> ${data.redes}</li>`);
    if (data.descripcion) extra.push(`<li><strong>Descripción:</strong> ${data.descripcion}</li>`);
    if (data.equipo) extra.push(`<li><strong>Equipo:</strong> ${data.equipo}</li>`);
    if (data.juego_torneo) extra.push(`<li><strong>Juego (torneo):</strong> ${data.juego_torneo}</li>`);

    return `
        <h2>Nuevo mensaje de contacto - VORANIX</h2>
        <p><strong>Nombre:</strong> ${data.nombre}</p>
        <p><strong>Email:</strong> ${data.email}</p>
        <p><strong>Motivo:</strong> ${asuntoLabel}</p>
        ${extra.length ? `<ul>${extra.join("")}</ul>` : ""}
        <p><strong>Mensaje:</strong></p>
        <p>${(data.mensaje || "").replace(/\n/g, "<br>")}</p>
    `;
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
