import type { ThemeId } from '../../types/app';

interface ThemeTabProps {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

const THEMES: { id: ThemeId; name: string; description: string; preview: string; gradient?: string }[] = [
  { id: 'dark', name: 'Dark', description: 'Classic dark theme', preview: '#1a1a1a' },
  { id: 'light', name: 'Light', description: 'Clean light theme', preview: '#f5f5f5' },
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
  { id: 'solid-rainbow', name: 'Rainbow Prism', description: 'Full spectrum multicolor gradient', preview: 'linear-gradient(135deg, #2d1a3d 0%, #3d1a5c 15%, #5c2a6b 30%, #6b4a3d 45%, #5c6b2a 60%, #2a6b5c 75%, #1a3a5c 90%, #2d1a4a 100%)', gradient: 'linear-gradient(135deg, #2d1a3d 0%, #3d1a5c 15%, #5c2a6b 30%, #6b4a3d 45%, #5c6b2a 60%, #2a6b5c 75%, #1a3a5c 90%, #2d1a4a 100%)' },
  { id: 'solid-copper', name: 'Copper Teal', description: 'Warm copper to teal gradient', preview: 'linear-gradient(135deg, #2d1810 0%, #4a2d1a 25%, #6b3d28 50%, #2a6b6b 75%, #1a4a4a 100%)', gradient: 'linear-gradient(135deg, #2d1810 0%, #4a2d1a 25%, #6b3d28 50%, #2a6b6b 75%, #1a4a4a 100%)' },
  { id: 'solid-midnightrose', name: 'Midnight Rose', description: 'Dark purple to burgundy to pink', preview: 'linear-gradient(135deg, #1a0a1f 0%, #2d1a3d 25%, #4a1a3d 50%, #6b2a4a 75%, #3d1a2d 100%)', gradient: 'linear-gradient(135deg, #1a0a1f 0%, #2d1a3d 25%, #4a1a3d 50%, #6b2a4a 75%, #3d1a2d 100%)' },
  { id: 'solid-enchanted', name: 'Enchanted Forest', description: 'Deep green to purple to blue', preview: 'linear-gradient(135deg, #0d1a0d 0%, #1a2d1a 25%, #2d1a3d 50%, #1a3a5c 75%, #0d2d4a 100%)', gradient: 'linear-gradient(135deg, #0d1a0d 0%, #1a2d1a 25%, #2d1a3d 50%, #1a3a5c 75%, #0d2d4a 100%)' },
];

export function ThemeTab({ theme, onThemeChange }: ThemeTabProps) {
  const handleThemeChange = async (newTheme: ThemeId) => {
    onThemeChange(newTheme);
    if (window.storage) {
      await window.storage.updateSettings({ theme: newTheme });
    }
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>Theme</h3>
        </div>

        <p className="section-description">
          Choose a visual theme for the application. Glassmorphism themes feature translucent,
          blurred backgrounds with vibrant color palettes.
        </p>

        <div className="theme-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: '12px',
          marginTop: '1.5rem'
        }}>
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
                  : '1px solid rgba(255,255,255,0.2)',
                background: theme === t.id
                  ? 'rgba(0, 212, 255, 0.15)'
                  : 'rgba(255,255,255,0.05)',
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
                  border: '2px solid rgba(255,255,255,0.3)',
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
                color: 'white',
                textAlign: 'center',
                marginBottom: '4px'
              }}>
                {t.name}
              </span>

              {/* Theme Description */}
              <span style={{
                fontSize: '0.7rem',
                color: 'rgba(255,255,255,0.6)',
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
    </div>
  );
}
