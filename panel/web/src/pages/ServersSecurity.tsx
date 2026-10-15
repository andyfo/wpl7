// @docs security/blocked-addresses
import { BlockedTab, DetectionTab, EnforcementTab, NeverBlockTab } from '../components/security/ServerTabs';
import { Tabs, useTabParam } from '../components/ui';

const TABS = [
  { id: 'blocked', label: 'Blocked addresses' },
  { id: 'detection', label: 'Detection' },
  { id: 'never-block', label: 'Never block' },
  { id: 'enforcement', label: 'Enforcement' },
];

/**
 * Servers -> Security: the addresses refused on every server, how they came to be, the ones
 * that never are, and where each server stands with enforcing the list.
 */
export function ServersSecurity() {
  const [tab, setTab] = useTabParam(TABS);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Server security</h1>
        <p className="text-sm text-neutral-500">
          Addresses refused on every server - found by the attack detection, or blocked by hand - and those that never are.
        </p>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'blocked' && <BlockedTab />}
      {tab === 'detection' && <DetectionTab />}
      {tab === 'never-block' && <NeverBlockTab />}
      {tab === 'enforcement' && <EnforcementTab />}
    </div>
  );
}
