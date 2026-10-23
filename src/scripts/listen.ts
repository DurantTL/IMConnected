// "Listen to this story" (issue #118): reads the visible article aloud with the browser's own speech synthesis.
// No dependency, nothing is sent anywhere, and nothing starts without a click. The control stays hidden unless the
// browser has speechSynthesis and SpeechSynthesisUtterance.

const SKIP_TAGS = new Set(['FIGURE', 'FIGCAPTION', 'BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'FORM', 'IFRAME', 'DIALOG', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'SELECT', 'TEXTAREA', 'INPUT']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'DIV', 'BLOCKQUOTE', 'SECTION', 'ASIDE', 'ARTICLE', 'HEADER', 'FOOTER', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'PRE', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'HR']);
const MAX_CHUNK = 200;

function skipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const c = el.classList;
  return c.contains('photo-caption') || c.contains('photo-credit') || c.contains('photo-credit-inline') || c.contains('share') || c.contains('listen') || c.contains('btn');
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

/** The text blocks to read, in order: title, dek, key points (when present), then the article body. */
export function storyBlocks(root: ParentNode = document): string[] {
  const out: string[] = [];
  for (const sel of ['.article-heading h1', '.article-heading .dek', '.key-points', '#article-body']) {
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
    let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max));
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Sentence-sized chunks (at most about 200 characters) so browsers that stop long utterances keep going. */
export function chunkText(blocks: string[], max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  for (const raw of blocks) {
    const block = /[.!?…:;]["'”’)\]]*$/.test(raw) ? raw : raw + '.';
    const sentences = block.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) ?? [block];
    let cur = '';
    const push = () => { const t = cur.trim(); if (t) chunks.push(t); cur = ''; };
    for (const sentence of sentences) {
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
  const base = lang.split('-')[0].toLowerCase();
  let run = 0; // a new number for every start/stop, so a late "end" event from a cancelled chunk is ignored
  let paused = false;
  const keep = new Set<unknown>(); // the current utterance stays referenced or some browsers drop its events

  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
  const pickVoice = (): SpeechSynthesisVoice | undefined => {
    let voices: SpeechSynthesisVoice[] = [];
    try { voices = synth.getVoices() || []; } catch { /* default voice */ }
    const want = base === 'en' || !voices.some((v) => norm(v).startsWith(base)) ? 'en' : base;
    const match = voices.filter((v) => norm(v).startsWith(want));
    return match.find((v) => norm(v) === lang.toLowerCase() && v.localService) || match.find((v) => norm(v) === lang.toLowerCase()) || match.find((v) => v.default) || match[0];
  };
  const show = (state: 'idle' | 'playing' | 'paused', message: string) => {
    start.hidden = state !== 'idle';
    pause.hidden = state === 'idle';
    stopBtn.hidden = state === 'idle';
    pause.textContent = state === 'paused' ? 'Resume' : 'Pause';
    pause.setAttribute('aria-label', state === 'paused' ? 'Resume listening' : 'Pause listening');
    status.textContent = message;
  };
  const stop = (message = 'Stopped.') => {
    run++; paused = false; keep.clear();
    try { synth.cancel(); } catch { /* nothing to stop */ }
    show('idle', message);
  };

  start.addEventListener('click', () => {
    const chunks = chunkText(storyBlocks());
    if (!chunks.length) return;
    try { synth.cancel(); } catch { /* ignore */ }
    const mine = ++run;
    paused = false;
    const voice = pickVoice();
    let i = 0;
    const next = () => {
      if (mine !== run) return;
      if (i >= chunks.length) { stop('Finished.'); return; }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      u.lang = voice?.lang || lang;
      if (voice) u.voice = voice;
      keep.clear(); keep.add(u);
      u.onend = () => next();
      u.onerror = (e: SpeechSynthesisErrorEvent) => { if (mine !== run || e.error === 'canceled' || e.error === 'interrupted') return; stop('Speech stopped.'); };
      synth.speak(u);
    };
    show('playing', 'Reading the story aloud.');
    next();
    pause.focus();
  });
  pause.addEventListener('click', () => {
    if (paused) { paused = false; synth.resume(); show('playing', 'Resumed.'); } else { paused = true; synth.pause(); show('paused', 'Paused.'); }
  });
  stopBtn.addEventListener('click', () => { stop(); start.focus(); });
  window.addEventListener('pagehide', () => { run++; try { synth.cancel(); } catch { /* ignore */ } });

  box.hidden = false;
}
init();
