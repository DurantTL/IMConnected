// Shared limits for the submit form (browser) and API (server).
export const LIMITS = {
  title: 140,
  dek: 240,
  bodyMin: 200,
  /** Announcements and events are short notices (issue #123). */
  bodyMinNotice: 40,
  bodyMax: 20000,
  maxPhotos: 6,
  maxPhotoMB: 10,
  photoText: 300,
};
