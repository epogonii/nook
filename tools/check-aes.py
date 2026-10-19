#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later

# Checks lib/aes.js against python3-cryptography: ECB and GCM, both directions,
# random keys, nonces and lengths.
#
#   python3 tools/check-aes.py

import json
import os
import subprocess
import sys

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'aes-vectors.js')

cases = [[os.urandom(16).hex(), os.urandom(12).hex(), os.urandom(13).hex(), os.urandom(n).hex()]
         for n in (0, 1, 15, 16, 17, 33, 200, 517)]
run = subprocess.run(['gjs', '-m', HELPER, json.dumps(cases)], capture_output=True, text=True, check=True)

failed = False
for (key, nonce, aad, data), got in zip(cases, json.loads(run.stdout)):
    key, nonce, aad, data = map(bytes.fromhex, (key, nonce, aad, data))

    padder = padding.PKCS7(128).padder()
    padded = padder.update(data) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    ecb = encryptor.update(padded) + encryptor.finalize()

    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(aad)
    gcm = encryptor.update(data) + encryptor.finalize()

    ok = (got['ecb'] == ecb.hex() and got['gcm'] == gcm.hex() and got['tag'] == encryptor.tag.hex()
          and got['ecbBack'] and got['gcmBack'])
    failed |= not ok
    print(f'{len(data):4} bytes: {"ok" if ok else "MISMATCH"}')

sys.exit(1 if failed else 0)
