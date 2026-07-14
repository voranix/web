import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const firebaseConfig = {
    apiKey: "AIzaSyB8pMUHXHUY8JcGiZ8D5m0Xa2MkChKOXgI",
    authDomain: "voranix-2ecc9.firebaseapp.com",
    projectId: "voranix-2ecc9",
    storageBucket: "voranix-2ecc9.firebasestorage.app",
    messagingSenderId: "777966944040",
    appId: "1:777966944040:web:0221b235179951afeeda1d",
    measurementId: "G-YHGBGXHF03"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
// Misma región que las Cloud Functions (ver functions/index.js -> setGlobalOptions).
export const functionsInstance = getFunctions(app, "southamerica-east1");

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}