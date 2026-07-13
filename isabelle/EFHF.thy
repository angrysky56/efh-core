theory EFHF
  imports Main
begin

text \<open>
  The EFHF / Triadic Kernel axiom network as an explicit locale.

  Epistemic status, made syntactic: everything proved below is conditional on
  the locale assumptions. Isabelle will not let a theorem escape this context
  without carrying the stipulations as premises — the "relative to axioms"
  caveat is enforced by the mechanism, not by editorial discipline.

  Predicates over an abstract entity type 'a:
    SI    — Subjective Integration     TA — Teleological Action
    AB    — Autonomous Boundary        DS — Differentiated State
    IC    — Informational Closure      CC — Causal Closure
    CompC — Computational Closure      K1 — Kernel 1
    CT    — Coherence Timeout

  This mirrors the 2026-03-13 Prover9 formalization and the Z3 quantified-UF
  port (efh-core claims 4 and 5). The predicates are still opaque here; the
  definitional-grounding arc (defining IC/CC/CompC as properties of Markov
  kernels and partitions via HOL-Probability, then PROVING these implications)
  is the successor to this file, not an edit of it.
\<close>

locale efhf =
  fixes SI TA AB DS IC CC CompC K1 CT :: "'a \<Rightarrow> bool"
  assumes si_ta: "\<And>x. SI x \<Longrightarrow> TA x"
    and ta_ab: "\<And>x. TA x \<Longrightarrow> AB x"
    and ab_ds: "\<And>x. AB x \<Longrightarrow> DS x"
    and ds_ic: "\<And>x. DS x \<Longrightarrow> IC x"
    and ic_closures: "\<And>x. IC x \<Longrightarrow> CC x \<and> CompC x"
    and closures_k1: "\<And>x. IC x \<Longrightarrow> CC x \<Longrightarrow> CompC x \<Longrightarrow> K1 x"
    and ct_not_k1: "\<And>x. CT x \<Longrightarrow> \<not> K1 x"
begin

text \<open>Theorem 1: Subjective Integration entails the full closure stack.\<close>

theorem full_closure_stack:
  assumes si: "SI x"
  shows "K1 x \<and> CompC x \<and> CC x \<and> IC x"
proof -
  from si have "TA x" by (rule si_ta)
  then have "AB x" by (rule ta_ab)
  then have "DS x" by (rule ab_ds)
  then have ic: "IC x" by (rule ds_ic)
  then have cc: "CC x" and compc: "CompC x"
    using ic_closures by blast+
  from ic cc compc have k1: "K1 x" by (rule closures_k1)
  from k1 compc cc ic show ?thesis by simp
qed

text \<open>Theorem 2: Subjective Integration and Coherence Timeout cannot coexist.\<close>

theorem si_ct_incompatible:
  assumes si: "SI x" and ct: "CT x"
  shows False
proof -
  from si have "K1 x" using full_closure_stack by blast
  moreover from ct have "\<not> K1 x" by (rule ct_not_k1)
  ultimately show False by blast
qed

corollary no_si_ct: "\<not> (SI x \<and> CT x)"
  using si_ct_incompatible by blast

end

text \<open>
  Consistency witness: the locale has a model (the everywhere-False
  interpretation), so the axiom set cannot derive False unconditionally.
  This is the Mace4/Z3-sat role, played by locale interpretation.
\<close>

interpretation trivial_model: efhf
  "\<lambda>_. False" "\<lambda>_. False" "\<lambda>_. False" "\<lambda>_. False"
  "\<lambda>_. False" "\<lambda>_. False" "\<lambda>_. False" "\<lambda>_. False" "\<lambda>_. False"
  by unfold_locales auto

text \<open>
  A less degenerate witness: an entity enjoying the full stack without
  timeout. Shows the axioms admit inhabited models, not only vacuous ones.
\<close>

interpretation inhabited_model: efhf
  "\<lambda>_. True" "\<lambda>_. True" "\<lambda>_. True" "\<lambda>_. True"
  "\<lambda>_. True" "\<lambda>_. True" "\<lambda>_. True" "\<lambda>_. True" "\<lambda>_. False"
  by unfold_locales auto

end
