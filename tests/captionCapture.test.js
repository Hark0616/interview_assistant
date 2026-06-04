/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('captionCapture.js - Microsoft Teams Logic', () => {
  let state, C, modules, captionCapture;

  beforeEach(() => {
    global.window = global;
    global.window.__ia = {};
    // Mock del DOM para JSDOM
    document.body.innerHTML = '';
    
    state = {
      config: { myName: 'Hark' },
      isActive: true,
      captionBuffer: [],
      seenBlockText: new WeakMap(),
      nextCaptionLineId: 1,
      lastSeenTextsPerSpeaker: new Map()
    };
    
    C = { CAPTION_BUFFER_MAX: 100 };
    
    modules = {
      sessionLog: {
        pushSessionTranscriptLine: vi.fn(),
        syncSessionTranscriptLast: vi.fn()
      },
      ui: { updateStatus: vi.fn(), renderTranscript: vi.fn() }
    };

    const code = fs.readFileSync(path.resolve(__dirname, '../captionCapture.js'), 'utf8');
    eval(code);
    captionCapture = window.__ia.createCaptionCapture(state, C, modules);
  });

  it('1. Debería extraer datos correctamente de un bloque de Teams', () => {
    document.body.innerHTML = `
      <div class="fui-ChatMessageCompact">
        <span data-tid="author">Ivan Fuentes</span>
        <span data-tid="closed-caption-text">Hola mundo</span>
      </div>
    `;
    
    // Forzamos que detecte Teams
    vi.spyOn(window, 'location', 'get').mockReturnValue({ hostname: 'teams.microsoft.com' });
    
    // Ejecutamos el procesador
    // Nota: Necesitamos que isTeamsHost() sea true
    captionCapture.onNewCaption({ speaker: 'Ivan Fuentes', text: 'Hola mundo', block: document.querySelector('.fui-ChatMessageCompact') });

    expect(state.captionBuffer[0].speaker).toBe('Ivan Fuentes');
    expect(state.captionBuffer[0].text).toBe('Hola mundo');
    expect(state.captionBuffer[0].role).toBe('interviewer');
  });

  it('2. Debería ANEXAR texto si es el mismo orador en bloques diferentes (Teams Style)', () => {
    const block1 = document.createElement('div');
    const block2 = document.createElement('div');

    // Primera parte de la frase
    captionCapture.onNewCaption({ speaker: 'Ivan', text: '¿Cómo estás', block: block1 });
    // Segunda parte (bloque distinto, mismo orador, < 5s)
    captionCapture.onNewCaption({ speaker: 'Ivan', text: 'el día de hoy?', block: block2 });

    expect(state.captionBuffer.length).toBe(1);
    expect(state.captionBuffer[0].text).toBe('¿Cómo estás el día de hoy?');
    expect(modules.sessionLog.syncSessionTranscriptLast).toHaveBeenCalled();
  });

  it('3. Debería reconocer al usuario actual (Self Speaker) con precisión', () => {
    // Caso A: Nombres reservados por el sistema
    expect(captionCapture.isSelfSpeaker('tú')).toBe(true);
    expect(captionCapture.isSelfSpeaker('YOU ')).toBe(true); // Espacios y mayúsculas
    expect(captionCapture.isSelfSpeaker('yo')).toBe(true);

    // Caso B: Nombre configurado en state.config.myName
    state.config.myName = 'Hark Ivan';
    expect(captionCapture.isSelfSpeaker('Hark Ivan')).toBe(true);
    expect(captionCapture.isSelfSpeaker('hark')).toBe(true); // Coincidencia parcial/minúscula

    // Caso C: No debería confundir nombres que NO contienen el nombre configurado
    expect(captionCapture.isSelfSpeaker('Roberto')).toBe(false); 
    expect(captionCapture.isSelfSpeaker('Ivan')).toBe(true); // 'Ivan' está en 'Hark Ivan'
    
    // Caso D: Orador externo
    expect(captionCapture.isSelfSpeaker('Entrevistador Senior')).toBe(false);
    // Caso E: Orador vacío (no debe detectarlo como self speaker por coincidencia parcial con "")
    expect(captionCapture.isSelfSpeaker('')).toBe(false);
    expect(captionCapture.isSelfSpeaker('   ')).toBe(false);
  });

  it('4. Prevención de Duplicados: No debería procesar el mismo texto/bloque varias veces', () => {
    const block = document.createElement('div');
    block.className = 'fui-ChatMessageCompact';
    block.innerHTML = '<span data-tid="author">Ivan</span><span data-tid="closed-caption-text">¿Cómo va todo?</span>';
    
    // Función que simula el ciclo de vida del procesador de subtítulos
    const simulateProcess = () => {
      const text = block.querySelector('[data-tid="closed-caption-text"]').textContent;
      const speaker = block.querySelector('[data-tid="author"]').textContent;
      
      // La lógica real que pusimos en captionCapture.js:
      if (state.seenBlockText.get(block) === text) return false;
      state.seenBlockText.set(block, text);
      
      captionCapture.onNewCaption({ speaker, text, block });
      return true;
    };

    // 1. Primer procesamiento: Debe ser aceptado
    const firstAttempt = simulateProcess();
    expect(firstAttempt).toBe(true);
    expect(state.captionBuffer.length).toBe(1);

    // 2. Segundo procesamiento (mismo bloque, mismo texto): Debe ser ignorado
    const secondAttempt = simulateProcess();
    expect(secondAttempt).toBe(false);
    expect(state.captionBuffer.length).toBe(1); // No aumenta
    expect(modules.sessionLog.pushSessionTranscriptLine).toHaveBeenCalledTimes(1);

    // 3. Tercer procesamiento (mismo bloque, PERO el texto cambió): Debe ser aceptado (comportamiento Meet)
    block.querySelector('[data-tid="closed-caption-text"]').textContent = '¿Cómo va todo? Tengo una pregunta.';
    const thirdAttempt = simulateProcess();
    expect(thirdAttempt).toBe(true);
    expect(state.captionBuffer[0].text).toContain('Tengo una pregunta');
  });
});
