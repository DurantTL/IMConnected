// "Listen to this story" (issue #118): reads the visible article aloud with the browser's own speech synthesis.
// No dependency, nothing is sent anywhere, and nothing starts without a click. The control stays hidden unless the
// browser has speechSynthesis and SpeechSynthesisUtterance. Voice and speed (issue #165): voices are ranked by
// src/lib/listen-voices.ts and the reader's choice is kept in this browser's localStorage (`imc.listen.v1`).

import { rankVoices, voiceKey, parseSettings, SPEEDS, DEFAULT_RATE, SETTINGS_KEY, SAMPLE_TEXT, type ListenSettings } from '../lib/listen-voices';

const SKIP_TAGS = new Set(['FIGURE', 'FIGCAPTION', 'BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'FORM', 'IFRAME', 'DIALOG', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'SELECT', 'TEXTAREA', 'INPUT']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'DIV', 'BLOCKQUOTE', 'SECTION', 'ASIDE', 'ARTICLE', 'HEADER', 'FOOTER', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'PRE', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'HR']);
const MAX_CHUNK = 200;

function skipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const c = el.classList;
  return c.contains('photo-caption') || c.contains('photo-credit') || c.contains('photo-credit-inline') || c.contains('story-video-player') || c.contains('share') || c.contains('listen') || c.contains('btn');
}

function inlineText(el: Element): string {
  if (skipped(el)) return '';
  if (el.tagName === 'BR') return ' ';
  let s = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) s += n.textContent ?? '';
    else if (n.nodeType === 1) s += inlineText(n as Element);
  }
  return s;
}

function collect(el: Element, out: string[]): void {
  if (skipped(el)) return;
  let buf = '';
  const flush = () => { const t = buf.replace(/\s+/g, ' ').trim(); if (t) out.push(t); buf = ''; };
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) buf += n.textContent ?? '';
    else if (n.nodeType === 1) {
      const child = n as Element;
      if (skipped(child)) continue;
      if (BLOCK_TAGS.has(child.tagName.toUpperCase())) { flush(); collect(child, out); } else buf += inlineText(child);
    }
  }
  flush();
}

/** The text blocks to read, in order: title, dek, key points and event/announcement details (when present), then the article body. */
export function storyBlocks(root: ParentNode = document): string[] {
  const out: string[] = [];
  for (const sel of ['.article-heading h1', '.article-heading .dek', '.key-points', '.announcement-details', '#article-body']) {
    const el = root.querySelector(sel);
    if (!el) continue;
    if (/^H[1-6]$/.test(el.tagName) || el.classList.contains('dek')) { const t = inlineText(el).replace(/\s+/g, ' ').trim(); if (t) out.push(t); } else collect(el, out);
  }
  return out;
}

function splitLong(s: string, max: number): string[] {
  if (s.length <= max) return s ? [s] : [];
  const parts: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let end = Math.max(rest.lastIndexOf(', ', max - 1), rest.lastIndexOf('; ', max - 1)) + 1;
    if (end < max / 2) end = rest.lastIndexOf(' ', max);
    if (end <= 0) end = max;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Sentence-sized chunks (at most about 200 characters) so browsers that stop long utterances keep going. */
export function chunkText(blocks: string[], max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  for (const raw of blocks) {
    const block = /[.!?…:;]["'”’)\]]*$/.test(raw) ? raw : raw + '.';
    let cur = '';
    const push = () => { const t = cur.trim(); if (t) chunks.push(t); cur = ''; };
    for (const sentence of block.replace(/([.!?…]["'”’)\]]*)\s+/g, '$1\u0000').split('\u0000')) {
      for (const piece of splitLong(sentence.trim(), max)) {
        if (cur && (cur + ' ' + piece).length > max) push();
        cur = cur ? cur + ' ' + piece : piece;
      }
    }
    push();
  }
  return chunks;
}

function init(): void {
  const box = document.querySelector<HTMLElement>('[data-listen]');
  if (!box || !('speechSynthesis' in window) || typeof (window as any).SpeechSynthesisUtterance !== 'function') return;
  const synth = window.speechSynthesis;
  const start = box.querySelector<HTMLButtonElement>('[data-listen-start]')!;
  const pause = box.querySelector<HTMLButtonElement>('[data-listen-pause]')!;
  const stopBtn = box.querySelector<HTMLButtonElement>('[data-listen-stop]')!;
  const status = box.querySelector<HTMLElement>('[data-listen-status]')!;
  const lang = (document.documentElement.lang || 'en').trim() || 'en';
  let run = 0; // a new number for every start/stop, so a late "end" event from a cancelled chunk is ignored
  let paused = false;
  let held = false; // a chunk ended while paused: speak the next one on Resume
  let chunks: string[] = [];
  let index = 0; // the next chunk to speak
  let voice: SpeechSynthesisVoice | undefined;
  // The voice fixed when Listen starts: a late voices-changed event must not switch it mid-story. A change of the
  // Voice setting (the reader's own choice) releases it.
  let lockedVoice: SpeechSynthesisVoice | undefined;
  let locked = false;
  // The utterance being spoken. It stays referenced (some browsers drop events of unreferenced ones), and a late
  // end/error event from any other (cancelled or replaced) utterance is ignored.
  let current: SpeechSynthesisUtterance | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const clearWatchdog = () => { if (watchdog !== undefined) clearTimeout(watchdog); watchdog = undefined; };

  // Voices load late in some browsers: ask once now and again when the list changes.
  let voices: SpeechSynthesisVoice[] = [];
  let ranked: SpeechSynthesisVoice[] = [];
  let settings: ListenSettings = { voice: '', rate: DEFAULT_RATE };
  const voiceSel = box.querySelector<HTMLSelectElement>('[data-listen-voice]');
  const rateSel = box.querySelector<HTMLSelectElement>('[data-listen-rate]');
  const tryBtn = box.querySelector<HTMLButtonElement>('[data-listen-try]');
  const readSaved = () => { try { settings = parseSettings(localStorage.getItem(SETTINGS_KEY)); } catch { settings = parseSettings(null); } };
  const save = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* not saved */ } };
  // The chosen voice when the device still has it, otherwise the recommended (first ranked) one.
  const pickVoice = (): SpeechSynthesisVoice | undefined => ranked.find((v) => voiceKey(v) === settings.voice) || ranked.find((v) => v.name === settings.voice) || ranked[0] || voices.find((v) => v.default);
  const fillVoices = () => {
    if (!voiceSel) return;
    voiceSel.textContent = '';
    const seen: Record<string, number> = {};
    ranked.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = voiceKey(v);
      seen[v.name] = (seen[v.name] || 0) + 1;
      const label = seen[v.name] > 1 ? `${v.name} (${seen[v.name]})` : v.name;
      o.textContent = i === 0 ? label + ' (recommended)' : label;
      voiceSel.appendChild(o);
    });
    if (!ranked.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Device default voice';
      voiceSel.appendChild(o);
    }
    const chosen = pickVoice();
    voiceSel.value = chosen ? voiceKey(chosen) : '';
  };
  const loadVoices = () => {
    try { voices = synth.getVoices() || []; } catch { voices = []; }
    ranked = rankVoices(voices, lang);
    fillVoices();
  };
  readSaved();
  if (rateSel) {
    rateSel.textContent = '';
    for (const sp of SPEEDS) { const o = document.createElement('option'); o.value = String(sp.rate); o.textContent = sp.label; rateSel.appendChild(o); }
    rateSel.value = String(settings.rate);
  }
  loadVoices();
  try { synth.addEventListener?.('voiceschanged', loadVoices); } catch { /* the default voice is used */ }
  // Changes apply from the next sentence: speak() reads the settings for every chunk. Focus stays where it is.
  voiceSel?.addEventListener('change', () => { settings.voice = voiceSel.value; locked = false; lockedVoice = undefined; save(); });
  rateSel?.addEventListener('change', () => { const r = Number(rateSel.value); settings.rate = SPEEDS.some((sp) => sp.rate === r) ? r : DEFAULT_RATE; save(); });

  const show = (state: 'idle' | 'playing' | 'paused', message: string) => {
    start.hidden = state !== 'idle';
    pause.hidden = state === 'idle';
    stopBtn.hidden = state === 'idle';
    pause.textContent = state === 'paused' ? 'Resume' : 'Pause';
    pause.setAttribute('aria-label', state === 'paused' ? 'Resume listening' : 'Pause listening');
    status.textContent = message;
  };
  // Chrome and Safari stay paused after cancel(), so always resume first.
  const cancelSpeech = () => {
    try { synth.resume(); } catch { /* ignore */ }
    try { synth.cancel(); } catch { /* nothing to stop */ }
  };
  const stop = (message = 'Stopped.', refocus = true) => {
    run++; paused = false; held = false; current = undefined; clearWatchdog();
    cancelSpeech();
    const hadFocus = box.contains(document.activeElement);
    show('idle', message);
    if (hadFocus && refocus) start.focus();
  };

  const speak = (text: string, mine: number) => {
    const u = new SpeechSynthesisUtterance(text);
    voice = locked ? lockedVoice : pickVoice(); // the settings are read for every chunk, so a change applies from the next sentence
    u.lang = voice?.lang || lang;
    if (voice) u.voice = voice;
    u.rate = settings.rate;
    u.pitch = 1;
    current = u;
    u.onend = () => { if (mine !== run || u !== current) return; if (paused) held = true; else next(); };
    u.onerror = (e: SpeechSynthesisErrorEvent) => { if (mine !== run || u !== current || e.error === 'canceled' || e.error === 'interrupted') return; stop('Speech stopped.'); };
    synth.speak(u);
  };
  const next = () => {
    if (index >= chunks.length) { stop('Finished.'); return; }
    speak(chunks[index++], run);
  };

  start.addEventListener('click', () => {
    chunks = chunkText(storyBlocks());
    if (!chunks.length) return;
    current = undefined; clearWatchdog();
    cancelSpeech();
    run++; paused = false; held = false; index = 0;
    lockedVoice = pickVoice(); locked = true;
    show('playing', 'Reading the story aloud.');
    next();
    pause.focus();
  });
  // Note: on engines where pause() ends the utterance (fires `end`), the rest of that chunk is skipped; Resume continues
  // with the next chunk. Chunks are sentence-sized, so at most a sentence is lost.
  pause.addEventListener('click', () => {
    clearWatchdog();
    if (paused) {
      paused = false;
      show('playing', 'Resumed.');
      if (held) { held = false; try { synth.resume(); } catch { /* ignore */ } next(); return; }
      const mine = run, was = index;
      try { synth.resume(); } catch { /* ignore */ }
      // If the browser did not pick the speech back up, say the current chunk again.
      watchdog = setTimeout(() => {
        watchdog = undefined;
        if (mine !== run || paused || held || index !== was || synth.speaking || index === 0) return;
        current = undefined; // the old utterance's cancel/end event must not advance the story
        cancelSpeech();
        speak(chunks[index - 1], run);
      }, 400);
    } else {
      paused = true;
      try { synth.pause(); } catch { /* ignore */ }
      show('paused', 'Paused.');
    }
  });
  stopBtn.addEventListener('click', () => stop());
  // "Try voice" says one neutral sentence (no story text) with the chosen voice and speed. Idle: just the sample.
  // While reading or paused the story keeps its place: it is left Paused at the chunk that was in progress (or the
  // next one when that chunk had already ended), and Resume continues from there with the new settings. The run
  // counter and `current` are reset first, so a late end from the cancelled chunk can never advance the story.
  tryBtn?.addEventListener('click', () => {
    const active = start.hidden; // Listen is hidden while a story is playing or paused
    const resumeAt = held ? index : Math.max(index - 1, 0);
    if (active) { run++; current = undefined; clearWatchdog(); paused = true; held = true; index = resumeAt; cancelSpeech(); } else stop('', false);
    const u = new SpeechSynthesisUtterance(SAMPLE_TEXT);
    const v = pickVoice();
    u.lang = v?.lang || lang;
    if (v) u.voice = v;
    u.rate = settings.rate;
    u.pitch = 1;
    synth.speak(u);
    if (active) show('paused', 'Playing a voice sample. Press Resume to continue the story.');
  });
  window.addEventListener('pagehide', () => stop(''));
  window.addEventListener('pageshow', (e) => { if (e.persisted) show('idle', ''); });

  box.hidden = false;
}
init();
