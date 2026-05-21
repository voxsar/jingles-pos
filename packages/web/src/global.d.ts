declare global {
  interface Window {
    electronAPI?: {
      app?: {
        backendUrl?: string;
      };
    };
  }
}

export {};
