// captionCapture.js — Captura de subtítulos: Google Meet + Microsoft Teams web (DOM + MutationObserver)
// Factory: window.__ia.createCaptionCapture(state, C, modules)
// Dependencias cruzadas (late binding): modules.sessionLog, modules.ui, modules.ai

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  window.__ia.createCaptionCapture = function (state, C, modules) {

    function normalizeQuestionFingerprint(text) {
      return String(text || '')
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    function normalizeSpeaker(speaker) {
      return String(speaker || '')
        .trim()
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ');
    }

    function speakerTokens(speaker) {
      return normalizeSpeaker(speaker)
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    }

    function blockSignature(speaker, text) {
      return `${normalizeSpeaker(speaker)}\u0000${String(text || '').trim()}`;
    }

    function captionRevision(caption) {
      const revision = Number(caption?.revision);
      return Number.isInteger(revision) && revision > 0 ? revision : 1;
    }

    function mergeCaptionText(previousText, nextText) {
      const previous = String(previousText || '').trim();
      const next = String(nextText || '').trim();
      if (!previous) return next;
      if (!next) return previous;
      if (previous === next) return previous;

      const previousLower = previous.toLocaleLowerCase();
      const nextLower = next.toLocaleLowerCase();
      if (previousLower === nextLower || previousLower.endsWith(nextLower)) return previous;
      if (nextLower.startsWith(previousLower)) return next;
      if (previousLower.startsWith(nextLower)) return previous;

      const wordsExist = previous.split(/\s+/);
      const wordsInc = next.split(/\s+/);
      const maxOverlap = Math.min(wordsExist.length, wordsInc.length);
      for (let overlap = maxOverlap; overlap > 0; overlap--) {
        const tail = wordsExist.slice(-overlap).join(' ');
        const head = wordsInc.slice(0, overlap).join(' ');
        if (tail.toLocaleLowerCase() === head.toLocaleLowerCase()) {
          return wordsExist.slice(0, -overlap).join(' ') + ' ' + next;
        }
      }

      return `${previous} ${next}`;
    }

    function buildAutoContextKey(lines) {
      const boundary = state.lastUserSpokeId ?? 'start';
      const captions = lines.map((caption) =>
        `${caption.id}:${captionRevision(caption)}:${normalizeQuestionFingerprint(caption.text)}`
      ).join('|');
      return `${boundary}|${captions}`;
    }

    function likelyCompleteQuestion(text) {
      const clean = String(text || '').trim();
      if (!clean) return false;
      if (/[?¿]/.test(clean)) return true;
      const words = clean.split(/\s+/).filter(Boolean);
      if (words.length >= 18) return true;
      if (words.length >= 7 && /[.!:]$/.test(clean)) return true;
      return /^(cu[eé]ntame|describe|explica|c[oó]mo|por qu[eé]|qu[eé]|cu[aá]l|when|why|how|what|tell me|describe|explain)\b/i.test(clean)
        && words.length >= 8;
    }

    const SELF_SPEAKER_NAMES = ['tú', 'you', 'yo', 'ich', 'je', 'tu'];

    // Mensajes de sistema de Teams/Meet que no son diálogo real.
    // Se comparan en minúsculas; se descartan si coinciden exactamente o empiezan con alguno de estos prefijos.
    const SYSTEM_MESSAGE_EXACT = new Set([
      'close caption has started.',
      'close captions have started.',
      'live captions have started.',
      'live captions have ended.',
      'live captions are on.',
      'live captions are off.',
      'captions are now available.',
      'captions are now on.',
      'captions are now off.',
      'captions have started.',
      'captions have ended.',
      'closed captions started.',
      'closed captions ended.',
      'caption has started.',
      'subtítulos en directo iniciados.',
      'subtítulos en directo finalizados.',
      'los subtítulos han comenzado.',
      'se han iniciado los subtítulos.',
    ]);

    const SYSTEM_MESSAGE_PREFIXES = [
      'close caption has',
      'live captions have',
      'live captions are',
      'captions are now',
      'captions have',
      'closed captions',
      'subtítulos en directo',
    ];

    function isSystemMessage(text) {
      if (!text) return true;
      if (text.length > 500) return true;
      const lower = String(text || '').toLocaleLowerCase().trim();
      if (SYSTEM_MESSAGE_EXACT.has(lower)) return true;
      for (const prefix of SYSTEM_MESSAGE_PREFIXES) {
        if (lower.startsWith(prefix)) return true;
      }
      if (
        lower.includes('videocamintegrated') ||
        lower.includes('idioma de la reunión') ||
        lower.includes('notificaciones de escritorio') ||
        lower.includes('control de la llamada') ||
        lower.includes('presionar para hablar')
      ) return true;
      return false;
    }
    function isTeamsHost() {
      const h = location.hostname;
      return h === 'teams.microsoft.com'
        || h === 'teams.live.com'
        || h === 'teams.cloud.microsoft'
        || h.endsWith('.teams.microsoft.com')
        || h.endsWith('.teams.cloud.microsoft');
    }

    function extractFromAriaLive(container) {
      const text = container.textContent.trim();
      if (!text) return null;
      const colonIdx = text.indexOf(':');
      if (colonIdx > 0 && colonIdx < 40) {
        return {
          speaker: text.substring(0, colonIdx).trim(),
          text: text.substring(colonIdx + 1).trim()
        };
      }
      return { speaker: '', text };
    }

    const CAPTION_STRATEGIES = [
      {
        container: '.nMcdL.bj4p3b',
        getText: (el) => {
          const speaker = el.querySelector('.NWpY1d')?.textContent?.trim() || '';
          const text = el.querySelector('.ygicle')?.textContent?.trim()
                    || el.querySelector('.VbkSUe')?.textContent?.trim()
                    || '';
          return text ? { speaker, text } : null;
        }
      },
      {
        container: '[aria-live="polite"]',
        getText: (el) => extractFromAriaLive(el)
      },
      {
        container: '[role="region"][aria-label]',
        getText: (el) => {
          if (!el.querySelector('.NWpY1d')) return null;
          const blocks = el.querySelectorAll('.nMcdL.bj4p3b');
          const last = blocks[blocks.length - 1];
          if (!last) return null;
          const speaker = last.querySelector('.NWpY1d')?.textContent?.trim() || '';
          const text = last.querySelector('.ygicle')?.textContent?.trim() || '';
          return text ? { speaker, text } : null;
        }
      },
      {
        container: '[data-message-text]',
        getText: (el) => ({ speaker: 'Desconocido', text: el.getAttribute('data-message-text') })
      }
    ];

    function isSelfSpeaker(speaker) {
      const tokens = speakerTokens(speaker);
      if (tokens.length === 0) return false;

      const reservedNames = new Set(SELF_SPEAKER_NAMES.map((name) => speakerTokens(name)[0]));
      // Meet puede mostrar «Nombre (You)» o directamente «You». Solo se acepta
      // un token completo; nunca una coincidencia de subcadena.
      if (tokens.some((token) => reservedNames.has(token))) return true;

      const configuredTokens = speakerTokens(state.config?.myName);
      if (configuredTokens.length === 0) return false;

      const normalizedTokens = new Set(configuredTokens);
      const normalizedSpeaker = tokens.join(' ');
      const normalizedConfigured = configuredTokens.join(' ');
      if (normalizedSpeaker === normalizedConfigured) return true;

      // Meet a veces enseña solo el nombre o el apellido configurado. La
      // coincidencia es por token completo para evitar falsos positivos como
      // «Ivan» → «Divan».
      if (tokens.length === 1 && normalizedTokens.has(tokens[0])) return true;
      if (configuredTokens.length === 1 && tokens.includes(configuredTokens[0])) return true;
      return false;
    }

    function processStrategyElements(strategy) {
      const elements = document.querySelectorAll(strategy.container);
      for (const el of elements) {
        const data = strategy.getText(el);
        if (!data?.text) continue;
        const signature = blockSignature(data.speaker, data.text);
        if (state.seenBlockText.get(el) === signature) continue;
        state.seenBlockText.set(el, signature);
        onNewCaption({ ...data, block: el });
      }
      return elements.length;
    }

    function processCaptionBlocks() {
      const blocks = document.querySelectorAll('.nMcdL.bj4p3b');
      let processedPrimaryBlocks = 0;
      for (const block of blocks) {
        const speaker = block.querySelector('.NWpY1d')?.textContent?.trim() || '';
        const text = block.querySelector('.ygicle')?.textContent?.trim()
                  || block.querySelector('.VbkSUe')?.textContent?.trim()
                  || '';
        if (!text || text.length <= 3) continue;
        processedPrimaryBlocks += 1;
        const signature = blockSignature(speaker, text);
        if (state.seenBlockText.get(block) === signature) continue;
        state.seenBlockText.set(block, signature);
        
        onNewCaption({ speaker, text, block });
      }

      // Los selectores alternativos solo se usan si no hay bloques Meet útiles.
      // Así no duplicamos el mismo caption cuando aria-live envuelve al bloque
      // principal, pero sí recuperamos una versión de DOM distinta si el
      // selector principal quedó presente sin texto.
      if (processedPrimaryBlocks === 0) {
        for (const strategy of CAPTION_STRATEGIES.slice(1)) {
          processStrategyElements(strategy);
        }
      }
    }

    /**
     * Microsoft Teams web: subtítulos en bloques Fluent UI (data-tid confirmados en HTML real).
     * Fallback: regiones aria-live con patrón "Orador: texto" (extractFromAriaLive).
     */
    function processTeamsCaptionBlocks() {
      const blocks = document.querySelectorAll('.fui-ChatMessageCompact');
      if (blocks.length > 0) {
        for (const block of blocks) {
          const speaker =
            block.querySelector('[data-tid="author"]')?.textContent?.trim()
            || block.querySelector('.fui-ChatMessageCompact__author')?.textContent?.trim()
            || 'Desconocido';

          const textEl = block.querySelector('[data-tid="closed-caption-text"]');
          const text = textEl?.textContent?.trim() || '';

          if (!text || text.length <= 2) continue;

          // Si el texto de este bloque específico no ha cambiado, saltar
          const signature = blockSignature(speaker, text);
          if (state.seenBlockText.get(block) === signature) continue;
          state.seenBlockText.set(block, signature);

          // Para Teams, si es un bloque nuevo de la misma persona, queremos ANEXAR,
          // no sobrescribir (como hace Meet que usa un solo bloque que crece).
          onNewCaption({ speaker, text, block });
        }
        return;
      }
      // Fallback a estrategias generales si no hay bloques FUI
      for (const strategy of CAPTION_STRATEGIES) {
        processStrategyElements({
          ...strategy,
          getText: (el) => {
            const data = strategy.getText(el);
            return data ? { ...data, speaker: data.speaker || 'Desconocido' } : data;
          }
        });
      }
    }

    function runCaptionProcessor() {
      if (isTeamsHost()) {
        processTeamsCaptionBlocks();
      } else {
        processCaptionBlocks();
      }
    }

    function startCaptionObserver() {
      if (state.captionObserver) state.captionObserver.disconnect();
      if (state.captionPollInterval) clearInterval(state.captionPollInterval);

      const isTeams = isTeamsHost();
      // Teams V2 usa virtualized lists. Intentamos encontrar el scroll container o el padre de los bloques.
      const captionRoot = isTeams
        ? (document.querySelector('[data-tid="closed-caption-v2-virtual-list-content"]')
            || document.querySelector('.fui-ChatMessageCompact')?.parentElement
            || document.querySelector('[data-tid="closed-captions-v2-items-renderer"]')?.closest('.fui-Flex')
            || document.body)
        : (document.querySelector('[aria-label="Subtítulos"]')
            || document.querySelector('[aria-label="Captions"]')
            || document.querySelector('.vNKgIf')
            || document.body);

      state.captionObserver = new MutationObserver(() => {
        if (!state.isActive || !state.config) return;
        if (state.captionProcessRAF) return;
        state.captionProcessRAF = requestAnimationFrame(() => {
          state.captionProcessRAF = null;
          runCaptionProcessor();
        });
      });

      state.captionObserver.observe(captionRoot, {
        childList: true,
        subtree: true,
        characterData: true
      });

      state.captionPollInterval = setInterval(() => {
        if (!state.isActive || !state.config) return;
        runCaptionProcessor();
      }, 1500);

      // Si los subtítulos ya estaban visibles al pulsar «Activar», no debemos
      // esperar al primer intervalo ni a otra mutación para capturarlos.
      runCaptionProcessor();

      const targetDesc = captionRoot === document.body ? 'body (fallback)' : 'contenedor de subtítulos';
      modules.ui.updateStatus(`Observando ${targetDesc}...`, 'active');
    }

    function stopCaptionObserver() {
      if (state.captionObserver) { state.captionObserver.disconnect(); state.captionObserver = null; }
      if (state.captionPollInterval) { clearInterval(state.captionPollInterval); state.captionPollInterval = null; }
      state.captionProcessRAF = null;
    }

    function onNewCaption({ speaker, text, block }) {
      const cleanText = String(text || '').trim();
      if (cleanText.length < 3) return;
      if (isSystemMessage(cleanText)) return;

      const last = state.captionBuffer[state.captionBuffer.length - 1];
      const isSameBlock = last && block && last.blockElement === block;
      const rawSpeaker = String(speaker || '').trim();
      const rawNormalizedSpeaker = normalizeSpeaker(rawSpeaker);
      const hasCurrentSpeaker = rawNormalizedSpeaker && rawNormalizedSpeaker !== 'desconocido';
      // Algunos renders de Meet reemplazan temporalmente el nodo del nombre
      // mientras el texto sigue creciendo. Conservamos el último speaker
      // conocido para no convertir una línea válida en «unknown».
      const effectiveSpeaker = isSameBlock && !hasCurrentSpeaker
        ? String(last.speaker || '').trim()
        : rawSpeaker;
      const normalizedSpeaker = normalizeSpeaker(effectiveSpeaker);
      const isMe = isSelfSpeaker(effectiveSpeaker);
      const hasSpeaker = normalizedSpeaker && normalizedSpeaker !== 'desconocido';
      const role = isMe
        ? 'me'
        : hasSpeaker
          ? 'interviewer'
          : isSameBlock && last.role
            ? last.role
            : 'unknown';
      
      // Lógica de Mezcla Inteligente:
      // 1. Si es el mismo bloque de DOM (Meet o Teams actualizando el mismo globo): Sobrescribir.
      // 2. Si es un bloque diferente pero mismo orador y tiempo cercano: Anexar.
      // 3. Si es orador diferente: Nueva línea.
      
      const lastSpeaker = normalizeSpeaker(last?.speaker);
      const currentSpeaker = normalizeSpeaker(effectiveSpeaker);
      const speakerChangedOnSameBlock =
        isSameBlock && lastSpeaker && currentSpeaker && lastSpeaker !== currentSpeaker;
      const sameKnownSpeaker =
        currentSpeaker &&
        currentSpeaker !== 'desconocido' &&
        lastSpeaker === currentSpeaker;
      const timeSinceLast = last ? Date.now() - last.timestamp : Infinity;

      if (isSameBlock && !speakerChangedOnSameBlock) {
        const textChanged = normalizeQuestionFingerprint(last.text) !== normalizeQuestionFingerprint(cleanText);
        const identityChanged = lastSpeaker !== currentSpeaker || last.role !== role;
        if (!textChanged && !identityChanged) return;
        last.speaker = effectiveSpeaker;
        last.role = role;
        if (textChanged) {
          last.text = cleanText; // El bloque creció o fue corregido (Meet/Teams)
          last.revision = captionRevision(last) + 1;
        }
        last.timestamp = Date.now();
        modules.sessionLog.syncSessionTranscriptLast(effectiveSpeaker, role, last.text, last.id ?? null, last.revision);
      } else if (sameKnownSpeaker && timeSinceLast < 5000) {
        // Es un bloque nuevo de Teams del mismo orador: anexamos sin repetir
        // prefijos/sufijos que el DOM pueda haber enviado otra vez.
        const mergedText = mergeCaptionText(last.text, cleanText);
        if (normalizeQuestionFingerprint(mergedText) === normalizeQuestionFingerprint(last.text)) return;
        last.text = mergedText;
        last.revision = captionRevision(last) + 1;
        last.timestamp = Date.now();
        modules.sessionLog.syncSessionTranscriptLast(effectiveSpeaker, role, last.text, last.id ?? null, last.revision);
      } else {
        const captionId = state.nextCaptionLineId++;
        state.captionBuffer.push({ 
          id: captionId, 
          speaker: effectiveSpeaker,
          text: cleanText,
          role, 
          revision: 1,
          timestamp: Date.now(),
          blockElement: block // Guardamos referencia para saber si el siguiente update es del mismo bloque
        });
        if (state.captionBuffer.length > C.CAPTION_BUFFER_MAX) {
          state.captionBuffer.shift();
        }
        modules.sessionLog.pushSessionTranscriptLine(effectiveSpeaker, role, cleanText, captionId, 1);
      }

      if (isMe) {
        const current = state.captionBuffer[state.captionBuffer.length - 1];
        state.lastUserSpokeId = current?.id ?? null;
        state.lastAutoContextKey = '';
        clearTimeout(state.debounceTimer);
      }

      modules.ui.renderTranscript();

      if (role === 'interviewer' && !state.manualModeActive) {
        clearTimeout(state.debounceTimer);
        const configuredDebounce = state.config?.debounceMs;
        const baseDebounceMs = configuredDebounce ?? 2800;
        const currentQuestionText = state.captionBuffer
          .filter((c, i) => c.role === 'interviewer' && i > modules.sessionLog.findLastUserSpokeIndex())
          .map((c) => c.text)
          .join(' ');
        const debounceMs = configuredDebounce === 0
          ? 0
          : likelyCompleteQuestion(currentQuestionText)
            ? baseDebounceMs
            : Math.max(baseDebounceMs, 3800);
        state.debounceTimer = setTimeout(() => {
          const latestUserIdx = modules.sessionLog.findLastUserSpokeIndex();
          const newInterviewerLines = state.captionBuffer
            .filter((c, i) => c.role === 'interviewer' && i > latestUserIdx);
          if (newInterviewerLines.length === 0) return;

          const newText = newInterviewerLines.map(c => c.text).join(' ');
          const fingerprint = normalizeQuestionFingerprint(newText);
          const contextKey = buildAutoContextKey(newInterviewerLines);
          if (
            newText &&
            fingerprint &&
            newText.length > 10 &&
            contextKey !== state.lastAutoContextKey
          ) {
            state.lastAutoContextKey = contextKey;
            state.lastSentText = newText;
            state.lastSentFingerprint = fingerprint;
            modules.ai.requestSuggestion();
          }
        }, debounceMs);
      }

      if (!isMe && state.manualModeActive) {
        modules.ui.highlightManualBtn();
      }
    }

    return {
      startCaptionObserver,
      stopCaptionObserver,
      onNewCaption,
      isSelfSpeaker
    };
  };
})();
