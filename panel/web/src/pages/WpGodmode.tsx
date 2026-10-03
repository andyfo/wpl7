import { OutButton } from '../components/ui';
import { GodmodeLogo } from '../components/Godmode';
import { Icon, type IconName } from '../components/Icon';
import wordpressUi from '../assets/wpgodmode/wordpress-ui.jpg';
import planMode from '../assets/wpgodmode/plan-mode.jpg';
import agents from '../assets/wpgodmode/agents.jpg';

/**
 * Where the green entry at the foot of the nav leads: WP Godmode, the AI plugin for
 * WordPress, in its own words - the copy and the screenshots are WP Godmode's.
 *
 * The images ship inside the panel rather than load from wpgodmode.com. Hotlinked, every
 * visit to this page would tell a third party that a panel had been opened, and the panel
 * makes no requests of anyone on its own; the page's links are the only way out, and only
 * when someone follows one.
 */
const SHOTS = [
  {
    src: wordpressUi,
    alt: "Godmode's start screen inside wp-admin, asking what you want to do",
    title: 'Familiar WordPress experience',
    text: 'WP Godmode runs entirely inside wp-admin, allowing your team to work in the environment they already know.',
  },
  {
    src: planMode,
    alt: 'A plan for a booking plugin, waiting to be approved',
    title: 'Plan before execution',
    text: 'Review the proposed implementation before WP Godmode makes changes to your website.',
  },
  {
    src: agents,
    alt: 'The Page Builder Agent building a WooCommerce and Breakdance page from a Figma design',
    title: 'Powerful autonomous agents',
    text: 'Build entire websites with Godmode Agents that understand your requirements, work in your favourite page builder and let you create virtually anything on WordPress.',
  },
];

const POINTS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'sparkles',
    title: 'AI directly in WordPress',
    text: 'Professional teams build, debug, optimize and automate without leaving wp-admin.',
  },
  { icon: 'layers', title: 'Deep WordPress integration', text: 'Understands your entire website stack.' },
  { icon: 'branch', title: 'Git-driven version history', text: 'For custom code and plugins.' },
  { icon: 'shield', title: 'Safe on your live websites', text: 'Configurable edit modes and a recovery mode.' },
];

/*
 * Pricing is where the free 30-day trial starts; the logo, the screenshots and "Learn more"
 * all go to the homepage. None of them sends a referrer, which would name this panel's
 * domain; utm_source still lets wpgodmode.com count the clicks that came from a WPL7 panel
 * without learning which one.
 */
const GET_PLUGIN_URL = 'https://wpgodmode.com/pricing/?utm_source=wpl7&utm_medium=panel';
const HOME_URL = 'https://wpgodmode.com/?utm_source=wpl7&utm_medium=panel';

export function WpGodmode() {
  return (
    <div className="godmode mx-auto max-w-5xl space-y-10 py-4">
      <header className="text-center">
        <h1>
          <a className="godmode-logo-link" href={HOME_URL} target="_blank" rel="noreferrer noopener">
            <GodmodeLogo className="godmode-logo" />
          </a>
        </h1>
        <p className="godmode-headline">The AI teammate that lives inside WordPress.</p>
        {/* The measure goes on a wrapper: .main-content caps every <ul> at 1000px, and that
            unlayered rule outranks a max-w utility on the list itself. The wrapper, not the
            window, also decides the second column: just past 800px the sidebar comes back and
            leaves too little room for two. role="list" as Safari stops announcing a list as one
            once its bullets are gone. */}
        <div className="@container mx-auto mt-10 max-w-3xl">
          <ul role="list" className="grid gap-x-10 gap-y-7 text-left @xl:grid-cols-2">
            {POINTS.map((point) => (
              <li key={point.title} className="flex gap-4">
                <span className="godmode-point-icon">
                  <Icon name={point.icon} size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-900">{point.title}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-pretty text-neutral-500">
                    {point.text}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </header>

      <div className="grid gap-6 sm:grid-cols-3">
        {SHOTS.map((shot) => (
          <figure key={shot.title}>
            <a className="godmode-shot-link" href={HOME_URL} target="_blank" rel="noreferrer noopener">
              <img className="godmode-shot" src={shot.src} alt={shot.alt} width={600} height={400} />
            </a>
            <figcaption className="mt-4">
              <span className="block text-sm font-medium text-neutral-900">{shot.title}</span>
              <span className="mt-1 block text-xs leading-relaxed text-neutral-500">{shot.text}</span>
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <OutButton href={GET_PLUGIN_URL} primary>
          Get the plugin
        </OutButton>
        <OutButton href={HOME_URL}>Learn more</OutButton>
      </div>
    </div>
  );
}
