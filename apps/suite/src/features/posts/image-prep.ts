/**
 * Getting a picture or a video ready for a post, in the browser (suite spec 09, 7.2).
 *
 * Pictures are drawn to a canvas at most 1440 px wide and saved as JPEG, which also
 * turns PNG, WebP and (where the browser can read it) HEIC into the JPEG that
 * Instagram needs. Videos are uploaded as they are; we only read their length and size.
 */
import { prepareImageSize } from "./posts-logic.js";

export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const PICTURE_TOO_LARGE = "This picture is too large even after shrinking. Use a smaller one.";
export const PICTURE_UNREADABLE = "This picture could not be opened. Try a JPEG or PNG.";
export const VIDEO_UNREADABLE = "This video could not be opened. Use an MP4 or MOV file.";
export const VIDEO_TOO_LARGE = "This video is larger than 100 MB. Use a shorter or smaller one.";

function loadImage(file: Blob): Promise<{ img: HTMLImageElement; release: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(PICTURE_UNREADABLE));
    };
    img.src = url;
  });
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** Scale to at most 1440 px wide and save as JPEG, lowering the quality step by step if it is still over 8 MB. */
export async function prepareImageForPost(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const { img, release } = await loadImage(file);
  try {
    const size = prepareImageSize(img.naturalWidth, img.naturalHeight);
    if (size.width === 0) throw new Error(PICTURE_UNREADABLE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(PICTURE_UNREADABLE);
    // JPEG has no see-through: put white behind a PNG's transparent parts.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(img, 0, 0, size.width, size.height);
    for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      const blob = await toJpeg(canvas, quality);
      if (!blob) throw new Error(PICTURE_UNREADABLE);
      if (blob.size <= MAX_PICTURE_BYTES) return { blob, width: size.width, height: size.height };
    }
    throw new Error(PICTURE_TOO_LARGE);
  } finally {
    release();
  }
}

/** Length and frame size of a video, read from a hidden video element. */
export function readVideoInfo(file: File): Promise<{ durationS: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const done = (): void => URL.revokeObjectURL(url);
    video.onloadedmetadata = () => {
      const info = { durationS: video.duration, width: video.videoWidth, height: video.videoHeight };
      done();
      if (!Number.isFinite(info.durationS) || info.durationS <= 0 || !info.width || !info.height) reject(new Error(VIDEO_UNREADABLE));
      else resolve({ durationS: Math.round(info.durationS * 10) / 10, width: info.width, height: info.height });
    };
    video.onerror = () => {
      done();
      reject(new Error(VIDEO_UNREADABLE));
    };
    video.src = url;
  });
}
