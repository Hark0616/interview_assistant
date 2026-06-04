// aiClient.js — Integración IA: contexto, prompt, comunicación con background
// Factory: window.__ia.createAiClient(state, C, modules)
// Dependencias cruzadas (late binding): modules.sessionLog, modules.ui

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  window.__ia.createAiClient = function (state, C, modules) {

    function findLastIndex(arr, predicate) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i])) return i;
      }
      return -1;
    }

    function trimContextLines(lines) {
      const out = lines.length > C.AI_CONTEXT_MAX_LINES ? lines.slice(-C.AI_CONTEXT_MAX_LINES) : lines;
      let totalChars = out.reduce((sum, c) => sum + c.text.length + 1, 0);
      let start = 0;
      while (totalChars > C.AI_CONTEXT_MAX_CHARS && start < out.length) {
        totalChars -= out[start].text.length + 1;
        start++;
      }
      return start > 0 ? out.slice(start) : out;
    }

    function getContextLinesForAI() {
      const lastUserSpokeIdx = modules.sessionLog.findLastUserSpokeIndex();
      const start = lastUserSpokeIdx + 1;
      if (start >= state.captionBuffer.length) {
        if (state.captionBuffer.length === 0) return [];
        // Nada nuevo después de que el usuario habló.
        // Solo devolver el buffer completo si la IA aún no ha respondido a este contexto.
        const lastCaptionId = state.captionBuffer[state.captionBuffer.length - 1]?.id;
        if (state.lastAiContextCaptionId != null && state.lastAiContextCaptionId >= lastCaptionId) {
          return [];
        }
        return trimContextLines(state.captionBuffer.slice());
      }
      return trimContextLines(state.captionBuffer.slice(start));
    }

    function sendMessageAsync(payload) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime?.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { success: false, error: 'Respuesta vacía del background' });
        });
      });
    }

    function buildSystemPrompt() {
      const myName = state.config?.myName || 'el candidato';
      const profile = state.condensedProfile || state.config?.cvProfile || '';
      const company = state.condensedCompany || state.config?.company || '';

      const sections = [`Eres un asistente INVISIBLE de entrevistas en tiempo real para ${myName}.`];

      if (profile) sections.push(`PERFIL:\n${profile}`);
      if (state.config?.jobDescription) sections.push(`PUESTO:\n${state.config.jobDescription}`);
      if (company) sections.push(`EMPRESA:\n${company}`);

      const userNote = String(state.userNote || '').trim();
      if (userNote) {
        sections.push(
          'NOTA DEL CANDIDATO (prioridad alta; instrucción directa del usuario en la reunión):\n' + userNote
        );
      }

      sections.push(`REGLAS:
- SOLO lo que el candidato diría, en primera persona directa, sin etiquetas, prefijos ni comentarios introductorios.
- ADAPTA EL FORMATO DINÁMICAMENTE al tipo de pregunta:
  * Pregunta conductual o de comportamiento ("Cuéntame cuando...", "Háblame de una situación...", "Cómo manejas..."): Estructura la respuesta usando el método STAR (Situación, Tarea, Acción, Resultado) de forma fluida, conversacional y en primera persona.
  * Pregunta técnica o de arquitectura: Da una respuesta estructurada con bullets cortos, mencionando tecnologías exactas de tu perfil, patrones de diseño y buenas prácticas.
  * Pregunta rápida o de calentamiento: Da una respuesta concisa y natural de 1 o 2 oraciones.
- Datos REALES del perfil. NUNCA inventes tecnologías, certificaciones o proyectos que no estén explícitamente en tu perfil/CV.
- IDIOMA: Responde SIEMPRE en el mismo idioma en el que habla/pregunta el entrevistador en el último tramo. Si te habla en inglés, responde obligatoriamente en inglés. Si habla en español, en español.
- El usuario puede enviar un bloque largo: todo lo dicho desde su última intervención; usa el hilo completo como contexto.
- Si aparece <<< RESPONDE A ESTO, prioriza eso (última intervención del entrevistador en el bloque); si no hay marca, infiere la pregunta principal del texto.
- Sé coherente con tus respuestas anteriores (turnos previos), no te repitas.
- NUNCA pidas aclaración ni hagas preguntas de vuelta; SIEMPRE da una respuesta directa aunque el contexto sea incompleto.
- La transcripción puede tener errores de reconocimiento de voz (palabras cortadas, repeticiones, ruido): IGNÓRALOS, infiere la intención real de la pregunta y responde.
- NUNCA menciones la transcripción, el sistema, la calidad del audio ni que eres un asistente; actúa como si fueras directamente el candidato pensando en voz alta.`);

      return sections.join('\n\n');
    }

    async function generateCondensedProfile() {
      const cvText = state.config?.cvProfile || '';

      if (!state.config?.apiKey || !cvText || cvText.length < 15000) {
        state.condensedProfile = cvText;
        return;
      }

      modules.ui.updateStatus('Condensando perfil...', 'active');

      const response = await sendMessageAsync({
        type: 'GET_AI_SUGGESTION',
        data: {
          provider: state.config.provider || 'gemini',
          apiKey: state.config.apiKey,
          model: state.config.model,
          systemPrompt: 'Condensa información. Responde SOLO con el resumen.',
          messages: [{
            role: 'user',
            content: `Condensa este CV en máximo 1200 palabras. Mantén todos los skills técnicos, tecnologías, herramientas, años de experiencia y logros cuantificables de cada rol. Sin bullets.\n\n${cvText}`
          }]
        }
      });

      if (response?.success && response.suggestion) {
        state.condensedProfile = response.suggestion;
        modules.ui.updateStatus('Perfil condensado', 'active');
      } else {
        state.condensedProfile = cvText.substring(0, 15000);
        modules.ui.updateStatus('Perfil truncado (error al condensar)', 'active');
      }
    }

    async function generateCondensedCompany() {
      const companyText = state.config?.company || '';

      if (!state.config?.apiKey || !companyText || companyText.length < 8000) {
        state.condensedCompany = companyText;
        return;
      }

      modules.ui.updateStatus('Condensando empresa...', 'active');

      const response = await sendMessageAsync({
        type: 'GET_AI_SUGGESTION',
        data: {
          provider: state.config.provider || 'gemini',
          apiKey: state.config.apiKey,
          model: state.config.model,
          systemPrompt: 'Condensa información. Responde SOLO con el resumen.',
          messages: [{
            role: 'user',
            content: `Condensa esta descripción de empresa en máximo 600 palabras. Conserva industria, tipo de producto/servicio, cultura relevante para entrevista y datos diferenciales útiles para contextualizar respuestas.\n\n${companyText}`
          }]
        }
      });

      if (response?.success && response.suggestion) {
        state.condensedCompany = response.suggestion;
        modules.ui.updateStatus('Empresa condensada', 'active');
      } else {
        state.condensedCompany = companyText.substring(0, 8000);
        modules.ui.updateStatus('Empresa truncada (error al condensar)', 'active');
      }
    }

    function buildConversationPayload(recentLines) {
      const lastIntIdx = findLastIndex(recentLines, (c) => c.role === 'interviewer');

      let preamble =
        'Contexto: transcripción desde tu última intervención en subtítulos (entrevistador y tú). ' +
        'Prioriza responder a lo más reciente del entrevistador.';
      if (lastIntIdx < 0) {
        preamble +=
          ' No hay líneas etiquetadas como [ENTREVISTADOR] en este tramo (revisa «Tu nombre» en el popup de la extensión); infiere la pregunta a partir del texto.';
      }
      preamble += '\n\n';

      const conversationText = preamble + recentLines
        .map((c, i) => {
          const label = c.role === 'me' ? '[TÚ]' : '[ENTREVISTADOR]';
          const marker = i === lastIntIdx ? ' <<< RESPONDE A ESTO' : '';
          return `${label}: ${c.text}${marker}`;
        })
        .join('\n');

      const latestQuestion = recentLines
        .filter((c) => c.role === 'interviewer')
        .map((c) => c.text)
        .join(' ')
        .trim();

      const digest = modules.sessionLog.buildSessionDigestForPrompt();
      const userPayload = digest
        ? `[Registro previo de la reunión (contexto; no lo repitas literalmente).\n${digest}]\n\n--- Mensaje actual (tramo desde tu última intervención) ---\n\n${conversationText}`
        : conversationText;

      return { userPayload, latestQuestion };
    }

    function buildMessages(systemPrompt, userPayload) {
      const messages = [];
      for (const h of state.suggestionHistory.slice(-3)) {
        messages.push({ role: 'user', content: h.question });
        messages.push({ role: 'assistant', content: h.answer });
      }
      messages.push({ role: 'user', content: userPayload });
      return messages;
    }

    function handleSuggestionSuccess(response, latestQuestion, recentLines) {
      const lastCaption = state.captionBuffer[state.captionBuffer.length - 1];
      if (lastCaption) state.lastAiContextCaptionId = lastCaption.id;

      const suggestionText = response.truncated
        ? response.suggestion + '\n⚠️ (respuesta cortada por límite de tokens — pulsa Regenerar)'
        : response.suggestion;

      modules.sessionLog.recordIaResponse(suggestionText);

      const historyQuestion =
        latestQuestion ||
        recentLines.map((c) => c.text).join(' ').trim() ||
        '(sin texto de entrevistador en el tramo)';

      state.suggestionHistory.push({ question: historyQuestion, answer: suggestionText, timestamp: Date.now() });
      if (state.suggestionHistory.length > 10) state.suggestionHistory.shift();

      if (String(state.userNote || '').trim()) {
        modules.ui.setUserNote('');
      }

      modules.ui.displaySuggestion(suggestionText);
    }

    async function requestSuggestion() {
      if (!state.config?.apiKey || state.isLoading) return;
      if (Date.now() - state.lastAiRequestCompletedAt < C.AI_REQUEST_COOLDOWN_MS) {
        modules.ui.updateStatus('Espera un momento...', 'idle');
        return;
      }

      const recentLines = getContextLinesForAI();
      if (recentLines.length === 0) {
        const msg = state.captionBuffer.length > 0
          ? 'No hay subtítulos nuevos desde la última sugerencia. Espera a que hablen y vuelve a pulsar «Enviar ahora».'
          : 'No hay subtítulos en contexto. Activa los subtítulos en directo y espera texto.';
        modules.ui.displaySuggestion(msg, true);
        return;
      }

      state.isLoading = true;
      modules.ui.setLoadingState(true);
      modules.ui.displaySuggestion(''); // Limpiar sugerencia previa

      const { userPayload, latestQuestion } = buildConversationPayload(recentLines);
      modules.sessionLog.recordIaActivation(userPayload);

      const systemPrompt = buildSystemPrompt();
      const messages = buildMessages(systemPrompt, userPayload);

      let accumulatedSuggestion = '';
      let isFirstChunk = true;

      try {
        const port = chrome.runtime.connect({ name: 'ai-stream' });
        
        port.postMessage({
          type: 'GET_AI_SUGGESTION_STREAM',
          data: {
            provider: state.config.provider || 'gemini',
            apiKey: state.config.apiKey,
            model: state.config.model,
            systemPrompt,
            messages
          }
        });

        port.onMessage.addListener((msg) => {
          if (msg.type === 'chunk') {
            if (isFirstChunk) {
              isFirstChunk = false;
              modules.ui.setLoadingState(false);
            }
            accumulatedSuggestion += msg.text;
            modules.ui.displaySuggestion(accumulatedSuggestion);
          } else if (msg.type === 'done') {
            state.isLoading = false;
            modules.ui.setLoadingState(false);
            state.lastAiRequestCompletedAt = Date.now();
            
            handleSuggestionSuccess({ suggestion: accumulatedSuggestion, truncated: false }, latestQuestion, recentLines);
            port.disconnect();
          } else if (msg.type === 'error') {
            state.isLoading = false;
            modules.ui.setLoadingState(false);
            state.lastAiRequestCompletedAt = Date.now();
            
            modules.sessionLog.recordIaError(msg.error || 'desconocido');
            modules.ui.displaySuggestion(`Error en streaming: ${msg.error || 'desconocido'}`, true);
            port.disconnect();
          }
        });

        port.onDisconnect.addListener(() => {
          if (state.isLoading) {
            state.isLoading = false;
            modules.ui.setLoadingState(false);
            if (accumulatedSuggestion) {
              handleSuggestionSuccess({ suggestion: accumulatedSuggestion, truncated: false }, latestQuestion, recentLines);
            } else {
              modules.ui.displaySuggestion('Error: Conexión con el fondo perdida', true);
            }
          }
        });

      } catch (err) {
        state.isLoading = false;
        modules.ui.setLoadingState(false);
        state.lastAiRequestCompletedAt = Date.now();
        modules.sessionLog.recordIaError(err.message);
        modules.ui.displaySuggestion(`Error de puerto: ${err.message}`, true);
      }
    }

    return {
      requestSuggestion,
      generateCondensedProfile,
      generateCondensedCompany,
      buildSystemPrompt,
      sendMessageAsync
    };
  };
})();
