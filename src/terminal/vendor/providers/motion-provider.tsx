import * as React from "react";

import { isReducedMotion, MotionContext } from "../hooks/use-motion.js";
import type { MotionProviderProps } from "../ui/types.js";

export type { MotionContextValue, MotionProviderProps } from "../ui/types.js";

export const MotionProvider = ({ children, reducedMotion }: MotionProviderProps) => {
  const value = React.useMemo(
    () => ({ reduced: reducedMotion ?? isReducedMotion() }),
    [reducedMotion]
  );

  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
};
