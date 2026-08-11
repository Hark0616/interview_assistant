# Interview Assistant AI — Extensión de Chrome

Asistente de entrevistas en tiempo real para **Google Meet** y **Microsoft Teams** (en el navegador).
Lee los subtítulos en directo, identifica quién habla, y genera sugerencias de respuesta con IA.

Soporta **Gemini**, **Groq** y el catálogo completo de **OpenRouter**.

---

## Instalación rápida

### 1. Obtener API Key (elige uno)

| Proveedor | Costo | Cómo obtener |
|-----------|-------|--------------|
| **Google Gemini** (recomendado) | Gratis, 1500 req/día | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → Get API Key |
| **Groq** | Gratis, 30 req/min | [console.groq.com](https://console.groq.com) → API Keys → Create |
| **OpenRouter** | Modelos gratuitos y de pago | [openrouter.ai/keys](https://openrouter.ai/keys) → Create Key |

### 2. Instalar en Chrome
1. Abre `chrome://extensions/`
2. Activa **Modo desarrollador** (toggle arriba a la derecha)
3. Clic en **"Cargar descomprimida"**
4. Selecciona la carpeta `interview-assistant`

### 3. Configurar
1. Clic en el ícono de la extensión en la barra de Chrome
2. **API**: selecciona proveedor, pega tu API key, elige modelo
3. **Perfil**: pega tu CV resumido o puntos relevantes
4. **Puesto**: descripción del trabajo y empresa
5. **Guardar configuración**

Con OpenRouter también puedes elegir el routing: **Más rápido** para entrevistas, **Balanceado** o **Más barato**. El modo de razonamiento queda desactivado por defecto para reducir latencia y puede activarse en nivel bajo o medio.

---

## Cómo usar durante la entrevista

1. Abre la reunión en **Meet** o **Teams** en el navegador (Chrome/Edge)
2. **Activa los subtítulos en directo** (CC en Meet; en Teams: Más opciones → Activar subtítulos en directo, según tu cliente)
3. Verás el overlay flotante en la esquina inferior derecha
4. Clic en **Activar** en el overlay
5. La IA generará sugerencias automáticamente cuando el entrevistador hable

### Controles del overlay
- **Auto / Manual** — elige si las sugerencias se generan automáticamente o bajo demanda
- **Enviar ahora** (modo manual) — envía el contexto actual a la IA
- **Pausa** (modo auto) — ajusta el tiempo de espera tras el último subtítulo antes de generar
- **Copiar** — copia la sugerencia al portapapeles
- **Regenerar** — pide una nueva sugerencia con el mismo contexto
- **Minimizar / Cerrar** — controla la visibilidad del panel
- **↗** — abre el asistente en **ventana aparte** (útil al compartir pantalla: si compartes solo la pestaña de Meet, la ventana del asistente no se ve)
- El overlay es **arrastrable**

### Atajos de teclado (pro)
1. Abre `chrome://extensions/shortcuts` (o **Extensiones** → menú ⋮ → **Atajos de teclado**).
2. Busca **Interview Assistant AI** y el comando *Ocultar o mostrar el asistente en la pestaña de Meet activa*.
3. Asigna la combinación que prefieras (por defecto: **Ctrl+Shift+H** en Windows/Linux, **Cmd+Shift+H** en Mac).

El atajo actúa sobre la **pestaña activa**; si no es Meet, no hará nada. Dentro de Meet también funciona **Ctrl+Shift+H** mientras el foco está en la página.

### Privacidad y datos sensibles
- Las **API keys** y el perfil se guardan en **chrome.storage.local** (solo en tu navegador); no pasan por un servidor propio de la extensión.
- Las llamadas a la IA van **directamente** a Google / Groq / OpenRouter según el proveedor que elijas.
- Para entrevistas con datos muy sensibles: usa la **ventana pop-out** + comparte solo la pestaña de Meet, y revisa las políticas del proveedor de IA que uses.

### Cofre local de API keys (tu PC, sin abrir el router)
Si quieres una copia de las claves en un **archivo en tu disco** (o varios PCs vía sincronización de carpeta tipo Dropbox *solo del archivo*), puedes usar el servidor incluido:

1. Elige un **token largo y secreto** (como una contraseña fuerte). En PowerShell:
   ```powershell
   $env:IA_VAULT_TOKEN = "pon-aqui-un-secreto-largo"
   npm run vault
   ```
   O con Node directo: `node scripts/vault-server.mjs` (tras exportar `IA_VAULT_TOKEN` en Linux/macOS).

2. El proceso escucha solo en **`127.0.0.1:3847`**: es decir, **solo desde tu misma máquina**. No reenvíes este puerto en el router; no hace falta y **aumentaría el riesgo** (bots, fuerza bruta al token).

3. En el popup de la extensión, pestaña **API**, sección **Cofre de claves**: URL `http://127.0.0.1:3847`, el mismo token, **Traer claves** / **Enviar claves**.

4. Los datos se guardan en **`%USERPROFILE%\.interview-assistant-vault.json`** (cámbialo con `IA_VAULT_FILE` si quieres).

**Nube propia:** el mismo contrato HTTP (`GET`/`PUT` `/v1/api-keys` + `Authorization: Bearer …`) lo puedes implementar en un Worker/VPS con **HTTPS** y fuerte autenticación. Tendrías que añadir el origen `https://tu-dominio/*` en `host_permissions` del `manifest.json` (extensión sin publicar = a tu cargo).

### Cómo funciona la IA
- Todo lo que digan **los entrevistadores** se marca como contexto para generar respuestas
- Lo que **tú dices** se registra para que la IA tenga contexto completo, pero NO genera sugerencia cuando hablas tú
- Las sugerencias son en **primera persona** para que puedas usarlas directamente
- La transcripción completa se conserva localmente; cada petición envía una memoria estructurada, una ventana reciente y hasta cuatro fragmentos anteriores relevantes.
- Cada cinco respuestas o diez minutos se actualiza la memoria consolidada, manteniendo estable el tamaño del prompt en entrevistas largas.
- Con OpenRouter, el pie del overlay muestra requests, tokens y costo real acumulado de la sesión.

---

## Solución de problemas

### No detecta subtítulos
- Verifica que **CC (captions)** esté activado en Meet
- Espera 5-10 segundos tras activar los subtítulos
- Google Meet cambia sus selectores CSS periódicamente — revisa la sección de actualización de selectores

### Error de API Key
- Usa el botón **Probar** en la configuración para validar
- Verifica que copiaste la key completa

### Actualizar selectores de Google Meet
En `captionCapture.js`, revisa `CAPTION_STRATEGIES` y actualiza los selectores:
1. En Meet con captions activos, abre DevTools (F12)
2. Inspecciona el texto de los subtítulos
3. Actualiza las clases CSS en las estrategias

---

## Modelos recomendados

En el popup, el botón **Actualizar** carga los IDs reales que devuelve cada proveedor (recomendado). Los valores de abajo son orientativos; para Gemini, los alias `*-latest` siguen al modelo estable actual ([modelos Gemini](https://ai.google.dev/gemini-api/docs/models)).

| Proveedor | Modelo | Notas |
|-----------|--------|--------|
| Gemini | gemini-flash-latest | Alias → último Flash (`generateContent`) |
| Gemini | gemini-flash-lite-latest | Alias → último Flash-Lite |
| Gemini | gemini-pro-latest | Alias → último Pro |
| Gemini | gemini-2.5-flash / gemini-2.5-flash-lite | Estables (según tu proyecto) |
| Groq | llama-3.1-8b-instant, llama-3.3-70b-versatile, qwen/qwen3-32b, … | Actualizar (filtra Whisper/Orpheus/guard) |
| OpenRouter | `anthropic/claude-sonnet-5` | Mejor opción general y para backend |
| OpenRouter | `openai/gpt-5.6-terra` | Razonamiento técnico/industrial; mayor latencia |
| OpenRouter | `anthropic/claude-haiku-4.5` | Máxima velocidad en tiempo real |

---

## Para desarrolladores

- **Cambios entre versiones:** ver [CHANGELOG.md](CHANGELOG.md).
- **Estructura:** `content.js` orquesta; `captionCapture`, `sessionLog`, `aiClient`, `overlayUI` son módulos bajo `window.__ia`; `utils.js` y `shared.css` comparten código entre overlay y `panel.html`.
- **Estilo de código:** [.editorconfig](.editorconfig) (indentación, UTF-8, finales de línea).

### Versiones
- Número en **`manifest.json`**; el popup muestra la misma versión automáticamente.
- Tras cambios: subir **PATCH** (`1.3.3` → `1.3.4`) y anotar en **`CHANGELOG.md`**. Si el cambio es **muy grande** (feature mayor, arquitectura, permisos…), subir **MINOR** y poner PATCH en `0` (p. ej. `1.4.0`).
- Detalle: `.cursor/rules/versioning.mdc`.

### Lint (desarrollo)
En la carpeta del proyecto:
```bash
npm install
npm run lint
```
ESLint revisa los `.js` por variables sin usar, referencias rotas obvias, etc. **No hace falta** instalar dependencias para usar la extensión en Chrome; `node_modules` solo sirve para desarrollo.

### Ideas para ir un paso más allá (opcional)
- **Prettier** (formateo automático) junto a ESLint.
- **TypeScript** o **JSDoc** estricto en módulos críticos (`aiClient`, `background`).
- **Pruebas** de integración mock para el parser de subtítulos (fixtures HTML de Meet).
- Página **Opciones** (`options_page`) si la configuración supera lo que cabe en el popup.
- **i18n** (`_locales`) si publicas en Chrome Web Store en varios idiomas.
