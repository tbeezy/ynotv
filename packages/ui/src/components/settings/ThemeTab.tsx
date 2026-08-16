import { useState } from 'react';
import type { ThemeId, CustomThemeConfig } from '../../types/app';
import { extractCurrentThemeVariables } from '../../utils/themeHelper';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

interface ThemeTabProps {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  customThemeConfig?: CustomThemeConfig;
  onCustomThemeConfigChange?: (config: Partial<CustomThemeConfig>) => void;
  oledBlack?: boolean;
  setOledBlack?: (enabled: boolean) => void;
  /** UI design version — OLED true-black only applies to the v3 UI. */
  modernUiEnabled?: boolean | string;
}

const THEMES: { id: ThemeId; name: string; description: string; preview: string; gradient?: string }[] = [
  { id: 'dark', name: 'Dark', description: 'Classic dark theme', preview: '#1a1a1a' },
  { id: 'light', name: 'Light', description: 'Clean light theme', preview: '#f5f5f5' },
  { id: 'dark-crimson', name: 'Dark Crimson', description: 'Crimson red on black', preview: '#ff0033' },
  { id: 'dark-cyan', name: 'Dark Cyan', description: 'Neon cyan on black', preview: '#00d4ff' },
  { id: 'dark-purple', name: 'Dark Purple', description: 'Violet on black', preview: '#b266ff' },
  { id: 'dark-emerald', name: 'Dark Emerald', description: 'Emerald green on black', preview: '#00e676' },
  { id: 'dark-orange', name: 'Dark Orange', description: 'Amber orange on black', preview: '#ff9100' },
  { id: 'dark-pink', name: 'Dark Pink', description: 'Hot pink on black', preview: '#ff4081' },
  { id: 'dark-blue', name: 'Dark Blue', description: 'Royal blue on black', preview: '#448aff' },
  { id: 'dark-gold', name: 'Dark Gold', description: 'Golden yellow on black', preview: '#ffd700' },
  { id: 'dark-lime', name: 'Dark Lime', description: 'Acid lime on black', preview: '#76ff03' },
  { id: 'dark-indigo', name: 'Dark Indigo', description: 'Indigo on black', preview: '#536dfe' },
  // Neutral Dark Themes
  { id: 'dark-slate', name: 'Dark Slate', description: 'Cool slate blue-grey on black', preview: '#6B7A99' },
  { id: 'dark-warmgrey', name: 'Dark Warm Grey', description: 'Subtle warm grey on black', preview: '#8A8A9A' },
  { id: 'dark-steel', name: 'Dark Steel', description: 'Muted dusty blue on black', preview: '#5C7A9E' },
  { id: 'glass-ocean', name: 'Ocean Glass', description: 'Deep blues and teals with glass effect', preview: '#0a1628' },
  { id: 'glass-neon', name: 'Neon Glass', description: 'Cyberpunk vibes with neon accents', preview: '#0d0d1a' },
  { id: 'glass-galaxy', name: 'Galaxy Glass', description: 'Purple and pink nebula effect', preview: '#1a0b2e' },
  { id: 'glass-autumn', name: 'Autumn Glass', description: 'Warm oranges and reds', preview: '#2d1810' },
  { id: 'glass-berry', name: 'Berry Glass', description: 'Deep berry tones', preview: '#2a0f1a' },
  { id: 'glass-forest', name: 'Forest Glass', description: 'Emerald and green tones', preview: '#0d2418' },
  { id: 'glass-sunset', name: 'Sunset Glass', description: 'Purple to orange gradient', preview: '#2d1b4e' },
  { id: 'glass-rose', name: 'Rose Glass', description: 'Soft pink and rose tones', preview: '#2a1518' },
  { id: 'glass-midnight', name: 'Midnight Glass', description: 'Deep midnight blue', preview: '#0a0a14' },
  { id: 'glass-amber', name: 'Amber Glass', description: 'Warm golden amber', preview: '#1a1205' },
  { id: 'glass-mint', name: 'Mint Glass', description: 'Fresh mint green', preview: '#0a1f14' },
  { id: 'glass-coral', name: 'Coral Glass', description: 'Coral and salmon tones', preview: '#2a1512' },
  { id: 'glass-lavender', name: 'Lavender Glass', description: 'Soft lavender purple', preview: '#1a1428' },
  { id: 'glass-slate', name: 'Slate Glass', description: 'Cool slate blue-gray', preview: '#0f172a' },
  { id: 'glass-cherry', name: 'Cherry Glass', description: 'Deep cherry red', preview: '#2a0a0f' },
  { id: 'glass-gold', name: 'Gold Glass', description: 'Luxury gold and yellow', preview: '#1a1508' },
  // Glassmorphism Neon Themes
  { id: 'glass-miami', name: 'Miami Vice', description: 'Hot pink to cyan retro neon', preview: '#1a0a2a' },
  { id: 'glass-electric', name: 'Electric Blue', description: 'Bright blue neon glow', preview: '#0a1528' },
  { id: 'glass-hotpink', name: 'Hot Pink', description: 'Vibrant pink neon', preview: '#2a0a1a' },
  { id: 'glass-lime', name: 'Lime Neon', description: 'Bright green neon', preview: '#0d1a0d' },
  { id: 'glass-orange', name: 'Orange Neon', description: 'Vibrant orange neon', preview: '#2a180a' },
  { id: 'glass-red', name: 'Red Neon', description: 'Bright red neon', preview: '#2a0a0a' },
  { id: 'glass-yellow', name: 'Yellow Neon', description: 'Bright yellow neon', preview: '#2a2a0a' },
  { id: 'glass-violet', name: 'Violet Neon', description: 'Deep purple neon', preview: '#1a0a2a' },
  { id: 'glass-coral-neon', name: 'Coral Neon', description: 'Vibrant coral neon', preview: '#2a1510' },
  { id: 'glass-turquoise', name: 'Turquoise Neon', description: 'Bright cyan-turquoise neon', preview: '#0a2a28' },
  { id: 'glass-magenta', name: 'Magenta Neon', description: 'Deep magenta neon', preview: '#2a0a1f' },
  { id: 'glass-chartreuse', name: 'Chartreuse Neon', description: 'Yellow-green neon', preview: '#1a2a0a' },
  { id: 'glass-indigo', name: 'Indigo Neon', description: 'Deep indigo neon', preview: '#0f0a2a' },
  // Solid Gradient Themes
  { id: 'solid-midnight', name: 'Midnight Vibe', description: 'Deep purple to pink gradient', preview: 'linear-gradient(135deg, #1a0b2e 0%, #4a1a6b 50%, #2d1b4e 100%)', gradient: 'linear-gradient(135deg, #1a0b2e 0%, #4a1a6b 50%, #2d1b4e 100%)' },
  { id: 'solid-ocean', name: 'Ocean Blue', description: 'Deep ocean blue gradient', preview: 'linear-gradient(135deg, #0a1628 0%, #1a3a5c 50%, #0d2137 100%)', gradient: 'linear-gradient(135deg, #0a1628 0%, #1a3a5c 50%, #0d2137 100%)' },
  { id: 'solid-forest', name: 'Forest Green', description: 'Rich emerald gradient', preview: 'linear-gradient(135deg, #0d2418 0%, #1a4a30 50%, #112f1f 100%)', gradient: 'linear-gradient(135deg, #0d2418 0%, #1a4a30 50%, #112f1f 100%)' },
  { id: 'solid-sunset', name: 'Sunset Glow', description: 'Warm orange to purple gradient', preview: 'linear-gradient(135deg, #2d1b4e 0%, #6b3a5c 50%, #4a2540 100%)', gradient: 'linear-gradient(135deg, #2d1b4e 0%, #6b3a5c 50%, #4a2540 100%)' },
  { id: 'solid-berry', name: 'Berry Crush', description: 'Deep berry pink gradient', preview: 'linear-gradient(135deg, #2a0f1a 0%, #5c1a35 50%, #3d1224 100%)', gradient: 'linear-gradient(135deg, #2a0f1a 0%, #5c1a35 50%, #3d1224 100%)' },
  { id: 'solid-rose', name: 'Rose Petal', description: 'Soft rose gradient', preview: 'linear-gradient(135deg, #2a1518 0%, #5c2d3a 50%, #3d1f28 100%)', gradient: 'linear-gradient(135deg, #2a1518 0%, #5c2d3a 50%, #3d1f28 100%)' },
  { id: 'solid-amber', name: 'Amber Gold', description: 'Warm amber gradient', preview: 'linear-gradient(135deg, #1a1205 0%, #3d2810 50%, #2a1c0a 100%)', gradient: 'linear-gradient(135deg, #1a1205 0%, #3d2810 50%, #2a1c0a 100%)' },
  { id: 'solid-mint', name: 'Mint Fresh', description: 'Cool mint gradient', preview: 'linear-gradient(135deg, #0a1f14 0%, #16452e 50%, #0f2e1f 100%)', gradient: 'linear-gradient(135deg, #0a1f14 0%, #16452e 50%, #0f2e1f 100%)' },
  { id: 'solid-coral', name: 'Coral Reef', description: 'Vibrant coral gradient', preview: 'linear-gradient(135deg, #2a1512 0%, #5c3028 50%, #3d201a 100%)', gradient: 'linear-gradient(135deg, #2a1512 0%, #5c3028 50%, #3d201a 100%)' },
  { id: 'solid-lavender', name: 'Lavender Dream', description: 'Soft lavender gradient', preview: 'linear-gradient(135deg, #1a1428 0%, #3d305c 50%, #282040 100%)', gradient: 'linear-gradient(135deg, #1a1428 0%, #3d305c 50%, #282040 100%)' },
  { id: 'solid-slate', name: 'Slate Gray', description: 'Modern slate gradient', preview: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #1a2332 100%)', gradient: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #1a2332 100%)' },
  { id: 'solid-cherry', name: 'Cherry Red', description: 'Bold cherry gradient', preview: 'linear-gradient(135deg, #2a0a0f 0%, #5c1420 50%, #3d0e16 100%)', gradient: 'linear-gradient(135deg, #2a0a0f 0%, #5c1420 50%, #3d0e16 100%)' },
  { id: 'solid-gold', name: 'Golden Hour', description: 'Rich golden gradient', preview: 'linear-gradient(135deg, #1a1508 0%, #3d3010 50%, #2a220a 100%)', gradient: 'linear-gradient(135deg, #1a1508 0%, #3d3010 50%, #2a220a 100%)' },
  { id: 'solid-emerald', name: 'Emerald City', description: 'Vibrant emerald gradient', preview: 'linear-gradient(135deg, #0a1f1a 0%, #16453a 50%, #0f2e28 100%)', gradient: 'linear-gradient(135deg, #0a1f1a 0%, #16453a 50%, #0f2e28 100%)' },
  { id: 'solid-sapphire', name: 'Sapphire Blue', description: 'Deep sapphire gradient', preview: 'linear-gradient(135deg, #0a1428 0%, #162a5c 50%, #0f1d3d 100%)', gradient: 'linear-gradient(135deg, #0a1428 0%, #162a5c 50%, #0f1d3d 100%)' },
  { id: 'solid-ruby', name: 'Ruby Red', description: 'Passionate ruby gradient', preview: 'linear-gradient(135deg, #280a10 0%, #5c1620 50%, #3d0f15 100%)', gradient: 'linear-gradient(135deg, #280a10 0%, #5c1620 50%, #3d0f15 100%)' },
  { id: 'solid-amethyst', name: 'Amethyst', description: 'Mystic purple gradient', preview: 'linear-gradient(135deg, #1a0a28 0%, #3d165c 50%, #280f3d 100%)', gradient: 'linear-gradient(135deg, #1a0a28 0%, #3d165c 50%, #280f3d 100%)' },
  { id: 'solid-cosmic', name: 'Cosmic Purple', description: 'Deep cosmic gradient', preview: 'linear-gradient(135deg, #1a0a2e 0%, #3d1a6b 50%, #2d1b4e 100%)', gradient: 'linear-gradient(135deg, #1a0a2e 0%, #3d1a6b 50%, #2d1b4e 100%)' },
  { id: 'solid-tropical', name: 'Tropical Teal', description: 'Fresh tropical gradient', preview: 'linear-gradient(135deg, #0a1f28 0%, #164545 50%, #0f2e3d 100%)', gradient: 'linear-gradient(135deg, #0a1f28 0%, #164545 50%, #0f2e3d 100%)' },
  // Multicolored Gradient Themes
  { id: 'solid-aurora', name: 'Aurora Borealis', description: 'Green to blue multicolor gradient', preview: 'linear-gradient(135deg, #0d2818 0%, #164a40 25%, #1a5c5c 50%, #1a4a6b 75%, #1a2a5c 100%)', gradient: 'linear-gradient(135deg, #0d2818 0%, #164a40 25%, #1a5c5c 50%, #1a4a6b 75%, #1a2a5c 100%)' },
  { id: 'solid-tropicana', name: 'Tropicana Sunset', description: 'Orange to pink to purple sunset', preview: 'linear-gradient(135deg, #3d1a10 0%, #6b3a1a 25%, #8c4a6b 50%, #6b2d5c 75%, #4a1a4a 100%)', gradient: 'linear-gradient(135deg, #3d1a10 0%, #6b3a1a 25%, #8c4a6b 50%, #6b2d5c 75%, #4a1a4a 100%)' },
  { id: 'solid-nebula', name: 'Cosmic Nebula', description: 'Purple to pink to blue cosmic', preview: 'linear-gradient(135deg, #1a0a2e 0%, #3d1a5c 25%, #5c2a6b 50%, #3d3a8c 75%, #1a3a6b 100%)', gradient: 'linear-gradient(135deg, #1a0a2e 0%, #3d1a5c 25%, #5c2a6b 50%, #3d3a8c 75%, #1a3a6b 100%)' },
  { id: 'solid-monochrome', name: 'Monochrome', description: 'Gray to blue gradient', preview: 'linear-gradient(135deg, #0f1419 0%, #1e293b 25%, #2d3a50 50%, #1e3a5c 75%, #1a2332 100%)', gradient: 'linear-gradient(135deg, #0f1419 0%, #1e293b 25%, #2d3a50 50%, #1e3a5c 75%, #1a2332 100%)' },
  { id: 'solid-neon', name: 'Neon Nights', description: 'Bright neon multicolor glow', preview: 'linear-gradient(135deg, #1a0a3d 0%, #3d0a5c 25%, #5c1a6b 50%, #2a4a7c 75%, #0a3a5c 100%)', gradient: 'linear-gradient(135deg, #1a0a3d 0%, #3d0a5c 25%, #5c1a6b 50%, #2a4a7c 75%, #0a3a5c 100%)' },
  { id: 'solid-horizon', name: 'Horizon Sunset', description: 'Blue to orange sunset gradient', preview: 'linear-gradient(135deg, #0d2137 0%, #1a4a6b 25%, #3d5c7c 50%, #7c4a3d 75%, #5c2d1a 100%)', gradient: 'linear-gradient(135deg, #0d2137 0%, #1a4a6b 25%, #3d5c7c 50%, #7c4a3d 75%, #5c2d1a 100%)' },
  { id: 'solid-dragonfruit', name: 'Dragon Fruit', description: 'Pink magenta with green accents', preview: 'linear-gradient(135deg, #2d1a2d 0%, #5c2a4a 25%, #8c1a5c 50%, #3d5c3d 75%, #1a3d1a 100%)', gradient: 'linear-gradient(135deg, #2d1a2d 0%, #5c2a4a 25%, #8c1a5c 50%, #3d5c3d 75%, #1a3d1a 100%)' },
  { id: 'solid-arctic', name: 'Arctic Ice', description: 'Icy blue to cyan gradient', preview: 'linear-gradient(135deg, #0a1628 0%, #1a3a5c 25%, #2d6a8c 50%, #1a5c6b 75%, #0d3d4a 100%)', gradient: 'linear-gradient(135deg, #0a1628 0%, #1a3a5c 25%, #2d6a8c 50%, #1a5c6b 75%, #0d3d4a 100%)' },
  { id: 'solid-volcano', name: 'Volcano', description: 'Black to red to orange fiery', preview: 'linear-gradient(135deg, #0d0d0d 0%, #2d1a1a 25%, #5c1a1a 50%, #8c3d1a 75%, #5c2d0d 100%)', gradient: 'linear-gradient(135deg, #0d0d0d 0%, #2d1a1a 25%, #5c1a1a 50%, #8c3d1a 75%, #5c2d0d 100%)' },
  // Additional Multicolored Themes
  { id: 'solid-zengarden', name: 'Zen Garden', description: 'Sage green to purple gradient', preview: 'linear-gradient(135deg, #1a2d1a 0%, #2d4a35 20%, #4a5c3d 40%, #6b6b4a 60%, #5c4a6b 80%, #3d2d4a 100%)', gradient: 'linear-gradient(135deg, #1a2d1a 0%, #2d4a35 20%, #4a5c3d 40%, #6b6b4a 60%, #5c4a6b 80%, #3d2d4a 100%)' },
  { id: 'solid-galaxy', name: 'Deep Galaxy', description: 'Black to purple to blue cosmic', preview: 'linear-gradient(135deg, #05050a 0%, #0f0a1f 20%, #1f0a3d 40%, #2d1a5c 60%, #1a3a6b 80%, #0a2d4a 100%)', gradient: 'linear-gradient(135deg, #05050a 0%, #0f0a1f 20%, #1f0a3d 40%, #2d1a5c 60%, #1a3a6b 80%, #0a2d4a 100%)' },
  { id: 'solid-miami', name: 'Miami Vice', description: 'Pink to cyan retro gradient', preview: 'linear-gradient(135deg, #2d1a3d 0%, #5c1a5c 25%, #ff00ff 50%, #00ffff 75%, #1a4a5c 100%)', gradient: 'linear-gradient(135deg, #2d1a3d 0%, #5c1a5c 25%, #ff00ff 50%, #00ffff 75%, #1a4a5c 100%)' },
  { id: 'solid-cyberpunk', name: 'Cyberpunk', description: 'Yellow to magenta to cyan neon', preview: 'linear-gradient(135deg, #2d2a0d 0%, #5c5c1a 25%, #ffff00 50%, #ff00ff 75%, #00ffff 100%)', gradient: 'linear-gradient(135deg, #2d2a0d 0%, #5c5c1a 25%, #ffff00 50%, #ff00ff 75%, #00ffff 100%)' },
  { id: 'solid-deepocean', name: 'Deep Ocean', description: 'Dark navy to teal to purple', preview: 'linear-gradient(135deg, #050a1f 0%, #0d1f3d 25%, #1a3a5c 50%, #1a5c6b 75%, #2d1a5c 100%)', gradient: 'linear-gradient(135deg, #050a1f 0%, #0d1f3d 25%, #1a3a5c 50%, #1a5c6b 75%, #2d1a5c 100%)' },
  { id: 'solid-blossom', name: 'Cherry Blossom', description: 'Pink to lavender to cream', preview: 'linear-gradient(135deg, #2d1a2d 0%, #4a2d3d 25%, #6b3d4a 50%, #8c5c6b 75%, #6b5c8c 100%)', gradient: 'linear-gradient(135deg, #2d1a2d 0%, #4a2d3d 25%, #6b3d4a 50%, #8c5c6b 75%, #6b5c8c 100%)' },
  { id: 'solid-northern', name: 'Northern Lights', description: 'Teal to green to purple shimmer', preview: 'linear-gradient(135deg, #0a1f28 0%, #1a3d4a 20%, #2d6b5c 40%, #4a8c6b 60%, #6b4a8c 80%, #3d1a5c 100%)', gradient: 'linear-gradient(135deg, #0a1f28 0%, #1a3d4a 20%, #2d6b5c 40%, #4a8c6b 60%, #6b4a8c 80%, #3d1a5c 100%)' },
  // Final Multicolored Themes
  { id: 'solid-rainbow', name: 'Rainbow Prism', description: 'Full spectrum multicolor gradient', preview: 'linear-gradient(135deg, #2d1a3d 0%, #3d1a5c 15%, #5c2a6b 30%, #6b4a3d 45%, #5c6b2a 60%, #2a6b5c 75%, #1a3a5c 90%, #2d1a4a 100%)', gradient: 'linear-gradient(135deg, #2d1a3d 0%, #3d1a5c 15%, #5c2a6b 30%, #6b4a3d 45%, #5c6b2a 60%, #2a6b5c 75%, #1a3a6b 90%, #2d1a4a 100%)' },
  { id: 'solid-copper', name: 'Copper Teal', description: 'Warm copper to teal gradient', preview: 'linear-gradient(135deg, #2d1810 0%, #4a2d1a 25%, #6b3d28 50%, #2a6b6b 75%, #1a4a4a 100%)', gradient: 'linear-gradient(135deg, #2d1810 0%, #4a2d1a 25%, #6b3d28 50%, #2a6b6b 75%, #1a4a4a 100%)' },
  { id: 'solid-midnightrose', name: 'Midnight Rose', description: 'Dark purple to burgundy to pink', preview: 'linear-gradient(135deg, #1a0a1f 0%, #2d1a3d 25%, #4a1a3d 50%, #6b2a4a 75%, #3d1a2d 100%)', gradient: 'linear-gradient(135deg, #1a0a1f 0%, #2d1a3d 25%, #4a1a3d 50%, #6b2a4a 75%, #3d1a2d 100%)' },
  { id: 'solid-enchanted', name: 'Enchanted Forest', description: 'Deep green to purple to blue', preview: 'linear-gradient(135deg, #0d1a0d 0%, #1a2d1a 25%, #2d1a3d 50%, #1a3a5c 75%, #0d2d4a 100%)', gradient: 'linear-gradient(135deg, #0d1a0d 0%, #1a2d1a 25%, #2d1a3d 50%, #1a3a5c 75%, #0d2d4a 100%)' },
];

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (val: string) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          background: value,
          border: '2px solid var(--surface-border)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
          transition: 'transform 0.15s ease'
        }}
        onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.08)'}
        onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
        >
          <input 
            type="color" 
            value={value} 
            onChange={(e) => onChange(e.target.value)} 
            style={{
              position: 'absolute',
              top: '-10px',
              left: '-10px',
              width: '60px',
              height: '60px',
              opacity: 0,
              cursor: 'pointer'
            }}
          />
        </div>
        <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
          {value.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

function SliderInput({ 
  label, 
  min, 
  max, 
  step, 
  value, 
  displayValue,
  onChange 
}: { 
  label: string; 
  min: number; 
  max: number; 
  step: number; 
  value: number; 
  displayValue: string;
  onChange: (val: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</label>
        <span style={{ fontSize: '0.8rem', color: 'var(--accent-primary, #00d4ff)', fontWeight: 600 }}>{displayValue}</span>
      </div>
      <input 
        type="range" 
        min={min} 
        max={max} 
        step={step} 
        value={value} 
        onChange={(e) => onChange(parseFloat(e.target.value))} 
        style={{
          width: '100%',
          height: '6px',
          borderRadius: '3px',
          background: 'var(--surface-color)',
          outline: 'none',
          cursor: 'pointer',
          accentColor: 'var(--accent-primary, #00d4ff)'
        }}
      />
    </div>
  );
}

function ButtonGroupSelector<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: { id: T; name: string }[];
  value: T;
  onChange: (val: T) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</label>
      <div style={{ display: 'flex', background: 'var(--bg-tertiary)', padding: '4px', borderRadius: '8px', border: '1px solid var(--surface-border)' }}>
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            style={{
              flex: 1,
              padding: '6px 12px',
              background: value === opt.id ? 'var(--accent-primary, #00d4ff)' : 'transparent',
              color: value === opt.id ? 'black' : 'var(--text-primary)',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ThemeTab({
  theme,
  onThemeChange,
  customThemeConfig,
  onCustomThemeConfigChange,
  oledBlack = false,
  setOledBlack,
  modernUiEnabled
}: ThemeTabProps) {
  useTranslation();
  const appFontFamily = useSettingsStore((s) => s.appFontFamily);
  const appCustomFontBase64 = useSettingsStore((s) => s.appCustomFontBase64);
  const appCustomFontFormat = useSettingsStore((s) => s.appCustomFontFormat);
  const appCustomFontName = useSettingsStore((s) => s.appCustomFontName);
  const updateAppFont = useSettingsStore((s) => s.updateAppFont);
  const savedCustomThemes = useSettingsStore((s) => s.savedCustomThemes);
  const setSavedCustomThemes = useSettingsStore((s) => s.setSavedCustomThemes);

  const [activeSubTab, setActiveSubTab] = useState<'premade' | 'custom'>(() => {
    return theme === 'custom' ? 'custom' : 'premade';
  });

  const [newThemeName, setNewThemeName] = useState('');
  const [copiedThemeId, setCopiedThemeId] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [importSuccess, setImportSuccess] = useState('');

  const handleThemeChange = async (newTheme: ThemeId) => {
    onThemeChange(newTheme);
    if (window.storage) {
      await window.storage.updateSettings({ theme: newTheme });
    }
  };

  const handleCustomizeCurrent = () => {
    if (onCustomThemeConfigChange) {
      const currentVars = extractCurrentThemeVariables();
      onCustomThemeConfigChange(currentVars);
    }
    handleThemeChange('custom');
    setActiveSubTab('custom');
  };

  const handleSaveTheme = () => {
    if (!customThemeConfig) return;
    const name = newThemeName.trim() || 'My Custom Theme';
    const newId = `custom-${Date.now()}`;
    const newTheme: CustomThemeConfig = {
      ...customThemeConfig,
      id: newId,
      themeName: name
    };
    setSavedCustomThemes([...savedCustomThemes, newTheme]);
    setNewThemeName('');
    handleThemeChange('custom');
  };

  const handleLoadCustomTheme = (themeConfig: CustomThemeConfig) => {
    if (onCustomThemeConfigChange) {
      onCustomThemeConfigChange(themeConfig);
    }
    handleThemeChange('custom');
  };

  const handleDeleteCustomTheme = (id: string) => {
    setSavedCustomThemes(savedCustomThemes.filter(t => t.id !== id));
  };

  const handleExportTheme = (themeConfig: CustomThemeConfig) => {
    const jsonStr = JSON.stringify(themeConfig, null, 2);
    navigator.clipboard.writeText(jsonStr).then(() => {
      if (themeConfig.id) {
        setCopiedThemeId(themeConfig.id);
        setTimeout(() => setCopiedThemeId(null), 2000);
      }
    });
  };

  const handleDownloadTheme = (themeConfig: CustomThemeConfig) => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(themeConfig, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${themeConfig.themeName || 'custom-theme'}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleImportTheme = () => {
    try {
      const parsed = JSON.parse(importText);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(i18n.t('settings:theme.errInvalidConfig'));
      }
      if (!parsed.backgroundType) {
        throw new Error(i18n.t('settings:theme.errMissingBgType'));
      }
      const importedTheme: CustomThemeConfig = {
        ...parsed,
        id: parsed.id || `custom-${Date.now()}`,
        themeName: parsed.themeName || `Imported Theme (${new Date().toLocaleDateString()})`
      };
      setSavedCustomThemes([...savedCustomThemes, importedTheme]);
      if (onCustomThemeConfigChange) {
        onCustomThemeConfigChange(importedTheme);
      }
      handleThemeChange('custom');
      setImportText('');
      setImportError('');
      setImportSuccess(i18n.t('settings:theme.importSuccess'));
      setTimeout(() => setImportSuccess(''), 3000);
    } catch (e: any) {
      setImportError(e.message || i18n.t('settings:theme.errParseJson'));
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error(i18n.t('settings:theme.errInvalidConfig'));
        }
        if (!parsed.backgroundType) {
          throw new Error(i18n.t('settings:theme.errMissingBgType'));
        }
        const importedTheme: CustomThemeConfig = {
          ...parsed,
          id: parsed.id || `custom-${Date.now()}`,
          themeName: parsed.themeName || file.name.replace('.json', '')
        };
        setSavedCustomThemes([...savedCustomThemes, importedTheme]);
        if (onCustomThemeConfigChange) {
          onCustomThemeConfigChange(importedTheme);
        }
        handleThemeChange('custom');
        setImportSuccess(i18n.t('settings:theme.importSuccessFile'));
        setTimeout(() => setImportSuccess(''), 3000);
      } catch (err: any) {
        alert(i18n.t('settings:theme.importFailed', { message: err.message }));
      }
    };
    reader.readAsText(file);
  };

  const handleLoadPreset = (presetId: ThemeId) => {
    const oldTheme = theme;
    
    // Clear inline custom theme variables temporarily so getComputedStyle reads the preset's actual values from themes.css
    const customKeys = [
      '--bg-primary',
      '--bg-secondary',
      '--bg-tertiary',
      '--surface-color',
      '--surface-hover',
      '--surface-active',
      '--surface-border',
      '--surface-glow',
      '--text-primary',
      '--text-secondary',
      '--text-muted',
      '--text-accent',
      '--accent-primary',
      '--accent-secondary',
      '--accent-glow',
      '--glass-blur',
      '--glass-saturation',
      '--glass-border',
      '--glass-shadow',
      '--bg-gradient-1',
      '--bg-gradient-2',
      '--bg-gradient-3',
      '--bg-gradient-4',
      '--bg-gradient-5',
      '--custom-blob-1',
      '--custom-blob-2',
      '--custom-blob-3',
      '--custom-blob-4',
      '--font-family'
    ];
    
    const savedInlineStyles: Record<string, string> = {};
    customKeys.forEach(key => {
      const val = document.documentElement.style.getPropertyValue(key);
      if (val) {
        savedInlineStyles[key] = val;
        document.documentElement.style.removeProperty(key);
      }
    });
    const styleEl = document.getElementById('custom-theme-font-face');
    if (styleEl) styleEl.remove();

    // Temporarily apply theme to documentElement to extract computed properties
    document.documentElement.setAttribute('data-theme', presetId);
    const presetVars = extractCurrentThemeVariables();
    
    // Restore theme state
    document.documentElement.setAttribute('data-theme', oldTheme);
    
    // Restore inline styles
    Object.entries(savedInlineStyles).forEach(([key, val]) => {
      document.documentElement.style.setProperty(key, val);
    });

    if (onCustomThemeConfigChange) {
      onCustomThemeConfigChange(presetVars);
    }
    if (theme !== 'custom') {
      handleThemeChange('custom');
    }
  };

  const handleResetToDefaultCustom = () => {
    if (onCustomThemeConfigChange) {
      onCustomThemeConfigChange({
        backgroundType: 'solid',
        backgroundColor: '#1a1a1a',
        gradientStart: '#1a0b2e',
        gradientMiddle: '#4a1a6b',
        gradientEnd: '#2d1b4e',
        accentColor: '#00d4ff',
        textColor: '#ffffff',
        textSecondaryColor: 'rgba(255,255,255,0.7)',
        surfaceColor: '#282828',
        surfaceOpacity: 0.85,
        surfaceBorderColor: '#ffffff',
        surfaceBorderOpacity: 0.1,
        glassBlur: 20,
        glassSaturation: 150,
        customBlob1: '#00bbf5',
        customBlob2: '#ff1493',
        customBlob3: '#ffd700',
        customBlob4: '#76ff03',
        customBlob1Opacity: 0.55,
        customBlob2Opacity: 0.45,
        customBlob3Opacity: 0.35,
        customBlob4Opacity: 0.3,
        showGlassBlobs: true
      });
    }
  };

  const activeThemeObj = THEMES.find(t => t.id === theme);

  // OLED true-black only makes sense in the v3 UI and for the dark family
  // (dark + dark-* presets). Custom/light/glass/solid themes are unaffected.
  // v3 is the default UI (and legacy settings may store `true` for modern).
  const isV3Ui = modernUiEnabled === 'v3' || modernUiEnabled === true || modernUiEnabled === undefined;
  const themeIsDarkFamily = theme === 'dark' || theme.startsWith('dark-');

  return (
    <div className="settings-tab-content">
      {/* Sub Tab Navigation */}
      <div style={{
        display: 'flex',
        gap: '12px',
        borderBottom: '1px solid var(--surface-border)',
        paddingBottom: '12px',
        marginBottom: '20px'
      }}>
        <button
          onClick={() => setActiveSubTab('premade')}
          style={{
            padding: '8px 16px',
            background: activeSubTab === 'premade' ? 'var(--surface-color)' : 'transparent',
            color: activeSubTab === 'premade' ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: 'none',
            borderRadius: '20px',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          🎨 {i18n.t('settings:theme.presetThemes')}
        </button>
        <button
          onClick={() => setActiveSubTab('custom')}
          style={{
            padding: '8px 16px',
            background: activeSubTab === 'custom' ? 'var(--surface-color)' : 'transparent',
            color: activeSubTab === 'custom' ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: 'none',
            borderRadius: '20px',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          🛠️ {i18n.t('settings:theme.customTheme')}
        </button>
      </div>

      {activeSubTab === 'premade' && (
        <div className="settings-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div className="section-header" style={{ marginBottom: 0 }}>
              <h3 style={{ margin: 0 }}>{i18n.t('settings:theme.selectTheme')}</h3>
            </div>
            {theme !== 'custom' && (
              <button
                onClick={handleCustomizeCurrent}
                style={{
          background: 'var(--surface-color)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: '20px',
                  padding: '6px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--accent-primary, #00d4ff)';
                  e.currentTarget.style.color = 'black';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--surface-color)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }}
              >
                🎨 {i18n.t('settings:theme.customizeQuote', { name: activeThemeObj?.name || theme })}
              </button>
            )}
          </div>

          <p className="section-description">
            {i18n.t('settings:theme.selectThemeSub')}
          </p>

          {/* OLED True-Black — v3 only, applies to the dark-family themes */}
          {isV3Ui && themeIsDarkFamily && (
            <div className="form-group" style={{ marginTop: '1.5rem', marginBottom: '0.75rem', textTransform: 'none', letterSpacing: 'normal' }}>
              <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', userSelect: 'none', textTransform: 'none', letterSpacing: 'normal' }}>
                <input
                  type="checkbox"
                  checked={oledBlack}
                  onChange={(e) => setOledBlack?.(e.target.checked)}
                />
                <span className="genre-name" style={{ fontSize: '0.95rem', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
                  {i18n.t('settings:theme.oledBlack')}
                </span>
              </label>
              <p className="form-hint" style={{ marginTop: '0.5rem', textTransform: 'none', letterSpacing: 'normal' }}>
                {i18n.t('settings:theme.oledBlackSub', { theme: activeThemeObj?.name || theme })}
              </p>
            </div>
          )}

          <div className="theme-grid" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: '12px',
            marginTop: '1.5rem'
          }}>
            {/* Show Custom Option in Grid too if it was configured */}
            {customThemeConfig && (
              <button
                onClick={() => handleThemeChange('custom')}
                className={`theme-option ${theme === 'custom' ? 'active' : ''}`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  padding: '16px 12px',
                  borderRadius: '12px',
                  border: theme === 'custom'
                    ? '2px solid var(--accent-primary, #00d4ff)'
                    : '1px solid var(--surface-border)',
                  background: theme === 'custom'
                    ? 'var(--surface-glow)'
                    : 'var(--surface-color)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: theme === 'custom'
                    ? '0 0 20px rgba(0, 212, 255, 0.3)'
                    : 'none'
                }}
              >
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    background: customThemeConfig.backgroundType === 'gradient'
                      ? `linear-gradient(135deg, ${customThemeConfig.gradientStart} 0%, ${customThemeConfig.gradientEnd} 100%)`
                      : customThemeConfig.backgroundColor,
                    marginBottom: '10px',
                    border: '2px solid var(--surface-border)',
                    boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                    position: 'relative',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontSize: '18px'
                  }}
                >
                  ⚙️
                </div>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', textAlign: 'center', marginBottom: '4px' }}>
                  {i18n.t('settings:theme.customThemeGrid')}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.3 }}>
                  {i18n.t('settings:theme.customThemeGridSub')}
                </span>
                {theme === 'custom' && (
                  <div style={{
                    position: 'absolute',
                    top: '8px',
                    right: '8px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: 'var(--accent-primary, #00d4ff)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    color: 'white'
                  }}>
                    ✓
                  </div>
                )}
              </button>
            )}

            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => handleThemeChange(t.id)}
                className={`theme-option ${theme === t.id ? 'active' : ''}`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  padding: '16px 12px',
                  borderRadius: '12px',
                  border: theme === t.id
                    ? '2px solid var(--accent-primary, #00d4ff)'
                    : '1px solid var(--surface-border)',
                  background: theme === t.id
                    ? 'var(--surface-glow)'
                    : 'var(--surface-color)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: theme === t.id
                    ? '0 0 20px rgba(0, 212, 255, 0.3)'
                    : 'none'
                }}
              >
                {/* Color Preview */}
                <div
                  className="theme-preview"
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    background: t.gradient || t.preview,
                    marginBottom: '10px',
                    border: '2px solid var(--surface-border)',
                    boxShadow: (t.id.includes('glass') || t.id.includes('solid'))
                      ? '0 4px 15px rgba(0,0,0,0.3), inset 0 0 20px rgba(255,255,255,0.1)'
                      : '0 2px 8px rgba(0,0,0,0.2)',
                    position: 'relative',
                    overflow: 'hidden'
                  }}
                >
                  {(t.id.includes('glass') || t.id.includes('solid')) && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '20%',
                        left: '20%',
                        right: '20%',
                        bottom: '20%',
                        background: 'rgba(255,255,255,0.2)',
                        borderRadius: '50%',
                        filter: 'blur(8px)'
                      }}
                    />
                  )}
                </div>

                {/* Theme Name */}
                <span style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  textAlign: 'center',
                  marginBottom: '4px'
                }}>
                  {t.name}
                </span>

                {/* Theme Description */}
                <span style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                  textAlign: 'center',
                  lineHeight: 1.3
                }}>
                  {t.description}
                </span>

                {/* Checkmark for active theme */}
                {theme === t.id && (
                  <div style={{
                    position: 'absolute',
                    top: '8px',
                    right: '8px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: 'var(--accent-primary, #00d4ff)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    color: 'white'
                  }}>
                    ✓
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeSubTab === 'custom' && (
        <div className="settings-section">
          {/* Status Header */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: theme === 'custom' ? 'var(--surface-glow)' : 'var(--surface-color)',
            border: theme === 'custom' ? '1px solid var(--accent-glow)' : '1px solid var(--surface-border)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '20px',
            boxShadow: theme === 'custom' ? '0 4px 15px rgba(0, 212, 255, 0.1)' : 'none'
          }}>
            <div>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'block', fontSize: '0.95rem', marginBottom: '4px' }}>
                🎨 {i18n.t('settings:theme.themeCreator')}
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {theme === 'custom' 
                  ? i18n.t('settings:theme.themeActiveDesc') 
                  : i18n.t('settings:theme.themeInactiveDesc')}
              </span>
            </div>
            {theme !== 'custom' ? (
              <button
                onClick={handleCustomizeCurrent}
                style={{
                  background: 'var(--accent-primary, #00d4ff)',
                  color: 'black',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '10px 20px',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: '0 4px 12px rgba(0, 212, 255, 0.25)'
                }}
                onMouseEnter={(e) => e.currentTarget.style.filter = 'brightness(1.15)'}
                onMouseLeave={(e) => e.currentTarget.style.filter = 'none'}
              >
                {i18n.t('settings:theme.startCustomizing')}
              </button>
            ) : (
              <span style={{
                background: 'var(--surface-glow)',
                color: 'var(--accent-primary)',
                borderRadius: '20px',
                padding: '4px 12px',
                fontSize: '0.75rem',
                fontWeight: 600,
                border: '1px solid var(--accent-glow)'
              }}>
                ● {i18n.t('settings:theme.active')}
              </span>
            )}
          </div>

          {theme === 'custom' && customThemeConfig && onCustomThemeConfigChange && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Presets and Actions */}
              <div style={{
                display: 'flex',
                gap: '16px',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                background: 'var(--surface-color)',
                padding: '12px 16px',
                borderRadius: '8px',
                border: '1px solid var(--surface-border)'
              }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1, minWidth: '240px' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{i18n.t('settings:theme.copyPreset')}</span>
                  <select
                    onChange={(e) => {
                      if (e.target.value) {
                        handleLoadPreset(e.target.value as ThemeId);
                        e.target.value = '';
                      }
                    }}
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--surface-border)',
                      borderRadius: '6px',
                      padding: '6px 10px',
                      fontSize: '0.8rem',
                      outline: 'none',
                      cursor: 'pointer',
                      width: '100%',
                      maxWidth: '220px'
                    }}
                  >
                    <option value="">{i18n.t('settings:theme.selectTemplate')}</option>
                    {THEMES.filter(t => t.id !== 'custom').map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleResetToDefaultCustom}
                  style={{
                    background: 'var(--surface-color)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                >
                  {i18n.t('settings:theme.resetCustomTheme')}
                </button>
              </div>

              {/* Saved Themes & Sharing Panel */}
              <div style={{
                background: 'var(--surface-color)',
                border: '1px solid var(--surface-border)',
                borderRadius: '12px',
                padding: '20px',
                marginBottom: '20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px'
              }}>
                <h3 style={{ margin: 0, fontSize: '1.0rem', color: 'var(--text-primary)', borderBottom: '1px solid var(--surface-border)', paddingBottom: '10px' }}>
                  {i18n.t('settings:theme.savedThemesSharing')}
                </h3>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
                  {/* Left Column: Save & List */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {i18n.t('settings:theme.saveCurrentConfig')}
                      </label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          type="text"
                          placeholder={i18n.t('settings:theme.themeNamePlaceholder')}
                          value={newThemeName}
                          onChange={(e) => setNewThemeName(e.target.value)}
                          style={{
                            flex: 1,
                            background: 'var(--bg-tertiary)',
                            border: '1px solid var(--surface-border)',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            color: 'var(--text-primary)',
                            fontSize: '0.85rem',
                            outline: 'none'
                          }}
                        />
                        <button
                          onClick={handleSaveTheme}
                          disabled={!newThemeName.trim()}
                          style={{
                            background: 'var(--accent-primary, #00d4ff)',
                            color: 'black',
                            border: 'none',
                            borderRadius: '6px',
                            padding: '0 16px',
                            fontSize: '0.85rem',
                            fontWeight: 600,
                            cursor: newThemeName.trim() ? 'pointer' : 'not-allowed',
                            opacity: newThemeName.trim() ? 1 : 0.6,
                            transition: 'all 0.2s ease',
                            height: '36px'
                          }}
                        >
                          {i18n.t('common:save')}
                        </button>
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {i18n.t('settings:theme.yourSavedThemes')}
                      </span>
                      {savedCustomThemes.length === 0 ? (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                          {i18n.t('settings:theme.noSavedThemes')}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
                          {savedCustomThemes.map((t) => (
                            <div
                              key={t.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                background: 'var(--surface-color)',
                                border: '1px solid var(--surface-border)',
                                borderRadius: '6px',
                                padding: '8px 12px'
                              }}
                            >
                              <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px' }}>
                                {t.themeName || i18n.t('settings:theme.unnamedTheme')}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <button
                                  onClick={() => handleLoadCustomTheme(t)}
                                  style={{
                                    background: 'var(--surface-color)',
                                    color: 'var(--text-primary)',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '4px 8px',
                                    fontSize: '0.75rem',
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease'
                                  }}
                                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                                  onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                                >
                                  {i18n.t('common:load')}
                                </button>
                                <button
                                  onClick={() => handleExportTheme(t)}
                                  style={{
                                    background: copiedThemeId === t.id ? '#2e7d32' : 'var(--surface-color)',
                                    color: 'var(--text-primary)',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '4px 8px',
                                    fontSize: '0.75rem',
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                    minWidth: '55px'
                                  }}
                                  onMouseEnter={(e) => { if (copiedThemeId !== t.id) e.currentTarget.style.background = 'var(--surface-color)'; }}
                                  onMouseLeave={(e) => { if (copiedThemeId !== t.id) e.currentTarget.style.background = 'var(--surface-color)'; }}
                                >
                                  {copiedThemeId === t.id ? i18n.t('settings:theme.copied') : i18n.t('common:copy')}
                                </button>
                                <button
                                  onClick={() => handleDownloadTheme(t)}
                                  title={i18n.t('settings:theme.downloadJson')}
                                  style={{
                                    background: 'var(--surface-color)',
                                    color: 'var(--text-primary)',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '4px 6px',
                                    fontSize: '0.75rem',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                  }}
                                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                                  onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                                >
                                  💾
                                </button>
                                <button
                                  onClick={() => t.id && handleDeleteCustomTheme(t.id)}
                                  style={{
                                    background: 'rgba(211, 47, 47, 0.2)',
                                    color: '#ff8a80',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '4px 8px',
                                    fontSize: '0.75rem',
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease'
                                  }}
                                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(211, 47, 47, 0.35)'}
                                  onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(211, 47, 47, 0.2)'}
                                >
                                  {i18n.t('common:delete')}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Import Theme */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {i18n.t('settings:theme.importThemeConfig')}
                      </label>
                      <textarea
                        rows={2}
                        placeholder={i18n.t('settings:theme.importPlaceholder')}
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        style={{
                          background: 'var(--bg-tertiary)',
                          border: '1px solid var(--surface-border)',
                          borderRadius: '6px',
                          padding: '8px 12px',
                          color: 'var(--text-primary)',
                          fontSize: '0.8rem',
                          outline: 'none',
                          resize: 'vertical',
                          fontFamily: 'monospace'
                        }}
                      />
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button
                          onClick={handleImportTheme}
                          disabled={!importText.trim()}
                          style={{
                            background: 'var(--surface-color)',
                            border: '1px solid var(--surface-border)',
                            borderRadius: '6px',
                            color: 'var(--text-primary)',
                            padding: '6px 12px',
                            fontSize: '0.8rem',
                            fontWeight: 500,
                            cursor: importText.trim() ? 'pointer' : 'not-allowed',
                            opacity: importText.trim() ? 1 : 0.6,
                            transition: 'all 0.2s ease',
                            height: '32px'
                          }}
                          onMouseEnter={(e) => { if (importText.trim()) e.currentTarget.style.background = 'var(--surface-color)'; }}
                          onMouseLeave={(e) => { if (importText.trim()) e.currentTarget.style.background = 'var(--surface-color)'; }}
                        >
                          {i18n.t('settings:theme.importClipboard')}
                        </button>

                        <button
                          onClick={() => document.getElementById('theme-file-uploader')?.click()}
                          style={{
                            background: 'var(--surface-color)',
                            border: '1px solid var(--surface-border)',
                            borderRadius: '6px',
                            color: 'var(--text-primary)',
                            padding: '6px 12px',
                            fontSize: '0.8rem',
                            fontWeight: 500,
                            cursor: 'pointer',
                            transition: 'all 0.2s ease',
                            height: '32px'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                        >
                          {i18n.t('settings:theme.uploadFile')}
                        </button>
                        <input
                          id="theme-file-uploader"
                          type="file"
                          accept=".json"
                          style={{ display: 'none' }}
                          onChange={handleImportFile}
                        />
                      </div>
                      
                      {importError && (
                        <div style={{ fontSize: '0.75rem', color: '#ff8a80', marginTop: '2px' }}>
                          ⚠️ {importError}
                        </div>
                      )}
                      {importSuccess && (
                        <div style={{ fontSize: '0.75rem', color: '#81c784', marginTop: '2px' }}>
                          ✓ {importSuccess}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Editor Columns */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                gap: '20px'
              }}>
                {/* Left Column: Background & Colors */}
                <div style={{ marginBottom: '20px' }}>
                  <div style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px'
                  }}>
                    <h4 style={{ margin: '0 0 4px 0', borderBottom: '1px solid var(--surface-border)', paddingBottom: '8px', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                      {i18n.t('settings:theme.backgroundAccent')}
                    </h4>

                    {/* Background Type */}
                    <ButtonGroupSelector
                      label={i18n.t('settings:theme.backgroundStyle')}
                      options={[
                        { id: 'solid', name: i18n.t('settings:theme.solidColor') },
                        { id: 'gradient', name: i18n.t('settings:theme.gradient5') }
                      ]}
                      value={customThemeConfig.backgroundType}
                      onChange={(val) => onCustomThemeConfigChange({ backgroundType: val })}
                    />

                    {/* Colors depending on style */}
                    {customThemeConfig.backgroundType === 'gradient' ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px' }}>
                        <ColorInput
                          label={i18n.t('settings:theme.stop1')}
                          value={customThemeConfig.gradientStart || '#1a0b2e'}
                          onChange={(val) => onCustomThemeConfigChange({ gradientStart: val })}
                        />
                        <ColorInput
                          label={i18n.t('settings:theme.stop2')}
                          value={customThemeConfig.gradientColor4 || customThemeConfig.gradientStart || '#1a0b2e'}
                          onChange={(val) => onCustomThemeConfigChange({ gradientColor4: val })}
                        />
                        <ColorInput
                          label={i18n.t('settings:theme.stop3')}
                          value={customThemeConfig.gradientMiddle || '#4a1a6b'}
                          onChange={(val) => onCustomThemeConfigChange({ gradientMiddle: val })}
                        />
                        <ColorInput
                          label={i18n.t('settings:theme.stop4')}
                          value={customThemeConfig.gradientColor5 || customThemeConfig.gradientEnd || '#2d1b4e'}
                          onChange={(val) => onCustomThemeConfigChange({ gradientColor5: val })}
                        />
                        <ColorInput
                          label={i18n.t('settings:theme.stop5')}
                          value={customThemeConfig.gradientEnd || '#2d1b4e'}
                          onChange={(val) => onCustomThemeConfigChange({ gradientEnd: val })}
                        />
                      </div>
                    ) : (
                      <ColorInput
                        label={i18n.t('settings:theme.backgroundColor')}
                        value={customThemeConfig.backgroundColor || '#1a1a1a'}
                        onChange={(val) => onCustomThemeConfigChange({ backgroundColor: val })}
                      />
                    )}

                    {/* Accent Color */}
                    <ColorInput
                      label={i18n.t('settings:theme.accentColor')}
                      value={customThemeConfig.accentColor || '#00d4ff'}
                      onChange={(val) => onCustomThemeConfigChange({ accentColor: val })}
                    />

                    {/* Text Colors */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '4px' }}>
                      <ColorInput
                        label={i18n.t('settings:theme.primaryText')}
                        value={customThemeConfig.textColor || '#ffffff'}
                        onChange={(val) => onCustomThemeConfigChange({ textColor: val })}
                      />
                      <ColorInput
                        label={i18n.t('settings:theme.secondaryText')}
                        value={customThemeConfig.textSecondaryColor || 'rgba(255,255,255,0.7)'}
                        onChange={(val) => onCustomThemeConfigChange({ textSecondaryColor: val })}
                      />
                    </div>
                  </div>

                  {/* Typography Settings Card */}
                  <div style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px',
                    marginTop: '16px'
                  }}>
                    <h4 style={{ margin: '0 0 4px 0', borderBottom: '1px solid var(--surface-border)', paddingBottom: '8px', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                      {i18n.t('settings:theme.typographySettings')}
                    </h4>

                    {/* Font Family selector */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {i18n.t('settings:theme.appFontFamily')}
                      </label>
                      <select
                        value={appFontFamily}
                        onChange={(e) => updateAppFont(e.target.value, appCustomFontBase64, appCustomFontFormat, appCustomFontName)}
                        style={{
                          background: 'var(--surface-color)',
                          border: '1px solid var(--surface-border)',
                          borderRadius: '6px',
                          padding: '8px 12px',
                          color: 'var(--text-primary)',
                          fontSize: '0.85rem',
                          outline: 'none',
                          cursor: 'pointer',
                          width: '100%',
                          height: '36px'
                        }}
                      >
                        <option value="inter" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:theme.interDefault')}</option>
                        <option value="switzer" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:theme.switzer')}</option>
                        <option value="cabinet-grotesk" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:theme.cabinetGrotesk')}</option>
                        <option value="fraunces" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:theme.fraunces')}</option>
                        <option value="sentient" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:theme.sentient')}</option>
                        <option value="custom" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:theme.customUploadedFont')}</option>
                      </select>
                    </div>

                    {/* Custom Font Upload UI */}
                    {appFontFamily === 'custom' && (
                      <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px',
                        background: 'var(--surface-color)',
                        border: '1px dashed var(--surface-border)',
                        borderRadius: '8px',
                        padding: '12px',
                        marginTop: '4px'
                      }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                          {i18n.t('settings:theme.fontUploadHint')}
                        </div>
                        
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <button
                            onClick={() => document.getElementById('custom-font-uploader')?.click()}
                            style={{
                              background: 'var(--surface-color)',
                              border: '1px solid var(--surface-border)',
                              borderRadius: '6px',
                              padding: '6px 12px',
                              color: 'var(--text-primary)',
                              fontSize: '0.8rem',
                              fontWeight: 500,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              transition: 'all 0.2s ease',
                              height: '32px'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                          >
                            {i18n.t('settings:theme.chooseFontFile')}
                          </button>
                          <input
                            id="custom-font-uploader"
                            type="file"
                            accept=".ttf,.otf,.woff,.woff2"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                const reader = new FileReader();
                                reader.onload = (event) => {
                                  const base64 = event.target?.result as string;
                                  let format = 'woff2';
                                  if (file.name.endsWith('.ttf')) format = 'truetype';
                                  else if (file.name.endsWith('.otf')) format = 'opentype';
                                  else if (file.name.endsWith('.woff')) format = 'woff';
                                  
                                  updateAppFont('custom', base64, format, file.name);
                                };
                                reader.readAsDataURL(file);
                              }
                            }}
                          />
                          
                          {appCustomFontName && (
                            <span style={{ fontSize: '0.75rem', color: 'var(--accent-primary, #00d4ff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }} title={appCustomFontName}>
                              {appCustomFontName}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column: Surfaces, Borders & Glass Effects */}
                <div>
                  <div style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px'
                  }}>
                    <h4 style={{ margin: '0 0 4px 0', borderBottom: '1px solid var(--surface-border)', paddingBottom: '8px', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                      {i18n.t('settings:theme.glassSurfaces')}
                    </h4>

                    {/* Surface Color */}
                    <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                      <div style={{ flex: '0 0 auto' }}>
                        <ColorInput
                          label={i18n.t('settings:theme.surfaceTint')}
                          value={customThemeConfig.surfaceColor || '#282828'}
                          onChange={(val) => onCustomThemeConfigChange({ surfaceColor: val })}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <SliderInput
                          label={i18n.t('settings:theme.surfaceOpacity')}
                          min={0.1}
                          max={1.0}
                          step={0.05}
                          value={customThemeConfig.surfaceOpacity ?? 0.85}
                          displayValue={`${Math.round((customThemeConfig.surfaceOpacity ?? 0.85) * 100)}%`}
                          onChange={(val) => onCustomThemeConfigChange({ surfaceOpacity: val })}
                        />
                      </div>
                    </div>

                    {/* Border Color */}
                    <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                      <div style={{ flex: '0 0 auto' }}>
                        <ColorInput
                          label={i18n.t('settings:theme.borderColor')}
                          value={customThemeConfig.surfaceBorderColor || '#ffffff'}
                          onChange={(val) => onCustomThemeConfigChange({ surfaceBorderColor: val })}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <SliderInput
                          label={i18n.t('settings:theme.borderOpacity')}
                          min={0.0}
                          max={0.8}
                          step={0.05}
                          value={customThemeConfig.surfaceBorderOpacity ?? 0.1}
                          displayValue={`${Math.round((customThemeConfig.surfaceBorderOpacity ?? 0.1) * 100)}%`}
                          onChange={(val) => onCustomThemeConfigChange({ surfaceBorderOpacity: val })}
                        />
                      </div>
                    </div>

                    {/* Glass Blur Slider */}
                    <SliderInput
                      label={i18n.t('settings:theme.backdropBlur')}
                      min={0}
                      max={40}
                      step={1}
                      value={customThemeConfig.glassBlur ?? 20}
                      displayValue={`${customThemeConfig.glassBlur ?? 20}px`}
                      onChange={(val) => onCustomThemeConfigChange({ glassBlur: val })}
                    />

                    {/* Glass Saturation Slider */}
                    <SliderInput
                      label={i18n.t('settings:theme.backdropSaturation')}
                      min={100}
                      max={200}
                      step={5}
                      value={customThemeConfig.glassSaturation ?? 150}
                      displayValue={`${customThemeConfig.glassSaturation ?? 150}%`}
                      onChange={(val) => onCustomThemeConfigChange({ glassSaturation: val })}
                    />
                  </div>

                  {/* V3 UI Bulb Glows card */}
                  <div style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px',
                    marginTop: '16px'
                  }}>
                    <h4 style={{ margin: '0 0 4px 0', borderBottom: '1px solid var(--surface-border)', paddingBottom: '8px', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                      {i18n.t('settings:theme.v3Bulbs')}
                    </h4>
                    
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px dashed var(--surface-border)' }}>
                      <label style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 500, cursor: 'pointer' }} htmlFor="toggle-glass-blobs">
                        {i18n.t('settings:theme.showBulbs')}
                      </label>
                      <input
                        id="toggle-glass-blobs"
                        type="checkbox"
                        checked={customThemeConfig.showGlassBlobs ?? true}
                        onChange={(e) => onCustomThemeConfigChange({ showGlassBlobs: e.target.checked })}
                        style={{
                          width: '18px',
                          height: '18px',
                          accentColor: 'var(--accent-primary, #00d4ff)',
                          cursor: 'pointer'
                        }}
                      />
                    </div>

                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.3 }}>
                      {i18n.t('settings:theme.bulbsDesc')}
                    </p>

                    {(customThemeConfig.showGlassBlobs ?? true) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', borderBottom: '1px dashed var(--surface-border)', paddingBottom: '16px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <ColorInput
                              label={i18n.t('settings:theme.bulb1')}
                              value={customThemeConfig.customBlob1 || '#00bbf5'}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob1: val })}
                            />
                            <SliderInput
                              label={i18n.t('settings:theme.bulb1Intensity')}
                              min={0}
                              max={100}
                              step={5}
                              value={Math.round((customThemeConfig.customBlob1Opacity ?? 0.55) * 100)}
                              displayValue={`${Math.round((customThemeConfig.customBlob1Opacity ?? 0.55) * 100)}%`}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob1Opacity: val / 100 })}
                            />
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <ColorInput
                              label={i18n.t('settings:theme.bulb2')}
                              value={customThemeConfig.customBlob2 || '#ff1493'}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob2: val })}
                            />
                            <SliderInput
                              label={i18n.t('settings:theme.bulb2Intensity')}
                              min={0}
                              max={100}
                              step={5}
                              value={Math.round((customThemeConfig.customBlob2Opacity ?? 0.45) * 100)}
                              displayValue={`${Math.round((customThemeConfig.customBlob2Opacity ?? 0.45) * 100)}%`}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob2Opacity: val / 100 })}
                            />
                          </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <ColorInput
                              label={i18n.t('settings:theme.bulb3')}
                              value={customThemeConfig.customBlob3 || '#ffd700'}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob3: val })}
                            />
                            <SliderInput
                              label={i18n.t('settings:theme.bulb3Intensity')}
                              min={0}
                              max={100}
                              step={5}
                              value={Math.round((customThemeConfig.customBlob3Opacity ?? 0.35) * 100)}
                              displayValue={`${Math.round((customThemeConfig.customBlob3Opacity ?? 0.35) * 100)}%`}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob3Opacity: val / 100 })}
                            />
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <ColorInput
                              label={i18n.t('settings:theme.bulb4')}
                              value={customThemeConfig.customBlob4 || '#76ff03'}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob4: val })}
                            />
                            <SliderInput
                              label={i18n.t('settings:theme.bulb4Intensity')}
                              min={0}
                              max={100}
                              step={5}
                              value={Math.round((customThemeConfig.customBlob4Opacity ?? 0.3) * 100)}
                              displayValue={`${Math.round((customThemeConfig.customBlob4Opacity ?? 0.3) * 100)}%`}
                              onChange={(val) => onCustomThemeConfigChange({ customBlob4Opacity: val / 100 })}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
