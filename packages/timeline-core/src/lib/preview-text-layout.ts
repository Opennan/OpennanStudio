// Computes text rows for editor preview canvas overlays.

export interface PreviewTextLine {
  text: string;
  width: number;
}

interface LayoutPreviewTextInput {
  text: string;
  maxWidth: number;
  fontSize: number;
  letterSpacing: number;
  measureText: (text: string) => number;
  /** Line height as a multiple of the font size (default 1.3). */
  lineHeight?: number;
}

interface PreviewTextLayout {
  lines: PreviewTextLine[];
  lineHeight: number;
  textWidth: number;
  boxWidth: number;
  boxHeight: number;
}

type GraphemeSegmenter = { segment(text: string): Iterable<{ segment: string }> };
type SegmenterConstructor = new (locale?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter;
const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const graphemeSegmenter: GraphemeSegmenter | null = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;

/** User-perceived characters (Intl.Segmenter grapheme clusters when available, else code points). */
export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function measureWithLetterSpacing(
  text: string,
  letterSpacing: number,
  measureText: (text: string) => number,
): number {
  return measureText(text) + Math.max(0, text.length - 1) * letterSpacing;
}

function splitLongToken(
  token: string,
  maxWidth: number,
  letterSpacing: number,
  measureText: (text: string) => number,
): PreviewTextLine[] {
  const lines: PreviewTextLine[] = [];
  let current = "";
  for (const ch of token) {
    const candidate = current + ch;
    const candidateWidth = measureWithLetterSpacing(candidate, letterSpacing, measureText);
    if (current && candidateWidth > maxWidth) {
      lines.push({ text: current, width: measureWithLetterSpacing(current, letterSpacing, measureText) });
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push({ text: current, width: measureWithLetterSpacing(current, letterSpacing, measureText) });
  }
  return lines;
}

export function layoutPreviewText(input: LayoutPreviewTextInput): PreviewTextLayout {
  const maxWidth = Math.max(1, input.maxWidth);
  const lineHeight = input.fontSize * (input.lineHeight ?? 1.3);
  const lines: PreviewTextLine[] = [];

  const pushLine = (line: string) => {
    lines.push({
      text: line,
      width: measureWithLetterSpacing(line, input.letterSpacing, input.measureText),
    });
  };

  const paragraphs = input.text.replace(/\r\n?/g, "\n").split("\n");
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      pushLine("");
      continue;
    }

    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      pushLine("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      const candidateWidth = measureWithLetterSpacing(candidate, input.letterSpacing, input.measureText);
      if (candidateWidth <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        pushLine(current);
        current = "";
      }

      const wordWidth = measureWithLetterSpacing(word, input.letterSpacing, input.measureText);
      if (wordWidth <= maxWidth) {
        current = word;
        continue;
      }

      const chunks = splitLongToken(word, maxWidth, input.letterSpacing, input.measureText);
      for (const chunk of chunks.slice(0, -1)) lines.push(chunk);
      current = chunks.at(-1)?.text ?? "";
    }

    if (current) pushLine(current);
  }

  if (lines.length === 0) pushLine("");
  const textWidth = Math.max(...lines.map((line) => line.width));
  return {
    lines,
    lineHeight,
    textWidth,
    boxWidth: textWidth + 16,
    boxHeight: lineHeight * lines.length,
  };
}
