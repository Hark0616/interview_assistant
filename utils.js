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
        const name = c.speaker || (isMe ? (myName || 'Yo') : 'Desconocido');
        return `<div class="ia-caption-line ${isMe ? 'ia-me' : 'ia-other'}">
          <span class="ia-speaker">${esc(name)}</span>
          <span class="ia-text">${esc(c.text)}</span>
        </div>`;
      }).join('');
    },

    renderMemoryBullets(view) {
      const esc = window.__ia.utils.escapeHtml;
      const bullets = Array.isArray(view?.bullets) ? view.bullets : [];
      const labels = view?.categoryLabels || {};
      if (!bullets.length) {
        return '<div class="ia-memory-empty">Aún no hay bullets. Se crearán solo a partir de subtítulos.</div>';
      }
      return Object.keys(labels).map((category) => {
        const items = bullets.filter((bullet) => bullet.category === category);
        if (!items.length) return '';
        return `<div class="ia-memory-group">
          <div class="ia-memory-category">${esc(labels[category])}</div>
          ${items.map((bullet) => `<div class="ia-memory-bullet" data-memory-id="${esc(bullet.id)}">
            <div class="ia-memory-text">${esc(bullet.text)}</div>
            <div class="ia-memory-meta">
              <span>${esc(bullet.confidence)}</span>
              <span>${esc(bullet.origin)}</span>
              ${bullet.sourceCaptionIds?.length ? `<span>caps ${bullet.sourceCaptionIds.map(esc).join(', ')}</span>` : ''}
              <div class="ia-memory-actions">
                <button type="button" data-memory-action="edit" title="Editar y confirmar">Editar</button>
                <button type="button" data-memory-action="pin" title="Fijar o desfijar">${bullet.pinned ? 'Desfijar' : 'Fijar'}</button>
                <button type="button" data-memory-action="retire" title="Retirar bullet">Retirar</button>
              </div>
            </div>
          </div>`).join('')}
        </div>`;
      }).join('');
    },
  };
})();
