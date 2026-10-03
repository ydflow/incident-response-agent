/** Reuse the existing real HTTP/session/Console harness, adding threshold and recovery. */
if (!process.argv.includes('--step7')) process.argv.push('--step7');
await import('./accept-v030-step6.js');
