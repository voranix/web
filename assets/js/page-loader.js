// Oculta el overlay de carga (#page-loader) una vez que la página terminó de
// cargar sus recursos, con un mínimo de tiempo visible para que no sea un
// parpadeo en conexiones rápidas.
(function () {
    var MIN_VISIBLE_MS = 350;
    // Seguro: el loader es position:fixed + z-index altísimo tapando TODA la
    // pantalla (incluido el botón de login de los portales). "load" solo
    // dispara cuando terminan TODOS los recursos de la página — un solo CDN
    // externo lento o bloqueado (Font Awesome, Google Fonts, un bloqueador de
    // anuncios cortando gstatic.com, una red corporativa restrictiva) puede
    // retrasarlo mucho o no dispararlo nunca, dejando a la persona viendo
    // solo el spinner para siempre sin poder tocar nada de abajo. Por eso el
    // loader se saca solo a los MAX_WAIT_MS pase lo que pase.
    var MAX_WAIT_MS = 4000;
    var shownAt = Date.now();
    var hidden = false;

    function hide() {
        if (hidden) return;
        hidden = true;
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
    setTimeout(hide, MAX_WAIT_MS);
})();
