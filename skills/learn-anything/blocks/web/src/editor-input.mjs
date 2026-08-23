const INDENT = "    ";

export function indentWithTab(value, selectionStart, selectionEnd) {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(start, Math.min(value.length, selectionEnd));
  if (start === end) {
    return {
      value: `${value.slice(0, start)}${INDENT}${value.slice(end)}`,
      selectionStart: start + INDENT.length,
      selectionEnd: start + INDENT.length,
    };
  }

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const selected = value.slice(lineStart, end);
  const indented = selected.replace(/^/gm, INDENT);
  const inserted = indented.length - selected.length;
  return {
    value: `${value.slice(0, lineStart)}${indented}${value.slice(end)}`,
    selectionStart: start + INDENT.length,
    selectionEnd: end + inserted,
  };
}
