// @docs security/blocked-addresses, security/site-protection
import { useEffect, useState } from 'react';
import type { SecurityCheckDto } from '../../../../shared/types';
import { checkAddress, useBlockAddress } from '../../api/security';
import { Button, ErrorNote, Field, Modal, Segmented, inputClass } from '../ui';

const DURATIONS = [
  { id: '60', label: 'An hour' },
  { id: '1440', label: 'A day' },
  { id: '10080', label: 'A week' },
  { id: 'forever', label: 'Until lifted' },
] as const;

/**
 * Block an address on every server. Before anything is sent it asks the panel whether the
 * address could be blocked at all - a fleet server, a trusted proxy, an address an admin used -
 * and says why not, rather than letting the request fail.
 */
export function BlockDialog({ address: initial, siteSlug, onClose }: { address?: string; siteSlug?: string; onClose: () => void }) {
  const [address, setAddress] = useState(initial ?? '');
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]['id']>('1440');
  const [note, setNote] = useState('');
  const [check, setCheck] = useState<SecurityCheckDto | null>(null);
  const block = useBlockAddress();

  useEffect(() => {
    const value = address.trim();
    if (!value) {
      setCheck(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void checkAddress(value)
        .then((c) => live && setCheck(c))
        .catch(() => live && setCheck(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [address]);

  const refusal = !check ? null : !check.valid ? check.problem : check.protectedBecause ? `Never blocked: ${check.protectedBecause}.` : check.blockedBy ? 'Blocked already.' : null;

  return (
    <Modal title="Block an address" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          block.mutate(
            { address: address.trim(), minutes: duration === 'forever' ? null : Number(duration), ...(note.trim() ? { note: note.trim() } : {}), ...(siteSlug ? { siteSlug } : {}) },
            { onSuccess: onClose },
          );
        }}
      >
        <Field label="Address or range" hint="An IPv6 visitor is best blocked by its /64: that is how the panel's own detection blocks them.">
          <input className={`${inputClass} font-mono`} autoFocus={!initial} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.7" />
        </Field>
        {check?.valid && check.country && <p className="text-xs text-neutral-500">Country: {check.country}</p>}
        {refusal && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{refusal}</p>}
        <div>
          <div className="mb-1 text-sm font-medium text-neutral-700">For</div>
          <Segmented small options={DURATIONS} value={duration} onChange={setDuration} label="How long" />
        </div>
        <Field label="Note" width="lg">
          <input className={inputClass} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it did" />
        </Field>
        <p className="text-xs text-neutral-500">
          On every server, within a minute: its connections to ports 80 and 443 are dropped, and behind a trusted proxy its requests get 403. SSH
          and FTP are not affected.
        </p>
        <ErrorNote error={block.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!address.trim() || refusal !== null || block.isPending}>
            Block
          </Button>
        </div>
      </form>
    </Modal>
  );
}
