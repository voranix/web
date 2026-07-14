// Alta masiva de cuentas de creadores en Firebase Auth + Firestore.
// Uso: ver scripts/README.md
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "serviceAccountKey.json");
const INPUT_PATH = path.join(__dirname, "cuentas.csv");
const RESULT_PATH = path.join(__dirname, "resultado.json");

const PASSWORD = process.env.BULK_PASSWORD || "CAMBIA-ESTA-CONTRASENA";
const ROLE = "creador";

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
        `Crea ese archivo con una cuenta por línea: email,Nombre para mostrar (el nombre es opcional).\n` +
        `Mira scripts/cuentas.example.csv como referencia.`
    );
}

if (PASSWORD === "CAMBIA-ESTA-CONTRASENA") {
    fail(
        `Define la contraseña que tendrán todas las cuentas.\n` +
        `Corre el script así: BULK_PASSWORD="tu-contraseña" node bulk-create-users.js`
    );
}

function parseAccounts(raw) {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
            const [email, ...rest] = line.split(",").map((part) => part.trim());
            return { email, displayName: rest.join(",") || "" };
        })
        .filter((account) => account.email);
}

async function ensureUser(auth, account) {
    try {
        const created = await auth.createUser({
            email: account.email,
            password: PASSWORD,
            displayName: account.displayName || undefined,
            emailVerified: false,
            disabled: false
        });
        return { uid: created.uid, status: "creada" };
    } catch (error) {
        if (error.code === "auth/email-already-exists") {
            const existing = await auth.getUserByEmail(account.email);
            return { uid: existing.uid, status: "ya_existia" };
        }
        return { uid: null, status: "error", error: error.message };
    }
}

async function ensureProfile(db, uid, account) {
    const ref = db.collection("users").doc(uid);
    const snapshot = await ref.get();
    if (snapshot.exists) {
        return "perfil_existente_sin_tocar";
    }
    await ref.set({
        email: account.email,
        displayName: account.displayName || "",
        role: ROLE,
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

    console.log(`Procesando ${accounts.length} cuenta(s) con la misma contraseña...\n`);

    const results = [];
    for (const account of accounts) {
        const userResult = await ensureUser(auth, account);
        let profileStatus = "no_aplica";
        if (userResult.uid) {
            profileStatus = await ensureProfile(db, userResult.uid, account);
        }
        const row = { email: account.email, ...userResult, profileStatus };
        results.push(row);
        console.log(
            `${row.status === "error" ? "✗" : "✓"} ${account.email} -> auth: ${row.status}, perfil: ${profileStatus}` +
            (row.error ? ` (${row.error})` : "")
        );
    }

    fs.writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2), "utf8");

    const errores = results.filter((r) => r.status === "error").length;
    console.log(`\nListo. ${results.length - errores} ok, ${errores} con error.`);
    console.log(`Detalle guardado en ${RESULT_PATH}`);
}

main().catch((error) => fail(error.stack || String(error)));
