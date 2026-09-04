/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('captura de Google Meet: DOM, speakers y ciclo del observer', () => {
  let state;
  let capture;
  let modules;
  let locationGetter;

  function meetBlock(speaker, text, textClass = 'ygicle') {
    const block = document.createElement('div');
    block.className = 'nMcdL bj4p3b';
    block.innerHTML = `
      <div class="NWpY1d"></div>
      <div class="${textClass}"></div>
    `;
    block.querySelector('.NWpY1d').textContent = speaker;
    block.querySelector(`.${textClass}`).textContent = text;
    return block;
  }

  function nextMutation() {
    return new Promise((resolve) => setTimeout(resolve, 10));
  }

  beforeEach(() => {
    global.window = global;
    global.window.__ia = {};
    document.body.innerHTML = '';
    locationGetter = vi.spyOn(window, 'location', 'get')
      .mockReturnValue({ hostname: 'meet.google.com' });
    global.requestAnimationFrame = (callback) => setTimeout(callback, 0);

    state = {
      config: { myName: 'María López', debounceMs: 0 },
      isActive: true,
      captionBuffer: [],
      debounceTimer: null,
      seenBlockText: new WeakMap(),
      nextCaptionLineId: 1,
      lastUserSpokeId: null,
      lastAutoContextKey: '',
      manualModeActive: false,
    };

    modules = {
      sessionLog: {
        pushSessionTranscriptLine: vi.fn(),
        syncSessionTranscriptLast: vi.fn(),
        findLastUserSpokeIndex: vi.fn(() => {
          if (state.lastUserSpokeId == null) return -1;
          return state.captionBuffer.findIndex((line) => line.id === state.lastUserSpokeId);
        }),
      },
      ui: { updateStatus: vi.fn(), renderTranscript: vi.fn(), highlightManualBtn: vi.fn() },
      ai: { requestSuggestion: vi.fn() },
    };

    const code = fs.readFileSync(path.resolve(__dirname, '../captionCapture.js'), 'utf8');
    eval(code);
    capture = window.__ia.createCaptionCapture(state, { CAPTION_BUFFER_MAX: 100 }, modules);
  });

  afterEach(() => {
    capture?.stopCaptionObserver();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete global.requestAnimationFrame;
  });

  it('captura inmediatamente bloques Meet ya presentes con speaker y texto separados', () => {
    const root = document.createElement('div');
    root.setAttribute('aria-label', 'Captions');
    root.append(
      meetBlock('Ivan Fuentes', 'Could you describe a difficult production incident?'),
      meetBlock('María López', 'Sí, puedo darte un ejemplo concreto.')
    );
    document.body.appendChild(root);

    capture.startCaptionObserver();

    expect(state.captionBuffer).toHaveLength(2);
    expect(state.captionBuffer.map(({ speaker, role, text }) => ({ speaker, role, text }))).toEqual([
      {
        speaker: 'Ivan Fuentes',
        role: 'interviewer',
        text: 'Could you describe a difficult production incident?',
      },
      {
        speaker: 'María López',
        role: 'me',
        text: 'Sí, puedo darte un ejemplo concreto.',
      },
    ]);
    expect(modules.sessionLog.pushSessionTranscriptLine).toHaveBeenCalledTimes(2);
  });

  it('actualiza una revisión parcial del mismo bloque sin crear una segunda línea', async () => {
    const block = meetBlock('Ivan Fuentes', 'How do you work with');
    document.body.appendChild(block);
    capture.startCaptionObserver();

    block.querySelector('.ygicle').textContent = 'How do you work with Kubernetes in production?';
    await nextMutation();

    expect(state.captionBuffer).toHaveLength(1);
    expect(state.captionBuffer[0]).toMatchObject({
      text: 'How do you work with Kubernetes in production?',
      revision: 2,
      id: 1,
    });
    expect(modules.sessionLog.syncSessionTranscriptLast).toHaveBeenLastCalledWith(
      'Ivan Fuentes',
      'interviewer',
      'How do you work with Kubernetes in production?',
      1,
      2
    );
  });

  it('no duplica el mismo bloque en polling y detecta texto que aparece tarde', async () => {
    vi.useFakeTimers();
    capture.startCaptionObserver();

    const root = document.createElement('div');
    root.setAttribute('aria-label', 'Subtítulos');
    document.body.appendChild(root);
    const block = meetBlock('Ivan Fuentes', 'Tell me about your testing approach.');
    root.appendChild(block);
    await vi.advanceTimersByTimeAsync(10);

    expect(state.captionBuffer).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.captionBuffer).toHaveLength(1);
    expect(modules.sessionLog.pushSessionTranscriptLine).toHaveBeenCalledTimes(1);
  });

  it('si el bloque reutilizado cambia de speaker aunque conserve el mismo texto, separa los roles', async () => {
    const block = meetBlock('Ivan Fuentes', 'I agree with that approach.');
    document.body.appendChild(block);
    capture.startCaptionObserver();

    block.querySelector('.NWpY1d').textContent = 'María López';
    await nextMutation();

    expect(state.captionBuffer).toHaveLength(2);
    expect(state.captionBuffer.map((line) => line.role)).toEqual(['interviewer', 'me']);
    expect(modules.sessionLog.pushSessionTranscriptLine).toHaveBeenCalledTimes(2);
  });

  it('conserva el speaker conocido si Meet lo oculta temporalmente durante una revisión', async () => {
    const block = meetBlock('Ivan Fuentes', 'How do you work with');
    document.body.appendChild(block);
    capture.startCaptionObserver();

    block.querySelector('.NWpY1d').textContent = '';
    block.querySelector('.ygicle').textContent = 'How do you work with Kubernetes in production?';
    await nextMutation();

    expect(state.captionBuffer).toHaveLength(1);
    expect(state.captionBuffer[0]).toMatchObject({
      speaker: 'Ivan Fuentes', role: 'interviewer', revision: 2
    });
    expect(modules.sessionLog.syncSessionTranscriptLast).toHaveBeenLastCalledWith(
      'Ivan Fuentes', 'interviewer', 'How do you work with Kubernetes in production?', 1, 2
    );
  });

  it('completa la identidad si el speaker aparece después de un caption desconocido', async () => {
    const block = meetBlock('', 'Could you describe a production incident?');
    document.body.appendChild(block);
    capture.startCaptionObserver();

    block.querySelector('.NWpY1d').textContent = 'Ivan Fuentes';
    block.querySelector('.ygicle').textContent = 'Could you describe a production incident in detail?';
    await nextMutation();

    expect(state.captionBuffer).toHaveLength(1);
    expect(state.captionBuffer[0]).toMatchObject({
      speaker: 'Ivan Fuentes', role: 'interviewer', revision: 2
    });
  });

  it('actualiza solo la identidad cuando el speaker aparece y el texto es idéntico', async () => {
    const block = meetBlock('', 'Could you describe a production incident?');
    document.body.appendChild(block);
    capture.startCaptionObserver();

    block.querySelector('.NWpY1d').textContent = 'Ivan Fuentes';
    await nextMutation();

    expect(state.captionBuffer).toHaveLength(1);
    expect(state.captionBuffer[0]).toMatchObject({
      speaker: 'Ivan Fuentes', role: 'interviewer', revision: 1
    });
    expect(modules.sessionLog.syncSessionTranscriptLast).toHaveBeenLastCalledWith(
      'Ivan Fuentes', 'interviewer', 'Could you describe a production incident?', 1, 1
    );
  });

  it('usa el fallback aria-live cuando Meet no expone los bloques principales', () => {
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    live.textContent = 'Ivan Fuentes: What is your experience with distributed systems?';
    document.body.appendChild(live);

    capture.startCaptionObserver();

    expect(state.captionBuffer).toHaveLength(1);
    expect(state.captionBuffer[0]).toMatchObject({
      speaker: 'Ivan Fuentes',
      role: 'interviewer',
      text: 'What is your experience with distributed systems?',
    });
  });

  it('procesa la fixture equivalente de Teams con lista virtualizada y fusiona fragmentos', () => {
    locationGetter.mockReturnValue({ hostname: 'teams.microsoft.com' });
    const root = document.createElement('div');
    root.setAttribute('data-tid', 'closed-caption-v2-virtual-list-content');
    root.innerHTML = `
      <div class="fui-ChatMessageCompact">
        <span data-tid="author">Ivan Fuentes</span>
        <span data-tid="closed-caption-text">Could you explain the first part</span>
      </div>
      <div class="fui-ChatMessageCompact">
        <span data-tid="author">Ivan Fuentes</span>
        <span data-tid="closed-caption-text">of your approach?</span>
      </div>
      <div class="fui-ChatMessageCompact">
        <span data-tid="author">María López</span>
        <span data-tid="closed-caption-text">I would start with the facts.</span>
      </div>
    `;
    document.body.appendChild(root);

    capture.startCaptionObserver();

    expect(state.captionBuffer).toHaveLength(2);
    expect(state.captionBuffer[0]).toMatchObject({
      speaker: 'Ivan Fuentes',
      role: 'interviewer',
      text: 'Could you explain the first part of your approach?',
      revision: 2,
    });
    expect(state.captionBuffer[1]).toMatchObject({ speaker: 'María López', role: 'me' });
  });

  it('no clasifica nombres parecidos como el candidato, pero admite nombre o apellido completo', () => {
    expect(capture.isSelfSpeaker('María')).toBe(true);
    expect(capture.isSelfSpeaker('Lopez')).toBe(true);
    expect(capture.isSelfSpeaker('Maria Lopez (You)')).toBe(true);
    expect(capture.isSelfSpeaker('Maribel')).toBe(false);

    state.config.myName = 'Ivan';
    expect(capture.isSelfSpeaker('Ivan')).toBe(true);
    expect(capture.isSelfSpeaker('Divan')).toBe(false);
    expect(capture.isSelfSpeaker('Iván')).toBe(true);
  });

  it('ignora mensajes del sistema y texto vacío/corto; deja un speaker desconocido sin atribución', () => {
    capture.onNewCaption({ speaker: '', text: '', block: document.createElement('div') });
    capture.onNewCaption({ speaker: '', text: 'ok', block: document.createElement('div') });
    capture.onNewCaption({
      speaker: '',
      text: 'Live captions have started.',
      block: document.createElement('div'),
    });
    capture.onNewCaption({
      speaker: '',
      text: 'Could you walk me through your approach?',
      block: document.createElement('div'),
    });

    expect(state.captionBuffer).toHaveLength(1);
    expect(state.captionBuffer[0]).toMatchObject({ speaker: '', role: 'unknown' });
    expect(modules.ai.requestSuggestion).not.toHaveBeenCalled();
    expect(modules.sessionLog.pushSessionTranscriptLine).toHaveBeenCalledTimes(1);
  });

  it('detiene polling y MutationObserver: no procesa cambios después de detener', async () => {
    const root = document.createElement('div');
    root.setAttribute('aria-label', 'Captions');
    document.body.appendChild(root);
    capture.startCaptionObserver();
    capture.stopCaptionObserver();

    root.appendChild(meetBlock('Ivan Fuentes', 'This must not be captured after stop.'));
    await nextMutation();

    expect(state.captionBuffer).toHaveLength(0);
    expect(state.captionObserver).toBeNull();
    expect(state.captionPollInterval).toBeNull();
  });
});
