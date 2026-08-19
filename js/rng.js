/**
 * rng.js — deterministic seeded random streams.
 *
 * Shared between browser (globalThis.SpectrumRng) and Node (module.exports)
 * so the authoritative server script can replay the exact same streams.
 *
 * Three independent streams are used per spec: rules, decoration, audiovisual.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpectrumRng = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** FNV-1a 32-bit string hash — stable across platforms. */
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** mulberry32 — small, fast, deterministic PRNG. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A named deterministic stream. */
  class RandomStream {
    constructor(seed, name) {
      this.name = name || 'stream';
      this.seed = (typeof seed === 'string' ? hashString(seed) : seed >>> 0);
      this._next = mulberry32(this.seed ^ hashString(this.name));
      this.draws = 0;
    }
    /** float in [0,1) */
    float() { this.draws++; return this._next(); }
    /** integer in [min, max] inclusive */
    int(min, max) { return min + Math.floor(this.float() * (max - min + 1)); }
    /** uniform pick from array */
    pick(arr) { return arr[this.int(0, arr.length - 1)]; }
    /** in-place Fisher–Yates shuffle (returns the same array) */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = this.int(0, i);
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }
    /** random hex id */
    hexId(len) {
      let s = '';
      const chars = '0123456789abcdef';
      for (let i = 0; i < (len || 8); i++) s += chars[this.int(0, 15)];
      return s;
    }
    /** fork a child stream (decor / audio variants never touch rules stream) */
    fork(name) { return new RandomStream((this.seed ^ hashString(name)) >>> 0, this.name + '/' + name); }
  }

  /** Create the three spec-mandated streams from one session seed. */
  function streams(seed) {
    return {
      rules: new RandomStream(seed, 'rules'),
      decor: new RandomStream(seed, 'decor'),
      audio: new RandomStream(seed, 'audio'),
    };
  }

  return { hashString, mulberry32, RandomStream, streams };
});
