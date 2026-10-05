import { Box, Text } from "ink";
import { terminalTheme } from "./theme.js";
import { renderStatic, safeText } from "./static.js";
import { Badge } from "./vendor/ui/badge.js";
import { KeyValue } from "./vendor/ui/key-value.js";
import { Table } from "./vendor/ui/table.js";
import { SetupFlow } from "./vendor/ui/setup-flow.js";
import { StatusMessage } from "./vendor/ui/status-message.js";
import type { Capabilities, StatusReport, Status } from "./types.js";

export { renderStatic, safeText };
export { renderAnalyze } from "./analyze.js";
export { renderContextHealth, renderCodebaseHealth } from "./health.js";
export function renderMessage(ctx: Capabilities, message: string, status: Status = "info") {
  return renderStatic(
    ctx,
    <StatusMessage variant={status}>
      <Text
        color={
          terminalTheme(ctx).colors[
            status === "pending" || status === "info" ? "foreground" : status
          ]
        }
      >
        {safeText(message)}
      </Text>
    </StatusMessage>
  );
}
export function renderStep(ctx: Capabilities, message: string) {
  return renderStatic(
    ctx,
    <SetupFlow.Step iconColor={terminalTheme(ctx).colors.success} status="done">
      {safeText(message)}
    </SetupFlow.Step>
  );
}
export function renderStatus(ctx: Capabilities, report: StatusReport) {
  const colors = terminalTheme(ctx).colors;
  const counts: Record<string, number> = {
    New: report.fresh.length,
    Modified: report.modified.length,
    Held: report.held.length,
    Clean: report.clean,
  };
  return renderStatic(
    ctx,
    <>
      <Text bold>
        AIOS <Text color={colors.primary}>{ctx.glyphs === "ascii" ? "|" : "·"} status</Text>
      </Text>
      <Text>{safeText(report.project)}</Text>
      <Text>Destination: {safeText(report.destination)}</Text>
      <Box marginY={1} flexDirection="column">
        {ctx.width < 80 ? (
          <KeyValue
            keyColor={colors.primary}
            items={Object.entries(counts).map(([key, value]) => ({ key, value: String(value) }))}
          />
        ) : (
          <Table
            data={[counts]}
            columns={Object.keys(counts).map((key) => ({ key, header: key, width: 12 }))}
          />
        )}
      </Box>
      {(
        [
          ["New", report.fresh],
          ["Modified", report.modified],
          ["Held locally", report.held],
        ] as const
      ).map(
        ([label, items]) =>
          items.length > 0 && (
            <Box key={label} flexDirection="column" marginBottom={1}>
              <Text
                bold
                color={
                  label === "New"
                    ? colors.success
                    : label === "Modified"
                      ? colors.warning
                      : colors.info
                }
              >
                {label} ({items.length})
              </Text>
              {items.map((item, i) => (
                <Box key={i} flexDirection="column" paddingLeft={2}>
                  <Text wrap="wrap">{safeText(item.rel)}</Text>
                  {item.reason ? (
                    <Text wrap="wrap">Reason: {safeText(item.reason)}</Text>
                  ) : (
                    <Badge
                      bordered={false}
                      color={item.tier === "team" ? colors.primary : colors.info}
                    >
                      {safeText(
                        [item.kind, item.tier]
                          .filter(Boolean)
                          .join(ctx.glyphs === "ascii" ? " | " : " · ")
                      )}
                    </Badge>
                  )}
                </Box>
              ))}
            </Box>
          )
      )}
      {report.held.length > 0 && (
        <StatusMessage variant="info">
          Held files stayed on this machine. Their reasons are listed above.
        </StatusMessage>
      )}
      <Text>
        Next:{" "}
        <Text color={colors.accent} bold>
          {report.fresh.length + report.modified.length ? "aios push --dry-run" : "aios status"}
        </Text>
      </Text>
    </>
  );
}
