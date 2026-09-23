import { describe, it, expect } from 'vitest';
import { validateLanguage } from './models';

describe('validateLanguage', () => {
  it('returns undefined for null/undefined', () => {
    expect(validateLanguage(undefined)).toBeUndefined();
    expect(validateLanguage(null)).toBeUndefined();
  });

  it('accepts supported ISO 639-1 codes', () => {
    expect(validateLanguage('de')).toBe('de');
    expect(validateLanguage('en')).toBe('en');
    expect(validateLanguage('yue')).toBe('yue');
  });

  it('rejects BCP 47 locale tags with a helpful message', () => {
    expect(() => validateLanguage('de-DE')).toThrow(/de-DE/);
    expect(() => validateLanguage('de-DE')).toThrow(/use 'de' instead/);
  });

  it('rejects unknown codes', () => {
    expect(() => validateLanguage('xx')).toThrow();
  });

});
