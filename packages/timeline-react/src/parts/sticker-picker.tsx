// src/components/editor/timeline/sticker-picker.tsx
// Sticker picker using emoji-mart — renders emoji as proper images, no API key needed.

"use client";

import { useEffect, useRef } from "react";

interface StickerPickerProps {
  onSelect: (url: string, emoji: string) => void;
}

export function StickerPicker({ onSelect }: StickerPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Dynamically import to avoid SSR issues
    Promise.all([
      import("emoji-mart").then((m) => m.Picker),
      import("@emoji-mart/data"),
    ]).then(([Picker, data]) => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const picker = new Picker({
        data: data.default,
        onEmojiSelect: (item: any) => {
          // emoji-mart gives us the native emoji char + image src
          const src = item.src ?? item.skins?.[0]?.src ?? null;
          const native = item.native ?? item.skins?.[0]?.native ?? item.id;
          onSelect(src, native);
        },
        theme: "dark",
        previewPosition: "none",
        skinTonePosition: "none",
        navPosition: "top",
        perLine: 7,
        emojiSize: 24,
        emojiButtonSize: 36,
      });
      ref.current?.appendChild(picker as unknown as Node);
    });
    const node = ref.current;
    return () => {
      if (node) node.innerHTML = "";
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={ref}
      className="w-full h-full [&>em-emoji-picker]:w-full [&>em-emoji-picker]:h-full"
      style={{ "--color-border-over": "transparent" } as React.CSSProperties}
    />
  );
}
