# Sanitized Meta webhook fixtures

Wire-format bodies for the WhatsApp Cloud API webhook, used by later Phase 04 tests. **Every identifier, phone number, name, id and message text here is fake.** No real numbers, BSUIDs, WABA/phone-number ids, tokens, secrets or messages belong in this directory.

`manifest.json` records, per file, its **origin**, the official page it was derived from, the retrieval date and notes:

| Origin | Meaning |
|---|---|
| `OFFICIAL_EXAMPLE_DERIVED` | Structure copied from an official Meta example (URL in the manifest), values replaced with fakes |
| `DASHBOARD_SAMPLE_DERIVED` | **None exist.** These need a Meta app (App Dashboard > Webhooks test); deferred to the optional live smoke |
| `SYNTHETIC_EDGE_CASE` | Built here for an edge case or from documented property rules; **not** an official example |

## Rules

- The files are **byte-exact test inputs**. Signature tests sign each file's own bytes; nothing may re-format them. They are excluded from Prettier (`.prettierignore`) and from line-ending conversion (`.gitattributes`).
- `text-sinhala-raw-utf8.json` and `text-sinhala-escaped.json` hold the same JSON value with different bytes (literal UTF-8 versus lowercase `\uXXXX` escapes). Which form Meta actually puts on the wire is **unverified**. The signature rule is the same for both: HMAC-SHA256 over the exact bytes received, nothing else.
- `system-user-changed-user-id.json` and `user-id-update.json` mirror the shapes printed on Meta's BSUID page, which contradicts other official pages (G0 item H1). They document a shape; no handler may depend on them until H1 is closed.
- `multi-sender-pairing.json` is synthetic: no official example has more than one contact or message per `value`.
- Not present because no official shape could be retrieved: Flow responses (`interactive.nfm_reply`) and `order` messages.
- `invalid-json.txt` and `invalid-utf8.bin` are deliberately malformed bodies.
