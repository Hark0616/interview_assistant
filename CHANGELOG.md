# Changelog

## 1.7.1

- La memoria puede cambiarse durante la entrevista entre desactivada, solo lectura y automática desde overlay, panel o popup.
- Al pausar se omiten localmente los captions de ese tramo, evitando una actualización acumulada y costosa al volver a activar el ledger.

## 1.7.0

- La memoria semántica se separa del log en un ledger por `meetingSessionId`, con migración automática de la memoria textual de 1.6.0.
- Un proceso cancelable de baja prioridad extrae operaciones JSON únicamente de captions con rol y procedencia; las sugerencias de IA nunca se usan como hechos.
- El modelo de memoria puede configurarse en el popup y reutiliza el proveedor/API key principal; si queda vacío usa el modelo principal.
- El contexto prioriza bullets confirmados, fijados y relevantes dentro de un presupuesto estable, seguido de ventana literal y fragmentos de transcripción.
- Overlay y panel incluyen una vista plegable para editar, fijar, retirar y exportar la memoria en JSON o Markdown.
- El uso del actualizador se registra como `memory-ledger`; una petición principal aborta la actualización sin avanzar el cursor de captions.

## 1.6.0

- OpenRouter registra por sesión requests, tokens de entrada/salida, razonamiento, caché y costo real; el resumen aparece en overlay, panel y exportación.
- Las llamadas usan `max_completion_tokens`, `session_id`, routing configurable por latencia/precio y prompt caching de una hora para modelos Claude.
- El streaming detecta errores SSE aunque HTTP ya haya respondido 200, conserva texto parcial y usa timeouts separados para primer token, inactividad y duración total.
- Los reintentos respetan `Retry-After`; el botón «Probar» valida OpenRouter con `GET /api/v1/key` sin generar tokens.
- El catálogo OpenRouter muestra contexto y precios, persiste metadata y evita enviar prompts que excedan la ventana del modelo.
- La memoria reemplaza el digest crudo creciente por resumen estructurado, ventana literal reciente y recuperación local de fragmentos relevantes; la transcripción completa sigue persistiendo localmente.
- Las sesiones pueden restaurarse durante seis horas y ya no se borran al reactivar el asistente.
- El modo automático espera más cuando una pregunta parece incompleta y usa huellas normalizadas para reducir llamadas duplicadas.

## 1.5.1

- Cola de contexto para no perder preguntas que llegan durante una respuesta, con cancelación al detener y timeout de 30 segundos para el streaming.
- La captura de subtítulos comienza inmediatamente al activar, continúa al cambiar de pestaña y la configuración guardada se refresca también en Teams.
- Se retiró de la carga de producción la POC que descargaba automáticamente los mensajes propios del chat de Meet.

## 1.5.0

- **Streaming de Sugerencias**: Se implementó una conexión persistente por puerto (`chrome.runtime.Port`) para transmitir la sugerencia en tiempo real token por token, reduciendo la latencia percibida a menos de 0.5 segundos.
- **Búfer de Contexto Ampliado (Smart Context)**: Se incrementó el límite de caracteres del digest de la reunión a 45,000 caracteres en las constantes para evitar que la IA pierda contexto de la llamada y se ampliaron los límites de condensación de CV y empresa para preservar detalles y skills específicos.
- **Prompts del Sistema Adaptativos**: Se agregaron reglas dinámicas de comportamiento en el system prompt para que la IA responda estructurando con el método STAR (para preguntas conductuales), viñetas concisas (preguntas de arquitectura/técnicas) o respuestas cortas y naturales.
- **Compatibilidad de Linter y Test**: Se corrigió ESLint flat config para resolver variables de node/browser en carpetas de tests y scripts, y se mockeó la API del puerto de Chrome en Vitest.

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
