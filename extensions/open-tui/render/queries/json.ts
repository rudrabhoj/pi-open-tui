// Vendored from the official tree-sitter-json repo (queries/highlights.scm).
// MIT licensed. Stored as a TS module so bundling never needs asset copying.
export default "(pair\n  key: (_) @string.special.key)\n\n(string) @string\n\n(number) @number\n\n[\n  (null)\n  (true)\n  (false)\n] @constant.builtin\n\n(escape_sequence) @escape\n\n(comment) @comment\n";
