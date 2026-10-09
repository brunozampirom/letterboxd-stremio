import { describe, expect, it } from 'vitest';
import { stripApiPrefix } from '../src/server/vercel';

describe('stripApiPrefix', () => {
  it('removes the prefix the vercel.json rewrite prepends', () => {
    expect(stripApiPrefix('/api/brunozampirom/rtw/manifest.json')).toBe(
      '/brunozampirom/rtw/manifest.json',
    );
    expect(stripApiPrefix('/api/health')).toBe('/health');
  });

  it('keeps a query string attached', () => {
    expect(stripApiPrefix('/api/admin/refresh?user=someone')).toBe('/admin/refresh?user=someone');
    expect(stripApiPrefix('/api?x=1')).toBe('/?x=1');
  });

  it('maps the bare prefix to the root', () => {
    expect(stripApiPrefix('/api')).toBe('/');
    expect(stripApiPrefix('/api/')).toBe('/');
  });

  it('leaves a path that never carried the prefix alone', () => {
    // A runtime that hands over the original path must not be rewritten.
    expect(stripApiPrefix('/brunozampirom/manifest.json')).toBe('/brunozampirom/manifest.json');
    expect(stripApiPrefix('/health')).toBe('/health');
    expect(stripApiPrefix('/')).toBe('/');
  });

  it('strips only one segment, so a user named api still resolves', () => {
    // The rewrite turns /api/manifest.json into /api/api/manifest.json.
    expect(stripApiPrefix('/api/api/manifest.json')).toBe('/api/manifest.json');
  });

  it('does not strip a path that merely starts with the letters api', () => {
    expect(stripApiPrefix('/apifoo/manifest.json')).toBe('/apifoo/manifest.json');
  });
});
