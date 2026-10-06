// @docs sites/files
import { Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import type { EditorLanguage } from '../../lib/fileKinds';

/**
 * CodeMirror, set up for the Files tab. This module is only ever reached through the lazy
 * FileEditor, so none of it - nor the language each file pulls in on demand - weighs on the
 * rest of the panel.
 */

export async function languageExtension(lang: EditorLanguage): Promise<Extension> {
  switch (lang) {
    case 'php':
      // Mixed PHP and HTML, as WordPress templates are.
      return (await import('@codemirror/lang-php')).php();
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript();
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'xml':
      return (await import('@codemirror/lang-xml')).xml();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    case 'ini': {
      const [{ StreamLanguage }, { properties }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/properties'),
      ]);
      return StreamLanguage.define(properties);
    }
    case 'shell': {
      const [{ StreamLanguage }, { shell }] = await Promise.all([
        import('@codemirror/language'),
        import('@codemirror/legacy-modes/mode/shell'),
      ]);
      return StreamLanguage.define(shell);
    }
    default:
      return [];
  }
}

/** The panel's own surfaces and neutrals, so the editor follows the theme and its accent. */
const chrome = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--surface)', color: 'var(--n900)' },
  '.cm-scroller': {
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: 'var(--n900)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--n900)' },
  '.cm-gutters': { backgroundColor: 'var(--n50)', color: 'var(--n400)', borderRight: '1px solid var(--n200)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--n100)', color: 'var(--n700)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent-soft) 40%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent) !important',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, #f5b041 35%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, #f5b041 65%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--n50)', color: 'var(--n800)', borderColor: 'var(--n200)' },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--surface)', border: '1px solid var(--n300)', borderRadius: '4px' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--n100)', border: 'none', color: 'var(--n500)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--n200)' },
});

const isDark = () => document.documentElement.dataset.theme === 'dark';

/**
 * Syntax colours for the current theme, and a watcher that swaps them when the operator
 * flips light/dark with the editor open.
 */
export function themeExtensions(): { extensions: Extension; watch: (view: EditorView) => () => void } {
  const highlight = new Compartment();
  const colours = () => syntaxHighlighting(isDark() ? oneDarkHighlightStyle : defaultHighlightStyle);
  return {
    extensions: [chrome, highlight.of(colours())],
    watch: (view) => {
      const observer = new MutationObserver(() => view.dispatch({ effects: highlight.reconfigure(colours()) }));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => observer.disconnect();
    },
  };
}
