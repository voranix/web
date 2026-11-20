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
    { nombre: "Proximamente 2", juego: "valorant", rol: "Por confirmar", rango: "",      rankImg: "",                               foto: "imagenes/logo.jpg",             activo: true },
    { nombre: "BobMarley_003",  juego: "fifa",     rol: "EA FC PRO PLAYER", rango: "Elite Division",  rankImg: "",                               foto: "imagenes/fifa/bobmarley_033.jpg", activo: true },
    { nombre: "Br0ly_NY",       juego: "fifa",     rol: "EA FC PRO PLAYER", rango: "Division 1",      rankImg: "",                               foto: "imagenes/fifa/broly_ny.jpg",      activo: true },
    { nombre: "Chris_barber96", juego: "fifa",     rol: "EA FC PRO PLAYER", rango: "Division 2",      rankImg: "",                               foto: "imagenes/fifa/chris_barber.jpg",   activo: true }
];

export const sponsorsSeed = [
    { nombre: "Ottoke",      tipo: "patrocinador", descripcion: "Patrocinador oficial de VORANIX.",           logo: "imagenes/marcas/Logo Ottoke.png",      web: "", activo: true },
    { nombre: "Mai Pizza",   tipo: "patrocinador", descripcion: "Patrocinador oficial de VORANIX.",           logo: "imagenes/marcas/Logo Mai.Pizza_.png",   web: "", activo: true },
    { nombre: "Kenkofoods",  tipo: "patrocinador", descripcion: "Colaborador de la comunidad VORANIX.",      logo: "imagenes/logo.jpg",                    web: "", activo: true },
    { nombre: "Doraking",    tipo: "patrocinador", descripcion: "Colaborador de la comunidad VORANIX.",      logo: "imagenes/logo.jpg",                    web: "", activo: true },
    { nombre: "Trulu Store", tipo: "patrocinador", descripcion: "Colaborador de la comunidad VORANIX.",      logo: "imagenes/marcas/Logo Trulustore.png",   web: "", activo: true }
];


// Participantes confirmados de Erineo (cargados desde el Excel de postulantes).
// Se importan con admin/migrar.html, igual que streamers/rosters/patrocinadores.
export const erineoParticipantesSeed = [
    {"nombre": "VS_AniiSeong", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/aniiseong", "activo": true},
    {"nombre": "DonBenjamilo", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/donbenjamilo", "activo": true},
    {"nombre": "Charlesg0_", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://twitch.tv/Charlesg0_", "activo": true},
    {"nombre": "Vicho1500", "descripcion": "Streamer de Kick", "foto": "", "canalUrl": "https://kick.com/vicho1500", "activo": true},
    {"nombre": "Yessiii_gamer", "descripcion": "Streamer de Kick", "foto": "", "canalUrl": "https://kick.com/yessi_gamer", "activo": true},
    {"nombre": "ALBAXZS", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/albazxs", "activo": true},
    {"nombre": "LvkasKL", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://twitch.tv/lvkaskl", "activo": true},
    {"nombre": "Goship", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/goshiip", "activo": true},
    {"nombre": "PixiPNJ", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/pixipnj", "activo": true},
    {"nombre": "AratakiGamer", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/aratakigamer", "activo": true},
    {"nombre": "Touya_bgmx21", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/touyagmx21", "activo": true},
    {"nombre": "RyuWP", "descripcion": "Streamer de Kick", "foto": "", "canalUrl": "https://kick.com/ryu-natsukire", "activo": true},
    {"nombre": "zaltok", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/zaltok", "activo": true},
    {"nombre": "Pansito_v", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/pansito_v", "activo": true},
    {"nombre": "Kevobo", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/kevobo", "activo": true},
    {"nombre": "Cylantrox", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/cylantrox", "activo": true},
    {"nombre": "StevannKL", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/stevanql", "activo": true},
    {"nombre": "Sebaitax", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/sebaitax", "activo": true},
    {"nombre": "Tio_frostty", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/tio_frostty", "activo": true},
    {"nombre": "CATAM12F", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/just_cataa", "activo": true},
    {"nombre": "nerupop", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://twitch.tv/nerupop", "activo": true},
    {"nombre": "McCookis", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/mccookis", "activo": true},
    {"nombre": "Niicoplease", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/niicoplease", "activo": true},
    {"nombre": "himiyuu", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/himiyuu", "activo": true},
    {"nombre": "iGato0", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/igato0_", "activo": true},
    {"nombre": "Dreewe", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://twitch.tv/dreewe", "activo": true},
    {"nombre": "ElKrys", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/elkrysoficial", "activo": true},
    {"nombre": "ChrisFbk", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/chrisfvck", "activo": true},
    {"nombre": "zyozep", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/zyosep", "activo": true},
    {"nombre": "Andliuuu", "descripcion": "Streamer de Kick", "foto": "", "canalUrl": "https://kick.com/andliuu", "activo": true},
    {"nombre": "NanukZz", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/nanukasd", "activo": true},
    {"nombre": "KatoResenias", "descripcion": "Creador de YouTube", "foto": "", "canalUrl": "https://www.youtube.com/@KatoReseñas", "activo": true},
    {"nombre": "Zarmiel", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/zarmiel_", "activo": true},
    {"nombre": "Reksa_l", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://www.twitch.tv/reksa__l", "activo": true},
    {"nombre": "Xbaar", "descripcion": "Streamer de Twitch", "foto": "", "canalUrl": "https://twitch.tv/xbaar", "activo": true},
];
