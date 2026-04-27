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

      const sections = [`Eres un asistente INVISIBLE de entrevistas en tiempo real para ${myName}.`];

      if (profile) sections.push(`PERFIL:\n${profile}`);
      if (state.config?.jobDescription) sections.push(`PUESTO:\n${state.config.jobDescription}`);
      if (state.config?.company) sections.push(`EMPRESA:\n${state.config.company}`);

      const userNote = String(state.userNote || '').trim();
      if (userNote) {
        sections.push(
          'NOTA DEL CANDIDATO (prioridad alta; instrucción directa del usuario en la reunión):\n' + userNote
        );
      }

      sections.push(`REGLAS:
- SOLO lo que el candidato diría, sin etiquetas ni prefijos
- Primera persona directa, máximo 3 puntos de 1-2 oraciones
- Datos REALES del perfil. Mismo idioma que el entrevistador
- El usuario puede enviar un bloque largo: todo lo dicho desde su última intervención; usa el hilo completo como contexto
- Si aparece <<< RESPONDE A ESTO, prioriza eso (última intervención del entrevistador en el bloque); si no hay marca, infiere la pregunta principal del texto
- Sé coherente con tus respuestas anteriores (turnos previos), no te repitas`);

      return sections.join('\n\n');
    }

    async function generateCondensedProfile() {
      const cvText = state.config?.cvProfile || '';

      if (!state.config?.apiKey || !cvText || cvText.length < 600) {
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
            content: `Condensa este CV en máximo 250 palabras. Mantén: skills técnicos clave, años de experiencia y logros cuantificables. Sin bullets.\n\n${cvText}`
          }]
        }
      });

      if (response?.success && response.suggestion) {
        state.condensedProfile = response.suggestion;
        modules.ui.updateStatus('Perfil condensado', 'active');
      } else {
        state.condensedProfile = cvText.substring(0, 1500);
        modules.ui.updateStatus('Perfil truncado (error al condensar)', 'active');
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

      const { userPayload, latestQuestion } = buildConversationPayload(recentLines);
      modules.sessionLog.recordIaActivation(userPayload);

      const systemPrompt = buildSystemPrompt();
      const messages = buildMessages(systemPrompt, userPayload);

      const response = await sendMessageAsync({
        type: 'GET_AI_SUGGESTION',
        data: {
          provider: state.config.provider || 'gemini',
          apiKey: state.config.apiKey,
          model: state.config.model,
          systemPrompt,
          messages
        }
      });

      state.isLoading = false;
      modules.ui.setLoadingState(false);
      state.lastAiRequestCompletedAt = Date.now();

      if (response?.success) {
        handleSuggestionSuccess(response, latestQuestion, recentLines);
      } else {
        modules.sessionLog.recordIaError(response?.error || 'desconocido');
        modules.ui.displaySuggestion(`Error: ${response?.error || 'desconocido'}`, true);
      }
    }

    return {
      requestSuggestion,
      generateCondensedProfile,
      buildSystemPrompt,
      sendMessageAsync
    };
  };
})();
