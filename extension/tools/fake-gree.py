#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later

# Fake Gree AC on 127.0.0.1 for trying lib/gree.js and the menu without a unit. Answers
# scan, bind, status and cmd in the ecb or gcm protocol as greeclimate describes them:
# tests the plumbing, not the protocol. Needs python3-cryptography.
#
#   python3 tools/fake-gree.py ecb|gcm [port] [idle seconds before exit, default 20]

import base64
import json
import socket
import sys

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MODE = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 7000
IDLE = int(sys.argv[3]) if len(sys.argv) > 3 else 20

ECB_KEY = b'a3K8Bx%2r8Y7#xDh'
GCM_KEY = b'{yxAHAY_Lm6pbC/<'
NONCE = bytes([0x54, 0x40, 0x78, 0x44, 0x49, 0x67, 0x5a, 0x51, 0x6c, 0x5e, 0x63, 0x13])
AAD = b'qualcomm-test'
DEVICE_KEY = b'0123456789abcdef'
MAC = 'f4911e000001'
FIRST_KEY = GCM_KEY if MODE == 'gcm' else ECB_KEY

state = {
    'Pow': 0, 'Mod': 1, 'SetTem': 24, 'TemUn': 0, 'WdSpd': 0, 'Air': 0,
    'Blo': 0, 'Health': 0, 'SwhSlp': 0, 'Lig': 1, 'SwingLfRig': 0,
    'SwUpDn': 0, 'Quiet': 0, 'Tur': 0, 'SvSt': 0, 'TemSen': 65, 'TemRec': 0,
    'StHt': 0, 'SlpMod': 0,
}


def seal(key, message):
    data = json.dumps(message).encode()
    if MODE == 'gcm':
        encryptor = Cipher(algorithms.AES(key), modes.GCM(NONCE)).encryptor()
        encryptor.authenticate_additional_data(AAD)
        sealed = encryptor.update(data) + encryptor.finalize()
        return {'pack': base64.b64encode(sealed).decode(),
                'tag': base64.b64encode(encryptor.tag).decode()}
    padder = padding.PKCS7(128).padder()
    data = padder.update(data) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return {'pack': base64.b64encode(encryptor.update(data) + encryptor.finalize()).decode()}


def unseal(key, packet):
    sealed = base64.b64decode(packet['pack'])
    if MODE == 'gcm':
        tag = base64.b64decode(packet['tag'])
        decryptor = Cipher(algorithms.AES(key), modes.GCM(NONCE, tag)).decryptor()
        decryptor.authenticate_additional_data(AAD)
        return json.loads(decryptor.update(sealed) + decryptor.finalize())
    decryptor = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    data = decryptor.update(sealed) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return json.loads(unpadder.update(data) + unpadder.finalize())


def answer(packet):
    if packet.get('t') == 'scan':
        info = {'t': 'dev', 'cid': MAC, 'mac': MAC, 'name': 'Fake AC', 'ver': 'V1.2.1'}
        return {'t': 'pack', 'i': 1, 'uid': 0, 'cid': MAC, 'tcid': '', **seal(FIRST_KEY, info)}

    if ('tag' in packet) != (MODE == 'gcm'):
        return None
    try:
        message = unseal(FIRST_KEY if packet.get('i') == 1 else DEVICE_KEY, packet)
    except Exception:
        return None

    if message['t'] == 'bind':
        body, key = {'t': 'bindok', 'mac': MAC, 'key': DEVICE_KEY.decode(), 'r': 200}, FIRST_KEY
    elif message['t'] == 'status':
        values = [state[col] for col in message['cols']]
        body, key = {'t': 'dat', 'mac': MAC, 'r': 200, 'cols': message['cols'], 'dat': values}, DEVICE_KEY
    elif message['t'] == 'cmd':
        for col, value in zip(message['opt'], message['p']):
            state[col] = value
        body = {'t': 'res', 'mac': MAC, 'r': 200, 'opt': message['opt'],
                'p': message['p'], 'val': message['p']}
        key = DEVICE_KEY
    else:
        return None
    return {'t': 'pack', 'i': packet.get('i', 0), 'uid': 0, 'cid': MAC, 'tcid': 'app', **seal(key, body)}


sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(('127.0.0.1', PORT))
sock.settimeout(IDLE)
while True:
    try:
        data, sender = sock.recvfrom(4096)
    except socket.timeout:
        break
    reply = answer(json.loads(data))
    if reply:
        sock.sendto(json.dumps(reply).encode(), sender)
