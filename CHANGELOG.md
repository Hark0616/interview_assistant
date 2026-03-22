# Changelog

## 1.3.4

- Repo Git propio en la carpeta del proyecto; `.gitignore` ampliado (`.env`, logs).

## 1.3.3

- Política de versiones documentada; regla Cursor `.cursor/rules/versioning.mdc` (PATCH en cada cambio, MINOR si es muy significativo).

## 1.3.2

- Cofre local de API keys (`vault-server.mjs` + sección en popup), permisos localhost en manifest.

## 1.3.0

- Refactor modular: `utils.js`, `shared.css`, `panel.css`, `panelManager.js`.
- Ventana pop-out para modo sigiloso al compartir pantalla.
- Atajo de teclado **configurable**: Chrome → Extensiones → **Atajos de teclado** → «Ocultar o mostrar el asistente…» (por defecto Ctrl+Shift+H / Cmd+Shift+H en Mac).
- Versión mostrada en el pie del popup de configuración.

## 1.2.0 y anteriores

- Soporte multi-proveedor (Gemini, Groq, OpenRouter), overlay en Meet, registro de sesión y exportación.
