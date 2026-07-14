document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("menu-toggle");
    const navbar = document.querySelector(".navbar");
    if (toggle && navbar) {
        toggle.addEventListener("click", () => navbar.classList.toggle("active"));
    }

    document.querySelectorAll(".nav-dropdown").forEach((dropdown) => {
        const button = dropdown.querySelector(".nav-dropdown-toggle");
        if (!button) return;
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            const isOpen = dropdown.classList.contains("open");
            document.querySelectorAll(".nav-dropdown.open").forEach((el) => el.classList.remove("open"));
            if (!isOpen) dropdown.classList.add("open");
        });
    });

    document.addEventListener("click", () => {
        document.querySelectorAll(".nav-dropdown.open").forEach((el) => el.classList.remove("open"));
    });
});
