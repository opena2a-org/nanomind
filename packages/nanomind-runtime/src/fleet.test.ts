import { describe, it } from 'node:test';
import assert from 'node:assert';
import { addDifferentialPrivacy, validatePrivacy } from './fleet';

describe('Fleet Gradient Submission', () => {
  it('adds noise to gradient', () => {
    const gradient = [0.1, 0.2, 0.3, 0.4, 0.5];
    const noisy = addDifferentialPrivacy(gradient);
    // Noisy gradient should differ from original
    let different = false;
    for (let i = 0; i < gradient.length; i++) {
      if (Math.abs(noisy[i] - gradient[i]) > 1e-10) {
        different = true;
        break;
      }
    }
    assert.ok(different, 'Noisy gradient should differ from original');
  });

  it('preserves gradient length', () => {
    const gradient = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const noisy = addDifferentialPrivacy(gradient);
    assert.strictEqual(noisy.length, gradient.length);
  });

  it('clips gradient to max norm', () => {
    // Very large gradient
    const large = Array(10).fill(100);
    const noisy = addDifferentialPrivacy(large, { maxNorm: 1.0 });
    // After clipping + noise, values should be much smaller than 100
    const maxVal = Math.max(...noisy.map(Math.abs));
    assert.ok(maxVal < 50, `Max value ${maxVal} should be << 100 after clipping`);
  });

  it('produces different noise each time', () => {
    const gradient = [0.5, 0.5, 0.5];
    const noisy1 = addDifferentialPrivacy(gradient);
    const noisy2 = addDifferentialPrivacy(gradient);
    let same = true;
    for (let i = 0; i < gradient.length; i++) {
      if (Math.abs(noisy1[i] - noisy2[i]) > 1e-10) {
        same = false;
        break;
      }
    }
    assert.ok(!same, 'Two noisy outputs should differ');
  });

  it('stronger privacy (lower epsilon) adds more noise', () => {
    const gradient = [1.0, 1.0, 1.0, 1.0, 1.0];
    const trials = 100;

    let strongNoiseMag = 0;
    let weakNoiseMag = 0;

    for (let t = 0; t < trials; t++) {
      const strong = addDifferentialPrivacy(gradient, { epsilon: 0.1 });
      const weak = addDifferentialPrivacy(gradient, { epsilon: 10.0 });

      for (let i = 0; i < gradient.length; i++) {
        strongNoiseMag += Math.abs(strong[i] - gradient[i]);
        weakNoiseMag += Math.abs(weak[i] - gradient[i]);
      }
    }

    assert.ok(
      strongNoiseMag > weakNoiseMag,
      `Strong privacy noise (${strongNoiseMag.toFixed(2)}) should exceed weak (${weakNoiseMag.toFixed(2)})`,
    );
  });

  it('validates privacy epsilon', () => {
    assert.strictEqual(validatePrivacy(1.0), true);  // standard
    assert.strictEqual(validatePrivacy(2.0), true);  // maximum
    assert.strictEqual(validatePrivacy(2.1), false); // too weak
    assert.strictEqual(validatePrivacy(0), false);   // invalid
    assert.strictEqual(validatePrivacy(-1), false);  // invalid
  });
});
