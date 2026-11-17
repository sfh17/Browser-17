#!/usr/bin/env python3
"""The Notebook 17 key: kept in the system keyring (GNOME Keyring / KWallet, through libsecret).

Prints the key (base64, 32 bytes); makes one and stores it the first time. The same key for
Browser-17 and the browser inside Player-17 (.deb and Flatpak alike), so they share one notebook.
Exit 2: no keyring (no Secret Service, or it refused).
"""
import base64
import os
import sys

try:
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Secret
except Exception as e:  # no libsecret for Python
    print("no-libsecret: %s" % e, file=sys.stderr)
    sys.exit(2)

SCHEMA = Secret.Schema.new("io.github.sfh17.Notebook", Secret.SchemaFlags.NONE,
                           {"app": Secret.SchemaAttributeType.STRING})
ATTRS = {"app": "notebook-17"}

if len(sys.argv) > 1 and sys.argv[1] == "legacy":
    # the key the first builds kept through libsecret's simple calls (inside Flatpak: a keyring
    # file of that app alone): only to open a notebook saved with it, once
    try:
        old = Secret.password_lookup_sync(SCHEMA, ATTRS, None)
    except Exception:
        old = None
    if not old:
        sys.exit(3)
    print(old)
    sys.exit(0)

# Straight to the Secret Service (the system keyring). libsecret's simple calls go, inside
# Flatpak, to a keyring file of that app alone: Browser-17 and Player-17 would not share a key.
try:
    service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
    items = service.search_sync(SCHEMA, ATTRS, Secret.SearchFlags.UNLOCK | Secret.SearchFlags.LOAD_SECRETS, None)
    value = items[0].get_secret() if items else None
    key = value.get_text() if value else None
    if not key:
        if len(sys.argv) > 1 and sys.argv[1] == "lookup":
            sys.exit(3)   # none yet (the caller only asked)
        key = base64.b64encode(os.urandom(32)).decode()
        coll = Secret.Collection.for_alias_sync(service, Secret.COLLECTION_DEFAULT,
                                                Secret.CollectionFlags.NONE, None)
        Secret.Item.create_sync(coll, SCHEMA, ATTRS, "Notebook 17 (Browser-17, Player-17)",
                                Secret.Value.new(key, len(key), "text/plain"),
                                Secret.ItemCreateFlags.NONE, None)
    print(key)
except SystemExit:
    raise
except Exception as e:
    print("keyring: %s" % e, file=sys.stderr)
    sys.exit(2)
