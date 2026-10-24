// SPDX-License-Identifier: GPL-2.0-or-later

// Credentials go in the keyring, never gsettings: dconf is plain text on disk and
// in backups. The Xiaomi passToken alone controls every device on the account.

import Secret from 'gi://Secret';

// Made per call, not at import: the shell imports this module before enable().
function getSchema() {
    return new Secret.Schema('io.github.epogonii.nook', Secret.SchemaFlags.NONE, {
        service: Secret.SchemaAttributeType.STRING,
    });
}

function settle(resolve, reject, finish) {
    return (_source, result) => {
        try {
            resolve(finish(result));
        } catch (e) {
            reject(e);
        }
    };
}

export function lookup(service, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(getSchema(), {service}, cancellable,
            settle(resolve, reject, Secret.password_lookup_finish));
    });
}

export function store(service, label, value) {
    return new Promise((resolve, reject) => {
        Secret.password_store(getSchema(), {service}, Secret.COLLECTION_DEFAULT, label, value, null,
            settle(resolve, reject, Secret.password_store_finish));
    });
}

export function clear(service) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(getSchema(), {service}, null,
            settle(resolve, reject, Secret.password_clear_finish));
    });
}
