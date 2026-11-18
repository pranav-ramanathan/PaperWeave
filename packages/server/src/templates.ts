// Papers to start from. Each is a small, complete paper of its kind that builds as it is in
// the pinned toolchain; `docs/import-matrix.md` says how much of each can be edited visually.
import type pg from 'pg';
import { writeZip } from './archive.ts';
import type { BlobStore } from './blobs.ts';
import { AppError } from './errors.ts';
import { importZip } from './import.ts';
import type { Project } from './projects.ts';

const REFS = String.raw`@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@article{lamport1978,
  author  = {Leslie Lamport},
  title   = {Time, Clocks, and the Ordering of Events in a Distributed System},
  journal = {Communications of the ACM},
  volume  = {21},
  number  = {7},
  pages   = {558--565},
  year    = {1978}
}
`;

export const TEMPLATES: {
  id: string;
  name: string;
  about: string;
  files: Record<string, string>;
}[] = [
  {
    id: 'article',
    name: 'Article',
    about: 'A plain article in one file, with a bibliography.',
    files: {
      'main.tex': String.raw`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\usepackage{graphicx}

\title{Title of the Paper}
\author{First Author \and Second Author}
\date{}

\begin{document}
\maketitle

\begin{abstract}
Say in a few sentences what the paper asks, what was done, and what was found.
\end{abstract}

\section{Introduction}
\label{sec:intro}

State the question and why it matters~\cite{knuth1984}. Say what is new here, and what
Section~\ref{sec:method} and Section~\ref{sec:results} hold.

\section{Method}
\label{sec:method}

Describe what was done, in enough detail that someone else could do it again. A quantity can be
written inline, as $n = 12$, or set apart and numbered:
\begin{equation}
  \label{eq:mean}
  \bar{x} = \frac{1}{n} \sum_{i=1}^{n} x_i .
\end{equation}

\section{Results}
\label{sec:results}

Report what was found. Equation~\eqref{eq:mean} gives the mean reported here.

\section{Conclusion}

Say what follows from the results, and what does not.

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`,
      'refs.bib': REFS,
    },
  },
  {
    id: 'ieee',
    name: 'IEEE conference paper',
    about: 'Two columns in the IEEEtran class, with one file for each section.',
    files: {
      'main.tex': String.raw`\documentclass[conference]{IEEEtran}
\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{cite}

\begin{document}

\title{Title of the Paper}
\author{\IEEEauthorblockN{First Author}
\IEEEauthorblockA{Department, Institution\\
City, Country\\
first.author@example.org}
\and
\IEEEauthorblockN{Second Author}
\IEEEauthorblockA{Department, Institution\\
City, Country\\
second.author@example.org}}
\maketitle

\begin{abstract}
Say in a few sentences what the paper asks, what was done, and what was found.
\end{abstract}

\begin{IEEEkeywords}
first keyword, second keyword, third keyword
\end{IEEEkeywords}

\input{sections/introduction}
\input{sections/method}
\input{sections/results}

\section{Conclusion}

Say what follows from the results, and what does not.

\bibliographystyle{IEEEtran}
\bibliography{refs}
\end{document}
`,
      'sections/introduction.tex': String.raw`\section{Introduction}
\label{sec:intro}

State the question and why it matters~\cite{lamport1978}. Say what is new here, and what
Section~\ref{sec:method} and Section~\ref{sec:results} hold.
`,
      'sections/method.tex': String.raw`\section{Method}
\label{sec:method}

Describe what was done, in enough detail that someone else could do it again. A quantity can be
written inline, as $n = 12$, or set apart and numbered:
\begin{equation}
  \label{eq:mean}
  \bar{x} = \frac{1}{n} \sum_{i=1}^{n} x_i .
\end{equation}
`,
      'sections/results.tex': String.raw`\section{Results}
\label{sec:results}

Report what was found. Equation~\eqref{eq:mean} gives the mean reported in Table~\ref{tab:results}.

\begin{table}[t]
  \centering
  \caption{What was measured.}
  \label{tab:results}
  \begin{tabular}{ll}
    \hline
    Condition & Mean \\
    \hline
    First & 1.0 \\
    Second & 2.0 \\
    \hline
  \end{tabular}
\end{table}
`,
      'refs.bib': REFS,
    },
  },
  {
    id: 'ams',
    name: 'AMS article',
    about: 'A mathematics article in the amsart class, with theorems and proofs.',
    files: {
      'main.tex': String.raw`\documentclass{amsart}
\usepackage[utf8]{inputenc}
\usepackage{amssymb}

\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}

\title{Title of the Paper}
\author{First Author}
\address{Department, Institution, City, Country}
\email{first.author@example.org}

\begin{document}

\begin{abstract}
Say in a few sentences what is proved.
\end{abstract}

\maketitle

\section{Introduction}
\label{sec:intro}

State the result and where it stands among what is known~\cite{knuth1984}. The main result is
Theorem~\ref{thm:main}.

\section{Preliminaries}
\label{sec:prelim}

\begin{definition}
\label{def:object}
Say what the objects of the paper are.
\end{definition}

\begin{lemma}
\label{lem:step}
For every $n \geq 1$ we have $\sum_{i=1}^{n} i = n(n+1)/2$.
\end{lemma}

\begin{proof}
By induction on $n$.
\end{proof}

\section{Main result}
\label{sec:main}

\begin{theorem}
\label{thm:main}
State the theorem.
\end{theorem}

\begin{proof}
Lemma~\ref{lem:step} gives the first step. The rest follows from
\begin{equation}
  \label{eq:bound}
  a_n \leq \frac{n(n+1)}{2} .
\end{equation}
\end{proof}

\bibliographystyle{amsplain}
\bibliography{refs}
\end{document}
`,
      'refs.bib': REFS,
    },
  },
];

/** Start a paper from a template. It is brought in the way an uploaded ZIP is. */
export async function createFromTemplate(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  name: unknown,
  templateId: unknown,
): Promise<Project> {
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new AppError('invalid_input', 'Choose one of the templates.');
  if (typeof name !== 'string' || !name.trim() || name.length > 200)
    throw new AppError('invalid_input', 'A project needs a name of at most 200 characters.');
  const zip = await writeZip(
    Object.entries(template.files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
  );
  const [project] = await importZip(pool, store, userId, zip, name.trim());
  // Kept so that it can later be said how papers from each template fare.
  await pool.query('update projects set template = $2 where id = $1', [project.id, template.id]);
  return project;
}
