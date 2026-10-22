import { parseStoryVideo } from '../lib/story-blocks';
// No provider request until a reader explicitly loads the player. The normal link works without scripts.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-load-video]')) {
  button.addEventListener('click', () => {
    const player = button.closest<HTMLElement>('[data-video-embed]');
    const video = parseStoryVideo(player?.dataset.videoEmbed);
    if (!player || !video) return;
    const frame = document.createElement('iframe');
    frame.src = video.embed;
    frame.title = player.dataset.videoTitle || `${video.provider} video`;
    frame.allow = 'encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    player.replaceChildren(frame); frame.focus();
  });
}
