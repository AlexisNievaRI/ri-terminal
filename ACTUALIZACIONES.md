# Actualizaciones automaticas de RI Terminal

Primera vez (una sola vez):
1. `.\setup-updater.ps1`  -> genera la clave de firma y configura la clave publica y tu repo.
2. Crear los secretos en GitHub (el script te indica cuales y copia la clave privada al portapapeles).
3. Subir el proyecto al repo (git init, add, commit, remote add origin, push).
4. `.\release.ps1 0.2.0`  -> GitHub compila y publica el instalador en Releases. Instalalo a mano.

Cada version nueva:
- Hacer los cambios, commit y `.\release.ps1 0.2.1` (sube el numero siempre).
- En la app: Ajustes > Actualizaciones > Buscar actualizaciones.

Compilar localmente (sin firmar): `.\build.ps1`
