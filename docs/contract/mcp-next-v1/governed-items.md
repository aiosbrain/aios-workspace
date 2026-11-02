# Governed item compatibility — revision 1.0.1

Contract-first implementation supplement for decisions and notes. Runtime capabilities remain disabled until separately verified. Member API version remains 1.27.

Governed decisions keep canonical decision UUID/row_key and a canonical source item; notes keep kind note and item UUID. Server-owned durable provenance binds actor, team, destination and content/operation identity. Workspace mirrors never replace this provenance. Pending graph extraction is not provider synchronization; sync not_applicable makes no graph-completion claim.

Legacy item ingress preflights the entire affected item/row batch before project or content mutations. Exact authorized semantic echoes of governed decisions are no-ops; omission cannot delete them. Attempts to change governed content, attribution, tier or source identity, or overwrite/delete a protected source item, return HTTP409 with `{"error":{"code":"immutable_origin","message":"This governed record is immutable; refresh the read-only mirror."}}`. Existing unprotected content retains its prior semantics. Server-generated paths use the reserved `1-inbox/governed/` prefix; legacy callers cannot create items there. A prefix or caller frontmatter never establishes trusted provenance.

Decision echo validation supports the accepted governed limits: title500, rationale25000 and impact5000 Unicode code points. Note title200/body25000 remain exact accepted content. Invalid UTF-8, unpaired surrogates and U+0000 are rejected before durable acceptance (422 invalid_payload); no normalization or trimming changes accepted content.

## Decision table cells

New pull output marks each encoded table with an immediately preceding `<!-- aios:decision-cells:v1 -->` line. Only marked tables decode the following entities once: `&amp;`, `&#124;`, `&#10;`, `&#13;`, `&lt;`, `&gt;`, `&#32;`, `&#9;`, `&#92;`. Encoder escapes ampersands first in a single pass, protects pipes/newlines/CR/angle brackets, and encodes boundary whitespace so Markdown cell trimming cannot lose it. Non-ASCII boundary whitespace uses decimal numeric code-point entities, decoded once only in marked cells. Backslashes are encoded as `&#92;` to avoid Markdown pipe-escape ambiguity; dollar text is literal. Unmarked historical tables keep their existing interpretation, including literal entity-looking text. Pull decodes the existing table according to its marker, then rewrites the full table under one encoding mode; mixed-mode rows are forbidden. Private/admin rows retain existing redaction and unknown-kind clients retain graceful compatibility.

## Note read and mirror representation

A retrieved note uses `kind: note`, exact `frontmatter.title`, exact body, stable item UUID, server-created actor, team access and reserved canonical path. Clients recognize note explicitly and ignore unknown future kinds before interpreting item paths or creating files. A pull mirror retains safe quoted title/kind/item identity and origin metadata plus the unchanged body. `from_brain: true` mirrors are held from ordinary workspace publication even when an include pattern selects the inbox.

Legacy `/items` accepts `kind: note` only to recognize an existing authorized exact semantic echo; it never creates a new note. The existing common item fields are used, with no `rows`. Matching persisted origin, kind, access, actor, content hash, body and complete frontmatter returns unchanged before any domain write. A fresh note, reserved-path squat or changed echo returns409 `immutable_origin`; caller metadata never establishes provenance.
