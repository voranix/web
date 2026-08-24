// Botón flotante de "Reportar un problema", compartido por todas las
// páginas públicas, los 3 portales y el admin. Se inyecta 100% por JS
// (estilos incluidos, con colores fijos en vez de var(--...) porque el
// admin y el sitio público no comparten los mismos nombres de variables
// CSS) para no tener que tocar el HTML de cada página.
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { auth, db, storage } from "/assets/js/firebase-config.js";

const STYLE = `
#report-bug-btn{
    position:fixed; right:18px; bottom:18px; z-index:300; width:48px; height:48px; border-radius:50%;
    background:linear-gradient(135deg,#7b2cff,#ff6a00); border:none; color:#fff; font-size:20px; cursor:pointer;
    box-shadow:0 6px 20px rgba(123,44,255,.4); display:flex; align-items:center; justify-content:center;
    transition:transform .15s ease;
}
#report-bug-btn:hover{ transform:translateY(-2px) scale(1.05); }
#report-bug-modal{ position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:301; display:flex; align-items:center; justify-content:center; padding:16px; }
#report-bug-modal.hidden{ display:none; }
#report-bug-card{
    width:min(420px,100%); background:#101018; border:1px solid rgba(123,44,255,.5); border-radius:14px;
    padding:22px; box-shadow:0 20px 60px rgba(0,0,0,.5); font-family:inherit; color:#fff;
}
#report-bug-card h3{ font-size:16px; margin:0; }
.report-bug-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.report-bug-head button{ background:none; border:none; color:#a9a9bc; font-size:16px; cursor:pointer; padding:4px; }
.report-bug-head button:hover{ color:#fff; }
#report-bug-form textarea{
    width:100%; min-height:100px; background:#0a0a14; color:#fff; border:1px solid rgba(255,255,255,.12);
    border-radius:8px; padding:11px; font:inherit; resize:vertical; box-sizing:border-box;
}
#report-bug-form input[type="file"]{ margin-top:10px; font-size:12px; color:#a9a9bc; }
#report-bug-form .help{ font-size:11px; color:#7a7a90; margin-top:6px; line-height:1.5; }
#report-bug-error{ color:#ff8b9d; font-size:12px; min-height:16px; margin-top:8px; }
#report-bug-submit{
    margin-top:12px; width:100%; border:0; color:#fff; background:linear-gradient(90deg,#7b2cff,#ff6a00);
    border-radius:8px; padding:11px 18px; font-weight:800; font-size:13px; cursor:pointer;
}
#report-bug-submit:disabled{ opacity:.6; cursor:default; }
#report-bug-success{ text-align:center; padding:14px 0; color:#00e676; font-size:13px; }
`;

function injectStyles() {
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);
}

function injectWidget() {
    const btn = document.createElement("button");
    btn.id = "report-bug-btn";
    btn.type = "button";
    btn.title = "Reportar un problema";
    btn.setAttribute("aria-label", "Reportar un problema");
    btn.textContent = "🐞";

    const modal = document.createElement("div");
    modal.id = "report-bug-modal";
    modal.className = "hidden";
    modal.innerHTML = `
<div id="report-bug-card">
    <div class="report-bug-head">
        <h3>Reportar un problema</h3>
        <button type="button" id="report-bug-close">✕</button>
    </div>
    <form id="report-bug-form">
        <textarea name="mensaje" required placeholder="Contanos qué pasó, así lo revisamos..."></textarea>
        <input type="file" name="captura" accept="image/*">
        <p class="help">Opcional: adjuntá una captura de pantalla.</p>
        <div id="report-bug-error"></div>
        <button id="report-bug-submit" type="submit">Enviar</button>
    </form>
    <p id="report-bug-success" class="hidden">¡Gracias! Ya lo recibimos.</p>
</div>`;

    document.body.appendChild(btn);
    document.body.appendChild(modal);
    return { btn, modal };
}

function attachHandlers({ btn, modal }) {
    const form = document.getElementById("report-bug-form");
    const errorEl = document.getElementById("report-bug-error");
    const successEl = document.getElementById("report-bug-success");
    const submitBtn = document.getElementById("report-bug-submit");

    function open() {
        modal.classList.remove("hidden");
        form.classList.remove("hidden");
        successEl.classList.add("hidden");
        errorEl.textContent = "";
    }
    function close() {
        modal.classList.add("hidden");
    }

    btn.addEventListener("click", open);
    document.getElementById("report-bug-close").addEventListener("click", close);
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorEl.textContent = "";
        const formData = new FormData(form);
        const mensaje = String(formData.get("mensaje") || "").trim();
        if (!mensaje) {
            errorEl.textContent = "Escribí algo antes de enviar.";
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando...";
        try {
            let capturaUrl = "";
            const archivo = formData.get("captura");
            if (archivo instanceof File && archivo.size) {
                const fileName = `${Date.now()}-${archivo.name}`.replace(/\s+/g, "_");
                const storageRef = ref(storage, `reportes/${fileName}`);
                const snapshot = await uploadBytes(storageRef, archivo);
                capturaUrl = await getDownloadURL(snapshot.ref);
            }

            await addDoc(collection(db, "reportes"), {
                mensaje,
                capturaUrl,
                pagina: location.pathname,
                email: auth.currentUser?.email || "",
                userAgent: navigator.userAgent,
                estado: "nuevo",
                createdAt: serverTimestamp()
            });

            form.reset();
            form.classList.add("hidden");
            successEl.classList.remove("hidden");
            setTimeout(close, 2000);
        } catch (error) {
            console.error(error);
            errorEl.textContent = "No se pudo enviar. Intentá de nuevo.";
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Enviar";
        }
    });
}

function init() {
    injectStyles();
    const refs = injectWidget();
    attachHandlers(refs);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
