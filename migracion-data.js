export function makeDocId(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export const streamersSeed = [
    { nombre: "Aniiseong",        twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/aniiseong.jpg",      activo: true },
    { nombre: "Doble N",          twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/soydoblen.jpg",       activo: true },
    { nombre: "Cameloth",         twitch: "", instagram: "", juegos: "Valorant",           horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/cameloth.jpg",        activo: true },
    { nombre: "Charles",          twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/charlesgo.jpg",       activo: true },
    { nombre: "Goshi",            twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/goshiip.jpg",         activo: true },
    { nombre: "Ste_Ale_",         twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/logo.jpg",                     activo: true },
    { nombre: "Valesuki",         twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/valesuki.jpg",        activo: true },
    { nombre: "Juacoxis",         twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/logo.jpg",                     activo: true },
    { nombre: "Kevinsinho",       twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/kevinsinho.jpg",      activo: true },
    { nombre: "Sr_Invisiblemudo", twitch: "", instagram: "", juegos: "Valorant / Variety", horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/srinvisiblemudo.jpg", activo: true },
    { nombre: "Solangelissett",   twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/logo.jpg",                     activo: true },
    { nombre: "Zmain18",          twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/logo.jpg",                     activo: true },
    { nombre: "Elniuxlml",        twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/elniux.jpg",          activo: true },
    { nombre: "Kachi_ndeah",      twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/logo.jpg",                     activo: true },
    { nombre: "Silenc3r23",       twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/silenc3r23.jpg",      activo: true },
    { nombre: "Anniegafe",        twitch: "", instagram: "", juegos: "Variety",            horario: "Consultar redes", pais: "Chile",  foto: "imagenes/streamers/anniegafe.jpg",       activo: true }
];

export const rostersSeed = [
    { nombre: "Cameloth",  juego: "valorant", rol: "Duelista",   rango: "Diamond 3",  rankImg: "imagenes/rangos/diamante.png",   foto: "imagenes/roster/cameloth.jpg", activo: true },
    { nombre: "Wolfsong",  juego: "valorant", rol: "Iniciador",  rango: "Platino",    rankImg: "imagenes/rangos/platino.png",    foto: "imagenes/roster/wolfsong.jpg", activo: true },
    { nombre: "Andriuu",   juego: "valorant", rol: "Duelista",   rango: "Ascendente",  rankImg: "imagenes/rangos/ascendente.png", foto: "imagenes/roster/andriuu.jpg",  activo: true },
    { nombre: "Xulinho",   juego: "valorant", rol: "Flex",       rango: "Platino",    rankImg: "imagenes/rangos/platino.png",    foto: "imagenes/roster/xulinho.jpg",   activo: true },
    { nombre: "Keke ssj",  juego: "valorant", rol: "Controlador", rango: "Diamante",   rankImg: "imagenes/rangos/diamante.png",   foto: "imagenes/roster/keke.jpg",      activo: true },
    { nombre: "Saaku",     juego: "valorant", rol: "Centinela",   rango: "Diamante",   rankImg: "imagenes/rangos/diamante.png",   foto: "imagenes/roster/saaku.jpg",     activo: true },
    { nombre: "Proximamente 1", juego: "valorant", rol: "Por confirmar", rango: "",      rankImg: "",                               foto: "imagenes/logo.jpg",             activo: true },
    { nombre: "Proximamente 2", juego: "valorant", rol: "Por confirmar", rango: "",      rankImg: "",                               foto: "imagenes/logo.jpg",             activo: true }
];

export const sponsorsSeed = [
    { nombre: "Ottoke",      tipo: "patrocinador", descripcion: "Patrocinador oficial de VORANIX.",           logo: "imagenes/marcas/Logo Ottoke.png",      web: "", activo: true },
    { nombre: "Mai Pizza",   tipo: "patrocinador", descripcion: "Patrocinador oficial de VORANIX.",           logo: "imagenes/marcas/Logo Mai.Pizza_.png",   web: "", activo: true },
    { nombre: "Kenkofoods",  tipo: "patrocinador", descripcion: "Colaborador de la comunidad VORANIX.",      logo: "imagenes/logo.jpg",                    web: "", activo: true },
    { nombre: "Doraking",    tipo: "patrocinador", descripcion: "Colaborador de la comunidad VORANIX.",      logo: "imagenes/logo.jpg",                    web: "", activo: true },
    { nombre: "Trulu Store", tipo: "patrocinador", descripcion: "Colaborador de la comunidad VORANIX.",      logo: "imagenes/marcas/Logo Trulustore.png",   web: "", activo: true }
];
