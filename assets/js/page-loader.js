// Oculta el overlay de carga (#page-loader) una vez que la página terminó de
// cargar sus recursos, con un mínimo de tiempo visible para que no sea un
// parpadeo en conexiones rápidas.
(function () {
    var MIN_VISIBLE_MS = 350;
    var shownAt = Date.now();

    function hide() {
        var el = document.getElementById("page-loader");
        if (!el) return;
        var wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
        setTimeout(function () {
            el.classList.add("hidden");
            setTimeout(function () { el.remove(); }, 500);
        }, wait);
    }

    if (document.readyState === "complete") hide();
    else window.addEventListener("load", hide);
})();
