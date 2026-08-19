import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatPercent,
  shortenFunctionName,
  shortenPath,
} from '../src/format.js';

describe('shortenPath', () => {
  it('splits on Windows separators, not just POSIX ones', () => {
    // A pattern that only splits on `/` leaves the whole Windows path as one
    // segment and returns it unchanged -- silently, which is how it survives.
    expect(shortenPath('C:\\xampp\\htdocs\\app\\src\\Service.php')).toBe('\u2026/src/Service.php');
  });

  it('shortens POSIX paths', () => {
    expect(shortenPath('/srv/app/vendor/acme/Repo.php')).toBe('\u2026/acme/Repo.php');
  });

  it('leaves short paths and pseudo-files alone', () => {
    expect(shortenPath('src/App.php')).toBe('src/App.php');
    expect(shortenPath('php:internal')).toBe('php:internal');
    expect(shortenPath('')).toBe('');
  });
});

describe('shortenFunctionName', () => {
  it('shortens closures, keeping the defining line', () => {
    expect(shortenFunctionName('{closure:D:\\work\\app\\src\\handler.php:48-50}')).toBe(
      '{closure @ handler.php:48}',
    );
  });

  it('shortens include pseudo-functions', () => {
    expect(shortenFunctionName('require::C:\\xampp\\htdocs\\app\\helper.php')).toBe(
      'require helper.php',
    );
    expect(shortenFunctionName('include_once::/srv/app/boot.php')).toBe('include_once boot.php');
  });

  it('leaves ordinary names untouched', () => {
    expect(shortenFunctionName('Widget->add')).toBe('Widget->add');
    expect(shortenFunctionName('php::usleep')).toBe('php::usleep');
    expect(shortenFunctionName('{main}')).toBe('{main}');
  });
});

describe('number formatting', () => {
  it('picks a readable time scale', () => {
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(12.345)).toBe('12.35 ms');
    expect(formatDuration(0.4)).toBe('400.0 \u00b5s');
    expect(formatDuration(0.0004)).toBe('400 ns');
  });

  it('picks a readable byte scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });

  it('never renders NaN as a percentage', () => {
    expect(formatPercent(0.1234)).toBe('12.34%');
    expect(formatPercent(Number.NaN)).toBe('0.00%');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('0.00%');
  });
});
