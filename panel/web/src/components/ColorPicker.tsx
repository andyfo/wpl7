import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const palettes = [
  { id: 'blue', label: 'Blue', swatch: '#315fc5' },
  { id: 'violet', label: 'Violet', swatch: '#7250b5' },
  { id: 'rose', label: 'Rose', swatch: '#b33f69' },
  { id: 'amber', label: 'Amber', swatch: '#946019' },
  { id: 'graphite', label: 'Graphite', swatch: '#505563' },
  { id: 'yellow', label: 'Yellow', swatch: '#e8c83b' },
  { id: 'green', label: 'Green', swatch: '#28744e' },
] as const;
const key = 'wpl7-accent';
const validAccent = (value: string | null) => palettes.find((palette) => palette.id === value)?.id ?? 'blue';

export function ColorPicker() {
  const [accent, setAccent] = useState(() => {
    try {
      return validAccent(localStorage.getItem(key));
    } catch {
      return 'blue' as const;
    }
  });

  const optionsRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<'start' | 'end' | 'both' | null>(null);

  // The row holds more colours than fit, and it lives inside a disclosure that starts
  // closed - so measure it whenever it resizes, and bring the chosen one into view the
  // moment the panel opens.
  useEffect(() => {
    const row = optionsRef.current;
    if (!row) return;
    let wasVisible = false;
    const measure = () => {
      const visible = row.clientWidth > 0;
      if (visible && !wasVisible) {
        row.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      wasVisible = visible;
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      setMore(start && end ? 'both' : start ? 'start' : end ? 'end' : null);
    };
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(row);
    return () => {
      row.removeEventListener('scroll', measure);
      resize.disconnect();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setAccent(validAccent(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [accent]);

  return (
    <div className="color-picker">
      <div className="color-picker-label">
        <span>Theme color</span>
        <span>{palettes.find((palette) => palette.id === accent)?.label}</span>
      </div>
      <div
        className="color-options"
        data-more={more ?? undefined}
        ref={optionsRef}
        role="group"
        aria-label="Theme color"
      >
        {palettes.map((palette) => (
          <button
            key={palette.id}
            type="button"
            className="color-option"
            aria-label={`${palette.label} theme color`}
            aria-pressed={accent === palette.id}
            onClick={() => {
              setAccent(palette.id);
              try {
                localStorage.setItem(key, palette.id);
              } catch {
                /* Apply for this visit when storage is unavailable. */
              }
            }}
          >
            <span
              className="color-swatch"
              style={{ backgroundColor: palette.swatch, color: palette.id === 'yellow' ? '#30290a' : undefined }}
            >
              {accent === palette.id && <Icon name="check" size={13} />}
            </span>
            <span>{palette.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
