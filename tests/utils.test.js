import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('utils.js', () => {
  beforeEach(() => {
    // Simular el entorno de la extensión
    global.window = global;
    global.window.__ia = {};
    
    // Cargar el archivo manualmente ya que es un IIFE
    const code = fs.readFileSync(path.resolve(__dirname, '../utils.js'), 'utf8');
    eval(code);
  });

  it('debería escapar caracteres HTML correctamente', () => {
    const { escapeHtml } = window.__ia.utils;
    expect(escapeHtml('<script>alert("hi")&</script>'))
      .toBe('&lt;script&gt;alert(&quot;hi&quot;)&amp;&lt;/script&gt;');
  });

  it('debería usar español por defecto y rechazar valores de idioma no soportados', () => {
    const { normalizeResponseLanguage, responseLanguageLabel } = window.__ia.utils;

    expect(normalizeResponseLanguage()).toBe('es');
    expect(normalizeResponseLanguage(null)).toBe('es');
    expect(normalizeResponseLanguage('fr')).toBe('es');
    expect(normalizeResponseLanguage('EN')).toBe('es');
    expect(normalizeResponseLanguage('en')).toBe('en');
    expect(responseLanguageLabel('en')).toBe('English');
    expect(responseLanguageLabel('fr')).toBe('Español');
  });

  it('debería renderizar líneas de subtítulos correctamente', () => {
    const { renderCaptionLines } = window.__ia.utils;
    const lines = [
      { role: 'interviewer', speaker: 'John', text: 'Hola' },
      { role: 'me', speaker: '', text: 'Qué tal' }
    ];
    
    const html = renderCaptionLines(lines, 'MiNombre');
    
    expect(html).toContain('ia-other');
    expect(html).toContain('John');
    expect(html).toContain('Hola');
    expect(html).toContain('ia-me');
    expect(html).toContain('MiNombre');
    expect(html).toContain('Qué tal');
  });

  it('renderiza controles de memoria escapando contenido editable', () => {
    const html = window.__ia.utils.renderMemoryBullets({
      categoryLabels: { 'candidate-fact': 'Hechos' },
      bullets: [{
        id: 'bullet-1', category: 'candidate-fact', text: '<script>dato</script>',
        confidence: 'confirmed', origin: 'manual', pinned: true, sourceCaptionIds: [7]
      }]
    });

    expect(html).toContain('&lt;script&gt;dato&lt;/script&gt;');
    expect(html).toContain('data-memory-action="edit"');
    expect(html).toContain('Desfijar');
    expect(html).toContain('caps 7');
  });
});
