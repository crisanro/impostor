# Guía de Despliegue en DokPloy

Este proyecto está listo para desplegarse usando Docker. Aquí tienes los pasos para subirlo a GitHub y conectarlo a DokPloy.

## 1. Subir código a GitHub

1.  Crea un **Nuevo Repositorio** (New Repository) en tu cuenta de GitHub (ej: `el-impostor-game`).
2.  Abre la terminal en la carpeta de este proyecto (`Impostor 1.0` o donde lo tengas).
3.  Ejecuta los siguientes comandos:

```bash
git init
git add .
git commit -m "Initial commit: El Impostor MVP completo"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/el-impostor-game.git
git push -u origin main
```
*(Reemplaza `TU_USUARIO` y la URL con la de tu repositorio real)*.

## 2. Configurar DokPloy

1.  Ingresa a tu panel de **DokPloy**.
2.  Ve a proyectos y crea uno nuevo (o usa uno existente).
3.  Selecciona **"Application"** -> **"Git"**.
4.  Conecta tu repositorio de GitHub y selecciona el repo `el-impostor-game`.
5.  **Configuración de Build:**
    *   **Build Type:** `Dockerfile` (Ya incluimos el archivo en el proyecto).
    *   **Dockerfile Path:** `./Dockerfile` (Default).
    *   **Context Path:** `./` (Default).
6.  **Environment Variables (CRÍTICO):**
    
    En DokPloy, dentro de tu aplicación, ve a la pestaña **"Environment"** y agrega las siguientes variables (copia los valores de tu consola de Firebase):

    *   `VITE_FIREBASE_API_KEY`: (Tu clave API)
    *   `VITE_FIREBASE_AUTH_DOMAIN`: (Tu auth domain)
    *   `VITE_FIREBASE_PROJECT_ID`: (Tu project ID)
    *   `VITE_FIREBASE_STORAGE_BUCKET`: (Tu bucket)
    *   `VITE_FIREBASE_MESSAGING_SENDER_ID`: (Tu sender ID)
    *   `VITE_FIREBASE_APP_ID`: (Tu app ID)
    *   `VITE_FIREBASE_MEASUREMENT_ID`: (Tu measurement ID)

    *Nota: DokPloy debe pasar estas variables al momento de construir la imagen (Build time). Si no funciona directo en "Environment", asegúrate de añadirlas como "Build Args" si la opción está disponible, o simplemente configúralas en la sección de Environment general y reconstruye.*

7.  **Deploy:** Haz clic en **"Deploy"**.

## 3. Verificar

DokPloy construirá la imagen de Docker (esto tomará unos minutos la primera vez):
1.  Instala dependencias.
2.  Construye la App de React (`npm run build`).
3.  Configura Nginx.

Cuando termine, DokPloy te dará una URL (o configura tu dominio personalizado en la pestaña "Domains").

¡Listo! Tu juego estará online y persistente a recargas.
