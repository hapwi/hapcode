import { useCallback, useEffect } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export interface ImagePreviewOverlayProps {
  expandedImage: ExpandedImagePreview;
  onClose: () => void;
  onChange: (next: ExpandedImagePreview) => void;
}

export function ImagePreviewOverlay({
  expandedImage,
  onClose,
  onChange,
}: ImagePreviewOverlayProps) {
  const navigateExpandedImage = useCallback(
    (direction: -1 | 1) => {
      if (expandedImage.images.length <= 1) {
        return;
      }
      const nextIndex =
        (expandedImage.index + direction + expandedImage.images.length) %
        expandedImage.images.length;
      if (nextIndex === expandedImage.index) {
        return;
      }
      onChange({ ...expandedImage, index: nextIndex });
    },
    [expandedImage, onChange],
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedImage, navigateExpandedImage, onClose]);

  const expandedImageItem = expandedImage.images[expandedImage.index];
  if (!expandedImageItem) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {expandedImage.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => {
            navigateExpandedImage(-1);
          }}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <img
          src={expandedImageItem.src}
          alt={expandedImageItem.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {expandedImageItem.name}
          {expandedImage.images.length > 1
            ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
            : ""}
        </p>
      </div>
      {expandedImage.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => {
            navigateExpandedImage(1);
          }}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
}
