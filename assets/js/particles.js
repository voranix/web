// Fondo de partículas ambiente (canvas 2D, sin librerías). Pensado para
// vivir detrás del contenido de un contenedor con position:relative — el
// canvas se ancla absolute+inset:0 dentro de ese contenedor, así que solo
// se ve en los espacios donde el contenido de arriba no lo tapa (igual que
// cualquier fondo). Se apaga solo si el visitante tiene activado "reducir
// movimiento" en su sistema.
export function initParticles(target, options = {}) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;

    const container = typeof target === "string" ? document.querySelector(target) : target;
    if (!container) return null;

    const {
        count = 30,
        colors = ["#7b2cff", "#ff6a00"],
        minSize = 1.5,
        maxSize = 4,
        speed = 0.3,
        direction = "up",
        glow = true,
        opacityRange = [0.15, 0.5],
        flicker = false
    } = options;

    const canvas = document.createElement("canvas");
    canvas.className = "voranix-particles-canvas";
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
        position: "absolute", inset: "0", width: "100%", height: "100%",
        zIndex: "-1", pointerEvents: "none", display: "block"
    });
    // El canvas usa z-index:-1 para quedar detrás del resto del contenido
    // del contenedor. Eso solo funciona si el contenedor mismo arma su
    // propio "stacking context" — position:relative solo no alcanza (con
    // z-index:auto no lo arma), y sin eso el z-index:-1 se escapa hacia
    // arriba en el árbol y termina detrás de TODO el contenedor (incluido
    // su propio fondo opaco), no solo detrás de sus hijos.
    const computed = getComputedStyle(container);
    if (computed.position === "static") container.style.position = "relative";
    if (computed.zIndex === "auto") container.style.zIndex = "0";
    container.insertBefore(canvas, container.firstChild);

    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, particles = [], raf = null, ro = null;

    function rand(min, max) { return min + Math.random() * (max - min); }

    function spawn() {
        return {
            x: rand(0, width), y: rand(0, height),
            size: rand(minSize, maxSize),
            speedY: rand(speed * 0.6, speed * 1.4) * (direction === "up" ? -1 : 1),
            speedX: rand(-0.15, 0.15),
            color: colors[Math.floor(Math.random() * colors.length)],
            opacity: rand(opacityRange[0], opacityRange[1]),
            flickerPhase: Math.random() * Math.PI * 2
        };
    }

    function resize() {
        width = canvas.width = container.clientWidth;
        height = canvas.height = container.clientHeight;
    }

    function init() {
        resize();
        particles = Array.from({ length: count }, spawn);
    }

    function step(t) {
        ctx.clearRect(0, 0, width, height);
        particles.forEach(p => {
            p.y += p.speedY;
            p.x += p.speedX;
            if (p.y < -10) { p.y = height + 10; p.x = rand(0, width); }
            if (p.y > height + 10) { p.y = -10; p.x = rand(0, width); }
            if (p.x < -10) p.x = width + 10;
            if (p.x > width + 10) p.x = -10;

            let alpha = p.opacity;
            if (flicker) alpha *= 0.6 + 0.4 * Math.sin(t / 300 + p.flickerPhase);

            ctx.beginPath();
            ctx.globalAlpha = Math.max(0, alpha);
            ctx.fillStyle = p.color;
            ctx.shadowBlur = glow ? p.size * 4 : 0;
            ctx.shadowColor = p.color;
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
        raf = requestAnimationFrame(step);
    }

    init();
    raf = requestAnimationFrame(step);

    if (window.ResizeObserver) {
        ro = new ResizeObserver(() => resize());
        ro.observe(container);
    } else {
        window.addEventListener("resize", resize);
    }

    return {
        destroy() {
            if (raf) cancelAnimationFrame(raf);
            if (ro) ro.disconnect(); else window.removeEventListener("resize", resize);
            canvas.remove();
        }
    };
}
