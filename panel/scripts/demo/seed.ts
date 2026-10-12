/**
 * Every seed, in the order they depend on each other. Each one is a file of its own, so one
 * page's data can be changed without reading the rest.
 */
import type { TestWorld } from '../../test/helpers.js';
import { seedServers } from './servers.js';
import { presentSrvAs } from './paths.js';
import { seedSites } from './sites.js';
import { seedExternalSites } from './external.js';
import { seedInventory } from './inventory.js';
import { seedTraffic } from './traffic.js';
import { seedBackups } from './backups.js';
import { seedJobs } from './jobs.js';
import { installDemoDocker } from './docker.js';
import { seedMail } from './mail.js';
import { seedSecurity } from './security.js';
import { seedAccounts } from './accounts.js';
import { seedRecipes } from './recipes.js';
import { seedFtp } from './ftp.js';
import { seedImports } from './imports.js';
import { installDemoTerminal } from './terminal.js';

export async function seedAll(world: TestWorld): Promise<void> {
  seedServers(world);
  presentSrvAs(world);
  seedSites(world);
  seedExternalSites(world);
  seedInventory(world);
  seedTraffic(world);
  seedBackups(world);
  seedJobs(world);
  installDemoDocker(world);
  seedMail(world);
  seedSecurity(world);
  seedAccounts(world);
  seedRecipes(world);
  seedFtp(world);
  seedImports(world);
  installDemoTerminal(world);
}
