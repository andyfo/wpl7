// @docs get-started/installation, reference/installer-and-scripts
import readline from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Questions on a terminal, for the restore command (src/cli/restore.ts). Kept behind an interface
 * so the questions themselves (snapshotRestore.ts) can be tested with scripted answers.
 */
export interface Prompter {
  /** A visible answer, trimmed. Enter alone gives `def`, when there is one. */
  ask(question: string, def?: string): Promise<string>;
  /** An answer nothing shows while it is typed, trimmed. It is kept nowhere but the string returned. */
  secret(question: string): Promise<string>;
  /**
   * Several hidden lines, up to and including the one `end` matches: a pasted PEM key. An empty
   * first line gives ''.
   */
  secretLines(question: string, end: RegExp): Promise<string>;
  say(line?: string): void;
}

/** Yes or no; Enter alone gives `def`. */
export async function confirm(io: Prompter, question: string, def: boolean): Promise<boolean> {
  const answer = (await io.ask(`${question} ${def ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
  if (answer === '') return def;
  return answer.startsWith('y');
}

/**
 * A Prompter on a terminal, through one readline interface.
 *
 * Hidden answers go through the same interface with its output muted: readline then draws nothing
 * of what is typed, while the terminal stays in the raw mode readline puts it in, so the kernel
 * echoes nothing either. Pasting works, and so does backspace. History is off, so the up arrow
 * cannot bring a secret back.
 *
 * `onInterrupt` is called on Ctrl-C at a question. readline swallows the keystroke in raw mode, and
 * without a listener it would only pause the input, leaving the question unanswered for good.
 */
export function terminalPrompter(opts: {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
  onInterrupt: () => void;
}): Prompter & { close(): void } {
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) opts.output.write(chunk);
      done();
    },
  });
  let rl: readline.Interface | null = null;
  const open = (): readline.Interface => {
    if (rl) return rl;
    rl = readline.createInterface({ input: opts.input, output: sink, terminal: opts.input.isTTY === true, historySize: 0 });
    rl.on('SIGINT', opts.onInterrupt);
    return rl;
  };

  const line = (query: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const iface = open();
      const ended = () => reject(new Error('The input ended before the question was answered.'));
      iface.once('close', ended);
      iface.question(query, (answer) => {
        iface.off('close', ended);
        resolve(answer);
      });
    });

  const hidden = async <T>(question: string, read: () => Promise<T>): Promise<T> => {
    opts.output.write(question);
    muted = true;
    try {
      return await read();
    } finally {
      muted = false;
      opts.output.write('\n');
    }
  };

  return {
    async ask(question, def) {
      const answer = (await line(def ? `${question} [${def}]: ` : `${question}: `)).trim();
      return answer === '' && def !== undefined ? def : answer;
    },
    async secret(question) {
      return (await hidden(`${question}: `, () => line(''))).trim();
    },
    async secretLines(question, end) {
      return hidden(`${question}\n`, () => {
        const iface = open();
        return new Promise<string>((resolve, reject) => {
          const lines: string[] = [];
          const finish = (result: string) => {
            iface.off('line', onLine);
            iface.off('close', ended);
            resolve(result);
          };
          const onLine = (text: string) => {
            if (lines.length === 0 && text.trim() === '') return finish('');
            lines.push(text.trimEnd());
            if (end.test(text.trim())) finish(`${lines.join('\n')}\n`);
          };
          const ended = () => reject(new Error('The input ended before the question was answered.'));
          iface.on('line', onLine);
          iface.once('close', ended);
        });
      });
    },
    say(text = '') {
      opts.output.write(`${text}\n`);
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}
