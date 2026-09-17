export interface Capabilities {
  mode: string;
  width: number;
  colorDepth: number;
  motion: boolean;
  glyphs: string;
  background: string;
  tier: string;
}
export type Status = "success" | "error" | "warning" | "info" | "pending";
export interface Option {
  value: string;
  label: string;
  hint?: string;
}
export interface Prompt {
  kind: "select" | "multiselect" | "password" | "text";
  message: string;
  options?: Option[];
  initialValue?: string;
  initialValues?: string[];
  placeholder?: string;
}
export interface ReportItem {
  rel: string;
  kind?: string;
  tier?: string;
  reason?: string;
}
export interface StatusReport {
  project: string;
  destination: string;
  fresh: ReportItem[];
  modified: ReportItem[];
  held: ReportItem[];
  clean: number;
}
export interface ProgressEvent {
  label: string;
  completed?: number;
  total?: number;
}
