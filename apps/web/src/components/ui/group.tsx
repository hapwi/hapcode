"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { Separator } from "./separator";
import "./group.css";

const groupVariants = cva("group-base flex w-fit", {
  defaultVariants: {
    orientation: "horizontal",
  },
  variants: {
    orientation: {
      horizontal: "group-horizontal",
      vertical: "group-vertical flex-col",
    },
  },
});

function Group({
  className,
  orientation,
  children,
  ...props
}: {
  className?: string;
  orientation?: VariantProps<typeof groupVariants>["orientation"];
  children: React.ReactNode;
} & React.ComponentProps<"div">) {
  return (
    <div
      className={cn(groupVariants({ orientation }), className)}
      data-orientation={orientation}
      data-slot="group"
      role="group"
      {...props}
    >
      {children}
    </div>
  );
}

function GroupText({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn(
      "group-text-base relative inline-flex items-center whitespace-nowrap gap-2 rounded-lg border border-input bg-muted px-[calc(--spacing(3)-1px)] text-muted-foreground text-base sm:text-sm shadow-xs/5 outline-none transition-shadow",
      className,
    ),
    "data-slot": "group-text",
  };
  return useRender({
    defaultTagName: "div",
    props: mergeProps(defaultProps, props),
    render,
  });
}

function GroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: {
  className?: string;
} & React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "group-separator-base pointer-events-none relative z-2 bg-input before:absolute before:inset-0",
        className,
      )}
      orientation={orientation}
      {...props}
    />
  );
}

export {
  Group,
  Group as ButtonGroup,
  GroupText,
  GroupText as ButtonGroupText,
  GroupSeparator,
  GroupSeparator as ButtonGroupSeparator,
  groupVariants,
};
