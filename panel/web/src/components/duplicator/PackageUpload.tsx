// @docs sites/duplicator
import { useEffect, useRef, useState } from 'react';
import { discardPackage, uploadPackage } from '../../api/packages';
import { uploadPercent } from '../../lib/appForm';
import { newUploadId } from '../../lib/uploadPlan';
import { ErrorNote, UploadButton } from '../ui';

/** An uploaded package: its upload id, and the file's name for the review. */
export interface PackageUploadValue {
  id: string;
  name: string;
}

/**
 * New site's package: the file goes up as soon as it is chosen. Null while none is chosen, or
 * one is still going up; choosing another throws the one before away.
 */
export function PackageUpload({ value, onChange }: { value: PackageUploadValue | null; onChange: (next: PackageUploadValue | null) => void }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const upload = useRef<AbortController | null>(null);

  // Leaving the step stops an upload still going, as leaving the Files tab does.
  useEffect(() => () => upload.current?.abort(), []);

  const pick = (file: File) => {
    upload.current?.abort();
    const controller = new AbortController();
    upload.current = controller;
    if (value) discardPackage(value.id);
    onChange(null);
    setError(null);
    setProgress(0);
    const id = newUploadId();
    void uploadPackage(id, file, (sent, total) => setProgress(uploadPercent(sent, total)), controller.signal)
      .then(() => {
        if (controller.signal.aborted) discardPackage(id);
        else onChange({ id, name: file.name });
      })
      .catch((err: unknown) => {
        // What went up of it is of no use: choosing the file again starts from nothing.
        discardPackage(id);
        if (!controller.signal.aborted) setError(err);
      })
      .finally(() => {
        if (upload.current !== controller) return;
        upload.current = null;
        setProgress(null);
      });
  };

  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-sm font-medium text-neutral-700">Package</div>
        <div className="flex flex-wrap items-center gap-3">
          <UploadButton accept=".zip,.daf" percent={progress} onFile={pick}>
            {value ? 'Choose another' : 'Choose package'}
          </UploadButton>
          {value && <span className="break-all text-sm">{value.name}</span>}
        </div>
        <p className="measure mt-1 text-xs text-neutral-500">
          The <code>_archive.zip</code> or <code>_archive.daf</code> file Duplicator made. Its installer.php is not needed.
        </p>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}
