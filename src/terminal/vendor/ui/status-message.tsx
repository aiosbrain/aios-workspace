import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { useTheme } from "../hooks/use-theme.js";
import { useUnicode } from "../hooks/use-unicode.js";
import { resolveStatusSymbol } from "../lib/terminal-symbols.js";

import { Spinner } from "./spinner.js";

export type StatusVariant = "success" | "error" | "warning" | "info" | "loading" | "pending";

export interface StatusMessageProps {
  variant?: StatusVariant;
  children: ReactNode;
  icon?: string;
  "aria-label"?: string;
}

export const StatusMessage = ({
  variant = "info",
  children,
  icon,
  "aria-label": ariaLabel,
}: StatusMessageProps) => {
  const theme = useTheme();
  const unicode = useUnicode();

  const variantColor = (() => {
    switch (variant) {
      case "success": {
        return theme.colors.success;
      }
      case "error": {
        return theme.colors.error;
      }
      case "warning": {
        return theme.colors.warning;
      }
      case "loading": {
        return theme.colors.primary;
      }
      case "pending": {
        return theme.colors.muted;
      }
      default: {
        return theme.colors.info;
      }
    }
  })();

  return (
    <Box flexDirection="row" aria-label={ariaLabel ?? `${variant} status`}>
      <Box flexShrink={0} marginRight={1}>
        {variant === "loading" ? (
          <Spinner type="dots" color={variantColor} aria-label="Loading" />
        ) : (
          <Text aria-hidden color={variantColor}>
            {icon ?? resolveStatusSymbol(unicode, variant as Exclude<StatusVariant, "loading">)}
          </Text>
        )}
      </Box>
      <Box flexShrink={1}>
        <Text>{children}</Text>
      </Box>
    </Box>
  );
};
