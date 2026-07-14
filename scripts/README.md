# Alta masiva de cuentas de creadores

Dos scripts, según cómo hayas creado las cuentas:

- **`bulk-create-users.js`**: crea las cuentas en Firebase Auth (todas con la misma
  contraseña) Y su perfil en Firestore, de una sola vez.
- **`import-users.js`**: si ya creaste las cuentas a mano en Authentication (Firebase
  Console), este solo las busca por email y les crea el perfil en Firestore
  (`users/{uid}`, rol `creador`, `active: true`). No crea cuentas ni toca contraseñas.

Ambos comparten el mismo archivo de entrada `cuentas.csv` y la misma clave de servicio.

## Pasos

1. **Descarga la clave de servicio** (una sola vez):
   Firebase Console → ⚙️ Configuración del proyecto → Cuentas de servicio → "Generar nueva clave privada".
   Guarda el archivo descargado como `scripts/serviceAccountKey.json`.
   ⚠️ Este archivo da acceso total al proyecto. Nunca lo subas a git (ya está en `.gitignore`).

2. **Instala las dependencias** (una sola vez):
   ```
   cd scripts
   npm install
   ```

3. **Arma la lista de cuentas**: copia `cuentas.example.csv` como `cuentas.csv` y
   pon una cuenta por línea.

### Opción A: crear las cuentas desde el script (`bulk-create-users.js`)

Formato de línea: `email,Nombre para mostrar` (el nombre es opcional).

Corre el script indicando la contraseña que tendrán todas las cuentas:

PowerShell:
```
$env:BULK_PASSWORD = "la-contraseña-que-quieras"
node bulk-create-users.js
```

Bash:
```
BULK_PASSWORD="la-contraseña-que-quieras" node bulk-create-users.js
```

Revisa `resultado.json` al terminar: indica qué cuentas se crearon, cuáles ya existían
y si alguna falló (por ejemplo, por un email mal escrito).

### Opción B: ya creaste las cuentas a mano en Authentication (`import-users.js`)

Formato de línea: `email,Nombre para mostrar,rol` (nombre y rol son opcionales, rol
por defecto `creador`).

```
node import-users.js
```

(no necesita `BULK_PASSWORD`, porque no crea contraseñas). Revisa `resultado-import.json`:
indica qué cuentas se encontraron en Auth y engancharon a Firestore, y cuáles no existían
todavía (créalas primero en la consola y vuelve a correr el script).

## Notas

- Es seguro volver a correr cualquiera de los dos: si una cuenta de Auth ya existe no la
  duplica, y si ya tiene perfil en `users/{uid}` no lo pisa (para no perder cambios de rol
  que hayas hecho a mano).
- Todas las cuentas quedan con rol `creador` salvo que indiques otro en el CSV. Para
  cambiarlo después, usa el panel Admin → Usuarios.
- Estos scripts y sus archivos (`serviceAccountKey.json`, `cuentas.csv`, `resultado*.json`)
  no se suben al hosting de Firebase.
