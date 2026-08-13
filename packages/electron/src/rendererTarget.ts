import path from 'path';
import { app } from 'electron';

export type RendererTarget =
  | { type: 'url'; value: string }
  | { type: 'file'; value: string };

/**
 * Where the renderer bundle lives for the current run. Shared by every window
 * the desktop app opens so the workstation and the customer display always load
 * the same build from the same place.
 */
export function resolveRendererTarget(): RendererTarget {
  if (process.env.NODE_ENV === 'development') {
    return {
      type: 'url',
      value: process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173',
    };
  }

  return {
    type: 'file',
    value: app.isPackaged
      ? path.join(process.resourcesPath, 'web', 'dist', 'index.html')
      : path.join(__dirname, '../../web/dist/index.html'),
  };
}
