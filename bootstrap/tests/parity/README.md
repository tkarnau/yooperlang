# Layer 1 parity corpus

Inputs for src/parity.test.js, which diffs the JS lexer's token dump against
the bootstrap lexer's. These files only have to LEX - they are never compiled,
so they can hold constructs neither parser accepts.

Keep them ASCII: spans are JS string indices on one side and byte offsets on
the other, so the two only agree on ASCII.
