// @docs panel/appearance
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { ColorPicker } from './ColorPicker';

type Theme = 'light' | 'dark' | 'system';
const key = 'wpl7-theme';
const validTheme = (value: string | null): Theme => (value === 'light' || value === 'dark' ? value : 'system');

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return validTheme(localStorage.getItem(key));
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setTheme(validTheme(event.newValue));
    };
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('storage', sync);
    return () => {
      media.removeEventListener('change', apply);
      window.removeEventListener('storage', sync);
    };
  }, [theme]);

  return (
    <div className="appearance-controls">
      <div className="theme-switch" role="group" aria-label="Appearance">
        {(['light', 'dark', 'system'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={theme === mode}
            title={mode === 'system' ? 'Follow system appearance' : `${mode === 'light' ? 'Light' : 'Dark'} appearance`}
            onClick={() => {
              setTheme(mode);
              try {
                localStorage.setItem(key, mode);
              } catch {
                /* Works for this visit if storage is unavailable. */
              }
            }}
          >
            <Icon name={mode === 'light' ? 'sun' : mode === 'dark' ? 'moon' : 'system'} size={15} />
            <span>{mode.charAt(0).toUpperCase() + mode.slice(1)}</span>
          </button>
        ))}
      </div>
      <ColorPicker />
    </div>
  );
}
