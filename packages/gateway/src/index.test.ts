import { describe, it, expect } from 'vitest';
import { __rehomeSmoke } from './index.js';

// Placeholder smoke test — proves the re-home import surface links both cores.
// gateway-001 replaces this with the real contract tests.
describe('re-home smoke', () => {
  it('resolves a value from both vendored cores', () => {
    expect(typeof __rehomeSmoke.scoreLintOnly).toBe('function');
    expect(typeof __rehomeSmoke.LeaseEnforcer).toBe('function');
  });
});
