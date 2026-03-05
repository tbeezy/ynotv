import { useCallback } from 'react';
import { Bridge } from '../services/tauri-bridge';

export interface WindowManagerState {
  handleMinimize: () => void;
  handleMaximize: () => void;
  handleClose: () => void;
}

export function useWindowManager(): WindowManagerState {
  const handleMinimize = useCallback(() => {
    Bridge.minimize();
  }, []);

  const handleMaximize = useCallback(() => {
    Bridge.toggleMaximize();
  }, []);

  const handleClose = useCallback(() => {
    Bridge.close();
  }, []);

  return {
    handleMinimize,
    handleMaximize,
    handleClose,
  };
}
