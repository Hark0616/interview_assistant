// meetChatSelfLogPoc.js — PRUEBA / POC (no producción)
// Intenta detectar cuando envías un mensaje al chat de Meet (Enter sin Shift),
// guarda el texto en chrome.storage.local y dispara la descarga de un .txt con todo el historial de esa reunión.
//
// Límites: el DOM de Meet cambia; si envías solo con el botón del ratón puede no capturarse;
// Shift+Enter en el chat suele ser nueva línea (no dispara envío). No captura otros sitios ni otras pestañas.
// Factory: window.__ia.createMeetChatSelfLogPoc(state, C, modules)

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  /** Poner en false para desactivar toda la POC sin quitar el script del manifest. */
  const MEET_CHAT_SELF_LOG_POC_ENABLED = true;
  const IS_MEET = location.hostname === 'meet.google.com';

  const STORAGE_KEY = 'iaMeetChatSelfLogPoc';
  const MAX_LINES = 400;
  const DEDUPE_MS = 2000;

  window.__ia.createMeetChatSelfLogPoc = function (_state, _C, modules) {
    let started = false;
    let lastDup = { text: '', t: 0 };
    let fileSessionStart = 0;

    function getMeetingCode() {
      return modules.sessionLog?.getMeetingCodeFromUrl?.() || 'meet';
    }

    function isOurOverlay(el) {
      return !!(el && typeof el.closest === 'function' && el.closest('#ia-interview-overlay'));
    }

    /**
     * Heurística por aria-label del compositor de Meet (ES/EN).
     */
    function looksLikeMeetChatCompose(el) {
      if (!el || isOurOverlay(el)) return false;
      const aria = ((el.getAttribute && el.getAttribute('aria-label')) || '').trim().toLowerCase();
      if (!aria) return false;
      const msgLike =
        aria.includes('send a message') ||
        aria.includes('enviar un mensaje') ||
        aria.includes('mensaje a') ||
        (aria.includes('message') && (aria.includes('send') || aria.includes('group')));
      if (!msgLike) return false;
      if (el.tagName === 'TEXTAREA') return true;
      if (el.getAttribute('contenteditable') === 'true' && el.getAttribute('role') === 'textbox') {
        return true;
      }
      return false;
    }

    function getComposeText(el) {
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        return String(el.value || '').trim();
      }
      if (el.isContentEditable) {
        return String(el.innerText || el.textContent || '').trim();
      }
      return '';
    }

    function buildFileBody(lines, meetingCode) {
      const iso = (t) => new Date(t).toISOString();
      const head = [
        '=== Interview Assistant — POC: mensajes que TÚ envías al chat de Meet (experimental) ===',
        `Reunión: ${meetingCode}`,
        `URL: ${window.location.href}`,
        `Generado: ${iso(Date.now())}`,
        'Nota: heurística por DOM; puede dejar de funcionar si Google cambia Meet.',
        'Captura al pulsar Enter (sin Shift). Cada envío descarga de nuevo el .txt completo actualizado.',
        '',
        '--- Mensajes ---',
        ''
      ];
      const body = lines.map((row) => `[${iso(row.t)}] ${row.text}`).join('\n');
      return head.join('\n') + body;
    }

    function downloadTxt(fullText, meetingCode) {
      const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meet-mi-chat-${meetingCode}-${fileSessionStart}.txt`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    function onKeyDown(e) {
      if (!MEET_CHAT_SELF_LOG_POC_ENABLED) return;
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.isComposing) return;
      const el = e.target;
      if (!looksLikeMeetChatCompose(el)) return;
      const text = getComposeText(el);
      if (!text) return;

      const now = Date.now();
      if (text === lastDup.text && now - lastDup.t < DEDUPE_MS) return;
      lastDup = { text, t: now };

      const meetingCode = getMeetingCode();
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime?.lastError) return;
        const prev = result[STORAGE_KEY];
        if (!prev || prev.meetingCode !== meetingCode) {
          fileSessionStart = Date.now();
        } else if (!fileSessionStart) {
          fileSessionStart = Date.now();
        }

        let lines;
        if (prev && prev.meetingCode === meetingCode && Array.isArray(prev.lines)) {
          lines = prev.lines.concat({ t: now, text });
        } else {
          lines = [{ t: now, text }];
        }
        while (lines.length > MAX_LINES) lines.shift();

        const payload = { meetingCode, lines, updatedAt: now };
        chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
          if (chrome.runtime?.lastError) return;
          downloadTxt(buildFileBody(lines, meetingCode), meetingCode);
        });
      });
    }

    function start() {
      if (!IS_MEET || !MEET_CHAT_SELF_LOG_POC_ENABLED || started) return;
      started = true;
      document.addEventListener('keydown', onKeyDown, true);
    }

    return { start };
  };
})();
