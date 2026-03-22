// captionCapture.js — Captura de subtítulos de Google Meet (DOM scraping + MutationObserver)
// Factory: window.__ia.createCaptionCapture(state, C, modules)
// Dependencias cruzadas (late binding): modules.sessionLog, modules.ui, modules.ai

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  window.__ia.createCaptionCapture = function (state, C, modules) {

    const SELF_SPEAKER_NAMES = ['tú', 'you', 'yo', 'ich', 'je', 'tu'];

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
      const s = speaker.toLowerCase().trim();
      if (SELF_SPEAKER_NAMES.includes(s)) return true;
      if (state.config?.myName && s.includes(state.config.myName.toLowerCase())) return true;
      return false;
    }

    function processCaptionBlocks() {
      const blocks = document.querySelectorAll('.nMcdL.bj4p3b');
      for (const block of blocks) {
        const speaker = block.querySelector('.NWpY1d')?.textContent?.trim() || '';
        const text = block.querySelector('.ygicle')?.textContent?.trim()
                  || block.querySelector('.VbkSUe')?.textContent?.trim()
                  || '';
        if (!text || text.length <= 3) continue;
        if (state.seenBlockText.get(block) === text) continue;
        state.seenBlockText.set(block, text);
        if (state.lastSeenTextsPerSpeaker.get(speaker) === text) continue;
        state.lastSeenTextsPerSpeaker.set(speaker, text);
        onNewCaption({ speaker, text });
      }

      if (blocks.length === 0) {
        for (const strategy of CAPTION_STRATEGIES) {
          const elements = document.querySelectorAll(strategy.container);
          for (const el of elements) {
            const data = strategy.getText(el);
            if (!data?.text) continue;
            if (state.seenBlockText.get(el) === data.text) continue;
            state.seenBlockText.set(el, data.text);
            const fallbackSpeaker = data.speaker || '';
            if (state.lastSeenTextsPerSpeaker.get(fallbackSpeaker) === data.text) continue;
            state.lastSeenTextsPerSpeaker.set(fallbackSpeaker, data.text);
            onNewCaption(data);
          }
        }
      }
    }

    function startCaptionObserver() {
      if (state.captionObserver) state.captionObserver.disconnect();
      if (state.captionPollInterval) clearInterval(state.captionPollInterval);

      const captionRoot = document.querySelector('[aria-label="Subtítulos"]')
                       || document.querySelector('[aria-label="Captions"]')
                       || document.querySelector('.vNKgIf')
                       || document.body;

      state.captionObserver = new MutationObserver(() => {
        if (!state.isActive || !state.config) return;
        if (state.captionProcessRAF) return;
        state.captionProcessRAF = requestAnimationFrame(() => {
          state.captionProcessRAF = null;
          processCaptionBlocks();
        });
      });

      state.captionObserver.observe(captionRoot, {
        childList: true,
        subtree: true,
        characterData: true
      });

      state.captionPollInterval = setInterval(() => {
        if (!state.isActive || !state.config) return;
        state.captionProcessRAF = null;
        processCaptionBlocks();
      }, 1500);

      const targetDesc = captionRoot === document.body ? 'body (fallback)' : 'contenedor de subtítulos';
      modules.ui.updateStatus(`Observando ${targetDesc}...`, 'active');
    }

    function stopCaptionObserver() {
      if (state.captionObserver) { state.captionObserver.disconnect(); state.captionObserver = null; }
      if (state.captionPollInterval) { clearInterval(state.captionPollInterval); state.captionPollInterval = null; }
      state.captionProcessRAF = null;
    }

    function onNewCaption({ speaker, text }) {
      if (!text || text.length < 4) return;

      const isMe = isSelfSpeaker(speaker);
      const role = isMe ? 'me' : 'interviewer';

      const last = state.captionBuffer[state.captionBuffer.length - 1];
      if (last && last.speaker === speaker) {
        last.text = text;
        last.timestamp = Date.now();
        modules.sessionLog.syncSessionTranscriptLast(speaker, role, text, last.id ?? null);
      } else {
        const captionId = state.nextCaptionLineId++;
        state.captionBuffer.push({ id: captionId, speaker, text, role, timestamp: Date.now() });
        if (state.captionBuffer.length > C.CAPTION_BUFFER_MAX) {
          state.captionBuffer.shift();
        }
        modules.sessionLog.pushSessionTranscriptLine(speaker, role, text, captionId);
      }

      if (isMe) {
        const current = state.captionBuffer[state.captionBuffer.length - 1];
        state.lastUserSpokeId = current?.id ?? null;
        clearTimeout(state.debounceTimer);
      }

      modules.ui.renderTranscript();

      if (!isMe && !state.isLoading && !state.manualModeActive) {
        clearTimeout(state.debounceTimer);
        const debounceMs = state.config?.debounceMs ?? 1800;
        state.debounceTimer = setTimeout(() => {
          const latestUserIdx = modules.sessionLog.findLastUserSpokeIndex();
          const newInterviewerLines = state.captionBuffer
            .filter((c, i) => c.role === 'interviewer' && i > latestUserIdx);
          if (newInterviewerLines.length === 0) return;

          const newText = newInterviewerLines.map(c => c.text).join(' ');
          if (newText && newText !== state.lastSentText && newText.length > 10) {
            state.lastSentText = newText;
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
