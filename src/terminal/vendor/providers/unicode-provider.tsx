import * as React from "react";

import { isNoUnicode, UnicodeContext } from "../hooks/use-unicode.js";
import type { UnicodeProviderProps } from "../ui/types.js";

export type { UnicodeContextValue, UnicodeProviderProps } from "../ui/types.js";

export const UnicodeProvider = ({ children, unicode }: UnicodeProviderProps) => {
  const value = React.useMemo(() => ({ unicode: unicode ?? !isNoUnicode() }), [unicode]);

  return <UnicodeContext.Provider value={value}>{children}</UnicodeContext.Provider>;
};
