import os from 'node:os';
// Prevent an upstream unit test from reaching a real API if a fixture stops intercepting fetch.
globalThis.fetch=async()=>{throw new Error('External fetch denied by offline unit-test guard');};
