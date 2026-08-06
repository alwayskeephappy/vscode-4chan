const MIME_BY_EXTENSION: Record<string, string> = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  webm: 'video/webm',
  mp4: 'video/mp4',
};

export function mediaExtension(url: string): string | undefined {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
    return match?.[1].toLowerCase();
  } catch {
    const path = url.split(/[?#]/, 1)[0];
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match?.[1].toLowerCase();
  }
}

export function mediaContentType(url: string, responseType?: string | null): string {
  const known = mediaExtension(url);
  return (known && MIME_BY_EXTENSION[known]) || responseType?.split(';', 1)[0].trim() || 'application/octet-stream';
}

export function mediaBasename(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || 'download';
  } catch {
    return url.split(/[?#]/, 1)[0].split('/').pop() || 'download';
  }
}
