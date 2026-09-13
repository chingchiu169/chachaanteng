type FlagType =
  | "bool"
  | "int"
  | "float"
  | "text"
  | "path"
  | "enum"
  | "multi_enum"
  | "text_list";

type ToolScope = "both" | "server" | "cli";

export interface FlagOption {
  value: string;
  label: string;
}

/** One llama.cpp CLI flag definition (ported from reference ui/js/flags/definitions.js). */
export interface FlagDef {
  id: string;
  /** primary CLI flag, e.g. "-ngl" or "--ctx-size" */
  flag: string;
  /** flag emitted when a bool is false, e.g. "--no-mmap" for mmap=false */
  false_flag?: string;
  category: string;
  type: FlagType;
  label: string;
  short_desc?: string;
  desc?: string;
  tool: ToolScope;
  /** default value; arrays only for multi_enum/text_list */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default?: any;
  options?: FlagOption[];
  sensitive?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export interface FlagCategory {
  id: string;
  name: string;
  icon?: string;
}

/** A flag value as held in the store — shape depends on FlagDef.type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FlagValue = any;

export type FlagValues = Record<string, FlagValue>;
