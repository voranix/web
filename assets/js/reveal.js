// Reveal-on-scroll: agrega .is-visible a .reveal/.reveal-stagger cuando entran
// en viewport, y anima los contadores [data-count-to] una sola vez.
(function () {
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var revealTargets = document.querySelectorAll(".reveal, .reveal-stagger");
    var counters = document.querySelectorAll("[data-count-to]");

    function showAll() {
        revealTargets.forEach(function (el) { el.classList.add("is-visible"); });
        counters.forEach(runCounter);
    }

    function runCounter(el) {
        var to = parseFloat(el.getAttribute("data-count-to"));
        if (isNaN(to)) return;
        var prefix = el.getAttribute("data-prefix") || "";
        var suffix = el.getAttribute("data-suffix") || "";
        if (reduceMotion) { el.textContent = prefix + to + suffix; return; }
        var duration = 1200;
        var start = null;
        function step(ts) {
            if (start === null) start = ts;
            var progress = Math.min((ts - start) / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = prefix + Math.round(eased * to) + suffix;
            if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    if (reduceMotion || !("IntersectionObserver" in window)) {
        showAll();
        return;
    }

    var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-visible");
            if (entry.target.hasAttribute("data-count-to")) runCounter(entry.target);
            io.unobserve(entry.target);
        });
    }, { threshold: 0.15, rootMargin: "0px 0px -60px 0px" });

    revealTargets.forEach(function (el) { io.observe(el); });
    counters.forEach(function (el) { io.observe(el); });
})();
