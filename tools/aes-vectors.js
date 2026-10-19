#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later

// Helper for tools/check-aes.py: encrypts its cases with lib/aes.js, prints the results.

import * as Aes from '../lib/aes.js';

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g) ?? [], h => Number.parseInt(h, 16));

const results = JSON.parse(ARGV[0]).map(([key, nonce, aad, data]) => {
    const [k, n, a, d] = [unhex(key), unhex(nonce), unhex(aad), unhex(data)];
    const ecb = Aes.ecbEncrypt(k, d);
    const [gcm, tag] = Aes.gcmEncrypt(k, n, a, d);
    return {
        ecb: hex(ecb),
        gcm: hex(gcm),
        tag: hex(tag),
        ecbBack: hex(Aes.ecbDecrypt(k, ecb)) === data,
        gcmBack: hex(Aes.gcmDecrypt(k, n, a, gcm, tag)) === data,
    };
});
print(JSON.stringify(results));
