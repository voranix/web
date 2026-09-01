import { doc, onSnapshot, collection, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "/assets/js/firebase-config.js";

const DEFAULT_LOGO = "/imagenes/logopng.png";
const SPONSOR_ROTATE_MS = 6000;
const CODIGO_VISIBLE_MS = 8000; // cuánto queda a la vista cada código
const CODIGO_HIDDEN_MS = 6000; // pausa oculto antes de mostrar el siguiente

// Redes de VORANIX (las mismas que ya se repiten en el footer del sitio).
const SOCIAL_LINKS = [
    { platform: "Discord", handle: "Únete a la comunidad", mono: "D", color: "#5865F2" },
    { platform: "Instagram", handle: "@voranixstudio", mono: "IG", color: "#c9348a" },
    { platform: "Twitch", handle: "voranixstudio", mono: "TW", color: "#9146FF" },
    { platform: "TikTok", handle: "@voranix_gaming", mono: "TT", color: "#25c2bd" }
];
const SOCIAL_POPUP_FIRST_DELAY_MS = 20000; // primera aparición a los 20s de cargar
const SOCIAL_POPUP_INTERVAL_MS = 30 * 60 * 1000; // cada 30 min
const SOCIAL_POPUP_VISIBLE_MS = 9000; // tiempo en pantalla antes de retirarse

const TICKER_FIRST_DELAY_MS = 20000; // primera aparición a los 20s de cargar
const TICKER_INTERVAL_MS = 30 * 60 * 1000; // cada 30 min
const TICKER_VISIBLE_MS = 20000; // tiempo en pantalla antes de retirarse

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

// Velocidad del marquee: píxeles por segundo (constante), así un mensaje
// largo no se siente más lento/rápido que uno corto.
const MARQUEE_PX_PER_SEC = 140;

export function initOverlay() {
    const logoEl = document.getElementById("overlay-logo");
    const lineEl = document.querySelector(".bar, .column");
    const tickerWrap = document.querySelector(".ticker-wrap");
    const tickerEl = document.getElementById("overlay-ticker");
    const timerLabelEl = document.getElementById("overlay-timer-label");
    const timerValueEl = document.getElementById("overlay-timer-value");
    const timerBox = document.getElementById("overlay-timer");
    const sponsorsBox = document.getElementById("overlay-sponsors");
    const sponsorImgA = document.getElementById("overlay-sponsor-logo-a");
    const sponsorImgB = document.getElementById("overlay-sponsor-logo-b");
    const codigosBox = document.getElementById("overlay-codigos");
    const codigoChip = document.getElementById("overlay-codigo-chip");
    const codigoImg = document.getElementById("overlay-codigo-img");
    const codigoCodeEl = document.getElementById("overlay-codigo-code");
    const codigoDescEl = document.getElementById("overlay-codigo-desc");

    let timerFecha = "";
    let countdownInterval = null;
    let sponsors = [];
    let sponsorIndex = 0;
    let sponsorInterval = null;
    let showingA = true;
    let codigos = [];
    let codigoIndex = 0;
    let codigoTimeout = null;
    let tickerMensaje = "";
    let tickerHideTimeout = null;
    let tickerCycleStarted = false;

    function startCountdown() {
        if (countdownInterval) clearInterval(countdownInterval);
        if (!timerFecha || !timerValueEl) return;
        const tick = () => { timerValueEl.textContent = formatCountdown(timerFecha); };
        tick();
        countdownInterval = setInterval(tick, 1000);
    }

    // Si el texto entra en el contenedor, queda quieto y centrado; si no
    // entra, se activa el desplazamiento continuo (marquee) a velocidad fija.
    function updateTickerScroll() {
        if (!tickerEl || !tickerWrap) return;
        tickerEl.classList.remove("scroll");
        tickerEl.style.animation = "";
        // requestAnimationFrame para medir después de que el navegador aplique el texto nuevo.
        requestAnimationFrame(() => {
            const overflow = tickerEl.scrollWidth - tickerWrap.clientWidth;
            if (overflow > 0) {
                const distance = tickerEl.scrollWidth + tickerWrap.clientWidth;
                const duration = distance / MARQUEE_PX_PER_SEC;
                tickerEl.classList.add("scroll");
                tickerEl.style.animationDuration = `${duration}s`;
            }
        });
    }

    // El ticker (mensaje rotativo / "síguenos en nuestras redes") no queda
    // fijo en pantalla: aparece cada 30 minutos, se muestra un rato y se
    // retira, igual que el popup de redes. La línea de acento del borde
    // inferior (horizontal) / lateral (vertical) acompaña ese mismo ciclo:
    // solo se ve mientras el mensaje está en pantalla.
    function showTicker() {
        if (!tickerEl || !tickerMensaje) return;
        tickerEl.textContent = tickerMensaje;
        updateTickerScroll();
        requestAnimationFrame(() => {
            tickerEl.classList.add("show");
            lineEl?.classList.add("show-line");
        });
        if (tickerHideTimeout) clearTimeout(tickerHideTimeout);
        tickerHideTimeout = setTimeout(hideTicker, TICKER_VISIBLE_MS);
    }

    function hideTicker() {
        if (tickerHideTimeout) clearTimeout(tickerHideTimeout);
        tickerEl?.classList.remove("show");
        lineEl?.classList.remove("show-line");
    }

    function startTickerCycle() {
        if (tickerCycleStarted) return;
        tickerCycleStarted = true;
        setTimeout(() => {
            showTicker();
            setInterval(showTicker, TICKER_INTERVAL_MS);
        }, TICKER_FIRST_DELAY_MS);
    }

    // Crossfade entre dos <img> superpuestas: precarga la próxima imagen
    // antes de mostrarla para no dejar un flash vacío mientras carga.
    function renderSponsor() {
        if (!sponsorImgA || !sponsorImgB) return;
        if (!sponsors.length) {
            sponsorsBox?.classList.add("hidden");
            return;
        }
        sponsorsBox?.classList.remove("hidden");
        sponsorIndex = sponsorIndex % sponsors.length;
        const sponsor = sponsors[sponsorIndex];
        const nextImg = showingA ? sponsorImgB : sponsorImgA;
        const prevImg = showingA ? sponsorImgA : sponsorImgB;

        const preload = new Image();
        preload.onload = () => {
            nextImg.src = assetUrl(sponsor.logo);
            nextImg.alt = sponsor.nombre || "Sponsor";
            nextImg.classList.add("show");
            prevImg.classList.remove("show");
            showingA = !showingA;
        };
        preload.src = assetUrl(sponsor.logo);

        sponsorIndex += 1;
    }

    function startSponsorRotation() {
        if (sponsorInterval) clearInterval(sponsorInterval);
        renderSponsor();
        sponsorInterval = setInterval(renderSponsor, SPONSOR_ROTATE_MS);
    }

    // A diferencia de los sponsors (que rotan siempre visibles con
    // crossfade), los códigos aparecen y desaparecen: se muestran un rato,
    // se ocultan del todo, y recién ahí entra el siguiente. Así se nota que
    // "cambió" en vez de quedar como un cartel fijo permanente.
    function hideCodigo() {
        if (codigoTimeout) clearTimeout(codigoTimeout);
        if (!codigoChip) return;
        codigoChip.classList.remove("show");
        codigoTimeout = setTimeout(showNextCodigo, CODIGO_HIDDEN_MS);
    }

    function showNextCodigo() {
        if (codigoTimeout) clearTimeout(codigoTimeout);
        if (!codigoChip || !codigos.length) {
            codigosBox?.classList.add("hidden");
            return;
        }
        codigosBox?.classList.remove("hidden");
        codigoIndex = codigoIndex % codigos.length;
        const codigo = codigos[codigoIndex];
        codigoIndex += 1;

        function apply() {
            if (codigoImg) {
                if (codigo.imagen) {
                    codigoImg.src = assetUrl(codigo.imagen);
                    codigoImg.alt = codigo.marca || codigo.codigo || "";
                    codigoImg.classList.remove("hidden");
                } else {
                    codigoImg.classList.add("hidden");
                }
            }
            if (codigoCodeEl) codigoCodeEl.textContent = codigo.codigo || "";
            if (codigoDescEl) codigoDescEl.textContent = codigo.descripcion || "";
            codigoChip.classList.add("show");
            codigoTimeout = setTimeout(hideCodigo, CODIGO_VISIBLE_MS);
        }

        if (codigo.imagen) {
            const preload = new Image();
            preload.onload = apply;
            preload.onerror = apply;
            preload.src = assetUrl(codigo.imagen);
        } else {
            apply();
        }
    }

    function startCodigoCycle() {
        if (codigoTimeout) clearTimeout(codigoTimeout);
        codigoChip?.classList.remove("show");
        if (!codigos.length) {
            codigosBox?.classList.add("hidden");
            return;
        }
        codigoTimeout = setTimeout(showNextCodigo, 500);
    }

    onSnapshot(doc(db, "overlayConfig", "config"), (snapshot) => {
        const data = snapshot.exists() ? snapshot.data() : {};

        if (logoEl) logoEl.src = assetUrl(data.logoOverlay) || DEFAULT_LOGO;

        if (tickerEl) {
            tickerMensaje = data.mensajeTicker || "";
            tickerEl.style.color = data.tickerColor || "";
            tickerEl.classList.toggle("hidden", !tickerMensaje);
            if (!tickerMensaje) {
                hideTicker();
            } else {
                startTickerCycle();
            }
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

    onSnapshot(collection(db, "overlayCodigos"), (snapshot) => {
        codigos = snapshot.docs
            .map((item) => item.data())
            .filter((item) => item.activo !== false && item.codigo);
        codigoIndex = 0;
        startCodigoCycle();
    }, (error) => console.error("overlayCodigos", error));
}

// Cartel que entra deslizando desde un lateral, se queda un rato mostrando
// una red de VORANIX (rotando entre Discord/Instagram/Twitch/TikTok) y se
// retira por el mismo lado. Se repite cada 30 minutos.
export function initSocialPopup() {
    const popup = document.getElementById("social-popup");
    if (!popup) return;
    const monoEl = popup.querySelector(".social-popup-mono");
    const platformEl = popup.querySelector(".social-popup-platform");
    const handleEl = popup.querySelector(".social-popup-handle");
    let index = 0;

    function showNext() {
        const item = SOCIAL_LINKS[index % SOCIAL_LINKS.length];
        index += 1;
        if (monoEl) {
            monoEl.textContent = item.mono;
            monoEl.style.background = item.color;
        }
        if (platformEl) platformEl.textContent = item.platform;
        if (handleEl) handleEl.textContent = item.handle;
        popup.classList.add("show");
        setTimeout(() => popup.classList.remove("show"), SOCIAL_POPUP_VISIBLE_MS);
    }

    setTimeout(() => {
        showNext();
        setInterval(showNext, SOCIAL_POPUP_INTERVAL_MS);
    }, SOCIAL_POPUP_FIRST_DELAY_MS);
}

const RAID_BANNER_VISIBLE_MS = 11000;

// Banner de "gracias por el raid": solo se activa si la URL del overlay
// trae ?canal=loginDeTwitch (cada streamer usa su propia URL en OBS). Sin
// ese parámetro, esta ventana simplemente no escucha raids de nadie.
export function initRaidAlert() {
    const params = new URLSearchParams(location.search);
    const canal = (params.get("canal") || "").toLowerCase().trim();
    if (!canal) return;

    const banner = document.getElementById("raid-banner");
    if (!banner) return;
    const nameEl = document.getElementById("raid-banner-name");
    const viewersEl = document.getElementById("raid-banner-viewers");

    // Cualquier raid anterior a que esta ventana cargara se ignora, para no
    // mostrar de nuevo el último raid cada vez que OBS recarga la fuente.
    let baseline = Date.now();
    let hideTimeout = null;

    onSnapshot(doc(db, "raidAlerts", canal), (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();
        const recibidoEn = data.receivedAt?.toMillis?.() || 0;
        if (recibidoEn <= baseline) return;
        baseline = recibidoEn;

        if (nameEl) nameEl.textContent = data.fromBroadcaster || "alguien";
        if (viewersEl) viewersEl.textContent = `${data.viewers || 0} viewers se sumaron a la fiesta 🎉`;

        if (hideTimeout) clearTimeout(hideTimeout);
        banner.classList.add("show");
        hideTimeout = setTimeout(() => banner.classList.remove("show"), RAID_BANNER_VISIBLE_MS);
    }, (error) => console.error("raidAlerts", error));
}

const COMANDO_BANNER_VISIBLE_MS = 12000;

// Banner "estilo noticiero" que dispara un comando de chat tipo pantalla/
// ambos/codigo (ver twitchChatWebhook). Escucha DOS fuentes en paralelo:
// - overlayEventoActual/{canal} (si la URL trae ?canal=, igual que el
//   banner de raid): solo eventos del propio stream, así un comando usado
//   en otro canal no interrumpe a este.
// - overlayEventoActual/_general (siempre, tenga o no ?canal=): mensajes
//   que el admin manda a propósito para TODOS los streams a la vez.
// Cada fuente tiene su propio "baseline" para no repetir eventos viejos al
// cargar la página, mismo patrón que initRaidAlert.
export function initOverlayEvento() {
    const banner = document.getElementById("comando-banner");
    if (!banner) return;
    const barEl = document.getElementById("comando-banner-bar");
    const imgEl = document.getElementById("comando-banner-img");
    const titleEl = document.getElementById("comando-banner-title");
    const detailEl = document.getElementById("comando-banner-detail");

    let hideTimeout = null;

    function mostrarBanner(data) {
        if (barEl) barEl.style.background = data.color || "var(--morado)";
        if (titleEl) titleEl.textContent = data.titulo || "";
        if (detailEl) {
            detailEl.textContent = data.detalle || "";
            detailEl.classList.toggle("hidden", !data.detalle);
        }
        if (imgEl) {
            if (data.imagen) {
                imgEl.src = assetUrl(data.imagen);
                imgEl.classList.remove("hidden");
            } else {
                imgEl.classList.add("hidden");
            }
        }

        if (hideTimeout) clearTimeout(hideTimeout);
        banner.classList.add("show");
        hideTimeout = setTimeout(() => banner.classList.remove("show"), COMANDO_BANNER_VISIBLE_MS);
    }

    function escucharEvento(docId) {
        let baseline = Date.now();
        onSnapshot(doc(db, "overlayEventoActual", docId), (snapshot) => {
            if (!snapshot.exists()) return;
            const data = snapshot.data();
            const activadoEn = data.activadoAt?.toMillis?.() || 0;
            if (activadoEn <= baseline) return;
            baseline = activadoEn;
            mostrarBanner(data);
        }, (error) => console.error(`overlayEventoActual/${docId}`, error));
    }

    const params = new URLSearchParams(location.search);
    const canal = (params.get("canal") || "").toLowerCase().trim();
    if (canal) escucharEvento(canal);
    escucharEvento("_general");
}

// Elementos que cada creador puede reposicionar libremente desde el editor
// de layout del Portal Creadores (overlayLayout/{canal}.horizontal|vertical).
// Solo la barra de ticker+timer queda fija en su lugar de siempre (ver
// overlay/horizontal.html y overlay/vertical.html — reservan el mismo
// espacio de antes con padding/spacer para que, sin un layout personalizado
// guardado, no se note ningún cambio).
const LAYOUT_ELEMENTOS = {
    logo: () => document.getElementById("logo-block"),
    social: () => document.getElementById("social-popup"),
    comando: () => document.getElementById("comando-banner"),
    raid: () => document.getElementById("raid-banner"),
    sponsors: () => document.getElementById("overlay-sponsors"),
    codigos: () => document.getElementById("overlay-codigos")
};

// Etiquetas y posiciones/tamaño por defecto de cada elemento movible,
// co-ubicadas acá (en vez de duplicadas en pages/creadores.html) junto al
// resto de este archivo que ya conoce el CSS real de cada overlay — así no
// se pueden desincronizar. "Guardar diseño" en el Portal Creadores graba
// TODAS las posiciones del layout actual (no solo la que se tocó), así que
// estos valores tienen que coincidir con la posición real en
// overlay/horizontal.html y vertical.html (ver sus comentarios "left/top"
// en px), o el primer guardado haría "saltar" a los elementos sin mover.
export const LAYOUT_LABELS = {
    logo: "Logo", social: "Redes sociales", comando: "Comando de chat", raid: "Raid",
    sponsors: "Sponsors", codigos: "Códigos"
};
export const LAYOUT_DEFAULTS = {
    horizontal: {
        logo:     { x: 2,  y: 85, visible: true, scale: 1 },
        social:   { x: 78, y: 6,  visible: true, scale: 1 },
        comando:  { x: 2,  y: 6,  visible: true, scale: 1 },
        raid:     { x: 50, y: 8,  visible: true, scale: 1 },
        sponsors: { x: 68, y: 80, visible: true, scale: 1 },
        codigos:  { x: 84, y: 91, visible: true, scale: 1 }
    },
    vertical: {
        logo:     { x: 25, y: 3,  visible: true, scale: 1 },
        social:   { x: 5,  y: 38, visible: true, scale: 1 },
        comando:  { x: 5,  y: 58, visible: true, scale: 1 },
        raid:     { x: 30, y: 78, visible: true, scale: 1 },
        sponsors: { x: 6,  y: 30, visible: true, scale: 1 },
        codigos:  { x: 6,  y: 44, visible: true, scale: 1 }
    }
};

// Tamaño nativo (px reales) de cada overlay — el editor los usa para
// calcular arrastre/tope directamente en píxeles, y el iframe de vista
// previa del Portal Creadores los usa para calcular su escala visual.
export const LAYOUT_NATIVE_SIZE = { horizontal: { w: 1920, h: 1080 }, vertical: { w: 340, h: 1080 } };

// raid-banner (ambas orientaciones) y social/comando (solo vertical) se
// centran con un transform de translate% además de su left/top — hay que
// combinar ese transform "base" con el scale() del editor en vez de
// pisarlo, o pierden el centrado.
const LAYOUT_BASE_TRANSFORM = {
    horizontal: { logo: "", social: "", comando: "", raid: "translate(-50%, 0)", sponsors: "", codigos: "" },
    vertical: { logo: "", social: "translate(0, -50%)", comando: "translate(0, -50%)", raid: "translate(-50%, -50%)", sponsors: "", codigos: "" }
};

// Si un elemento no tiene posición guardada, se deja tal cual estaba (su
// CSS original) — así ningún creador que nunca abrió el editor nota ningún
// cambio en su overlay. Solo se pisan left/top/right/bottom cuando SÍ hay
// una posición guardada para ese elemento puntual.
export function initCustomLayout(orientacion) {
    const params = new URLSearchParams(location.search);
    const canal = (params.get("canal") || "").toLowerCase().trim();
    if (!canal) return;

    onSnapshot(doc(db, "overlayLayout", canal), (snapshot) => {
        const layout = (snapshot.exists() ? snapshot.data()[orientacion] : null) || {};
        for (const [key, getEl] of Object.entries(LAYOUT_ELEMENTOS)) {
            const pos = layout[key];
            if (!pos) continue;
            const el = getEl();
            if (!el) continue;
            el.style.left = `${pos.x}%`;
            el.style.top = `${pos.y}%`;
            el.style.right = "auto";
            el.style.bottom = "auto";
            el.style.display = pos.visible === false ? "none" : "";
            // El scale solo pisa el transform inline cuando el creador
            // realmente agrandó el elemento — así el resto (sin scale
            // guardado, la inmensa mayoría) no pierde la animación de
            // aparición/retiro que controla el transform vía la clase
            // .show del CSS.
            if (pos.scale && pos.scale !== 1) {
                const base = (LAYOUT_BASE_TRANSFORM[orientacion] || {})[key] || "";
                el.style.transformOrigin = "top left";
                el.style.transform = `${base} scale(${pos.scale})`.trim();
            }
        }
    }, (error) => console.error("overlayLayout", error));
}

// ---------------------------------------------------------------------
// Editor "WYSIWYG" del layout (Portal Creadores → Herramientas): corre
// SOLO dentro del iframe que carga este mismo overlay con ?editor=1 (ver
// el <script> final de horizontal.html/vertical.html) — nunca se ejecuta
// en el overlay real que ve OBS. Muestra los 6 elementos movibles de
// forma estática (con su contenido real o un placeholder) y los deja
// arrastrar (mover) y redimensionar (agarre en la esquina inferior
// derecha, scale clamped a [1,3] — 1 es el tamaño predeterminado real y
// nunca se puede achicar por debajo de eso).
// ---------------------------------------------------------------------

const EDITOR_EMPTY_LABELS = { sponsors: "Sin sponsors todavía", codigos: "Sin códigos todavía" };

function aplicarTransformEditor(el, orientacion, key, scale) {
    const base = (LAYOUT_BASE_TRANSFORM[orientacion] || {})[key] || "";
    el.style.transformOrigin = "top left";
    el.style.transform = scale && scale !== 1 ? `${base} scale(${scale})`.trim() : base;
}

function injectEditorStyles() {
    if (document.getElementById("__editor-mode-style")) return;
    const style = document.createElement("style");
    style.id = "__editor-mode-style";
    style.textContent = `
        [data-editor-el]{ outline:2px dashed rgba(255,255,255,.55); outline-offset:3px; cursor:grab; touch-action:none; }
        [data-editor-el]:active{ cursor:grabbing; }
        [data-editor-el].editor-empty{ background:rgba(255,255,255,.08) !important; border-radius:8px; }
        [data-editor-el].editor-empty > *:not(.editor-empty-label){ visibility:hidden; }
        .editor-empty-label{
            position:absolute; inset:0; display:none; align-items:center; justify-content:center;
            font-size:13px; font-weight:700; color:rgba(255,255,255,.85); text-align:center; padding:0 8px; pointer-events:none;
        }
        .editor-resize-handle{
            position:absolute; width:22px; height:22px; border-radius:50%; line-height:18px; text-align:center;
            background:#7b2cff; border:2px solid #fff; z-index:99999; cursor:nwse-resize; touch-action:none;
            font-size:11px; color:#fff;
        }
    `;
    document.head.appendChild(style);
}

export async function initEditorMode(orientacion) {
    const params = new URLSearchParams(location.search);
    const canal = (params.get("canal") || "").toLowerCase().trim();
    if (!canal) return;

    injectEditorStyles();
    const native = LAYOUT_NATIVE_SIZE[orientacion];
    const state = JSON.parse(JSON.stringify(LAYOUT_DEFAULTS[orientacion]));

    try {
        const snap = await getDoc(doc(db, "overlayLayout", canal));
        const saved = (snap.exists() ? snap.data()[orientacion] : null) || {};
        for (const key of Object.keys(LAYOUT_ELEMENTOS)) {
            if (saved[key]) state[key] = { scale: 1, ...saved[key] };
        }
    } catch (error) { console.error("overlayLayout", error); }

    // Contenido real (o de ejemplo, para lo que normalmente solo aparece
    // disparado por un evento en vivo) de cada elemento, para que se
    // pueda ver y agarrar aunque ahora mismo no esté pasando nada.
    try {
        const cfgSnap = await getDoc(doc(db, "overlayConfig", "config"));
        const cfg = cfgSnap.exists() ? cfgSnap.data() : {};
        const logoEl = document.getElementById("overlay-logo");
        if (logoEl) logoEl.src = assetUrl(cfg.logoOverlay) || DEFAULT_LOGO;
    } catch (error) { console.error("overlayConfig", error); }

    const popup = document.getElementById("social-popup");
    if (popup) {
        const item = SOCIAL_LINKS[0];
        const monoEl = popup.querySelector(".social-popup-mono");
        const platformEl = popup.querySelector(".social-popup-platform");
        const handleEl = popup.querySelector(".social-popup-handle");
        if (monoEl) { monoEl.textContent = item.mono; monoEl.style.background = item.color; }
        if (platformEl) platformEl.textContent = item.platform;
        if (handleEl) handleEl.textContent = item.handle;
        popup.classList.add("show");
    }

    const raidNameEl = document.getElementById("raid-banner-name");
    const raidViewersEl = document.getElementById("raid-banner-viewers");
    if (raidNameEl) raidNameEl.textContent = "EjemploStreamer";
    if (raidViewersEl) raidViewersEl.textContent = "123 viewers se sumaron a la fiesta 🎉";
    document.getElementById("raid-banner")?.classList.add("show");

    const comandoTitleEl = document.getElementById("comando-banner-title");
    const comandoDetailEl = document.getElementById("comando-banner-detail");
    const comandoImgEl = document.getElementById("comando-banner-img");
    if (comandoTitleEl) comandoTitleEl.textContent = "Vista previa de comando";
    if (comandoDetailEl) { comandoDetailEl.textContent = "Así se ve cuando alguien usa un comando."; comandoDetailEl.classList.remove("hidden"); }
    if (comandoImgEl) comandoImgEl.classList.add("hidden");
    document.getElementById("comando-banner")?.classList.add("show");

    const sponsorsBox = document.getElementById("overlay-sponsors");
    const sponsorImgA = document.getElementById("overlay-sponsor-logo-a");
    try {
        const snap = await getDocs(collection(db, "sponsors"));
        const activos = snap.docs.map((item) => item.data()).filter((item) => item.activo !== false && item.logo);
        if (activos.length && sponsorImgA) {
            sponsorImgA.src = assetUrl(activos[0].logo);
            sponsorImgA.alt = activos[0].nombre || "Sponsor";
            sponsorImgA.classList.add("show");
            sponsorsBox?.classList.remove("editor-empty");
        } else {
            sponsorsBox?.classList.add("editor-empty");
        }
    } catch (error) { console.error("sponsors", error); sponsorsBox?.classList.add("editor-empty"); }
    sponsorsBox?.classList.remove("hidden");

    const codigosBox = document.getElementById("overlay-codigos");
    const codigoChip = document.getElementById("overlay-codigo-chip");
    const codigoImg = document.getElementById("overlay-codigo-img");
    const codigoCodeEl = document.getElementById("overlay-codigo-code");
    const codigoDescEl = document.getElementById("overlay-codigo-desc");
    try {
        const snap = await getDocs(collection(db, "overlayCodigos"));
        const activos = snap.docs.map((item) => item.data()).filter((item) => item.activo !== false && item.codigo);
        if (activos.length) {
            const codigo = activos[0];
            if (codigoImg) {
                if (codigo.imagen) { codigoImg.src = assetUrl(codigo.imagen); codigoImg.classList.remove("hidden"); }
                else codigoImg.classList.add("hidden");
            }
            if (codigoCodeEl) codigoCodeEl.textContent = codigo.codigo || "";
            if (codigoDescEl) codigoDescEl.textContent = codigo.descripcion || "";
            codigoChip?.classList.add("show");
            codigosBox?.classList.remove("editor-empty");
        } else {
            codigosBox?.classList.add("editor-empty");
        }
    } catch (error) { console.error("overlayCodigos", error); codigosBox?.classList.add("editor-empty"); }
    codigosBox?.classList.remove("hidden");

    for (const key of Object.keys(EDITOR_EMPTY_LABELS)) {
        const el = LAYOUT_ELEMENTOS[key]?.();
        if (!el) continue;
        let label = el.querySelector(".editor-empty-label");
        if (!label) {
            label = document.createElement("span");
            label.className = "editor-empty-label";
            label.textContent = EDITOR_EMPTY_LABELS[key];
            el.appendChild(label);
        }
        label.style.display = el.classList.contains("editor-empty") ? "flex" : "none";
    }

    // --- Ubicar/escalar los 6 elementos y hacerlos arrastrables + redimensionables ---
    const handles = {};

    function crearHandle(key) {
        const handle = document.createElement("div");
        handle.className = "editor-resize-handle";
        handle.dataset.editorHandle = key;
        handle.textContent = "⤡";
        document.body.appendChild(handle);
        return handle;
    }

    function posicionarHandle(key, el) {
        const handle = handles[key];
        if (!handle) return;
        const rect = el.getBoundingClientRect();
        handle.style.left = `${rect.right - 11}px`;
        handle.style.top = `${rect.bottom - 11}px`;
    }

    function aplicarPosicion(key) {
        const el = LAYOUT_ELEMENTOS[key]();
        if (!el) return;
        const pos = state[key];
        el.dataset.editorEl = "1";
        el.style.left = `${pos.x}%`;
        el.style.top = `${pos.y}%`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.display = pos.visible === false ? "none" : "";
        aplicarTransformEditor(el, orientacion, key, pos.scale || 1);
        posicionarHandle(key, el);
    }

    for (const key of Object.keys(LAYOUT_ELEMENTOS)) {
        const el = LAYOUT_ELEMENTOS[key]();
        if (!el) continue;
        handles[key] = crearHandle(key);
        aplicarPosicion(key);

        // Arrastrar para mover: mismo patrón offset punto-de-agarre/tope
        // según tamaño real ya usado en el editor anterior de
        // pages/creadores.html, ahora en píxeles nativos del propio
        // overlay en vez de un canvas chico a escala.
        el.addEventListener("pointerdown", (event) => {
            if (event.target.closest(".editor-resize-handle")) return;
            event.preventDefault();
            el.setPointerCapture(event.pointerId);
            const elRect = el.getBoundingClientRect();
            const offsetXPct = ((event.clientX - elRect.left) / native.w) * 100;
            const offsetYPct = ((event.clientY - elRect.top) / native.h) * 100;
            const maxX = Math.max(0, 100 - (elRect.width / native.w) * 100);
            const maxY = Math.max(0, 100 - (elRect.height / native.h) * 100);

            function onMove(moveEvent) {
                const relX = (moveEvent.clientX / native.w) * 100 - offsetXPct;
                const relY = (moveEvent.clientY / native.h) * 100 - offsetYPct;
                state[key].x = Math.max(0, Math.min(maxX, relX));
                state[key].y = Math.max(0, Math.min(maxY, relY));
                aplicarPosicion(key);
            }
            function onUp() {
                el.removeEventListener("pointermove", onMove);
                el.removeEventListener("pointerup", onUp);
            }
            el.addEventListener("pointermove", onMove);
            el.addEventListener("pointerup", onUp);
        });

        // Redimensionar: la distancia entre el punto de agarre y la
        // esquina superior izquierda del elemento (su ancla x/y) contra
        // su tamaño natural (sin escalar) define el nuevo scale. Nunca
        // baja de 1 (el tamaño predeterminado es el piso) ni sube de 3
        // (tope).
        handles[key].addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            handles[key].setPointerCapture(event.pointerId);
            const elRect = el.getBoundingClientRect();
            const scaleActual = state[key].scale || 1;
            const naturalW = elRect.width / scaleActual;
            const naturalH = elRect.height / scaleActual;
            const anchorX = elRect.left;
            const anchorY = elRect.top;

            function onMove(moveEvent) {
                const distX = moveEvent.clientX - anchorX;
                const distY = moveEvent.clientY - anchorY;
                const nuevaEscala = Math.max(distX / naturalW, distY / naturalH);
                state[key].scale = Math.max(1, Math.min(3, nuevaEscala));
                aplicarPosicion(key);
            }
            function onUp() {
                handles[key].removeEventListener("pointermove", onMove);
                handles[key].removeEventListener("pointerup", onUp);
            }
            handles[key].addEventListener("pointermove", onMove);
            handles[key].addEventListener("pointerup", onUp);
        });
    }

    window.__editorLayout = {
        getState() { return JSON.parse(JSON.stringify(state)); },
        reload() { location.reload(); }
    };
}
