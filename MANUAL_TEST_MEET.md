# Prueba manual antes de una reunión en Google Meet

Esta guía valida la parte que no puede reproducirse por completo en JSDOM: la UI real de Meet, sus selectores actuales, el permiso de subtítulos y el streaming real del proveedor.

## Preparación

- Cargar la carpeta desde `chrome://extensions/` con **Modo desarrollador**.
- Pulsar **Actualizar** en la extensión después de cada cambio de código.
- Configurar API key, modelo y `Tu nombre en la reunión` exactamente como aparece en Meet.
- Abrir una reunión de prueba o entrar unos minutos antes de la entrevista.

## Flujo esperado

1. Con la página de Meet abierta, activar **Subtítulos** y esperar a que aparezca texto.
2. Confirmar que aparece el overlay y pulsar **Activar**.
3. Decir una frase como entrevistador y comprobar que aparece con su nombre en la zona de speaker externo.
4. Responder y comprobar que aparece con tu nombre en la zona de speaker propio; esa línea no debe generar una sugerencia automática.
5. Esperar el debounce y verificar que llega una sugerencia.
6. Repetir la misma pregunta después de responder: debe producir una nueva sugerencia.
7. Cambiar a **English**, hacer clic en **Regenerar** y comprobar que el prompt pide inglés aunque el contexto esté en español. Volver a **Español** y comprobar lo contrario.
8. Abrir el pop-out y verificar que muestra la misma transcripción y sugerencia. Cerrar el pop-out: el overlay debe volver a mostrarse.
9. Pulsar **Exportar** y abrir el `.txt`: debe incluir la transcripción consolidada, roles, `captionId`/`revision`, memoria verificable y eventos de IA.

## Casos de borde

- Antes de hablar, cambiar una pregunta parcial hasta completarla. Debe quedar una sola línea, con el texto final, no dos preguntas duplicadas.
- Esperar sin mutaciones visibles: el polling no debe duplicar la última línea.
- Pulsar **Regenerar** sin captions nuevos: debe forzar otra llamada con el contexto actual.
- Desactivar y volver a activar: no debe quedar un observer antiguo duplicando captions.
- Borrar temporalmente el nombre configurado o provocar un caption sin nombre: la línea debe verse como `Desconocido` y no disparar auto-respuesta.
- Abrir el pop-out desde otra pestaña de Meet mientras ya existe uno: no debe controlar ni ocultar silenciosamente la primera reunión.
- Restaurar la extensión dentro de las seis horas y exportar: el encabezado debe indicar una sesión consolidada, sin llamar “esta activación” a las líneas restauradas.
- Probar una API key inválida o desconectar temporalmente el proveedor: la UI debe mostrar error y volver a permitir reintentar.

## Evidencia mínima

- Captura del overlay con una línea del entrevistador y otra tuya.
- Confirmación de idioma visible en el switch.
- Una regeneración y una pregunta repetida posteriores.
- Un `.txt` exportado con una línea final de caption actualizado, un speaker desconocido y los eventos de IA.
- Si falla la captura, copiar el HTML del bloque de subtítulos desde DevTools y anotar la versión de Chrome/Meet; los selectores de Meet pueden cambiar.
