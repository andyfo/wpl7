// The WPL7 documentation site, served as static files from https://wpl7.com/docs/.
// Writing, screenshots, generated pages and publishing: README.md next to this file.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightImageZoom from 'starlight-image-zoom';

const REPO = 'https://github.com/andyfo/wpl7';

/** One sidebar group per folder, in the panel's own order. Pages sort by `sidebar.order`. */
const group = (label, directory, collapsed = true) => ({
  label,
  collapsed,
  items: [{ autogenerate: { directory } }],
});

export default defineConfig({
  site: 'https://wpl7.com',
  // A physical /docs directory next to WordPress: every page is a folder with an index.html,
  // and every internal link carries its trailing slash.
  base: '/docs',
  trailingSlash: 'always',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
  // The typeface is the panel's own files (src/styles/fonts.css), one directory up.
  vite: {
    server: { fs: { allow: ['.', '../../panel/web/src/fonts'] } },
    build: {
      rolldownOptions: {
        // Astro's MDX modules carry a directive the bundler says it may drop; it is harmless
        // and would otherwise be printed once per page.
        onLog(level, log, handler) {
          if (log.code === 'MODULE_LEVEL_DIRECTIVE') return;
          handler(level, log);
        },
      },
    },
  },
  integrations: [
    starlight({
      title: 'WPL7 Docs',
      description:
        'WPL7 turns an Ubuntu server into WordPress hosting with a panel: one container per site, certificates, mail, backups, security and an API.',
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/docs/favicon.ico', sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/docs/apple-touch-icon.png' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs/site/` },
      lastUpdated: true,
      pagination: true,
      credits: false,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: [
        './src/styles/fonts.css',
        './src/styles/theme.css',
        './src/styles/wordmark.css',
        './src/styles/content.css',
      ],
      components: {
        Header: './src/components/overrides/Header.astro',
        SiteTitle: './src/components/overrides/SiteTitle.astro',
        SocialIcons: './src/components/overrides/SocialIcons.astro',
        Footer: './src/components/overrides/Footer.astro',
        TableOfContents: './src/components/overrides/TableOfContents.astro',
      },
      routeMiddleware: './src/routeData.ts',
      sidebar: [
        { label: 'Get started', items: ['index', { autogenerate: { directory: 'get-started' } }] },
        group('Sites', 'sites'),
        group('Servers', 'servers'),
        group('Plugins', 'plugins'),
        group('Backups', 'backups'),
        group('Mail', 'mail'),
        group('Security', 'security'),
        group('Automations', 'automations'),
        group('Integrations', 'integrations'),
        group('Panel', 'panel'),
        group('Reference', 'reference'),
        group('Help', 'help'),
        // Not a group: one page, in sight whether Help is open or not.
        'support',
      ],
      plugins: [
        starlightLinksValidator({
          errorOnRelativeLinks: true,
          errorOnInvalidHashes: true,
          errorOnLocalLinks: true,
          // An absolute link into the docs must be written as a path. The website around them
          // (wpl7.com/community, /enterprise/) is a different site on the same domain.
          sameSitePolicy: 'error',
          exclude: ({ link }) => /^https:\/\/wpl7\.com\/(?!docs\/)/.test(link),
          components: [['UiPath', 'href']],
        }),
        starlightLlmsTxt({
          projectName: 'WPL7',
          description:
            'WPL7 is self-hosted WordPress hosting: an installer that turns an Ubuntu server into a host, and a panel that runs one container per site with certificates, mail, backups, security, a REST API and an MCP server.',
          exclude: ['help/changelog'],
        }),
        starlightImageZoom(),
      ],
    }),
  ],
});
