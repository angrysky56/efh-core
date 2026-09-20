theory EFHF_Grounding_Measure
  imports "HOL-Probability.Probability"
begin

text \<open>
  Measure-theoretic grounding of closure — the successor to the finite
  stochastic result in EFHF_Grounding.thy.

  The finite version proved: on a FINITE state space with a real-valued
  transition matrix, strong lumpability (Kemeny–Snell) yields a well-defined,
  stochastic, commuting macro kernel. That result could in principle be an
  artifact of finiteness. Here we lift it to an ARBITRARY measurable space with
  a genuine probability kernel, using HOL-Probability's measure theory. Nothing
  is assumed finite or discrete.

  Setup (locale @{text lumpable_kernel}):
    M  — micro measurable space
    N  — macro measurable space
    p  — measurable coarse-graining  M \<rightarrow> N
    K  — a probability kernel: for each micro point x, @{term "K x"} is a
         probability measure on M (the one-step law from x)

  The MACRO one-step law from x is the pushforward @{term "distr (K x) N p"} —
  where the macro state lands after one micro step, seen through p.

  Strong lumpability (kernel-level informational closure): micro points in the
  same macro cell induce the SAME macro law,
      @{term "p x = p y \<Longrightarrow> distr (K x) N p = distr (K y) N p"}.
  So the macro law depends only on the macro state — micro detail below p adds
  no predictive information.

  Proved below:
    lumped_welldefined / lumped_commutes — the lumped kernel is representative-
        independent and the diagram commutes: the macro law out of @{term "p x"}
        equals the pushforward of the micro law out of x (computational closure).
    lumped_prob_space — the lumped macro kernel is itself a probability measure:
        the macro level is a bona fide probability kernel, not a bookkeeping
        artifact (closure under the same mathematical type, now measure-theoretic).

  Together: kernel-level informational closure \<Longrightarrow> computational closure, for
  arbitrary probability kernels on arbitrary measurable spaces. The IC \<rightarrow> CompC
  edge that EFHF.thy merely assumes is here a theorem with no finiteness crutch.
\<close>

locale lumpable_kernel =
  fixes M :: "'s measure"
    and N :: "'m measure"
    and p :: "'s \<Rightarrow> 'm"
    and K :: "'s \<Rightarrow> 's measure"
  assumes p_meas: "p \<in> measurable M N"
    and K_prob:  "\<And>x. x \<in> space M \<Longrightarrow> prob_space (K x)"
    and K_sets:  "\<And>x. x \<in> space M \<Longrightarrow> sets (K x) = sets M"
    and lumpable: "\<And>x y. x \<in> space M \<Longrightarrow> y \<in> space M \<Longrightarrow> p x = p y
                    \<Longrightarrow> distr (K x) N p = distr (K y) N p"
begin

text \<open>The macro one-step law from a micro point.\<close>

definition macro :: "'s \<Rightarrow> 'm measure" where
  "macro x = distr (K x) N p"

text \<open>@{term p} is measurable out of @{term "K x"} too, since @{term "K x"}
  shares @{term M}'s \<sigma>-algebra.\<close>

lemma p_meas_K:
  assumes x: "x \<in> space M"
  shows "p \<in> measurable (K x) N"
  using p_meas by (simp add: measurable_cong_sets[OF K_sets[OF x] refl])

text \<open>The macro law is a probability measure (pushforward of a probability
  measure along a measurable map).\<close>

lemma macro_prob_space:
  assumes x: "x \<in> space M"
  shows "prob_space (macro x)"
proof -
  interpret prob_space "K x" using K_prob[OF x] .
  show ?thesis
    unfolding macro_def by (rule prob_space_distr[OF p_meas_K[OF x]])
qed

text \<open>A representative micro point of a macro state that is actually inhabited.\<close>

definition rep :: "'m \<Rightarrow> 's" where
  "rep m = (SOME x. x \<in> space M \<and> p x = m)"

definition lumped :: "'m \<Rightarrow> 'm measure" where
  "lumped m = macro (rep m)"

lemma rep_correct:
  assumes x: "x \<in> space M"
  shows "rep (p x) \<in> space M \<and> p (rep (p x)) = p x"
proof -
  have "\<exists>x'. x' \<in> space M \<and> p x' = p x" using x by blast
  thus ?thesis unfolding rep_def by (rule someI_ex)
qed

text \<open>Commuting diagram / computational closure: the lumped macro law out of
  @{term "p x"} equals the pushforward of the micro law out of x. Representative
  choice does not matter, by lumpability.\<close>

theorem lumped_commutes:
  assumes x: "x \<in> space M"
  shows "lumped (p x) = macro x"
proof -
  have r: "rep (p x) \<in> space M" and pr: "p (rep (p x)) = p x"
    using rep_correct[OF x] by auto
  have "distr (K (rep (p x))) N p = distr (K x) N p"
    by (rule lumpable[OF r x pr])
  thus ?thesis unfolding lumped_def macro_def .
qed

text \<open>Well-definedness proper: micro points in the same macro cell induce the
  same macro law, so the lumped kernel does not depend on the representative.\<close>

corollary macro_welldefined:
  assumes "x \<in> space M" and "y \<in> space M" and "p x = p y"
  shows "macro x = macro y"
  unfolding macro_def by (rule lumpable[OF assms])

text \<open>The lumped kernel is a probability measure on the macro space.\<close>

theorem lumped_prob_space:
  assumes x: "x \<in> space M"
  shows "prob_space (lumped (p x))"
  using lumped_commutes[OF x] macro_prob_space[OF x] by simp

end

text \<open>
  Non-vacuity: the identity coarse-graining on any probability space is a
  lumpable kernel (every micro state is its own macro cell, trivially lumpable).
  This witnesses that the locale assumptions are satisfiable, so the theorems
  above are not vacuously about an empty class.
\<close>

lemma (in prob_space) identity_lumpable:
  "lumpable_kernel M M (\<lambda>x. x) (\<lambda>x. M)"
  by unfold_locales (auto simp: prob_space_axioms intro: measurable_ident_sets)

end
