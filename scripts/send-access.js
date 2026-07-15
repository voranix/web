// Manda el correo de "acceso al Portal Creadores" (enviarAccesoCreador) a una
// lista puntual de emails, sin pasar por el botón del admin. Util para
// reenvíos parciales (por ejemplo, si un envío masivo se cortó a mitad de
// camino y no querés reenviarle a quien ya recibió el correo).
// Uso: ver scripts/README.md
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "serviceAccountKey.json");
const INPUT_PATH = path.join(__dirname, "access-emails.csv");
const RESULT_PATH = path.join(__dirname, "resultado-acceso.json");
const FUNCTION_URL = "https://southamerica-east1-voranix-2ecc9.cloudfunctions.net/enviarAccesoCreador";
const WEB_API_KEY = "AIzaSyB8pMUHXHUY8JcGiZ8D5m0Xa2MkChKOXgI"; // misma que assets/js/firebase-config.js

function fail(message) {
    console.error("\n" + message + "\n");
    process.exit(1);
}

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    fail(`Falta scripts/serviceAccountKey.json (ver scripts/README.md).`);
}
if (!fs.existsSync(INPUT_PATH)) {
    fail(`Falta scripts/access-emails.csv: un email por línea, de las cuentas a las que querés (re)mandar el acceso.`);
}

async function main() {
    admin.initializeApp({
        credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH))
    });
    const auth = admin.auth();
    const db = admin.firestore();

    const emails = fs.readFileSync(INPUT_PATH, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    if (!emails.length) fail("scripts/access-emails.csv no tiene ningún email.");

    console.log(`Resolviendo ${emails.length} email(s) a UID de Authentication...`);
    const uids = [];
    for (const email of emails) {
        try {
            const user = await auth.getUserByEmail(email);
            uids.push(user.uid);
            console.log(`  ok  ${email} -> ${user.uid}`);
        } catch (error) {
            console.log(`  --  ${email} -> no existe en Auth (${error.code || error.message})`);
        }
    }
    if (!uids.length) fail("Ningún email se pudo resolver a un UID existente.");

    // enviarAccesoCreador exige que quien llama sea admin: tomamos cualquier
    // cuenta con role=admin y nos "autenticamos" como ella para invocarla.
    const adminsSnap = await db.collection("users").where("role", "==", "admin").limit(1).get();
    if (adminsSnap.empty) fail("No hay ninguna cuenta con role=admin en Firestore.");
    const adminUid = adminsSnap.docs[0].id;

    const customToken = await auth.createCustomToken(adminUid);
    const signInRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: customToken, returnSecureToken: true })
        }
    );
    const signInData = await signInRes.json();
    if (!signInData.idToken) fail("No se pudo obtener el idToken de admin: " + JSON.stringify(signInData));

    console.log(`\nLlamando a enviarAccesoCreador con ${uids.length} UID(s)...`);
    const callRes = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${signInData.idToken}` },
        body: JSON.stringify({ data: { uids } })
    });
    const callData = await callRes.json();
    if (!callRes.ok) fail("Error llamando la función: " + JSON.stringify(callData));

    const detalle = (callData.result && callData.result.detalle) || (callData.data && callData.data.detalle) || [];
    fs.writeFileSync(RESULT_PATH, JSON.stringify(detalle, null, 2), "utf8");

    const ok = detalle.filter((d) => d.status === "enviado").length;
    console.log(`\nEnviados: ${ok}/${detalle.length}.`);
    detalle.forEach((d) => {
        console.log(`  ${d.status === "enviado" ? "OK " : "ERR"} ${d.uid} ${d.email || ""} ${d.error || ""}`);
    });
    console.log(`\nDetalle guardado en ${RESULT_PATH}`);
}

main().catch((error) => fail(error.stack || String(error)));
