import { describe, expect, it } from 'vitest';
import { mediaBasename, mediaContentType, mediaExtension } from '../src/media';

describe('media URL handling', () => {
  it('recognizes extensions through query strings', () => {
    expect(mediaExtension('https://i.4cdn.org/g/123.webm?x=1')).toBe('webm');
    expect(mediaBasename('https://i.4cdn.org/g/123.webm?x=1')).toBe('123.webm');
  });

  it('overrides an incorrect response MIME for known media', () => {
    expect(mediaContentType('https://i.4cdn.org/g/123.webm', 'application/wasm')).toBe('video/webm');
    expect(mediaContentType('https://i.4cdn.org/g/123.mp4', 'application/octet-stream')).toBe('video/mp4');
  });

  it('keeps a response MIME for unknown extensions', () => {
    expect(mediaContentType('https://example.com/file.bin', 'application/octet-stream; charset=binary'))
      .toBe('application/octet-stream');
  });
});
