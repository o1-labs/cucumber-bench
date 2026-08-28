// shared types for the benchmark system, see legal-ai-benchmark-system-one-pager.pdf
export type {
  PublicCase,
  PrivateCase,
  Usage,
  RunResult,
  GradeResult,
  RunContext,
  SystemUnderTest,
  Grader,
  ModelClient,
  Generation,
};

// visible to every system under test
type PublicCase = {
  id: string;
  suite: string;
  task: string;
  // task definition, e.g. what hearsay is
  instructions: string;
  // few-shot examples from the benchmark's base prompt
  examples: { q: string; a: string }[];
  // the case-specific text to analyze
  input: string;
  // question appended after the input, e.g. "Is there hearsay?"
  question: string;
  // allowed answer labels
  choices: string[];
};

// never passed to a system under test
type PrivateCase = {
  id: string;
  grader: 'exact';
  answer: string;
  aliases?: string[];
};

type Usage = { modelCalls: number; tokensIn: number; tokensOut: number };

type RunResult = Usage & {
  caseId: string;
  system: string;
  repetition: number;
  output: string;
  // latencyMs is wall time of run(), set by the runner
  latencyMs: number;
  error?: string;
};

type GradeResult = {
  caseId: string;
  system: string;
  repetition: number;
  pass: boolean;
  score: number; // 0..1
  // the answer the grader extracted from the output, for consistency-across-reps
  extracted?: string;
  detail?: string;
};

type RunContext = {
  runId: string;
  repetition: number;
  model: ModelClient;
};

type SystemUnderTest = {
  name: string;
  // short human-readable note on models/settings/strategy, shown in the report
  info?: string;
  run(c: PublicCase, ctx: RunContext): Promise<RunResult>;
};

type Grader = {
  name: string;
  grade(pub: PublicCase, priv: PrivateCase, result: RunResult): GradeResult;
};

type Generation = { text: string; usage: Usage };

type ModelClient = {
  model: string;
  generate(prompt: string, opts?: { system?: string; temperature?: number }): Promise<Generation>;
};
