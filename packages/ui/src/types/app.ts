export type ThemeId = 'dark' | 'light' | 'midnight' | 'forest' | 'ocean' | 'sunset' | 'glass-ocean' | 'glass-neon' | 'glass-galaxy' | 'glass-autumn' | 'glass-berry' | 'glass-forest' | 'glass-sunset' | 'glass-rose' | 'glass-midnight' | 'glass-amber' | 'glass-mint' | 'glass-coral' | 'glass-lavender' | 'glass-slate' | 'glass-cherry' | 'glass-gold' | 'glass-miami' | 'glass-electric' | 'glass-hotpink' | 'glass-lime' | 'glass-orange' | 'glass-red' | 'glass-yellow' | 'glass-violet' | 'glass-coral-neon' | 'glass-turquoise' | 'glass-magenta' | 'glass-chartreuse' | 'glass-indigo' | 'solid-midnight' | 'solid-ocean' | 'solid-forest' | 'solid-sunset' | 'solid-berry' | 'solid-rose' | 'solid-amber' | 'solid-mint' | 'solid-coral' | 'solid-lavender' | 'solid-slate' | 'solid-cherry' | 'solid-gold' | 'solid-emerald' | 'solid-sapphire' | 'solid-ruby' | 'solid-amethyst' | 'solid-cosmic' | 'solid-tropical' | 'solid-aurora' | 'solid-tropicana' | 'solid-nebula' | 'solid-monochrome' | 'solid-neon' | 'solid-horizon' | 'solid-dragonfruit' | 'solid-arctic' | 'solid-volcano' | 'solid-zengarden' | 'solid-galaxy' | 'solid-miami' | 'solid-cyberpunk' | 'solid-deepocean' | 'solid-blossom' | 'solid-northern' | 'solid-rainbow' | 'solid-copper' | 'solid-midnightrose' | 'solid-enchanted';

export interface ShortcutsMap {
    [action: string]: string;
}

export type ShortcutAction =
    | 'togglePlay'
    | 'toggleMute'
    | 'cycleSubtitle'
    | 'cycleAudio'
    | 'selectSubtitle'
    | 'selectAudio'
    | 'toggleStats'
    | 'toggleFullscreen'
    | 'toggleGuide'
    | 'toggleCategories'
    | 'toggleLiveTV'
    | 'toggleDvr'
    | 'toggleSettings'
    | 'focusSearch'
    | 'close'
    | 'seekForward'
    | 'seekBackward';

export interface AppSettings {
    theme?: ThemeId;
    language?: string;
    debug?: boolean;
    epgRefreshHours?: number;
    vodRefreshHours?: number;
    channelSortOrder?: string;
    channelFontSize?: number;
    categoryFontSize?: number;
    shortcuts?: ShortcutsMap;
    showSidebar?: boolean;
    startupWidth?: number;
    startupHeight?: number;
    [key: string]: any;
}

export interface MpvStatus {
    playing?: boolean;
    volume?: number;
    muted?: boolean;
    position?: number;
    duration?: number;
    pause?: boolean;
    Idle?: boolean;
}
