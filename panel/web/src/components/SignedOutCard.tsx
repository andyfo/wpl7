import type { FormEvent, ReactNode } from 'react';
import { Wordmark } from './Wordmark';

/**
 * The one-card layout of the pages a signed-out browser can reach: signing in, the two an
 * emailed link opens, and an AI app's approval page. A form, because every one of them is a
 * form - even the page whose only control is a Confirm button, so that Enter does what the
 * button does.
 */
export function SignedOutCard({
  subtitle,
  onSubmit,
  children,
  wide = false,
}: {
  subtitle: string;
  onSubmit?: (e: FormEvent) => void;
  children: ReactNode;
  /** For a card that holds a choice with explanations, not two fields. */
  wide?: boolean;
}) {
  return (
    <div className="login-page flex min-h-screen flex-col items-center justify-center p-4">
      <Wordmark as="h1" className="login-wordmark mb-8" />
      <form
        onSubmit={onSubmit ?? ((e) => e.preventDefault())}
        className={`w-full ${wide ? 'max-w-md' : 'max-w-sm'} space-y-4 rounded-2xl bg-surface p-8 shadow-lg`}
      >
        <p className="text-sm text-neutral-500">{subtitle}</p>
        {children}
      </form>
    </div>
  );
}

/** The quiet text button under a signed-out form: "Start over", "Back to sign in". */
export function QuietButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-center text-xs text-neutral-500 hover:text-neutral-800"
    >
      {children}
    </button>
  );
}
