import { doc, onSnapshot, collection } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "/assets/js/firebase-config.js";

const DEFAULT_LOGO = "/imagenes/logopng.png";
const SPONSOR_ROTATE_MS = 6000;

function assetUrl(path) {
    if (!path) return "";
    return /^https?:\/\//.test(path) || path.startsWith("/") ? path : "/" + path;
}

function formatCountdown(targetValue) {
    if (!targetValue) return "";
    const target = new Date(targetValue).getTime();
    if (Number.isNaN(target)) return "";
    const diff = target - Date.now();
    if (diff <= 0) return "00:00:00:00";

    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function initOverlay() {
    const logoEl = document.getElementById("overlay-logo");
    const tickerEl = document.getElementById("overlay-ticker");
    const timerLabelEl = document.getElementById("overlay-timer-label");
    const timerValueEl = document.getElementById("overlay-timer-value");
    const timerBox = document.getElementById("overlay-timer");
    const sponsorsBox = document.getElementById("overlay-sponsors");
    const sponsorImg = document.getElementById("overlay-sponsor-logo");

    let timerFecha = "";
    let countdownInterval = null;
    let sponsors = [];
    let sponsorIndex = 0;
    let sponsorInterval = null;

    function startCountdown() {
        if (countdownInterval) clearInterval(countdownInterval);
        if (!timerFecha || !timerValueEl) return;
        const tick = () => { timerValueEl.textContent = formatCountdown(timerFecha); };
        tick();
        countdownInterval = setInterval(tick, 1000);
    }

    function renderSponsor() {
        if (!sponsorImg) return;
        if (!sponsors.length) {
            sponsorsBox?.classList.add("hidden");
            return;
        }
        sponsorsBox?.classList.remove("hidden");
        sponsorIndex = sponsorIndex % sponsors.length;
        const sponsor = sponsors[sponsorIndex];
        sponsorImg.src = assetUrl(sponsor.logo);
        sponsorImg.alt = sponsor.nombre || "Sponsor";
        sponsorIndex += 1;
    }

    function startSponsorRotation() {
        if (sponsorInterval) clearInterval(sponsorInterval);
        renderSponsor();
        sponsorInterval = setInterval(renderSponsor, SPONSOR_ROTATE_MS);
    }

    onSnapshot(doc(db, "overlayConfig", "config"), (snapshot) => {
        const data = snapshot.exists() ? snapshot.data() : {};

        if (logoEl) logoEl.src = assetUrl(data.logoOverlay) || DEFAULT_LOGO;

        if (tickerEl) {
            const mensaje = data.mensajeTicker || "";
            tickerEl.textContent = mensaje;
            tickerEl.classList.toggle("hidden", !mensaje);
        }

        timerFecha = data.timerFecha || "";
        if (timerLabelEl) timerLabelEl.textContent = data.timerLabel || "";
        timerBox?.classList.toggle("hidden", !timerFecha);
        startCountdown();
    }, (error) => console.error("overlayConfig", error));

    onSnapshot(collection(db, "sponsors"), (snapshot) => {
        sponsors = snapshot.docs
            .map((item) => item.data())
            .filter((item) => item.activo !== false && item.logo);
        sponsorIndex = 0;
        startSponsorRotation();
    }, (error) => console.error("sponsors", error));
}
