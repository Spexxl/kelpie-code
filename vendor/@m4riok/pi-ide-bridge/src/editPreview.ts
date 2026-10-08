export type EditPreviewResult = {
  output: string;
  appliedCount: number;
  skippedCount: number;
};

export function applyEditPreview(original: string, edits: Array<{ oldText: string; newText: string }>): EditPreviewResult {
  let output = original;
  let appliedCount = 0;
  let skippedCount = 0;

  for (const edit of edits) {
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
      skippedCount++;
      continue;
    }
    const idx = findUniqueOccurrence(output, edit.oldText);
    if (idx === undefined) {
      skippedCount++;
      continue;
    }
    output = output.slice(0, idx) + edit.newText + output.slice(idx + edit.oldText.length);
    appliedCount++;
  }

  return { output, appliedCount, skippedCount };
}

function findUniqueOccurrence(text: string, search: string): number | undefined {
  if (!search) return undefined;

  const first = text.indexOf(search);
  if (first === -1) return undefined;

  const second = text.indexOf(search, first + 1);
  return second === -1 ? first : undefined;
}
