import { Source } from '@ynotv/core';
import { AppSettings } from './app';

declare global {
    interface Window {
        __debugLoggingEnabled?: boolean;
        storage: {
            getSources: () => Promise<{ success: boolean; data?: Source[]; error?: string }>;
            saveSource: (source: Source) => Promise<{ success: boolean; error?: string }>;
            deleteSource: (id: string) => Promise<{ success: boolean; error?: string }>;
            getSettings: () => Promise<{ success: boolean; data?: AppSettings; error?: string }>;
            updateSettings: (settings: AppSettings) => Promise<{ success: boolean; error?: string }>;
            getSource: (id: string) => Promise<{ success: boolean; data?: Source; error?: string }>;
            saveJsonFile: (content: string, defaultName: string) => Promise<{ success: boolean; data?: { filePath: string }; error?: string; canceled?: boolean }>;
            openJsonFile: () => Promise<{ success: boolean; data?: string; error?: string; canceled?: boolean }>;
            importM3UFile: () => Promise<{ success: boolean; data?: { content: string; fileName: string }; error?: string; canceled?: boolean }>;
            isEncryptionAvailable: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
        };
        fetchProxy: {
            fetch: (url: string, options?: any) => Promise<{ data?: { ok: boolean; status: number; statusText: string; text: string; json: () => Promise<any> }; error?: string; success: boolean }>;
            fetchBinary: (url: string) => Promise<{ data?: Uint8Array; success: boolean; error?: string }>;
        };
        debug: {
            logFromRenderer: (msg: string) => Promise<void>;
            getLogPath: () => Promise<{ data?: string }>;
            openLogFolder: () => Promise<void>;
            setDebugLoggingEnabled: (enabled: boolean) => void;
        };
        mpv: any; // MPV player API
        platform?: string;
    }
}

export { };
