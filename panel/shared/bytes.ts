/** `512 B`, `3.2 MiB`, `38 GiB`: how the panel writes a size, in the browser and in its emails and job logs. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}
