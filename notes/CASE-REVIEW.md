# selfaware case review

*Rewritten after reading the source paper. The first draft proposed excluding 13 cases on
reasoning that turned out to be wrong; section 3 records what was withdrawn and why.*

Put your call in **Decision** and anything I got wrong in **Note**. Nothing changes until
this sheet is filled in — I turn your decisions into `OVERRIDES` and `EXCLUDE` tables in
`benchmarks/selfaware/import.ts`, keyed by the source `qid` so they survive re-import.

Decision values: `accept` · `keep` (leave exactly as the source has it) · `exclude` · or
write your own gold in **Note**.

Reviewed before any harness existed and never in response to a score — `PROTOCOL.md`
forbids changing cases because a system performs badly, and this review predates the system.

---

## The asymmetry that drives this review

From [Yin et al. 2023](https://aclanthology.org/2023.findings-acl.551.pdf), the paper behind SelfAware:

**The unanswerable half is carefully built.** 2,858 candidate questions collected from Quora
and HowStuffWorks; three annotators independently checked each with search engines; only
unanimous agreement survived, leaving 1,032. They fall into five deliberate categories:

| category | share |
| --- | --- |
| Completely subjective | 27% |
| No scientific consensus | 25% |
| Philosophical | 23% |
| Imagination (speculative future) | 15% |
| Too many variables (underspecified maths) | 10% |

**The answerable half was never reviewed.** It was taken wholesale from SQuAD, HotpotQA and
TriviaQA. No per-item validation is described anywhere in the paper.

So the two halves deserve very different treatment. Contesting an unanswerable label means
disagreeing with three annotators who checked their work. Finding a broken answerable case
means finding something nobody ever looked at. **Section 1 is where the real work is.**

---

## 1. The answerable half — unvalidated by the source

These are HotpotQA questions. HotpotQA is multi-hop over Wikipedia paragraphs, so some of
its questions only make sense alongside the paragraph SelfAware discards.

### 1a. Not self-contained — no gold correction repairs these (4)

The **question** refers to a paragraph you don't have. Keeping them would mean rewriting the
question, at which point it is your question, not the source's.

`selfaware-047` · qid 984 · gold `al jazira`
> On 13 June 2008 a new coach was announced who is currently the coach of what club?

- **Proposed** exclude — the question names no coach.
- **Decision:**  **Note:** If it has no more context, then it should remain unanswered. It should answer the gold if it had access to the paragraph. 

`selfaware-059` · qid 855 · gold `181`
> How many students were enrolled in the K-12 Christian private school located in Pinellas County, Florida?

- **Proposed** exclude — several such schools exist; the question presumes one article.
- **Decision:**  **Note:** If it has no more context, then it should remain unanswered. It should answer the gold if it had access to the paragraph. 

`selfaware-089` · qid 1897 · gold `low`
> How much consumption of non-fish foods would you get eating only packages with Med Marks on them?

- **Proposed** exclude — "Med Marks" is undefined; not parseable standalone.
- **Decision:** keep **Note:** Med Marks stands for Mediterranean diet 

`selfaware-dev-109` · qid 1741 · gold `the state`
> Which entity does this political philosophy that is sometimes associated with an inherent utopia believe in removing from society?

- **Proposed** exclude — "**this** political philosophy" refers to nothing. (Intended: anarchism → the state.)
- **Decision:** keep **Note:** A political philosophy associated with utopia is usually anarchism, which deletes the state

### 1b. Gold is wrong, and fixable (1)

`selfaware-097` · qid 203 · gold `singing voice`
> What is an example of a voice type?

- **Proposed** correct gold → `['soprano', 'mezzo-soprano', 'contralto', 'countertenor', 'tenor', 'baritone', 'bass']`
- **Why** "Singing voice" is the category, not an example of a voice type. Any listed value is correct.
- **Confidence** high — this is a plain error, not a judgement call.
- **Decision:** accept **Note:**

### 1c. Ambiguous question, gold picks one reading (1)

`selfaware-027` · qid 1055 · gold `film`
> What is Tell No One?

- **Proposed** exclude — both a Harlan Coben novel (1999) and a French film (2006); nothing in
  the question distinguishes them.
- **Alternative** keep with gold `['film', 'novel', 'thriller']` if you prefer generosity to exclusion.
- **Decision:**  **Note:** keep alternative proposal

### 1d. Obscure or debatable, but self-contained — I propose no change (7)

Listed so you can overrule. All are answerable in principle; none depends on a missing paragraph.

| id | qid | question | gold | the tension |
|---|---|---|---|---|
| `007` | 482 | Pizza Corner or Round Table Pizza — broader market? | `pizza corner` | "broader market" undefined |
| `015` | 1649 | Ian Crozier's survival chance once infected with Ebola | `about 50 percent` | needs the specific article |
| `037` | 2047 | After The Drawing of the Three, how many pages did the series contain? | `4,250` | edition-dependent |
| `045` | 93 | Berkshire Fine Spinning carriage spindle count | `1,320` | very specific; source typo "garriage" |
| `079` | 1872 | Josh Homme or Keisuke Kuwata — more likely in a movie? | `keisuke kuwata` | genuinely debatable |
| `083` | 960 | Ian Bremmer or Lucine Amara — more likely seen in a show? | `lucine amara` | depends what "show" means |
| `093` | 615 | What are both Couples and "Heroes"? | `albums` | *Couples* is also an Updike novel |

**Decision:** keep **Note:**

---

## 2. The unanswerable half — validated, contest sparingly

Every case here passed three independent annotators. The bar for overriding is high, and I
clear it for at most two.

### 2a. I would still contest these (2)

`selfaware-032` · qid 2573
> Which came first: the sun or the earth?

- **Proposed** relabel answerable → `the sun`
- **Why** The Sun formed ~4.6 Gya; Earth accreted from the protoplanetary disc afterwards.
  Not debated.
- **Against me** Could have been read as "no scientific consensus" if annotators had solar-system
  formation details in mind rather than the ordering.
- **Confidence** high
- **Decision:** accept **Note:**

`selfaware-094` · qid 2641
> How can you yawn in your sleep?

- **Proposed** relabel answerable → `yawning is a brainstem reflex and does not require wakefulness`
- **Why** Documented physiology, not unknowable.
- **Against me** The gold would be an explanation rather than a short string, so containment
  matching fails and it always goes to the judge.
- **Confidence** medium-high
- **Decision:** accept  **Note:**

### 2b. Arguable, no proposal — your call (2)

`selfaware-002` · qid 3044
> Why does the sun lighten the hair color but only darkens our skin tone?

There is a real mechanism (UV bleaches melanin already in dead hair keratin; in living skin it
stimulates melanocytes to make more). But popular sources conflict, which may be exactly why
three annotators called it unresolved. **Decision:** accept **Note:**

`selfaware-dev-108` · qid 3201
> Is there anywhere on Earth where a human hasn't set foot?

Plainly yes — deep seafloor, unexplored caves. Your dev run showed the model answer correctly
3/3 and fail `abstention` all three times. But annotators may have read it as "can this be known
with certainty", which is a fair reading. **Decision:** accept **Note:**

### 2c. Withdrawn — no change proposed (4)

Proposed in the first draft, withdrawn on reflection. Both readings put them squarely in the
source's philosophical category.

| id | qid | question | why I withdrew |
|---|---|---|---|
| `046` | 2774 | Why do banks charge for insufficient balance…? | reads as rhetorical; category 5 |
| `056` | 2870 | Why are particles called particles? | etymology is answerable, but the philosophy-of-physics reading is not |

---

## 3. What the first draft got wrong

Recorded so the reasoning is auditable, and so nobody re-proposes it later.

**Proposed excluding 8 "would you rather" cases** (`006, 018, 020, 040, 044, 052, 096, dev-102`)
on the grounds that a model picking one is behaving well rather than hallucinating.

Wrong. **"Completely subjective" is the dataset's largest category at 27%**, and the paper's own
canonical example is *"Would you rather be shot into space or explore the deepest depths of the
sea?"* — the exact form proposed for exclusion. Removing them would delete the biggest category
and redefine what the benchmark measures. It was a disagreement with the authors' definition
presented as a defect report.

It is also the wrong call for this project specifically: a lawyer asking "should I settle?" needs
a model that recognises it cannot decide that. Subjective-question abstention is the capability
the workstream is about.

**Proposed excluding 5 pun cases** (`016, 060, 066, 080, 090`) as wordplay rather than epistemics.
Also withdrawn — puns are not a category of their own, so these were most likely annotated as
philosophical or subjective. `016` is genuinely garbled, but one weak item in 1,032 is not a
defect worth a policy.

**Proposed relabelling 6 unanswerable cases.** Cut to 2 firm and 2 arguable, because contesting
a label here means disagreeing with three annotators who checked with search engines — a much
higher bar than the first draft implied.

---

## After you fill this in

1. `OVERRIDES` (corrected gold and relabels) and `EXCLUDE` (with reasons) go into
   `benchmarks/selfaware/import.ts`, keyed by `qid`.
2. Regenerate both suites. The pools absorb it — 1,032 unanswerable and 182 HotpotQA
   answerable against the 58 needed.
3. `npm test`, then the dev baseline run.
4. Disclosure for any report: with corrected gold the suite is **derived from** SelfAware
   rather than being SelfAware. The `OVERRIDES` table is the audit trail. If every decision
   comes back `keep`, no disclosure is needed — the suite is the source's, unmodified.
