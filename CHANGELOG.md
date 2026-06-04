# Changelog

## 1.4.4

- Robustez de respuesta ante subtítulos ruidosos: el prompt ahora obliga a inferir intención y responder directo, evitando pedir aclaraciones o mencionar problemas de transcripción.
- Filtro de mensajes de sistema en captura (`captionCapture.js`): se descartan eventos como “Close caption has started” para que no contaminen el contexto enviado a la IA.

## 1.4.3

- Contexto de empresa optimizado: se agrega condensación de `company` al activar (similar al CV) y re-condensación automática al cambiar configuración.
- Nota puntual one-shot: la nota para IA se envía en la siguiente petición exitosa y luego se limpia automáticamente en overlay/panel.
- Auditoría visible de prompts: se añaden logs de depuración en `background.js` para inspeccionar el payload enviado por petición (proveedor, modelo, tamaños y preview truncado del body).

## 1.4.2

- **Teams (sala de espera / v2)**: el overlay ya no exige barra de llamada o subtítulos; si la URL es de Teams v2, reunión, etc., se crea el panel de inmediato. Fallback a 10s en cualquier host de Teams.

## 1.4.1

- Fix para Microsoft Teams en `teams.cloud.microsoft`: se añaden `matches` y `host_permissions` para ese dominio y sus subdominios.
- `captionCapture` ahora reconoce también `teams.cloud.microsoft` como host de Teams y activa la ruta de captura correcta.

## 1.4.0

- Soporte **Microsoft Teams** en el navegador (`teams.microsoft.com`, `teams.live.com`, subdominios `*.teams.microsoft.com`): captura de subtítulos en directo vía DOM Fluent UI (`data-tid` / `.fui-ChatMessageCompact`), con fallback genérico si cambia la UI.
- **Google Meet** sin cambios de flujo; mismos content scripts en ambas plataformas.
- `sessionLog`: identificador de reunión y exportación (`ia-session-…`) agnósticos de plataforma; POC de chat de Meet solo en `meet.google.com`.
- Textos de UI y atajo de teclado referidos a «reunión» en lugar de solo Meet.

## 1.3.5

- Módulo experimental `meetChatSelfLogPoc.js`: prueba de registro de mensajes enviados por ti al chat de Meet (storage + descarga .txt al pulsar Enter).

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
