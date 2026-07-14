// Crea el perfil en Firestore (users/{uid}) para cuentas que YA existen en
// Firebase Authentication (creadas a mano en la consola). No crea cuentas
// de Auth ni toca contraseñas. Uso: ver scripts/README.md
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "serviceAccountKey.json");
const INPUT_PATH = path.join(__dirname, "cuentas.csv");
const RESULT_PATH = path.join(__dirname, "resultado-import.json");

const DEFAULT_ROLE = "creador";

function fail(message) {
    console.error("\n" + message + "\n");
    process.exit(1);
}

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    fail(
        `No encuentro scripts/serviceAccountKey.json.\n` +
        `Descárgalo desde Firebase Console → Configuración del proyecto → Cuentas de servicio → "Generar nueva clave privada",\n` +
        `y guárdalo exactamente en: ${SERVICE_ACCOUNT_PATH}`
    );
}

if (!fs.existsSync(INPUT_PATH)) {
    fail(
        `No encuentro scripts/cuentas.csv.\n` +
        `Crea ese archivo con una cuenta por línea: email,Nombre para mostrar,rol (el nombre y el rol son opcionales, rol por defecto "creador").\n` +
        `Mira scripts/cuentas.example.csv como referencia.`
    );
}

function parseAccounts(raw) {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
            const [email, displayName, role] = line.split(",").map((part) => (part || "").trim());
            return { email, displayName: displayName || "", role: role || DEFAULT_ROLE };
        })
        .filter((account) => account.email);
}

async function ensureProfile(db, uid, account) {
    const ref = db.collection("users").doc(uid);
    const snapshot = await ref.get();
    if (snapshot.exists) {
        return "perfil_existente_sin_tocar";
    }
    await ref.set({
        email: account.email,
        displayName: account.displayName,
        role: account.role,
        active: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return "perfil_creado";
}

async function main() {
    admin.initializeApp({
        credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH))
    });
    const auth = admin.auth();
    const db = admin.firestore();

    const accounts = parseAccounts(fs.readFileSync(INPUT_PATH, "utf8"));
    if (!accounts.length) fail("scripts/cuentas.csv no tiene ninguna cuenta válida.");

    console.log(`Buscando ${accounts.length} cuenta(s) ya existentes en Authentication...\n`);

    const results = [];
    for (const account of accounts) {
        let row;
        try {
            const user = await auth.getUserByEmail(account.email);
            const profileStatus = await ensureProfile(db, user.uid, account);
            row = { email: account.email, uid: user.uid, status: "encontrada", profileStatus };
        } catch (error) {
            row = {
                email: account.email,
                uid: null,
                status: error.code === "auth/user-not-found" ? "no_existe_en_auth" : "error",
                error: error.code === "auth/user-not-found" ? undefined : error.message
            };
        }
        results.push(row);
        console.log(
            `${row.status === "encontrada" ? "✓" : "✗"} ${account.email} -> ${row.status}` +
            (row.profileStatus ? `, perfil: ${row.profileStatus}` : "") +
            (row.error ? ` (${row.error})` : "")
        );
    }

    fs.writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2), "utf8");

    const noEncontradas = results.filter((r) => r.status !== "encontrada").length;
    console.log(`\nListo. ${results.length - noEncontradas} enganchadas a Firestore, ${noEncontradas} con problema.`);
    console.log(`Detalle guardado en ${RESULT_PATH}`);
}

main().catch((error) => fail(error.stack || String(error)));
