// shared types for the benchmark system, see legal-ai-benchmark-system-one-pager.pdf
export type {
  PublicCase,
  PrivateCase,
  Usage,
  RunResult,
  GradeResult,
  SystemUnderTest,
  Grader,
  ModelClient,
  ModelProxy,
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
};

type Usage = { modelCalls: number; tokensIn: number; tokensOut: number };

type RunResult = Usage & {
  caseId: string;
  system: string;
  repetition: number;
  output: string;
  // wall time of run(), set by the runner
  latencyMs: number;
  error?: string;
};

type GradeResult = {
  caseId: string;
  system: string;
  repetition: number;
  pass: boolean;
  // the answer extracted from the output, '(none)' if there was none; drives consistency across reps
  extracted: string;
  detail?: string;
};

type SystemUnderTest = {
  name: string;
  run(
    c: PublicCase,
    // sandboxed systems reach the model only through the proxy, which holds the real key
    ctx: { runId: string; repetition: number; model: ModelClient; proxy?: ModelProxy },
  ): Promise<Omit<RunResult, 'latencyMs'>>;
};

type Grader = {
  name: string;
  grade(pub: PublicCase, priv: PrivateCase, result: RunResult): GradeResult;
};

type ModelClient = {
  model: string;
  generate(prompt: string, opts?: { temperature?: number }): Promise<{ text: string; usage: Usage }>;
};

type ModelProxy = {
  url: string;
  register(runId: string): string; // returns the bearer token for one run
  usage(token: string): Usage;
  close(): Promise<void>;
};
