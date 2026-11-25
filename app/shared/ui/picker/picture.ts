// A space's picture in Edit Theme Color (M2.9 step 7, docs/SPACE-BACKGROUNDS.md Part B §7): what the default panel
// (ui/picker/panel.ts) and a theme's part (ui/picker/part.ts) share to take one in.
// - `PictureRequests`: given by ui/behaviors/background-picker.ts only where the host serves pictures (Margin.app:
//   `Host.pictureUrl`); without it, neither picker shows a picture's controls. `choose` asks Margin.app for its file
//   picker, `drop` sends a dropped file's bytes; the behaviour saves what comes back (an id) as any edit is saved.
// - A drop on the picker (`pictureDrop`): only a drag that carries files is taken (the page never opens a file
//   dropped on it: Margin.app's window loads nothing but its own page), the first file, an image by its type, at most
//   PICTURE_MAX_BYTES (checked again by Margin.app before it's decoded, and by the core after).
import { PICTURE_MAX_BYTES } from './model.ts';
import { WORDS } from './words.ts';

export type PictureRequests = {
  /** Where the picture with this id is served (its thumbnail), or null. */
  url(id: string): string | null,
  /** Margin.app's file picker. */
  choose(): void,
  /** A file dropped on the picker. */
  drop(file: File): void,
};

const carriesFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

/** What's wrong with a dropped file before it's read (words for the picker), or null: send it. */
export function droppedProblem(file: { type: string, size: number }): string | null {
  if (!/^image\//i.test(file.type)) return WORDS.pictureNotOne;
  if (file.size <= 0) return WORDS.pictureUnreadable;
  if (file.size > PICTURE_MAX_BYTES) return WORDS.pictureTooLarge;
  return null;
}

/**
 * Takes a picture dropped on `target`: `over` while a drag with files is over it (for its look), `dropped` with the
 * first file. Returns what takes it off again.
 */
export function pictureDrop(target: HTMLElement, { over, dropped }: { over: (on: boolean) => void, dropped: (file: File) => void }): () => void {
  let depth = 0;
  const enter = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth++;
    over(true);
  };
  const move = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    // (Taken here: a drop the page doesn't take is the browser's.)
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const leave = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) over(false);
  };
  const drop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    over(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) dropped(file);
  };
  target.addEventListener('dragenter', enter);
  target.addEventListener('dragover', move);
  target.addEventListener('dragleave', leave);
  target.addEventListener('drop', drop);
  return () => {
    target.removeEventListener('dragenter', enter);
    target.removeEventListener('dragover', move);
    target.removeEventListener('dragleave', leave);
    target.removeEventListener('drop', drop);
  };
}

/** A file's bytes as base64 (what `backgroundAdd` takes), or null when it can't be read. */
export function readBase64(file: Blob, win: Window): Promise<string | null> {
  return new Promise((done) => {
    const reader = new (win as Window & typeof globalThis).FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const at = url.indexOf(';base64,');
      done(at >= 0 ? url.slice(at + 8) : null);
    };
    reader.onerror = () => done(null);
    reader.readAsDataURL(file);
  });
}
