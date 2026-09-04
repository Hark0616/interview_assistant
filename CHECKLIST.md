# Checklist de programación — Interview Assistant

## Alcance actual

Objetivo: mejorar la fiabilidad de las sugerencias durante una entrevista personal, especialmente cuando los subtítulos llegan por partes o cambian mientras se están generando respuestas.

Fuera de alcance por ahora: endurecimiento de privacidad, limpieza de almacenamiento, límites artificiales de entrada/contexto, detección avanzada de cambio de reunión y restricción del arranque en Teams.

## Prioridad máxima — Idioma de respuesta

- [x] Añadir `responseLanguage` a la configuración con valores `es` y `en`.
- [x] Usar `es` como valor por defecto cuando no exista configuración guardada o el valor sea inválido.
- [x] Añadir en el prompt de sugerencias una instrucción explícita y obligatoria cuando el modo sea fijo:
  - `en`: responder exclusivamente en inglés.
  - `es`: responder exclusivamente en español.
- [x] Eliminar la dependencia de detección automática del idioma.
- [x] Exponer un switch `Español / English` en el popup.
- [x] Exponer un switch rápido equivalente en el overlay y en el panel pop-out.
- [x] Propagar el cambio en caliente mediante `CONFIG_UPDATED` o un comando específico, sin recargar la pestaña.
- [x] Aplicar el idioma fijo únicamente a las respuestas para el candidato; no alterar el JSON del ledger ni los prompts internos de condensación.
- [x] Añadir tests que verifiquen ambos idiomas, valores inválidos y la sincronización de los controles.

### Criterios de aceptación del idioma

- [x] En modo `en`, una pregunta en inglés produce una respuesta en inglés aunque el CV, la empresa o el contexto estén en español.
- [x] En modo `en`, una pregunta en español sigue produciendo una respuesta en inglés.
- [x] En modo `es`, una pregunta en inglés sigue produciendo una respuesta en español.
- [x] En modo `es`, una pregunta en español produce una respuesta en español.
- [x] Una instalación/configuración nueva inicia en español.
- [x] El switch del popup, overlay y panel representa el mismo valor.

Resultado de implementación: `responseLanguage` se normaliza a `es`/`en`; el prompt principal recibe la instrucción al inicio y los tests pasan con el comando normal del proyecto.

## Fase 0 — Reproducir y fijar el comportamiento actual

- [x] Añadir un test de regresión para «Regenerar» después de una respuesta exitosa con el mismo contexto.
- [x] Añadir un test de regresión para una pregunta repetida después de una intervención del candidato.
- [x] Añadir un test de regresión para un caption del mismo bloque DOM que crece después de haberse enviado una sugerencia.
- [x] Añadir un test de regresión para un caption del mismo bloque DOM que ya fue procesado por el ledger y luego cambia.
- [x] Corregir el entorno de tests: fijar Vitest 2.1.9 y jsdom 24.1.3 para que `npm test` funcione con Node 20.
- [ ] Ejecutar todos los tests antes de modificar la lógica y guardar el resultado como línea base.

## Fase 1 — Corregir identidad y revisiones de captions

- [x] Separar el identificador estable del bloque DOM de una revisión de texto.
- [x] Generar una revisión nueva cuando cambie el texto de un mismo bloque.
- [x] Mantener la posibilidad de fusionar fragmentos consecutivos de Teams sin perder la revisión más reciente.
- [x] Hacer que el ledger procese cambios de texto aunque el bloque conserve el mismo identificador.
- [x] Evitar que un caption actualizado se duplique como una nueva frase completa.
- [x] Verificar que el contexto enviado conserve la pregunta completa y no solo la primera versión parcial.

### Criterios de aceptación

- [x] Si Meet cambia `¿Cómo trabajas con…` por `¿Cómo trabajas con Kubernetes?`, la IA puede recibir la versión completa.
- [x] Si el ledger ya procesó una línea y luego esta se corrige, puede actualizar sus fuentes sin reprocesar todo el transcript.
- [x] Un mismo texto sin cambios sigue siendo ignorado.

## Fase 2 — Separar deduplicación automática de regeneración manual

- [x] Introducir una identidad de contexto basada en texto/revisión y posición conversacional, no únicamente en `lastAiContextCaptionId`.
- [x] Resetear o recalcular el fingerprint cuando el candidato intervenga.
- [x] Permitir que «Regenerar» fuerce una nueva petición con el contexto actual.
- [x] Definir claramente qué debe hacer «Enviar ahora» cuando no hay captions nuevos: forzar el contexto actual.
- [x] Mantener el bloqueo de llamadas automáticas idénticas mientras no haya contexto nuevo.
- [x] Verificar que una pregunta repetida después de una respuesta del candidato sí genere una nueva sugerencia.
- [x] Verificar que captions nuevos que llegan durante un streaming sigan entrando en cola.

### Criterios de aceptación

- [x] «Regenerar» funciona aunque no haya captions nuevos.
- [x] Una pregunta idéntica en otro momento de la conversación no se descarta como duplicada.
- [x] Una modificación real del caption dispara contexto nuevo en modo automático.
- [x] No se generan peticiones repetidas por cada mutación idéntica del DOM.

## Fase 3 — Robustez del pop-out

- [x] Asociar el panel a una pestaña y a una sesión concretas.
- [x] Evitar que abrir el panel desde otra pestaña reutilice silenciosamente el panel de la primera reunión.
- [x] Recuperar la asociación cuando el service worker se reinicie.
- [x] Manejar errores de `chrome.windows.create` y `chrome.windows.update`.
- [x] Cerrar o marcar como desconectado un panel cuya pestaña de reunión ya no exista.
- [x] Añadir tests para panel, service worker reiniciado y dos pestañas.

### Criterios de aceptación

- [x] El panel sigue recibiendo estado después de una suspensión/reactivación del service worker.
- [x] Los comandos del panel siempre llegan a la pestaña que lo abrió.
- [x] Una segunda reunión no controla accidentalmente la primera.

## Fase 4 — Captura y experiencia de uso

- [ ] Extraer la lógica de parsing de Meet/Teams a funciones testeables sin depender completamente del DOM global.
- [x] Añadir fixtures HTML representativos para Meet y Teams.
- [x] Probar `MutationObserver`, polling, bloques virtualizados y aparición tardía del contenedor.
- [x] Revisar la coincidencia de `myName` para evitar falsos positivos por `includes`.
- [x] Decidir cómo tratar un speaker vacío o desconocido sin clasificarlo automáticamente como entrevistador.
- [x] Corregir el texto inicial del debounce del overlay: muestra `1.8s`, pero el valor real por defecto es `2.8s`.

## Fase 5 — Telemetría y acabado técnico

- [x] Revisar el registro de uso para que una llamada cuente aunque el proveedor no devuelva usage.
- [x] Mapear los formatos de usage específicos de cada proveedor cuando se quiera mostrar métricas fiables.
- [x] Eliminar warnings de ESLint y whitespace detectado por `git diff --check`.
- [x] Añadir una comprobación reproducible de `lint`, `test` y manifest válido.
- [x] Crear una pequeña guía de prueba manual para cargar la extensión y validar Meet, Teams y pop-out.

## Orden recomendado

1. Fase 0: tests de regresión y entorno ejecutable.
2. Fases 1 y 2: captions revisables y deduplicación/regeneración.
3. Fase 3: pop-out y ciclo de vida MV3.
4. Fase 4: cobertura de captura real y pequeños bugs de UX.
5. Fase 5: telemetría y acabado.

## Definición de terminado

- [x] `npm test -- --run` ejecuta correctamente todos los tests.
- [x] `npm run lint` termina sin errores ni warnings propios del proyecto.
- [x] Una pregunta parcial puede completarse sin perder la versión final.
- [x] Regenerar funciona con el mismo contexto.
- [x] Preguntas repetidas en distintos momentos reciben sugerencias nuevas.
- [x] El panel pop-out no pierde la reunión asociada durante una sesión normal.
- [ ] Meet y Teams pasan la guía manual de prueba.
