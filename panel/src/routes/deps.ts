import type { CoreServices } from '../services/index.js';
import type { JobWorker } from '../jobs/worker.js';
import type { Schedulers } from '../jobs/schedulers.js';
import type { SitesService } from '../services/sites.js';
import type { ApiKeysService } from '../services/apiKeys.js';
import type { ApiActivityService } from '../services/apiActivity.js';
import type { PluginCatalogService } from '../services/pluginCatalog.js';
import type { SystemInfoService } from '../servers/systemInfo.js';
import type { TerminalService } from '../servers/terminal.js';
import type { TwoFactorService } from '../services/twoFactor.js';
import type { UsersService } from '../services/users.js';
import type { AccountRecoveryService } from '../services/accountRecovery.js';
import type { WporgDirectory } from '../services/wporg.js';
import type { WpBulkService } from '../services/wpBulk.js';
import type { OAuthService } from '../services/oauth.js';

export interface AppDeps extends CoreServices {
  worker: JobWorker;
  sites: SitesService;
  apiKeys: ApiKeysService;
  /** The API request log behind the Activity tab, written by the onResponse hook. */
  apiActivity: ApiActivityService;
  /** The admin accounts that sign in to the panel: the owner, and everyone they added. */
  users: UsersService;
  /** Optional TOTP second factor on the panel login, per account. */
  twoFactor: TwoFactorService;
  /** Recovery addresses, and "Forgot your password?" links sent to them. */
  recovery: AccountRecoveryService;
  /** OAuth sign-in for AI apps connecting over MCP: the window, the connections, the tokens. */
  oauth: OAuthService;
  pluginCatalog: PluginCatalogService;
  /** Fleet-wide WordPress bulk runs (batches) and the fleet scan's bookkeeping. */
  wpBulk: WpBulkService;
  /** wordpress.org plugin directory, for the catalog typeahead and slug validation. */
  wporg: WporgDirectory;
  /** OS/kernel/CPU/uptime per server, for the server detail page. */
  serverInfo: SystemInfoService;
  terminal: TerminalService;
  /**
   * Everything that runs on its own: the built-in tasks and the custom schedules. Tests
   * build it too, without `start()` - which is the only thing that arms a timer.
   */
  schedulers: Schedulers;
}
