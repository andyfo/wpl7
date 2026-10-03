/**
 * The wordmark, in the one markup every place that shows it shares.
 *
 * `brand-name-accent` is where the whole treatment lives - the theme-accent gradient and
 * the sheen that sweeps across it - so the sidebar, the About page and the sign-in page
 * cannot drift apart by one of them being edited. Size and tracking are the caller's,
 * through `className`.
 */
export function Wordmark({ as: Tag = 'span', className = '' }: { as?: 'span' | 'h1'; className?: string }) {
  return (
    <Tag className={`brand-name ${className}`}>
      WP<span className="brand-name-accent">L7</span>
    </Tag>
  );
}
