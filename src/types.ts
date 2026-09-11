// shared types for the benchmark system, see legal-ai-benchmark-system-one-pager.pdf
export type {
  PublicCase,
  PrivateCase,
  Usage,
  RunResult,
  GradeResult,
  GradeContext,
  Stage,
  Trace,
  SystemUnderTest,
  Grader,
  Models,
  ModelProxy,
};

// visible to every system under test
type PublicCase = {
  id: string;
  suite: string;
  task: string;
  // what to do: the task definition, a redaction instruction, ...
  instructions: string;
  // the case-specific text: a fact pattern, a document, ...
  input: string;
  // context passages the answer may cite, numbered from 1 in order (asqa; cuad later)
  docs?: { title: string; text: string }[];
  // worked examples (few-shot); label tasks also carry the question and the allowed labels
  examples?: { q: string; a: string }[];
  question?: string;
  choices?: string[];
};

// never passed to a system under test. graders[0] is the primary (task) grader. the file also
// holds the gold data, but that belongs to the graders: each one declares its Gold type and
// builds it from the raw case (Grader.gold). the core reads only id and graders
type PrivateCase = {
  id: string;
  graders: string[];
};

// costUsd is what the provider reported (openrouter returns usage.cost per request);
// 0 when the provider reports none, e.g. a local ollama. models are the ids actually
// requested, recorded by the proxy: the report shows them next to each system
type Usage = { modelCalls: number; tokensIn: number; tokensOut: number; costUsd: number; models: string[] };

// one step inside a harness (input safety, agent, output safety), self-reported by the harness
type Stage = {
  name: string;
  module: string;
  version: string;
  policy?: string;
  mode: 'passthrough' | 'regex' | 'llm' | 'hybrid';
  findings: string[];
  decision: 'pass' | 'modified' | 'blocked';
};

type Trace = {
  source: string;
  transformedSource: string;
  rawOutput: string;
  releasedOutput: string;
  stages: Stage[];
};

type RunResult = Usage & {
  caseId: string;
  system: string;
  repetition: number;
  output: string;
  // wall time of run(), set by the runner
  latencyMs: number;
  error?: string;
  // what actually reached the model: recorded by the proxy for sandboxes
  modelRequests?: string[];
  trace?: Trace;
};

type GradeResult = {
  grader: string;
  pass: boolean;
  score: number; // 0..1
  // the answer extracted from the output, for label tasks; drives consistency across reps
  extracted?: string;
  detail?: string;
};

type SystemUnderTest = {
  name: string;
  // the benchmark suites this system runs on; all of them when absent
  suites?: string[];
  // the models this system calls: its own choice, declared in its manifest
  models: Models;
  // the proxy is the only way to reach a model
  run(c: PublicCase, ctx: { runId: string; repetition: number; proxy: ModelProxy }): Promise<Omit<RunResult, 'latencyMs'>>;
};

// main answers on the guarded route; safety is the trusted model a safety stage may show raw
// data to. a harness may name further roles (e.g. compose) and use them on the guarded route
type Models = { main: string; safety: string; [role: string]: string };

// what a grader may use beyond the case and the result: a greedy judge model behind
// the proxy, on a token of its own so grading cost is counted apart from the harness
type GradeContext = { judge: (prompt: string) => Promise<string> };

// a grader over its own gold type. gold(raw, id) turns the private case, as loaded from json,
// into Gold, and throws (naming the case) when a field is missing or malformed. the runner
// calls it for every case before the first model call, and again before grade, so grade sees
// checked, typed gold. a grader that reads no gold is a Grader<undefined>
type Grader<Gold = unknown> = {
  name: string;
  // one sentence that says what passes: shown in the report and chart glossary
  description: string;
  gold(raw: unknown, id: string): Gold;
  grade(pub: PublicCase, gold: Gold, result: RunResult, ctx: GradeContext): Promise<GradeResult>;
};

type ModelProxy = {
  url: string;
  // returns the bearer token for one run. a harness token reaches the guarded and safety routes
  // and only the models it names; a judge token (judge: true) reaches the judge route only.
  // models: the allowed model ids (any when omitted); maxCalls: this run's own call limit;
  // upstreams: per-model providers; a model not named goes to the main upstream
  register(
    runId: string,
    opts?: { judge?: boolean; models?: string[]; maxCalls?: number; upstreams?: { [model: string]: { url: string; key: string } } },
  ): string;
  usage(token: string): Usage;
  requests(token: string): string[]; // prompt texts that went through, in order
  close(): Promise<void>;
};
