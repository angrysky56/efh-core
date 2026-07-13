theory EFHF_Grounding
  imports Complex_Main
begin

text \<open>
  Definitional grounding for EFHF closure concepts.

  EFHF.thy stipulates the closure network as locale axioms; here the closure
  concepts are DEFINED as properties of dynamics, and their relationships are
  PROVED. Two settings, in increasing generality:

  1. Deterministic dynamics (f : 's => 's) with a coarse-graining (p : 's => 'm):
     informational closure and computational closure coincide — the
     deterministic shadow of Rosas et al.'s Theorem 1 (IC <-> CC for spatial
     coarse-grainings).

  2. Finite stochastic dynamics (a transition kernel over a finite state
     space): strong lumpability (= kernel-level informational closure: the
     next macro state's distribution depends only on the current macro state)
     yields a well-defined, stochastic, commuting macro kernel
     (= computational closure: the macro automaton is a coherent
     coarse-graining of the micro automaton).

  What this grounds and what it does not: the IC -> CompC edge that EFHF.thy
  assumes (ic_closures / closures_k1 flavor) here becomes a theorem about
  defined mathematical objects. The agent-theoretic chain (SI -> TA -> AB -> DS)
  and the identification of Kernel 1 with commuting closure remain theory
  choices, visibly quarantined in the locale. Measure-theoretic generalization
  (arbitrary state spaces via HOL-Probability) is the successor step.
\<close>

section \<open>Deterministic grounding\<close>

text \<open>
  Informational closure: the macro trajectory is predictable from the macro
  state alone — micro detail below the partition adds nothing.
\<close>

definition info_closed :: "('s \<Rightarrow> 's) \<Rightarrow> ('s \<Rightarrow> 'm) \<Rightarrow> bool" where
  "info_closed f p \<longleftrightarrow> (\<forall>x y. p x = p y \<longrightarrow> p (f x) = p (f y))"

text \<open>
  Computational closure: there exists a macro dynamic g making the diagram
  commute — stepping then projecting equals projecting then stepping.
\<close>

definition comp_closed :: "('s \<Rightarrow> 's) \<Rightarrow> ('s \<Rightarrow> 'm) \<Rightarrow> bool" where
  "comp_closed f p \<longleftrightarrow> (\<exists>g. \<forall>x. g (p x) = p (f x))"

theorem det_info_imp_comp:
  assumes ic: "info_closed f p"
  shows "comp_closed f p"
proof -
  define g where "g m = p (f (SOME x. p x = m))" for m
  have "g (p x) = p (f x)" for x
  proof -
    have rep: "p (SOME y. p y = p x) = p x"
      using someI[of "\<lambda>y. p y = p x" x] by simp
    with ic have "p (f (SOME y. p y = p x)) = p (f x)"
      unfolding info_closed_def by blast
    then show ?thesis by (simp add: g_def)
  qed
  then show ?thesis
    unfolding comp_closed_def by blast
qed

theorem det_comp_imp_info:
  assumes "comp_closed f p"
  shows "info_closed f p"
  using assms unfolding comp_closed_def info_closed_def by metis

corollary det_closure_equivalence:
  "info_closed f p \<longleftrightarrow> comp_closed f p"
  using det_info_imp_comp det_comp_imp_info by blast

section \<open>Finite stochastic grounding\<close>

text \<open>
  A transition kernel over a finite state space: nonnegative entries, rows
  summing to one.
\<close>

definition stochastic :: "('s::finite \<Rightarrow> 's \<Rightarrow> real) \<Rightarrow> bool" where
  "stochastic P \<longleftrightarrow> (\<forall>x y. 0 \<le> P x y) \<and> (\<forall>x. (\<Sum>y\<in>UNIV. P x y) = 1)"

text \<open>Probability of jumping from micro state x into the block of macro state m.\<close>

definition block_prob :: "('s::finite \<Rightarrow> 's \<Rightarrow> real) \<Rightarrow> ('s \<Rightarrow> 'm) \<Rightarrow> 's \<Rightarrow> 'm \<Rightarrow> real" where
  "block_prob P p x m = (\<Sum>y\<in>{y. p y = m}. P x y)"

text \<open>
  Strong lumpability (Kemeny–Snell), i.e. kernel-level informational closure:
  micro states in the same block agree on every block-transition probability,
  so the macro process is Markov regardless of the initial distribution.
\<close>

definition strongly_lumpable :: "('s::finite \<Rightarrow> 's \<Rightarrow> real) \<Rightarrow> ('s \<Rightarrow> 'm) \<Rightarrow> bool" where
  "strongly_lumpable P p \<longleftrightarrow>
     (\<forall>x y. p x = p y \<longrightarrow> (\<forall>m. block_prob P p x m = block_prob P p y m))"

text \<open>The lumped (macro) kernel, defined via an arbitrary block representative.\<close>

definition lumped :: "('s::finite \<Rightarrow> 's \<Rightarrow> real) \<Rightarrow> ('s \<Rightarrow> 'm) \<Rightarrow> 'm \<Rightarrow> 'm \<Rightarrow> real" where
  "lumped P p m m' = block_prob P p (SOME x. p x = m) m'"

text \<open>
  Computational closure, proved: under strong lumpability the lumped kernel is
  well-defined (independent of the chosen representative) and the diagram
  commutes — the macro transition out of p x equals the micro block
  transition out of x.
\<close>

theorem lumped_commutes:
  assumes sl: "strongly_lumpable P p"
  shows "lumped P p (p x) m' = block_prob P p x m'"
proof -
  have rep: "p (SOME y. p y = p x) = p x"
    using someI[of "\<lambda>y. p y = p x" x] by simp
  with sl have "block_prob P p (SOME y. p y = p x) m' = block_prob P p x m'"
    unfolding strongly_lumpable_def by blast
  then show ?thesis
    by (simp add: lumped_def)
qed

text \<open>Summing a quantity block-by-block equals summing it over all micro states.\<close>

lemma sum_over_blocks:
  fixes h :: "'s::finite \<Rightarrow> real" and p :: "'s \<Rightarrow> 'm::finite"
  shows "(\<Sum>m\<in>UNIV. (\<Sum>y\<in>{y. p y = m}. h y)) = (\<Sum>y\<in>UNIV. h y)"
proof -
  have "(\<Sum>y\<in>UNIV. h y) = (\<Sum>m\<in>p ` UNIV. \<Sum>y\<in>{y \<in> UNIV. p y = m}. h y)"
    by (rule sum.image_gen) simp
  also have "\<dots> = (\<Sum>m\<in>p ` UNIV. \<Sum>y\<in>{y. p y = m}. h y)"
    by simp
  also have "\<dots> = (\<Sum>m\<in>UNIV. \<Sum>y\<in>{y. p y = m}. h y)"
  proof (rule sum.mono_neutral_left)
    show "finite (UNIV::'m set)" by simp
    show "p ` UNIV \<subseteq> UNIV" by simp
    show "\<forall>m\<in>UNIV - p ` UNIV. (\<Sum>y\<in>{y. p y = m}. h y) = 0"
    proof
      fix m assume "m \<in> UNIV - p ` UNIV"
      then have "{y. p y = m} = {}" by auto
      then show "(\<Sum>y\<in>{y. p y = m}. h y) = 0" by simp
    qed
  qed
  finally show ?thesis by simp
qed

text \<open>The lumped kernel is itself a stochastic kernel — the macro level is a
  genuine dynamical system of the same kind, not a bookkeeping artifact.\<close>

theorem lumped_stochastic:
  fixes P :: "'s::finite \<Rightarrow> 's \<Rightarrow> real" and p :: "'s \<Rightarrow> 'm::finite"
  assumes st: "stochastic P"
  shows "stochastic (lumped P p)"
  unfolding stochastic_def
proof (intro conjI allI)
  fix m m' :: 'm
  show "0 \<le> lumped P p m m'"
    using st unfolding lumped_def block_prob_def stochastic_def
    by (auto intro: sum_nonneg)
next
  fix m :: 'm
  have "(\<Sum>m'\<in>UNIV. lumped P p m m') =
        (\<Sum>m'\<in>UNIV. \<Sum>y\<in>{y. p y = m'}. P (SOME x. p x = m) y)"
    by (simp add: lumped_def block_prob_def)
  also have "\<dots> = (\<Sum>y\<in>UNIV. P (SOME x. p x = m) y)"
    by (rule sum_over_blocks)
  also have "\<dots> = 1"
    using st unfolding stochastic_def by blast
  finally show "(\<Sum>m'\<in>UNIV. lumped P p m m') = 1" .
qed

text \<open>
  Reading back into EFHF vocabulary:

  \<^item> strongly_lumpable P p  — informational closure of the coarse-graining p
    over dynamics P (macro suffices to predict macro).
  \<^item> lumped_commutes        — computational closure: a macro automaton exists
    and coheres with the micro automaton (the commuting diagram holds).
  \<^item> lumped_stochastic      — the macro level is closed under the same
    mathematical type: coarse-graining a stochastic system under strong
    lumpability yields a stochastic system.

  Together: kernel-level IC implies CompC for finite stochastic systems —
  previously an assumed edge, now a theorem. The deterministic section gives
  the stronger two-way version. Every step above passed Isabelle's kernel.
\<close>

end
