# Alta masiva de cuentas de creadores

Crea decenas de cuentas de Firebase Auth (con la misma contraseña) más su perfil en Firestore
(`users/{uid}`, rol `creador`, `active: true`) de una sola vez, sin tocar la consola de Firebase
una por una.

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
   pon una cuenta por línea: `email,Nombre para mostrar` (el nombre es opcional).

4. **Corre el script** indicando la contraseña que tendrán todas las cuentas:

   PowerShell:
   ```
   $env:BULK_PASSWORD = "la-contraseña-que-quieras"
   node bulk-create-users.js
   ```

   Bash:
   ```
   BULK_PASSWORD="la-contraseña-que-quieras" node bulk-create-users.js
   ```

5. Revisa `resultado.json` al terminar: indica qué cuentas se crearon, cuáles ya existían
   y si alguna falló (por ejemplo, por un email mal escrito).

## Notas

- Es seguro volver a correrlo: si una cuenta de Auth ya existe no la duplica, y si ya tiene
  perfil en `users/{uid}` no lo pisa (para no perder cambios de rol que hayas hecho a mano).
- Todas las cuentas quedan con rol `creador`. Si necesitas otro rol, cámbialo después desde
  el panel Admin → Usuarios, o edita la constante `ROLE` en `bulk-create-users.js`.
- Este script y sus archivos (`serviceAccountKey.json`, `cuentas.csv`, `resultado.json`) no se
  suben al hosting de Firebase.
