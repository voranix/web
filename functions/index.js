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
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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

function construirCorreoConfirmacionHtml(data) {
    const asuntoLabel = ASUNTOS[data.asunto] || data.asunto || "tu consulta";
    return `
<div style="background:#06060e;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#0d0d1e;border-radius:12px;overflow:hidden;border:1px solid #2a2a40;">
    <img src="https://voranix.web.app/imagenes/header-email.jpg" alt="VORANIX" style="width:100%;display:block;">
    <div style="padding:32px 28px;text-align:center;">
      <img src="https://voranix.web.app/imagenes/logopng.png" alt="VORANIX" width="64" height="64" style="width:64px;height:64px;margin:0 auto 16px;display:block;">
      <h1 style="color:#ffffff;font-size:22px;margin:0 0 12px;">¡Gracias por escribirnos, ${data.nombre}!</h1>
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
// enviarAccesoCreador: envía el link de "configurar contraseña" + un
// correo explicando el portal, a una o varias cuentas creador.
// ---------------------------------------------------------------------

const PORTAL_URL = "https://voranix.web.app/pages/creadores.html";

function construirCorreoAcceso({ displayName, email, resetLink }) {
    const nombre = displayName || "";
    return `
        <h2>¡Bienvenido/a al Portal Creadores VORANIX!</h2>
        <p>Hola ${nombre},</p>
        <p>Como parte del equipo de creadores con contrato VORANIX, ahora tenés
        acceso a un portal exclusivo donde vas a encontrar accesos anticipados
        (por ejemplo, postulaciones a torneos) antes que el público general.</p>
        <p><strong>Paso 1 — Configurá tu contraseña</strong><br>
        Hacé clic en este link (válido por tiempo limitado):<br>
        <a href="${resetLink}">${resetLink}</a></p>
        <p><strong>Paso 2 — Entrá al portal</strong><br>
        Una vez configurada tu contraseña, ingresá con tu email
        (<strong>${email}</strong>) en:<br>
        <a href="${PORTAL_URL}">${PORTAL_URL}</a></p>
        <p>Cualquier duda, escribinos por Discord.</p>
        <p>— Equipo VORANIX</p>
    `;
}

exports.enviarAccesoCreador = onCall(
    { secrets: [SMTP_USER, SMTP_PASS] },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
        }

        // Solo admin puede disparar este envío (no editor: manda links de
        // acceso a cuentas, es una acción sensible).
        const callerSnap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
        const callerProfile = callerSnap.exists ? callerSnap.data() : null;
        if (!callerProfile || callerProfile.role !== "admin") {
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

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: smtpUser, pass: smtpPass }
        });

        const results = await Promise.allSettled(uids.map(async (uid) => {
            const profileSnap = await admin.firestore().doc(`users/${uid}`).get();
            if (!profileSnap.exists) throw new Error(`Perfil ${uid} no existe en Firestore`);
            const profile = profileSnap.data();

            // Blindaje: solo se manda a cuentas creador activas, aunque el
            // llamador haya mandado otro UID por error (ej. un admin).
            if (profile.role !== "creador" || profile.active === false) {
                throw new Error(`${uid} no es una cuenta creador activa, se omite`);
            }

            const authUser = await admin.auth().getUser(uid);
            const email = authUser.email || profile.email;
            if (!email) throw new Error(`${uid} no tiene email`);

            const resetLink = await admin.auth().generatePasswordResetLink(email, { url: PORTAL_URL });

            await transporter.sendMail({
                from: `VORANIX <${smtpUser}>`,
                to: email,
                subject: "Tu acceso al Portal Creadores VORANIX",
                html: construirCorreoAcceso({ displayName: profile.displayName, email, resetLink })
            });

            return { uid, email, status: "enviado" };
        }));

        const detalle = results.map((r, i) => r.status === "fulfilled"
            ? r.value
            : { uid: uids[i], status: "error", error: String(r.reason?.message || r.reason) });

        return { detalle };
    }
);
