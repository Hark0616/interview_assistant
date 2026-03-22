// utils.js — Utilidades compartidas entre content scripts y páginas de extensión
// Se carga antes que el resto de scripts (manifest content_scripts + <script> en panel/popup).

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  window.__ia.utils = {
    escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    FONT_LEVELS: [
      { suggestion: '13px', text: '12px', label: 'A' },
      { suggestion: '18px', text: '16px', label: 'A+' },
      { suggestion: '24px', text: '20px', label: 'A++' },
    ],

    renderCaptionLines(lines, myName) {
      const esc = window.__ia.utils.escapeHtml;
      return lines.map(c => {
        const isMe = c.role === 'me';
        const name = c.speaker || (isMe ? (myName || 'Yo') : 'Entrevistador');
        return `<div class="ia-caption-line ${isMe ? 'ia-me' : 'ia-other'}">
          <span class="ia-speaker">${esc(name)}</span>
          <span class="ia-text">${esc(c.text)}</span>
        </div>`;
      }).join('');
    },
  };
})();
