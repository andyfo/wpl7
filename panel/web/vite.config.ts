import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));

// Conductor hands every workspace its own port block, so the dev ports come from the
// environment. The defaults keep a bare `npm run dev` on the old 5173 -> 3000 pair.
const webPort = Number(process.env.WEB_PORT) || 5173;
const apiTarget = process.env.API_URL || 'http://localhost:3000';

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: webPort,
    // Conductor advertises this exact port, so fail loudly instead of drifting to the next one.
    strictPort: true,
    // ws: true also proxies the terminal's WebSocket upgrades in dev. Do not add
    // changeOrigin: the terminal handshake rejects any request whose Origin and Host
    // disagree, and rewriting Host to the API's would break exactly that check.
    //
    // MCP and its OAuth endpoints too - but not /oauth/authorize, which is a page of the app.
    // To sign in through here, give the API PANEL_DOMAIN=localhost:<this port> (docs/mcp.md).
    proxy: {
      '/api': { target: apiTarget, ws: true },
      '/mcp': { target: apiTarget },
      '/oauth/register': { target: apiTarget },
      '/oauth/token': { target: apiTarget },
      '/oauth/revoke': { target: apiTarget },
      '/.well-known/oauth-': { target: apiTarget },
    },
  },
});
