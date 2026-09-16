// ---------------------------------------------------------------------------
// Arithmetic verification-challenge generator (spec: verification).
//
// Produces a single expression with exactly five operators — three `×` terms
// joined by two `+` / `−` joiners — no parentheses, no division, and every
// operand and intermediate result bounded to ±1000. Terms carry only positive
// operands, so the only signs in the expression are the joiners themselves and
// no decimal point can ever appear. The answer is a "four distinct integer
// choices, exactly one correct" set.
// ---------------------------------------------------------------------------

export interface ArithmeticChallenge {
  /** Human display form, e.g. "3 × 5 − 8 ÷ 4 + 6". */
  expression: string;
  answer: number;
  /** Four distinct integers, exactly one correct, in display order. */
  choices: number[];
}

interface Term {
  text: string;
  value: number;
}

function randInt(minInclusive: number, maxInclusive: number): number {
  return Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) + minInclusive;
}

/** One of the three terms: `a × b` with |result| ≤ 300 and positive operands,
 *  so a term never displays a sign or a zero inside itself. */
function makeTerm(): Term {
  const a = randInt(1, 30);
  const b = randInt(1, 10);
  return { text: `${a} × ${b}`, value: a * b };
}

export function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function generateArithmeticQuestion(): ArithmeticChallenge {
  const t1 = makeTerm();
  const t2 = makeTerm();
  const t3 = makeTerm();
  const j1 = Math.random() < 0.5 ? "+" : "−";
  const j2 = Math.random() < 0.5 ? "+" : "−";

  const first = j1 === "+" ? t1.value + t2.value : t1.value - t2.value;
  const answer = j2 === "+" ? first + t3.value : first - t3.value;

  const wrong = new Set<number>();
  while (wrong.size < 3) {
    const offset = randInt(1, 15) * (Math.random() < 0.5 ? -1 : 1);
    const candidate = answer + offset;
    if (candidate !== answer && !wrong.has(candidate)) wrong.add(candidate);
  }

  return {
    expression: `${t1.text} ${j1} ${t2.text} ${j2} ${t3.text}`,
    answer,
    choices: shuffle([answer, ...wrong]),
  };
}
