import { describe, it, expect } from 'vitest';
import { imageUrl } from '../src/api';

describe('imageUrl', () => {
  it('builds full image url', () => {
    expect(imageUrl('g', 123, '.jpg')).toBe('https://i.4cdn.org/g/123.jpg');
  });

  it('builds thumbnail url', () => {
    expect(imageUrl('g', 123, '.jpg', true)).toBe('https://i.4cdn.org/g/123s.jpg');
  });

  it('returns undefined when image fields missing', () => {
    expect(imageUrl('g', undefined, '.jpg')).toBeUndefined();
    expect(imageUrl('g', 123, undefined)).toBeUndefined();
  });
});
