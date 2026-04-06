import React from "react";

import { cardSurfaceClassName } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SurfaceProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
};

export function Surface({ as: Component = "div", className, ...props }: SurfaceProps) {
  return <Component className={cn(cardSurfaceClassName, "p-6", className)} {...props} />;
}
