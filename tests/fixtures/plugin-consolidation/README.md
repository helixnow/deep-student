# Plugin consolidation historical evidence

These `.txt` files contain complete, unmodified `git show <revision>:<path>` blobs.
`e73e0d98` freezes the pre-refactor consumer declarations and App hook inventory;
`6992cdc0` freezes the delivered ContextRefChips inherited-key regression.

Tests read these checked-in blobs rather than requiring the original commit IDs
in a checkout's history. The `.txt` suffix keeps historical code out of builds
and source contract scans.
