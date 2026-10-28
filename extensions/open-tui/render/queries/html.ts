// Vendored highlights.scm for html (source: tree-sitter/tree-sitter-html/master/queries/highlights.scm).
// Stored as a TS module so bundling never needs asset copying.
export default '(tag_name) @tag\n(erroneous_end_tag_name) @tag.error\n(doctype) @constant\n(attribute_name) @attribute\n(attribute_value) @string\n(comment) @comment\n\n[\n  "<"\n  ">"\n  "</"\n  "/>"\n] @punctuation.bracket\n';
