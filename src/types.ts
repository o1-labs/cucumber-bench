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

// never passed to a system under test. graders[0] is the primary (task) grader;
// each grader reads the gold field(s) it needs
type PrivateCase = {
  id: string;
  graders: string[];
  answer?: string; // exact: the gold label
  protected?: string[]; // removal / leakage / retention: spans that must not survive or reach the model
  qaPairs?: { question: string; shortAnswers: string[] }[]; // str-em: the sub-questions of an ambiguous question
};

type Usage = { modelCalls: number; tokensIn: number; tokensOut: number };

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
  run(
    c: PublicCase,
    // model is the name to request; the proxy is the only way to reach it
    ctx: { runId: string; repetition: number; model: string; proxy: ModelProxy },
  ): Promise<Omit<RunResult, 'latencyMs'>>;
};

// what a grader may use beyond the case and the result: a greedy judge model behind
// the proxy, on a token of its own so grading cost is counted apart from the harness
type GradeContext = { judge: (prompt: string) => Promise<string> };

type Grader = {
  name: string;
  // one sentence for the chart glossary
  description?: string;
  grade(pub: PublicCase, priv: PrivateCase, result: RunResult, ctx: GradeContext): Promise<GradeResult>;
};

type ModelProxy = {
  url: string;
  register(runId: string): string; // returns the bearer token for one run
  usage(token: string): Usage;
  requests(token: string): string[]; // prompt texts that went through, in order
  close(): Promise<void>;
};
