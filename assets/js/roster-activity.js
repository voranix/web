import { escapeHtml } from "/assets/js/firebase-config.js";

const TIPO_ICONOS = {
    torneo: "fa-trophy",
    scrim: "fa-bolt",
    entrenamiento: "fa-dumbbell"
};

const TIPO_LABELS = {
    torneo: "Torneo",
    scrim: "Scrim",
    entrenamiento: "Entrenamiento"
};

function formatFecha(value) {
    if (!value) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return value;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}

function formatRango(item) {
    const inicio = formatFecha(item.fechaInicio);
    const fin = formatFecha(item.fechaFin);
    let rango = inicio;
    if (fin && fin !== inicio) rango = inicio ? `${inicio} – ${fin}` : fin;
    if (item.hora) rango = rango ? `${rango} · ${item.hora}` : item.hora;
    return rango;
}

function renderItem(item) {
    const tipo = item.tipo || "torneo";
    const icono = TIPO_ICONOS[tipo] || "fa-calendar";
    const rango = formatRango(item);
    return `
<div class="actividad-item">
    <div class="actividad-icon"><i class="fas ${icono}"></i></div>
    <div class="actividad-body">
        <span class="actividad-tipo">${escapeHtml(TIPO_LABELS[tipo] || tipo)}</span>
        <h4>${escapeHtml(item.titulo) || "Sin título"}</h4>
        ${rango ? `<p class="actividad-fecha">${escapeHtml(rango)}</p>` : ""}
        ${item.resultado ? `<p class="actividad-resultado">${escapeHtml(item.resultado)}</p>` : ""}
        ${item.descripcion ? `<p class="actividad-desc">${escapeHtml(item.descripcion)}</p>` : ""}
    </div>
</div>`;
}

export function renderActividadList(items) {
    if (!items || !items.length) {
        return `<p class="actividad-empty">Todavía no hay actividad publicada.</p>`;
    }
    const sorted = [...items].sort((a, b) => String(b.fechaInicio || "").localeCompare(String(a.fechaInicio || "")));
    return `<div class="actividad-timeline">${sorted.map(renderItem).join("")}</div>`;
}
