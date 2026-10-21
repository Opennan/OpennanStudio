// Calculates the export-frame rectangle inside the editor preview host.
const MIN_PREVIEW_PAD_X = 16;
const MAX_PREVIEW_PAD_X = 48;
const MIN_PREVIEW_PAD_Y = 12;
const MAX_PREVIEW_PAD_Y = 32;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getPreviewScreenFrame(
  hostSize: { w: number; h: number },
  projectRatio: number,
): { w: number; h: number } {
  const ratio = Number.isFinite(projectRatio) && projectRatio > 0 ? projectRatio : 16 / 9;
  const padX = clamp(hostSize.w * 0.05, MIN_PREVIEW_PAD_X, MAX_PREVIEW_PAD_X);
  const padY = clamp(hostSize.h * 0.05, MIN_PREVIEW_PAD_Y, MAX_PREVIEW_PAD_Y);
  const availW = Math.max(80, hostSize.w - padX * 2);
  const availH = Math.max(80, hostSize.h - padY * 2);
  const availR = availW / availH;
  let w = availW;
  let h = availH;
  if (availR > ratio) {
    h = availH;
    w = h * ratio;
  } else {
    w = availW;
    h = w / ratio;
  }
  // The 80px floors above can produce a frame LARGER than a collapsed host,
  // which would draw overlays outside the visible preview. Never exceed host.
  if (w > hostSize.w || h > hostSize.h) {
    const shrink = Math.min(hostSize.w / w, hostSize.h / h);
    w *= shrink;
    h *= shrink;
  }
  return { w, h };
}
