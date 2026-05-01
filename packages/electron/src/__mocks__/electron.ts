// Mock for electron in tests
export const app = {
  getPath: (_name: string) => '/home/runner/work/jingles-pos/jingles-pos/packages/electron',
  on: () => {},
  whenReady: () => Promise.resolve(),
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
};

export const BrowserWindow = class {
  loadFile() {}
  webContents = { send: () => {} };
};

export default { app, ipcMain, BrowserWindow };
