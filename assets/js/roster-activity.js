import { escapeHtml } from "/assets/js/firebase-config.js";

const TIPO_ICONOS = {
    torneo: "fa-trophy",
    scrim: "fa-bolt",
    entrenamiento: "fa-dumbbell",
    reunion: "fa-people-arrows",
    premier: "fa-medal",
    liga: "fa-shield-halved"
};

export const TIPO_LABELS = {
    torneo: "Torneo",
    scrim: "Scrim",
    entrenamiento: "Práctica",
    reunion: "Reunión",
    premier: "Premier Playoff",
    liga: "Liga"
};

function formatFecha(value) {
    if (!value) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return value;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatRango(item) {
    const inicio = formatFecha(item.fechaInicio);
    const fin = formatFecha(item.fechaFin);
    let rango = inicio;
    if (fin && fin !== inicio) rango = inicio ? `${inicio} – ${fin}` : fin;
    if (item.hora) rango = rango ? `${rango} · ${item.hora}` : item.hora;
    return rango;
}

// Fecha/hora de referencia del evento (fechaFin si existe, si no fechaInicio)
// usada para decidir si va en "Próximos" o "Anteriores".
function parseEventDate(item) {
    const dateStr = item.fechaFin || item.fechaInicio;
    if (!dateStr) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
    if (!match) return null;
    let hours = 23, minutes = 59;
    if (item.hora) {
        const horaMatch = /^(\d{2}):(\d{2})/.exec(item.hora);
        if (horaMatch) { hours = Number(horaMatch[1]); minutes = Number(horaMatch[2]); }
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hours, minutes);
}

function isUpcoming(item) {
    const date = parseEventDate(item);
    if (!date) return true;
    return date.getTime() >= Date.now();
}

// El más próximo entre los que todavía no pasaron (usado por el resumen
// del Portal Roster). Devuelve null si no hay ninguno.
export function getProximoEvento(items) {
    const proximos = (items || []).filter(isUpcoming);
    if (!proximos.length) return null;
    proximos.sort((a, b) => (parseEventDate(a)?.getTime() || 0) - (parseEventDate(b)?.getTime() || 0));
    return proximos[0];
}

function renderLineup(lineup) {
    if (!Array.isArray(lineup) || !lineup.length) return "";
    const rows = lineup.filter(row => row && (row.jugador || row.agente));
    if (!rows.length) return "";
    // El MVP va primero para que resalte de inmediato en la línea del equipo.
    const sorted = [...rows].sort((a, b) => (b.mvp ? 1 : 0) - (a.mvp ? 1 : 0));
    return `
    <div class="actividad-lineup">
        <p class="actividad-lineup-title"><i class="fas fa-users"></i> Line-up</p>
        <ul class="actividad-lineup-list">
            ${sorted.map(row => `
            <li class="${row.mvp ? "is-mvp" : ""}">
                ${row.mvp ? `<i class="fas fa-crown" title="MVP"></i>` : ""}
                <span class="lineup-player">${escapeHtml(row.jugador || "?")}</span>
                ${row.agente ? `<span class="lineup-agent">${escapeHtml(row.agente)}</span>` : ""}
            </li>`).join("")}
        </ul>
    </div>`;
}

function renderItem(item, isPast) {
    const tipo = item.tipo || "torneo";
    const icono = TIPO_ICONOS[tipo] || "fa-calendar";
    const rango = formatRango(item);
    return `
<div class="actividad-item${isPast ? " is-past" : ""}">
    <div class="actividad-item-top">
        <div class="actividad-icon"><i class="fas ${icono}"></i></div>
        <div class="actividad-body">
            <div class="actividad-heading">
                <span class="actividad-tipo">${escapeHtml(TIPO_LABELS[tipo] || tipo)}</span>
                ${rango ? `<span class="actividad-fecha">${escapeHtml(rango)}</span>` : ""}
            </div>
            <h4>${escapeHtml(item.titulo) || "Sin título"}</h4>
            ${item.resultado ? `<p class="actividad-resultado">${escapeHtml(item.resultado)}</p>` : ""}
            ${item.descripcion ? `<p class="actividad-desc">${escapeHtml(item.descripcion)}</p>` : ""}
        </div>
    </div>
    ${renderLineup(item.lineup)}
</div>`;
}

export function renderActividadList(items) {
    if (!items || !items.length) {
        return `<p class="actividad-empty">Todavía no hay actividad publicada.</p>`;
    }

    const proximos = [];
    const anteriores = [];
    items.forEach(item => (isUpcoming(item) ? proximos : anteriores).push(item));

    proximos.sort((a, b) => String(a.fechaInicio || "").localeCompare(String(b.fechaInicio || "")));
    anteriores.sort((a, b) => String(b.fechaInicio || "").localeCompare(String(a.fechaInicio || "")));

    const groups = [];
    if (proximos.length) {
        groups.push(`
<div class="actividad-group">
    <h3 class="actividad-group-title"><i class="fas fa-calendar-day"></i> Próximos</h3>
    <div class="actividad-timeline">${proximos.map(item => renderItem(item, false)).join("")}</div>
</div>`);
    }
    if (anteriores.length) {
        groups.push(`
<div class="actividad-group">
    <h3 class="actividad-group-title"><i class="fas fa-calendar-check"></i> Anteriores</h3>
    <div class="actividad-timeline">${anteriores.map(item => renderItem(item, true)).join("")}</div>
</div>`);
    }
    return groups.join("");
}
