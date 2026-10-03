import { useEffect, useState } from 'react';
import { siteFileBase } from '../../../../shared/siteFilePath';
import { downloadUrl, readFile } from '../../api/files';
import { imageTypeFor } from '../../lib/fileKinds';
import { formatBytes } from '../../lib/format';
import { Button, ErrorNote, Modal, Spinner } from '../ui';

/**
 * An image, shown from a blob URL. The blob's type comes from the name's allowlist
 * (lib/fileKinds.ts), never from the file, and it is only ever put in an `<img>`: a blob URL
 * has the panel's origin, and an SVG's scripts do not run inside an image.
 */
export function ImagePreview({
  slug,
  path,
  onEdit,
  onClose,
}: {
  slug: string;
  path: string;
  /** SVG is text too; offered as "Edit as text". */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    const type = imageTypeFor(path);
    if (!type) return;
    readFile(slug, path)
      .then(({ bytes }) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        setSize(bytes.length);
        setUrl(objectUrl);
      })
      .catch((err: unknown) => alive && setError(err));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [slug, path]);

  return (
    <Modal title={siteFileBase(path)} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex min-h-40 items-center justify-center rounded-lg bg-[repeating-conic-gradient(var(--n100)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-3">
          {url ? <img src={url} alt={siteFileBase(path)} className="max-h-[60vh] max-w-full" /> : !error && <Spinner />}
        </div>
        <ErrorNote error={error} />
        <div className="flex items-center justify-between text-sm">
          <span className="font-mono text-xs text-neutral-500">
            <bdi>{path}</bdi> {size > 0 && `· ${formatBytes(size)}`}
          </span>
          <span className="flex gap-2">
            {onEdit && (
              <Button small variant="secondary" onClick={onEdit}>
                Edit as text
              </Button>
            )}
            <a className="button-primary inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium" href={downloadUrl(slug, path)}>
              Download
            </a>
          </span>
        </div>
      </div>
    </Modal>
  );
}
