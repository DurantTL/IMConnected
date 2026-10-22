import { parseStoryVideo } from '../lib/story-blocks';
// One popup, no provider request until Play. Ordinary provider links work without this enhancement.
let dialog: HTMLDialogElement | undefined;
let opener: HTMLButtonElement | null = null;
function videoDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  const d = document.createElement('dialog');
  d.className = 'story-video-dialog'; d.setAttribute('aria-labelledby', 'story-video-title');
  d.innerHTML = '<div class="story-video-heading"><h2 id="story-video-title"></h2><button type="button" class="btn" aria-label="Close video">Close video ×</button></div><div class="story-video-stage"></div><p><a class="story-video-fallback" target="_blank" rel="noopener noreferrer">Watch on the video provider</a></p>';
  d.querySelector('button')!.addEventListener('click', () => d.close());
  d.addEventListener('click', (e) => { if (e.target === d) { const rect = d.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) d.close(); } });
  d.addEventListener('close', () => {
    d.querySelector('iframe')?.remove(); // discard the player to stop audio/video immediately
    document.documentElement.classList.remove('video-open');
    if (opener?.isConnected) opener.focus();
    opener = null;
  });
  document.body.append(d); dialog = d; return d;
}
if (typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function') for (const button of document.querySelectorAll<HTMLButtonElement>('[data-load-video]')) {
  button.addEventListener('click', () => {
    const player = button.closest<HTMLElement>('[data-video-embed]');
    const video = parseStoryVideo(player?.dataset.videoEmbed);
    if (!player || !video) return;
    const d = videoDialog(), frame = document.createElement('iframe');
    frame.src = video.embed;
    frame.title = player.dataset.videoTitle || `${video.provider} video`;
    frame.allow = 'encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    d.querySelector('h2')!.textContent = frame.title;
    const fallback = d.querySelector<HTMLAnchorElement>('.story-video-fallback')!;
    fallback.href = video.url; fallback.textContent = `Watch on ${video.provider}`;
    d.querySelector('.story-video-stage')!.replaceChildren(frame);
    opener = button; document.documentElement.classList.add('video-open');
    if (!d.open) d.showModal();
    d.querySelector<HTMLButtonElement>('button')!.focus();
  });
}
