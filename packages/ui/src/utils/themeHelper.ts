import type { CustomThemeConfig } from '../types/app';

/**
 * Relative luminance (WCAG) of a hex color, 0 (black) → 1 (white).
 * Returns null for non-hex values so callers can fall back gracefully
 * (e.g. rgba() accent values from themes that don't use hex).
 */
export function relativeLuminance(hex: string): number | null {
  let h = hex.trim();
  if (!/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) return null;
  h = h.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Keeps the scrollbar hover color readable no matter what accent the user
 * picked. Themes allow any accent — including pure black — which becomes
 * invisible when used to "light up" a scrollbar on a dark background.
 *
 * This reads the active `--accent-primary` and `--text-primary`, and if the
 * accent doesn't reach ~3:1 contrast against the theme background it replaces
 * it with white (dark themes) or black (light themes) via the
 * `--scrollbar-hover-color` variable. All scrollbar hover rules reference that
 * variable, so a single theme change updates every scrollbar.
 */
export function updateScrollbarHoverColor(): void {
  const root = document.documentElement;
  if (!root) return;
  const style = getComputedStyle(root);
  const accent = style.getPropertyValue('--accent-primary').trim() || '#00d4ff';
  const text = style.getPropertyValue('--text-primary').trim() || '#ffffff';
  const accentLum = relativeLuminance(accent);
  const textLum = relativeLuminance(text);
  if (accentLum === null || textLum === null) return;
  // Light text ⇒ dark theme (and vice versa). Use text polarity as the
  // background proxy so gradient backgrounds don't need special parsing.
  const darkTheme = textLum >= 0.5;
  const bgLum = darkTheme ? 0.02 : 0.98;
  const ratio = (Math.max(accentLum, bgLum) + 0.05) / (Math.min(accentLum, bgLum) + 0.05);
  const visible = darkTheme ? '#ffffff' : '#000000';
  root.style.setProperty('--scrollbar-hover-color', ratio >= 3 ? accent : visible);
}

export const hexToRgba = (hex: string, alpha: number): string => {
  let c = hex.substring(1);
  if (c.length === 3) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const applyCustomTheme = (config: CustomThemeConfig) => {
  const root = document.documentElement;
  if (!root) return;

  // 1. Background Style
  if (config.backgroundType === 'gradient') {
    const start = config.gradientStart || '#1a0b2e';
    const mid = config.gradientMiddle || '#4a1a6b';
    const end = config.gradientEnd || '#2d1b4e';
    const c4 = config.gradientColor4 || start;
    const c5 = config.gradientColor5 || end;

    const grad = `linear-gradient(135deg, ${start} 0%, ${c4} 25%, ${mid} 50%, ${c5} 75%, ${end} 100%)`;
    root.style.setProperty('--bg-primary', grad);
    root.style.setProperty('--bg-gradient-1', start);
    root.style.setProperty('--bg-gradient-2', mid);
    root.style.setProperty('--bg-gradient-3', end);
    root.style.setProperty('--bg-gradient-4', c4);
    root.style.setProperty('--bg-gradient-5', c5);
  } else {
    const solid = config.backgroundColor || '#1a1a1a';
    root.style.setProperty('--bg-primary', solid);
    root.style.setProperty('--bg-gradient-1', solid);
    root.style.setProperty('--bg-gradient-2', solid);
    root.style.setProperty('--bg-gradient-3', solid);
    root.style.setProperty('--bg-gradient-4', solid);
    root.style.setProperty('--bg-gradient-5', solid);
  }

  const getHex = (val: string, fallback: string) => {
    if (!val) return fallback;
    if (val.startsWith('#')) return val;
    return fallback;
  };

  // 2. Surface Color & Opacity
  const sColor = getHex(config.surfaceColor, '#282828');
  const sOpacity = typeof config.surfaceOpacity === 'number' ? config.surfaceOpacity : 0.85;
  const surfaceRgba = hexToRgba(sColor, sOpacity);
  root.style.setProperty('--surface-color', surfaceRgba);
  root.style.setProperty('--surface-hover', hexToRgba(sColor, Math.min(sOpacity + 0.08, 1)));
  root.style.setProperty('--surface-active', hexToRgba(sColor, Math.min(sOpacity + 0.15, 1)));

  // Derive secondary/tertiary/overlay backgrounds
  const isLightText = (config.textColor || '#ffffff').toLowerCase() !== '#000000' && (config.textColor || '#ffffff').toLowerCase() !== '#1a1a1a';
  const overlayBase = isLightText ? '#000000' : '#ffffff';
  root.style.setProperty('--bg-overlay', hexToRgba(overlayBase, 0.85));
  root.style.setProperty('--bg-secondary', hexToRgba(sColor, Math.min(sOpacity + 0.1, 1)));
  root.style.setProperty('--bg-tertiary', hexToRgba(sColor, Math.min(sOpacity + 0.05, 1)));

  // 3. Surface Border
  const sbColor = getHex(config.surfaceBorderColor, '#ffffff');
  const sbOpacity = typeof config.surfaceBorderOpacity === 'number' ? config.surfaceBorderOpacity : 0.1;
  const borderRgba = hexToRgba(sbColor, sbOpacity);
  root.style.setProperty('--surface-border', borderRgba);
  root.style.setProperty('--glass-border', `1px solid ${borderRgba}`);

  // 4. Accent
  const acc = getHex(config.accentColor, '#00d4ff');
  root.style.setProperty('--accent-primary', acc);
  root.style.setProperty('--text-accent', acc);
  root.style.setProperty('--accent-glow', hexToRgba(acc, 0.4));
  root.style.setProperty('--surface-glow', hexToRgba(acc, 0.15));
  root.style.setProperty('--accent-secondary', acc);

  // 5. Text
  root.style.setProperty('--text-primary', config.textColor || '#ffffff');
  root.style.setProperty('--text-secondary', config.textSecondaryColor || 'rgba(255,255,255,0.7)');
  const textMuted = isLightText ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
  root.style.setProperty('--text-muted', textMuted);

  // 6. Glass Blur & Saturation
  const blurVal = typeof config.glassBlur === 'number' ? config.glassBlur : 20;
  root.style.setProperty('--glass-blur', `${blurVal}px`);

  const satVal = typeof config.glassSaturation === 'number' ? config.glassSaturation : 150;
  root.style.setProperty('--glass-saturation', `${satVal}%`);

  root.style.setProperty('--glass-shadow', isLightText ? '0 8px 32px rgba(0, 0, 0, 0.5)' : '0 8px 32px rgba(0, 0, 0, 0.15)');
  root.style.setProperty('--status-live', '#e74c3c');
  root.style.setProperty('--status-recording', '#e74c3c');
  root.style.setProperty('--status-new', '#2ecc71');

  // 6b. Modal overlay opacity — the scrim behind settings/modals. Kept
  // readable even when the backdrop blur is disabled via the optimization
  // toggle (the v3 overlay token was dropped to 0.4 and relied on blur).
  const overlayOpacity = typeof config.glassOverlayOpacity === 'number' ? config.glassOverlayOpacity : 0.85;
  root.style.setProperty('--glass-overlay-bg', hexToRgba('#08080c', overlayOpacity));

  // 7. Custom background glow bulbs (for v3 liquid glass look)
  const cb1 = getHex(config.customBlob1 || '', '#00bbf5');
  const cb2 = getHex(config.customBlob2 || '', '#ff1493');
  const cb3 = getHex(config.customBlob3 || '', '#ffd700');
  const cb4 = getHex(config.customBlob4 || '', '#76ff03');

  const cb1Opacity = typeof config.customBlob1Opacity === 'number' ? config.customBlob1Opacity : 0.55;
  const cb2Opacity = typeof config.customBlob2Opacity === 'number' ? config.customBlob2Opacity : 0.45;
  const cb3Opacity = typeof config.customBlob3Opacity === 'number' ? config.customBlob3Opacity : 0.35;
  const cb4Opacity = typeof config.customBlob4Opacity === 'number' ? config.customBlob4Opacity : 0.3;

  root.style.setProperty('--custom-blob-1', hexToRgba(cb1, cb1Opacity));
  root.style.setProperty('--custom-blob-2', hexToRgba(cb2, cb2Opacity));
  root.style.setProperty('--custom-blob-3', hexToRgba(cb3, cb3Opacity));
  root.style.setProperty('--custom-blob-4', hexToRgba(cb4, cb4Opacity));

  // 8. Show/hide background bulbs
  // Use opacity/visibility instead of display:none — display changes require a CPU layout pass
  // and can flash for 1-2 frames when GPU compositor renders layers before layout completes.
  const blobHidden = config.showGlassBlobs === false;
  root.style.setProperty('--glass-blob-opacity', blobHidden ? '0' : '0.18');
  root.style.setProperty('--glass-blob-visibility', blobHidden ? 'hidden' : 'visible');
  // De-promote GPU layer when hidden so compositor doesn't render it independently
  root.style.setProperty('--glass-blob-will-change', blobHidden ? 'auto' : 'transform');

  // 9. OLED true-black — replicates the built-in OLED mode (which only applies
  // to the dark-* preset themes via [data-theme^="dark"] in CSS) for custom
  // themes, so a dark custom theme can match the OLED look. Pure-black
  // surfaces, flattened gradients, no backdrop-blur boosts, neutral borders.
  // Runs last so it overrides the surface/glass tokens set above. The
  // --custom-oled-black marker lets extractCurrentThemeVariables round-trip
  // the checkbox, and all touched vars are in settingsDomApplier's
  // CUSTOM_THEME_KEYS so they're cleaned up when leaving the custom theme.
  if (config.oledBlack === true) {
    root.style.setProperty('--bg-primary', '#000000');
    root.style.setProperty('--bg-secondary', '#000000');
    root.style.setProperty('--bg-tertiary', '#050505');
    root.style.setProperty('--bg-overlay', '#000000');
    root.style.setProperty('--bg-gradient-1', '#000000');
    root.style.setProperty('--bg-gradient-2', '#000000');
    root.style.setProperty('--bg-gradient-3', '#000000');
    root.style.setProperty('--surface-color', '#000000');
    root.style.setProperty('--surface-hover', '#0d0d0d');
    root.style.setProperty('--surface-active', '#141414');
    root.style.setProperty('--surface-border', 'rgba(255, 255, 255, 0.08)');
    root.style.setProperty('--surface-glow', 'none');
    root.style.setProperty('--glass-surface-bg', '#000000');
    root.style.setProperty('--glass-settings-bg', '#080808');
    root.style.setProperty('--glass-overlay-bg', 'rgba(0, 0, 0, 0.75)');
    root.style.setProperty('--glass-blur', '0px');
    root.style.setProperty('--glass-saturation', '100%');
    root.style.setProperty('--glass-surface-filter', 'none');
    root.style.setProperty('--glass-modal-filter', 'none');
    root.style.setProperty('--glass-overlay-filter', 'none');
    root.style.setProperty('--glass-settings-filter', 'none');
    root.style.setProperty('--strip-filter', 'none');
    root.style.setProperty('--vs-scrollbar-thumb-bg', 'rgba(255, 255, 255, 0.12)');
    root.style.setProperty('--guide-scroll-strip-thumb-bg', 'rgba(255, 255, 255, 0.12)');
    root.style.setProperty('--custom-oled-black', '1');
  } else {
    // Unchecking OLED: drop the OLED-only overrides so the stylesheet tokens
    // (or the base custom-theme values) win again. Tokens the base sections
    // always write (--bg-*, --surface-*, --glass-blur, --glass-saturation,
    // --glass-overlay-bg) are refreshed by the sections above automatically.
    ['--glass-surface-bg', '--glass-settings-bg', '--glass-surface-filter', '--glass-modal-filter', '--glass-overlay-filter', '--glass-settings-filter', '--strip-filter', '--vs-scrollbar-thumb-bg', '--guide-scroll-strip-thumb-bg', '--custom-oled-black'].forEach((k) => root.style.removeProperty(k));
  }
};

export const extractCurrentThemeVariables = (): CustomThemeConfig => {
  const rootStyle = getComputedStyle(document.documentElement);
  const activeThemeId = document.documentElement.getAttribute('data-theme') || '';

  const parseColorAndOpacity = (colorStr: string) => {
    colorStr = colorStr.trim();
    if (colorStr.startsWith('#')) {
      return { color: colorStr, opacity: 1 };
    }

    const rgbaMatch = colorStr.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
    if (rgbaMatch) {
      const r = parseInt(rgbaMatch[1]);
      const g = parseInt(rgbaMatch[2]);
      const b = parseInt(rgbaMatch[3]);
      const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;

      const componentToHex = (c: number) => {
        const hex = c.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      };
      const hex = '#' + componentToHex(r) + componentToHex(g) + componentToHex(b);
      return { color: hex, opacity: a };
    }
    return { color: '#ffffff', opacity: 1 };
  };

  const getVar = (name: string, fallback: string) => {
    return rootStyle.getPropertyValue(name).trim() || fallback;
  };

  const parseGradientColors = (gradStr: string): string[] => {
    const regex = /(rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+)?\)|#[0-9a-f]{3,6})/gi;
    const matches = gradStr.match(regex);
    return matches ? matches.map(m => m.trim()) : [];
  };

  let backgroundType: 'solid' | 'gradient' = 'solid';
  let backgroundColor = '#1a1a1a';
  let gradientStart = '#1a0b2e';
  let gradientMiddle = '#4a1a6b';
  let gradientEnd = '#2d1b4e';
  let gradientColor4 = '';
  let gradientColor5 = '';

  const bgEl = document.querySelector('.livetv-liquid-glass-bg');
  let computedBg = '';
  if (bgEl) {
    const style = getComputedStyle(bgEl);
    computedBg = (style.backgroundImage && style.backgroundImage !== 'none') 
      ? style.backgroundImage 
      : (style.background || style.backgroundColor || '');
    computedBg = computedBg.trim();
  }

  if (computedBg && computedBg.includes('gradient')) {
    const colors = parseGradientColors(computedBg);
    if (colors.length >= 5) {
      backgroundType = 'gradient';
      gradientStart = colors[0];
      gradientColor4 = colors[1];
      gradientMiddle = colors[2];
      gradientColor5 = colors[3];
      gradientEnd = colors[4];
    } else if (colors.length >= 3) {
      backgroundType = 'gradient';
      gradientStart = colors[0];
      gradientMiddle = colors[1];
      gradientEnd = colors[colors.length - 1];
      gradientColor4 = colors[0];
      gradientColor5 = colors[colors.length - 1];
    } else if (colors.length >= 2) {
      backgroundType = 'gradient';
      gradientStart = colors[0];
      gradientMiddle = colors[0];
      gradientEnd = colors[1];
      gradientColor4 = colors[0];
      gradientColor5 = colors[1];
    } else {
      backgroundType = 'solid';
      backgroundColor = colors[0] || '#1a1a1a';
    }
  } else if (computedBg && !computedBg.includes('none')) {
    backgroundType = 'solid';
    backgroundColor = parseColorAndOpacity(computedBg).color;
  } else {
    // Fallback to CSS variables
    const bgPrimary = getVar('--bg-primary', '#1a1a1a');
    if (bgPrimary.includes('gradient')) {
      backgroundType = 'gradient';
      const colors = parseGradientColors(bgPrimary);
      if (colors.length >= 5) {
        gradientStart = colors[0];
        gradientColor4 = colors[1];
        gradientMiddle = colors[2];
        gradientColor5 = colors[3];
        gradientEnd = colors[4];
      } else if (colors.length >= 3) {
        gradientStart = colors[0];
        gradientMiddle = colors[1];
        gradientEnd = colors[colors.length - 1];
        gradientColor4 = colors[0];
        gradientColor5 = colors[colors.length - 1];
      } else if (colors.length >= 2) {
        gradientStart = colors[0];
        gradientMiddle = colors[0];
        gradientEnd = colors[1];
        gradientColor4 = colors[0];
        gradientColor5 = colors[1];
      }
    } else if (activeThemeId.startsWith('glass-') || activeThemeId.startsWith('solid-')) {
      backgroundType = 'gradient';
      gradientStart = getVar('--bg-gradient-1', '#1a0b2e');
      gradientMiddle = getVar('--bg-gradient-2', '#4a1a6b');
      gradientEnd = getVar('--bg-gradient-3', '#2d1b4e');
      gradientColor4 = getVar('--bg-gradient-4', gradientStart);
      gradientColor5 = getVar('--bg-gradient-5', gradientEnd);
    } else {
      backgroundType = 'solid';
      backgroundColor = parseColorAndOpacity(bgPrimary).color;
    }
  }

  const surfaceInfo = parseColorAndOpacity(getVar('--surface-color', 'rgba(40, 40, 40, 0.85)'));
  const borderInfo = parseColorAndOpacity(getVar('--surface-border', 'rgba(255, 255, 255, 0.1)'));
  const textInfo = parseColorAndOpacity(getVar('--text-primary', '#ffffff'));
  const textSecInfo = parseColorAndOpacity(getVar('--text-secondary', 'rgba(255,255,255,0.7)'));
  const accentInfo = parseColorAndOpacity(getVar('--accent-primary', '#00d4ff'));

  const glassBlurRaw = getVar('--glass-blur', '20px');
  const glassBlur = parseInt(glassBlurRaw) || 0;

  const glassSatRaw = getVar('--glass-saturation', '150%');
  const glassSaturation = parseInt(glassSatRaw) || 100;

  // Determine theme-prefix aware default bulb colors
  const getFallbackBulbs = (themeId: string) => {
    const id = themeId.toLowerCase();

    // 1. Red/Pink/Crimson group
    if (
      id.includes('crimson') ||
      id.includes('pink') ||
      id.includes('rose') ||
      id.includes('berry') ||
      id.includes('cherry') ||
      id.includes('ruby') ||
      id.includes('red') ||
      id.includes('dragonfruit') ||
      id.includes('magenta') ||
      id.includes('volcano')
    ) {
      return {
        b1: 'rgba(255, 0, 80, 0.55)',
        b2: 'rgba(186, 8, 80, 0.45)',
        b3: 'rgba(239, 68, 68, 0.35)',
        b4: 'rgba(147, 51, 234, 0.3)'
      };
    }

    // 2. Green/Orange/Yellow/Coral group
    if (
      id.includes('forest') ||
      id.includes('mint') ||
      id.includes('amber') ||
      id.includes('coral') ||
      id.includes('gold') ||
      id.includes('lime') ||
      id.includes('orange') ||
      id.includes('yellow') ||
      id.includes('chartreuse')
    ) {
      return {
        b1: 'rgba(0, 255, 127, 0.55)',
        b2: 'rgba(255, 165, 0, 0.45)',
        b3: 'rgba(34, 139, 34, 0.35)',
        b4: 'rgba(255, 215, 0, 0.3)'
      };
    }

    // 3. Purple/Violet/Sunset group
    if (
      id.includes('galaxy') ||
      id.includes('sunset') ||
      id.includes('midnight') ||
      id.includes('lavender') ||
      id.includes('violet') ||
      id.includes('amethyst') ||
      id.includes('cosmic') ||
      id.includes('nebula') ||
      id.includes('tropicana') ||
      id.includes('midnightrose')
    ) {
      return {
        b1: 'rgba(138, 43, 226, 0.55)',
        b2: 'rgba(255, 20, 147, 0.45)',
        b3: 'rgba(255, 99, 71, 0.35)',
        b4: 'rgba(75, 0, 130, 0.3)'
      };
    }

    // 4. Blue/Cyan/Indigo group (and default fallback)
    return {
      b1: 'rgba(0, 191, 255, 0.55)',
      b2: 'rgba(0, 100, 255, 0.45)',
      b3: 'rgba(147, 51, 234, 0.35)',
      b4: 'rgba(0, 255, 204, 0.3)'
    };
  };

  const fallbackBulbs = getFallbackBulbs(activeThemeId);

  // Extract custom background glow bulbs
  const parseGradientColor = (gradStr: string, fallback: string) => {
    const transparentRegex = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|transparent/i;
    if (transparentRegex.test(gradStr)) {
      return fallback;
    }
    const match = gradStr.match(/(rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)|#[0-9a-f]{3,6})/i);
    if (match) {
      return match[1];
    }
    return fallback;
  };

  let blob1 = getVar('--custom-blob-1', '');
  let blob2 = getVar('--custom-blob-2', '');
  let blob3 = getVar('--custom-blob-3', '');
  let blob4 = getVar('--custom-blob-4', '');

  const b1El = document.querySelector('.livetv-liquid-glass-bg .blob-1');
  const b2El = document.querySelector('.livetv-liquid-glass-bg .blob-2');
  const b3El = document.querySelector('.livetv-liquid-glass-bg .blob-3');
  const b4El = document.querySelector('.livetv-liquid-glass-bg .blob-4');

  if (b1El && !blob1) {
    const style = getComputedStyle(b1El);
    const gradStr = (style.backgroundImage && style.backgroundImage !== 'none') ? style.backgroundImage : (style.background || style.backgroundColor || '');
    blob1 = parseGradientColor(gradStr, fallbackBulbs.b1);
  }
  if (b2El && !blob2) {
    const style = getComputedStyle(b2El);
    const gradStr = (style.backgroundImage && style.backgroundImage !== 'none') ? style.backgroundImage : (style.background || style.backgroundColor || '');
    blob2 = parseGradientColor(gradStr, fallbackBulbs.b2);
  }
  if (b3El && !blob3) {
    const style = getComputedStyle(b3El);
    const gradStr = (style.backgroundImage && style.backgroundImage !== 'none') ? style.backgroundImage : (style.background || style.backgroundColor || '');
    blob3 = parseGradientColor(gradStr, fallbackBulbs.b3);
  }
  if (b4El && !blob4) {
    const style = getComputedStyle(b4El);
    const gradStr = (style.backgroundImage && style.backgroundImage !== 'none') ? style.backgroundImage : (style.background || style.backgroundColor || '');
    blob4 = parseGradientColor(gradStr, fallbackBulbs.b4);
  }

  blob1 = blob1 || fallbackBulbs.b1;
  blob2 = blob2 || fallbackBulbs.b2;
  blob3 = blob3 || fallbackBulbs.b3;
  blob4 = blob4 || fallbackBulbs.b4;

  const b1Parsed = parseColorAndOpacity(blob1);
  const b2Parsed = parseColorAndOpacity(blob2);
  const b3Parsed = parseColorAndOpacity(blob3);
  const b4Parsed = parseColorAndOpacity(blob4);

  // Determine if moving glass bulbs are visible
  let showGlassBlobs = true;
  const tempTheme = document.documentElement.getAttribute('data-theme') || '';
  if (tempTheme === 'dark' || tempTheme === 'light' || tempTheme.startsWith('dark-')) {
    showGlassBlobs = false;
  } else if (b1El) {
    showGlassBlobs = getComputedStyle(b1El).display !== 'none';
  }

  const overlayParsed = parseColorAndOpacity(getVar('--glass-overlay-bg', 'rgba(8, 8, 12, 0.85)'));

  return {
    backgroundType,
    backgroundColor,
    gradientStart: gradientStart.startsWith('#') ? gradientStart : parseColorAndOpacity(gradientStart).color,
    gradientMiddle: gradientMiddle.startsWith('#') ? gradientMiddle : parseColorAndOpacity(gradientMiddle).color,
    gradientEnd: gradientEnd.startsWith('#') ? gradientEnd : parseColorAndOpacity(gradientEnd).color,
    gradientColor4: gradientColor4 ? (gradientColor4.startsWith('#') ? gradientColor4 : parseColorAndOpacity(gradientColor4).color) : undefined,
    gradientColor5: gradientColor5 ? (gradientColor5.startsWith('#') ? gradientColor5 : parseColorAndOpacity(gradientColor5).color) : undefined,
    accentColor: accentInfo.color,
    textColor: textInfo.color,
    textSecondaryColor: textSecInfo.color,
    surfaceColor: surfaceInfo.color,
    surfaceOpacity: surfaceInfo.opacity,
    surfaceBorderColor: borderInfo.color,
    surfaceBorderOpacity: borderInfo.opacity,
    glassBlur,
    glassSaturation,
    glassOverlayOpacity: overlayParsed.opacity,
    oledBlack: rootStyle.getPropertyValue('--custom-oled-black').trim() === '1',
    customBlob1: b1Parsed.color,
    customBlob1Opacity: b1Parsed.opacity,
    customBlob2: b2Parsed.color,
    customBlob2Opacity: b2Parsed.opacity,
    customBlob3: b3Parsed.color,
    customBlob3Opacity: b3Parsed.opacity,
    customBlob4: b4Parsed.color,
    customBlob4Opacity: b4Parsed.opacity,
    showGlassBlobs
  };
};
